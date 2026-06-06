import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgresql://sol:sol@127.0.0.1:5432/solpump"),
  RPC_HTTP_URLS: z.string().default("https://api.mainnet-beta.solana.com"),
  RPC_WSS_URLS: z.string().default("wss://api.mainnet-beta.solana.com"),
  HELIUS_API_KEY: z.string().optional().default(""),
  DISCORD_WEBHOOK_URL: z.string().optional().default(""),
  TRADER_MODE: z.enum(["paper", "devnet", "live"]).default("paper"),
  RISK_PRESET: z.enum(["conservative", "balanced", "aggressive"]).default("balanced"),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  /** Intelligence-commit tick interval (ms). */
  INTELLIGENCE_TICK_MS: z.coerce.number().int().min(2000).max(30_000).default(3000),
  /** Max active mints in commit universe. */
  INTELLIGENCE_UNIVERSE_MAX: z.coerce.number().int().min(20).max(300).default(150),
  /** Skip re-eval if signal/state/rank unchanged (ms). */
  INTELLIGENCE_SKIP_UNCHANGED_MS: z.coerce.number().int().min(10_000).max(120_000).default(35_000),
  /** Always evaluate top-N by rank each tick. */
  INTELLIGENCE_TOP_RANK: z.coerce.number().int().min(5).max(50).default(20),
  /** Max mints evaluated per intelligence tick (priority queue cap). */
  INTELLIGENCE_MAX_EVAL_PER_TICK: z.coerce.number().int().min(10).max(200).default(60),
  /** Max decision_log rows written per tick (batched insert). */
  INTELLIGENCE_MAX_COMMITS_PER_TICK: z.coerce.number().int().min(1).max(60).default(12),
  /** Commit input bundle cache TTL (ms). */
  INTELLIGENCE_BUNDLE_TTL_MS: z.coerce.number().int().min(3000).max(60_000).default(10_000),
  /** Max HOT_LAUNCH mints evaluated per intelligence tick (separate from continuation hot). */
  INTELLIGENCE_MAX_LAUNCH_HOT_PER_TICK: z.coerce.number().int().min(1).max(20).default(12),
  LAUNCH_HOT_MIN_V_SOL: z.coerce.number().nonnegative().default(2),
  LAUNCH_HOT_MIN_TRADES: z.coerce.number().int().min(0).default(1),
  LAUNCH_HOT_MIN_UNIQUE_WALLETS: z.coerce.number().int().min(2).default(2),
  LAUNCH_HOT_MIN_GATES: z.coerce.number().int().min(1).max(4).default(2),
  LAUNCH_HOT_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.45),
  LAUNCH_HOT_TTL_MS: z.coerce.number().int().min(5000).max(60_000).default(18_000),
  LAUNCH_HOT_LOOKBACK_SEC: z.coerce.number().int().min(5).max(120).default(30),
  LAUNCH_HOT_MAX_MARK_PER_FLUSH: z.coerce.number().int().min(1).max(20).default(8),
  LAUNCH_HOT_PENDING_MAX_MS: z.coerce.number().int().min(10_000).max(120_000).default(60_000),
  WORKERS: z.enum(["on", "off"]).default("on"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Realistic paper trading knobs (single-account engine). */
  PAPER_START_SOL: z.coerce.number().positive().default(10),
  PAPER_SIZE_PER_TRADE_SOL: z.coerce.number().nonnegative().optional(),
  PAPER_ENABLE_SLIPPAGE: z.enum(["on", "off"]).default("on"),
  PAPER_ENABLE_FEES: z.enum(["on", "off"]).default("on"),
  PAPER_ENABLE_LATENCY: z.enum(["on", "off"]).default("on"),
  PAPER_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).max(50).default(3),
  PAPER_MAX_POSITION_SOL: z.coerce.number().positive().default(0.25),
  PAPER_DAILY_LOSS_LIMIT_SOL: z.coerce.number().positive().default(1),
  PAPER_MARK_TO_MARKET_MS: z.coerce.number().int().min(2000).max(60_000).default(10_000),
  AUTO_TUNE: z.enum(["on", "off"]).default("off"),
  /**
   * Runtime profile — gates live execution at startup.
   * - paper_safe: no live tx; quick-buy/sell rejected
   * - dev: devnet only
   * - live: mainnet real money; requires LIVE_EXECUTION=on AND LIVE_CONFIRM token
   */
  RUNTIME_PROFILE: z.enum(["paper_safe", "dev", "live"]).default("paper_safe"),
  LIVE_EXECUTION: z.enum(["on", "off"]).default("off"),
  LIVE_DRY_RUN: z.enum(["on", "off"]).default("on"),
  /** Operator must echo this exact string when RUNTIME_PROFILE=live. */
  LIVE_CONFIRM: z.string().optional().default(""),
  LIVE_MAX_PER_TRADE_SOL: z.coerce.number().nonnegative().default(0.05),
  LIVE_MAX_DAILY_SOL: z.coerce.number().nonnegative().default(5.0),
  LIVE_MAX_DAILY_LOSS_SOL: z.coerce.number().nonnegative().default(0.5),
  LIVE_MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().min(1).max(50).default(3),
  LIVE_SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(500),
  LIVE_PRIORITY_FEE_SOL: z.coerce.number().nonnegative().default(0.0005),
  /** Backpressure: max in-memory ingest buffer before drops are audited. */
  MAX_INGEST_QUEUE: z.coerce.number().int().min(100).max(50_000).default(5000),
  WORKER_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  /**
   * Optional. When set, the worker auto-unlocks the local vault at boot so it
   * can sign live trade intents submitted via the web-write gate. Unset = the
   * worker stays locked and rejects all live intents at the executor.
   * NEVER read or send this value from the web process.
   */
  VAULT_PASSPHRASE: z.string().optional().default(""),
  WALLET_AUTO_LOCK_MINUTES: z.coerce.number().int().positive().default(30),
  /**
   * Web-process wallet session gate.
   * - off (default): /api/wallet/unlock|lock|wipe are disabled
   * - on: legacy web wallet-session endpoints enabled
   *
   * Keep OFF for worker-only live execution architecture.
   */
  WEB_WALLET_SESSION: z.enum(["on", "off"]).default("off"),
  JUPITER_BASE_URL: z.string().default("https://quote-api.jup.ag/v6"),
  PUMPPORTAL_TRADE_URL: z.string().default("https://pumpportal.fun/api/trade-local"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  NOTIFY_MIN_PNL_SOL: z.coerce.number().nonnegative().default(0.05),
  /** Background paper trades on filtered strong signals — feeds the learner. */
  /** Background paper learner — default off; opt-in after P2.1b canonical executor routing. */
  SHADOW_LEARNER: z.enum(["on", "off"]).default("off"),
  SHADOW_LEARN_SIZE_SOL: z.coerce.number().positive().default(0.03),
  /** launch = sniper; profit = continuation; hybrid = both launch analytics + Dex continuation. */
  SIGNAL_MODE: z.enum(["launch", "profit", "hybrid"]).default("hybrid"),
  /**
   * Max REAL (pump/DEX) market cap, in USD, to allow a launch/hybrid auto-entry.
   * The entry gate scores on bonding-curve data, so a coin that already graduated
   * to a multi-$M DEX cap can slip through as a "launch". 0 = disabled (default).
   * Set e.g. 100000 to keep auto-trade to fresh, pre-/early-graduation coins.
   */
  MAX_ENTRY_MCAP_USD: z.coerce.number().min(0).default(0),
  /** Override analytics active-mint window (minutes). Defaults by SIGNAL_MODE. */
  ACTIVE_MINT_WINDOW_MINUTES: z.coerce.number().int().min(5).max(720).optional(),
  /** Looser auto-trader entry gates for paper/demo sessions. */
  AUTO_DEMO_RELAX: z.enum(["on", "off"]).default("on"),
  /** Engine B continuation alerts (default off — enable explicitly). */
  AUTO_CONTINUATION: z.enum(["on", "off"]).default("off"),
  CONTINUATION_MIN_LIQ_USD: z.coerce.number().nonnegative().default(8000),
  /** Engine B score floors (fusion WATCH paths) and h24 exhaustion proxy (probability.ts). */
  CONTINUATION_ALERT_SCORE: z.coerce.number().min(0).max(1).default(0.38),
  CONTINUATION_BUY_SCORE: z.coerce.number().min(0).max(1).default(0.52),
  CONTINUATION_EXHAUSTION_H24: z.coerce.number().nonnegative().default(400),
  CONTINUATION_RANK_EMIT_PCTL: z.coerce.number().min(0).max(1).default(0.7),
  CONTINUATION_P_EXHAUSTION_BLOCK: z.coerce.number().min(0).max(1).default(0.7),
  CONTINUATION_P_BREAKOUT_ALERT: z.coerce.number().min(0).max(1).default(0.65),
  CONTINUATION_P_BREAKOUT_BUY: z.coerce.number().min(0).max(1).default(0.8),
  /** Coarse bundle — explicit env vars always win over preset defaults. */
  RUNTIME_PRESET: z
    .enum(["paper_safe", "paper_aggressive", "live_safe", "live_aggressive"])
    .optional(),
  CONFIG_STRICT_MODE: z.enum(["on", "off"]).default("off"),
  LEGACY_TRADER: z.enum(["on", "off"]).default("off"),
  RUNTIME_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** Chart WebSocket server port (worker process). */
  CHART_WS_PORT: z.coerce.number().int().min(1024).max(65535).default(8788),
  /** Browser chart WS URL (defaults to localhost worker). */
  NEXT_PUBLIC_CHART_WS_URL: z.string().default("ws://127.0.0.1:8788/chart"),
});

