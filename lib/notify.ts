import "server-only";
import { desc } from "drizzle-orm";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import { notifications } from "@/lib/db/schema";

const log = logger("notify");

export type NotifyKind =
  | "auto_started"
  | "auto_stopped"
  | "auto_error"
  | "trade_open"
  | "trade_skip"
  | "trade_win"
  | "trade_loss"
  | "daily_loss_cap"
  | "wallet_locked"
  | "circuit_halted"
  | "circuit_resumed"
  | "system";

export type NotifyOpts = {
  kind: NotifyKind;
  title: string;
  body?: string;
  mint?: string;
  pnlSol?: number;
  severity?: "info" | "warn" | "error" | "win" | "loss";
  extra?: Record<string, unknown>;
};

const recent = new Map<string, number>();
const DEDUPE_MS = 30_000;

export async function notify(opts: NotifyOpts): Promise<void> {
  const e = env();
  const sev: NonNullable<NotifyOpts["severity"]> = opts.severity ??
    (opts.kind === "trade_win" ? "win" :
     opts.kind === "trade_loss" ? "loss" :
     opts.kind === "auto_error" || opts.kind === "daily_loss_cap" || opts.kind === "circuit_halted" ? "error" :
     opts.kind === "wallet_locked" ? "warn" : "info");

  // Tiny payload-based dedupe (per kind+mint+title) so loops don't spam.
  const key = `${opts.kind}|${opts.mint ?? ""}|${opts.title}`;
  const now = Date.now();
  const last = recent.get(key) ?? 0;
  if (now - last < DEDUPE_MS) return;
  recent.set(key, now);

  // PnL filter: skip "trade_win" / "trade_loss" below threshold.
  if ((opts.kind === "trade_win" || opts.kind === "trade_loss") && opts.pnlSol != null) {
    if (Math.abs(opts.pnlSol) < e.NOTIFY_MIN_PNL_SOL) return;
  }

  // Persist to DB so the UI's notifications panel can show recent alerts.
  try {
    await getDb().insert(notifications).values({
      kind: opts.kind,
      title: opts.title.slice(0, 200),
      body: opts.body?.slice(0, 1000) ?? null,
      mint: opts.mint ?? null,
      severity: sev,
      extra: { pnlSol: opts.pnlSol, ...(opts.extra ?? {}) },
    });
  } catch (err) {
    log.warn("persist notification failed", { err: String(err) });
  }

  // Log to stdout — also visible in `pnpm dev` output.
  const line = `[${sev}] ${opts.title}${opts.body ? ` — ${opts.body}` : ""}`;
  if (sev === "error") log.error(line, { mint: opts.mint });
  else if (sev === "warn") log.warn(line, { mint: opts.mint });
  else log.info(line, { mint: opts.mint });

  // Telegram (optional).
  if (e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID) {
    void sendTelegram(e.TELEGRAM_BOT_TOKEN, e.TELEGRAM_CHAT_ID, opts).catch((err) =>
      log.warn("telegram failed", { err: String(err) }),
    );
  }

  // Discord (re-uses existing optional webhook).
  if (e.DISCORD_WEBHOOK_URL) {
    void sendDiscord(e.DISCORD_WEBHOOK_URL, opts).catch((err) =>
      log.warn("discord failed", { err: String(err) }),
    );
  }
}

async function sendTelegram(botToken: string, chatId: string, opts: NotifyOpts) {
  const emoji =
    opts.severity === "win" ? "🟢" :
    opts.severity === "loss" ? "🔴" :
    opts.severity === "error" ? "❌" :
    opts.severity === "warn" ? "⚠️" : "ℹ️";
  const lines: string[] = [];
  lines.push(`${emoji} <b>${escapeHtml(opts.title)}</b>`);
  if (opts.body) lines.push(escapeHtml(opts.body));
  if (opts.mint) lines.push(`<code>${escapeHtml(opts.mint)}</code>`);
  if (opts.pnlSol != null) lines.push(`PnL: ${opts.pnlSol >= 0 ? "+" : ""}${opts.pnlSol.toFixed(4)} SOL`);
  const text = lines.join("\n");

  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`telegram ${r.status}: ${t.slice(0, 200)}`);
  }
}

async function sendDiscord(webhook: string, opts: NotifyOpts) {
  const color =
    opts.severity === "win" ? 0x16a34a :
    opts.severity === "loss" ? 0xdc2626 :
    opts.severity === "error" ? 0x991b1b :
    opts.severity === "warn" ? 0xf59e0b : 0x3b82f6;
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (opts.mint) fields.push({ name: "mint", value: `\`${opts.mint}\``, inline: true });
  if (opts.pnlSol != null) fields.push({ name: "pnl", value: `${opts.pnlSol.toFixed(4)} SOL`, inline: true });
  await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: opts.title,
          description: opts.body ?? "",
          color,
          fields,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export async function fetchRecentNotifications(limit = 50) {
  return await getDb().select().from(notifications).orderBy(desc(notifications.ts)).limit(limit);
}
