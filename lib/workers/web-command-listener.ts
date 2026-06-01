import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { appendEvent } from "@spr/core";
import { logger } from "@/lib/log";
import { transition } from "@/lib/circuit-breaker/state";
import {
  setUiTradingMode,
  setDemoStartSol,
  type UiTradingMode,
} from "@/lib/db/repos/trading-mode";
import { setTradeLimits } from "@/lib/db/repos/settings";
import {
  startSession,
  stopSession,
  DEFAULT_PARAMS,
  type AutoSessionParams,
} from "@/lib/db/repos/auto-sessions";
import { setRuleStatus } from "@/lib/db/repos/loss-learning";
import { invalidateCache } from "@/lib/api/short-cache";

const log = logger("web-command-listener");

const POLL_MS = 1_500;
const BATCH = 8;

const COMMAND_TYPES = [
  "SETTINGS_MODE_REQUESTED",
  "SETTINGS_LIMITS_REQUESTED",
  "AUTO_SESSION_START_REQUESTED",
  "AUTO_SESSION_STOP_REQUESTED",
  "CIRCUIT_BREAKER_REQUESTED",
  "LEARNING_RULE_STATUS_REQUESTED",
] as const;

/**
 * Transitional poll loop (localhost single-worker). Risks: duplicate scans, burst
 * inefficiency, listener overlap. Future: LISTEN/NOTIFY or leased job table.
 */
export function startWebCommandListener(): () => void {
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const types = COMMAND_TYPES.map((t) => `'${t}'`).join(", ");
      const res = await getDb().execute(
        sql.raw(`
        SELECT de.id::text AS id, de.type, de.payload, de.correlation_id
        FROM domain_events de
        WHERE de.type IN (${types})
          AND de.occurred_at > now() - interval '10 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM domain_events done
            WHERE done.correlation_id = de.correlation_id
              AND done.type LIKE '%_COMPLETED'
          )
        ORDER BY de.id ASC
        LIMIT ${BATCH}
      `),
      );
      type Row = {
        id: string;
        type: string;
        payload: Record<string, unknown>;
        correlation_id: string | null;
      };
      for (const r of (res as unknown as { rows: Row[] }).rows) {
        if (stopped) break;
        await processCommand(r);
      }
    } catch (e) {
      log.warn("tick failed", { err: String(e) });
    } finally {
      busy = false;
    }
  };

  const t = setInterval(() => void tick(), POLL_MS);
  setTimeout(() => void tick(), 2_000);

  return () => {
    stopped = true;
    clearInterval(t);
  };
}

async function processCommand(r: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
}) {
  const correlationId = r.correlation_id;
  if (!correlationId) return;

  const complete = async (payload: Record<string, unknown>) => {
    const suffix = r.type.replace("_REQUESTED", "");
    await appendEvent({
      type: `${suffix}_COMPLETED`,
      payload: { ok: true, ...payload },
      correlationId,
    }).catch(() => undefined);
  };

  const reject = async (reason: string) => {
    const suffix = r.type.replace("_REQUESTED", "");
    await appendEvent({
      type: `${suffix}_REJECTED`,
      payload: { reason },
      correlationId,
    }).catch(() => undefined);
    await appendEvent({
      type: `${suffix}_COMPLETED`,
      payload: { ok: false, reason },
      correlationId,
    }).catch(() => undefined);
  };

  try {
    switch (r.type) {
      case "SETTINGS_MODE_REQUESTED": {
        const mode = r.payload.mode as UiTradingMode | undefined;
        const demoStartSol = r.payload.demoStartSol as number | undefined;
        if (mode != null) await setUiTradingMode(mode);
        if (demoStartSol != null) await setDemoStartSol(demoStartSol);
        invalidateCache("settings:mode");
        invalidateCache("settings:mode-lite");
        await complete({});
        break;
      }
      case "SETTINGS_LIMITS_REQUESTED": {
        const limits = await setTradeLimits(r.payload.limits as Parameters<typeof setTradeLimits>[0]);
        invalidateCache("settings:limits");
        await complete({ limits });
        break;
      }
      case "CIRCUIT_BREAKER_REQUESTED": {
        const action = r.payload.action as string;
        if (action === "halt") {
          await transition("HALTED", (r.payload.reason as string) ?? "manual halt");
        } else if (action === "resume") {
          await transition("RUNNING", (r.payload.reason as string) ?? "manual resume");
        } else {
          await reject("invalid_action");
          return;
        }
        await complete({ action });
        break;
      }
      case "LEARNING_RULE_STATUS_REQUESTED": {
        const id = BigInt(String(r.payload.id));
        const status = r.payload.status as "applied" | "proposed" | "reverted";
        await setRuleStatus(id, status);
        await complete({});
        break;
      }
      case "AUTO_SESSION_START_REQUESTED": {
        const mode = r.payload.mode as "paper" | "live";
        const params = {
          ...DEFAULT_PARAMS,
          ...(r.payload.params as Partial<AutoSessionParams> | undefined),
        };
        const session = await startSession({ mode, params });
        invalidateCache("trade:bootstrap");
        invalidateCache("auto:status");
        invalidateCache("auto:log");
        await complete({ session, session_id: session.id });
        break;
      }
      case "AUTO_SESSION_STOP_REQUESTED": {
        await stopSession((r.payload.reason as string) ?? "user requested");
        invalidateCache("trade:bootstrap");
        invalidateCache("auto:status");
        invalidateCache("auto:log");
        await complete({});
        break;
      }
      default:
        return;
    }
  } catch (e) {
    await reject(String(e).slice(0, 200));
  }
}