type Env = z.infer<typeof EnvSchema>;

const PRESET_BUNDLES: Record<string, Record<string, string>> = {
  paper_safe: {
    RUNTIME_PROFILE: "paper_safe",
    LIVE_EXECUTION: "off",
    LIVE_DRY_RUN: "on",
    TRADER_MODE: "paper",
    RISK_PRESET: "conservative",
  },
  paper_aggressive: {
    RUNTIME_PROFILE: "paper_safe",
    LIVE_EXECUTION: "off",
    TRADER_MODE: "paper",
    RISK_PRESET: "aggressive",
    PAPER_MAX_POSITION_SOL: "0.4",
  },
  live_safe: {
    RUNTIME_PROFILE: "live",
    LIVE_EXECUTION: "on",
    LIVE_DRY_RUN: "on",
    RISK_PRESET: "conservative",
    LIVE_MAX_PER_TRADE_SOL: "0.25",
    LIVE_MAX_DAILY_SOL: "2",
  },
  live_aggressive: {
    RUNTIME_PROFILE: "live",
    LIVE_EXECUTION: "on",
    RISK_PRESET: "aggressive",
    LIVE_MAX_PER_TRADE_SOL: "1",
    LIVE_MAX_DAILY_SOL: "8",
  },
};

let cached: Env | null = null;
let presetKeysLogged = false;

function buildMergedEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  const presetName = merged.RUNTIME_PRESET;
  if (presetName && PRESET_BUNDLES[presetName]) {
    for (const [k, v] of Object.entries(PRESET_BUNDLES[presetName])) {
      if (merged[k] === undefined || merged[k] === "") merged[k] = v;
    }
  }
  return merged;
}

export function logRuntimePresetKeys(): void {
  if (presetKeysLogged) return;
  presetKeysLogged = true;
  const preset = process.env.RUNTIME_PRESET;
  if (!preset || !PRESET_BUNDLES[preset]) return;
  const applied = Object.keys(PRESET_BUNDLES[preset]).filter(
    (k) => process.env[k] === undefined || process.env[k] === "",
  );
  if (applied.length > 0) {
    console.log(`[env] RUNTIME_PRESET=${preset} filled defaults: ${applied.join(", ")}`);
  }
}

/** Log effective live per-trade cap when live execution is enabled (Option B: presets unchanged). */
export function logLiveMaxPerTradeAtBoot(): void {
  const e = env();
  if (e.LIVE_EXECUTION !== "on") return;

  const envExplicit =
    process.env.LIVE_MAX_PER_TRADE_SOL !== undefined && process.env.LIVE_MAX_PER_TRADE_SOL !== "";
  const preset = process.env.RUNTIME_PRESET;
  let source: string;
  if (envExplicit) {
    source = ".env";
  } else if (preset && PRESET_BUNDLES[preset]?.LIVE_MAX_PER_TRADE_SOL) {
    source = `preset: ${preset}`;
  } else {
    source = "default";
  }

  console.log(
    `[LIVE] Effective LIVE_MAX_PER_TRADE_SOL: ${e.LIVE_MAX_PER_TRADE_SOL} SOL  ← ${source}`,
  );
}

const APP_ENV_PREFIXES = [
  "DATABASE_",
  "RPC_",
  "HELIUS_",
  "DISCORD_",
  "TRADER_",
  "RISK_",
  "VAULT_",
  "EVENT_",
  "INTELLIGENCE_",
  "LAUNCH_",
  "WORKER",
  "WORKERS",
  "LOG_",
  "PAPER_",
  "AUTO_",
  "RUNTIME_",
  "LIVE_",
  "MAX_",
  "CONFIG_",
  "LEGACY_",
  "WEB_",
  "PUMPPORTAL_",
  "TELEGRAM_",
  "NOTIFY_",
  "SHADOW_",
  "SIGNAL_",
  "ACTIVE_",
  "CONTINUATION_",
];

/** Removed from schema — ignore if still present in .env.local. */
const REMOVED_ENV_KEYS = new Set([
  "VAULT_PATH",
  "SHYFT_API_KEY",
  "JUPITER_API_KEY",
  "SETTINGS_SNAPSHOT",
  "PAPER_MANUAL_CLOSE",
]);

function pickSchemaInput(merged: Record<string, string | undefined>): Record<string, string | undefined> {
  const known = new Set(Object.keys(EnvSchema.shape));
  const out: Record<string, string | undefined> = {};
  for (const key of known) {
    if (merged[key] !== undefined) out[key] = merged[key];
  }
  return out;
}

function warnUnknownEnvKeys(merged: Record<string, string | undefined>, parsed: Env): void {
  const known = new Set(Object.keys(EnvSchema.shape));
  const strict = merged.CONFIG_STRICT_MODE === "on" && parsed.RUNTIME_PROFILE === "live";
  const unknown: string[] = [];
  for (const key of Object.keys(merged)) {
    if (known.has(key)) continue;
    if (REMOVED_ENV_KEYS.has(key)) continue;
    if (!APP_ENV_PREFIXES.some((p) => key.startsWith(p))) continue;
    unknown.push(key);
  }
  if (unknown.length === 0) return;
  const msg = `Unknown env keys: ${unknown.join(", ")}`;
  if (strict) throw new Error(msg);
  console.warn(`[env] ${msg}`);
}

export function env() {
  if (cached) return cached;
  const merged = buildMergedEnv();
  const input = pickSchemaInput(merged);
  const useStrict = merged.CONFIG_STRICT_MODE === "on" && merged.RUNTIME_PROFILE === "live";
  const schema = useStrict ? EnvSchema.strict() : EnvSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  cached = parsed.data;
  warnUnknownEnvKeys(merged, cached);
  // Cross-field safety: if live execution can fire real money, demand the
  // explicit confirmation token. Crash at first env() call so it cannot be
  // silently misconfigured at runtime.
  if (cached.LIVE_EXECUTION === "on" && cached.LIVE_DRY_RUN !== "on") {
    if (cached.RUNTIME_PROFILE !== "live") {
      throw new Error(
        "LIVE_EXECUTION=on with LIVE_DRY_RUN=off requires RUNTIME_PROFILE=live. " +
          "Current RUNTIME_PROFILE=" +
          cached.RUNTIME_PROFILE,
      );
    }
    if (cached.LIVE_CONFIRM !== "I_UNDERSTAND_REAL_MONEY") {
      throw new Error(
        "LIVE_EXECUTION=on requires LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY. " +
          "Set it explicitly in .env.local to acknowledge real-money exposure.",
      );
    }
  }
  if (cached.TRADER_MODE === "live" && cached.RUNTIME_PROFILE === "paper_safe") {
    console.warn(
      "[env] TRADER_MODE=live but RUNTIME_PROFILE=paper_safe — live intents will be blocked at runtime gates",
    );
  }
  if (cached.RUNTIME_PROFILE === "dev") {
    const rpcUrls = `${cached.RPC_HTTP_URLS},${cached.RPC_WSS_URLS}`.toLowerCase();
    if (rpcUrls.includes("mainnet")) {
      console.warn(
        "[env] RUNTIME_PROFILE=dev but RPC URLs include mainnet — verify endpoints point at devnet",
      );
    }
  }
  return cached;
}

export function isLiveAllowed(): boolean {
  const e = env();
  return (
    e.RUNTIME_PROFILE === "live" &&
    e.LIVE_EXECUTION === "on" &&
    e.LIVE_CONFIRM === "I_UNDERSTAND_REAL_MONEY"
  );
}

/** TODO: wire to DEVNET=on env gate in live executor, or remove if devnet unsupported. */
export function isDevnetAllowed(): boolean {
  const e = env();
  return e.RUNTIME_PROFILE === "dev" || e.RUNTIME_PROFILE === "live";
}

/** Helius free-tier key → primary low-latency endpoints (public RPC stays fallback). L1.1. */
function heliusKey(): string {
  return (env().HELIUS_API_KEY ?? "").trim();
}

export function rpcHttpUrls() {
  const configured = env()
    .RPC_HTTP_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const key = heliusKey();
  if (!key) return configured;
  const helius = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return [helius, ...configured.filter((u) => !u.includes("helius-rpc.com"))];
}

export function rpcWssUrls() {
  const configured = env()
    .RPC_WSS_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const key = heliusKey();
  if (key) {
    const helius = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
    return [helius, ...configured.filter((u) => !u.includes("helius-rpc.com"))];
  }
  return configured;
}

export type SignalMode = "launch" | "profit" | "hybrid";

/**
 * Runtime override for SIGNAL_MODE so the strategy can be switched from the UI
 * without editing .env or restarting. Process-local (null → use the env default);
 * persisted in `user_settings` and loaded into each process — the worker refreshes
 * it on a timer (orchestrator) and the web API sets it on change. All the
 * mode helpers below read it via getEffectiveSignalMode(), so one toggle flows
 * through the gate, entry filter, learner, and engines.
 */
let signalModeOverride: SignalMode | null = null;

export function setSignalModeOverride(mode: SignalMode | null): void {
  signalModeOverride = mode;
}

export function getEffectiveSignalMode(): SignalMode {
  return signalModeOverride ?? (env().SIGNAL_MODE as SignalMode);
}

export function activeMintWindowMinutes(): number {
  const e = env();
  if (e.ACTIVE_MINT_WINDOW_MINUTES != null) return e.ACTIVE_MINT_WINDOW_MINUTES;
  const m = getEffectiveSignalMode();
  if (m === "launch") return 15;
  if (m === "hybrid") return 180;
  return 240;
}

export function isProfitSignalMode(): boolean {
  const m = getEffectiveSignalMode();
  return m === "profit" || m === "hybrid";
}

export function isHybridSignalMode(): boolean {
  return getEffectiveSignalMode() === "hybrid";
}

/** launch + hybrid modes allow the fresh-launch (newborn) entry tier. */
export function allowsLaunchTier(): boolean {
  const m = getEffectiveSignalMode();
  return m === "launch" || m === "hybrid";
}

export function intelEnv() {
  const e = env();
  return {
    tickMs: e.INTELLIGENCE_TICK_MS,
    universeMax: e.INTELLIGENCE_UNIVERSE_MAX,
    skipUnchangedMs: e.INTELLIGENCE_SKIP_UNCHANGED_MS,
    topRankAlways: e.INTELLIGENCE_TOP_RANK,
    maxEvaluatePerTick: e.INTELLIGENCE_MAX_EVAL_PER_TICK,
    maxCommitsPerTick: e.INTELLIGENCE_MAX_COMMITS_PER_TICK,
    bundleTtlMs: e.INTELLIGENCE_BUNDLE_TTL_MS,
    maxLaunchHotPerTick: e.INTELLIGENCE_MAX_LAUNCH_HOT_PER_TICK,
  };
}

export function launchHotEnv() {
  const e = env();
  return {
    minVSol: e.LAUNCH_HOT_MIN_V_SOL,
    minTrades: e.LAUNCH_HOT_MIN_TRADES,
    minUniqueWallets: e.LAUNCH_HOT_MIN_UNIQUE_WALLETS,
    minGates: e.LAUNCH_HOT_MIN_GATES,
    minHotScore: e.LAUNCH_HOT_MIN_SCORE,
    ttlMs: e.LAUNCH_HOT_TTL_MS,
    lookbackSec: e.LAUNCH_HOT_LOOKBACK_SEC,
    maxMarkPerFlush: e.LAUNCH_HOT_MAX_MARK_PER_FLUSH,
    pendingMaxMs: e.LAUNCH_HOT_PENDING_MAX_MS,
  };
}

/** Engine B fusion / probability thresholds — consumed in lib/continuation/*. */
export function envContinuation() {
  const e = env();
  return {
    minLiqUsd: e.CONTINUATION_MIN_LIQ_USD,
    alertScore: e.CONTINUATION_ALERT_SCORE,
    buyScore: e.CONTINUATION_BUY_SCORE,
    exhaustionH24: e.CONTINUATION_EXHAUSTION_H24,
    rankEmitPctl: e.CONTINUATION_RANK_EMIT_PCTL,
    exhaustionBlock: e.CONTINUATION_P_EXHAUSTION_BLOCK,
    breakoutAlert: e.CONTINUATION_P_BREAKOUT_ALERT,
    breakoutBuy: e.CONTINUATION_P_BREAKOUT_BUY,
    rankBuyMin: e.CONTINUATION_RANK_EMIT_PCTL,
  };
}

export function autoContinuationEnabled(): boolean {
  return env().AUTO_CONTINUATION === "on";
}

export function autoDemoRelaxEnabled(): boolean {
  return env().AUTO_DEMO_RELAX !== "off";
}
