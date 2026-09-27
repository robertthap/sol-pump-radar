import type { ColorToken } from "@/lib/radar/layout";

/** Stage colours on the dark terminal ground. Semantic, not decorative: each maps to one kind of stage. */
export const RADAR_COLOR: Record<ColorToken, string> = {
  ingest: "rgb(77 141 255)",
  score: "rgb(168 120 255)",
  pass: "rgb(34 197 94)",
  reject: "rgb(244 84 84)",
  profit: "rgb(245 196 81)",
  trailing: "rgb(45 212 230)",
  skipped: "rgb(245 154 66)",
};

/** Live money gets its own electric lane colour; paper stays the calm pass green. */
export const LIVE_LANE_COLOR = "rgb(125 240 255)";

/** What each stage means in the worker, in the operator's words. */
export const STAGE_HELP: Record<string, string> = {
  ingested: "The ingestor stored this coin's first trade inside the window.",
  scored: "The intelligence lane scored it (confluence score, 0 to 1).",
  "rejected::not_scored": "Seen by the ingestor, but not scored by the intelligence lane in this window.",
  "rejected::avoid": "Scored, but the verdict was AVOID. The scorer's reason is shown per coin.",
  "skipped::already_in": "A BUY signal for a coin the bot already holds.",
  "skipped::max_positions": "Every position slot was in use, so the signal was never checked.",
  "rejected::strictness": "The signal's strength is below the session's strictness setting.",
  "rejected::rug_label": "The coin is labelled rugged.",
  "rejected::no_price": "No price to trade at: no live price yet, or no on-chain price (unsupported pool, or not quoted in SOL).",
  "rejected::curve_band": "Bonding-curve position outside the preset's vSol band.",
  "rejected::bundle_veto": "Bundled launch or mechanical uptrend.",
  "rejected::age_limit": "The coin is older than MAX_ENTRY_AGE_SEC.",
  "rejected::flow": "DEX order flow is dead, dumping, or below the preset's momentum thresholds.",
  "rejected::smart_money": "The session requires smart-money buyers and none qualified.",
  "rejected::activity_floor": "Fewer 5-minute DEX buys than ENTRY_MIN_DEX_BUYS_M5, and no smart money.",
  "rejected::entry_filter": "Refused by the entry filter (wallet, coin and timing confidence).",
  "rejected::mcap_ceiling": "On-chain market cap above MAX_ENTRY_MCAP_USD.",
  "rejected::stale": "The signal was older than MAX_DECISION_AGE_SEC once every check had run.",
  gate_passed: "Passed every entry gate.",
  "skipped::insufficient_balance": "Passed the gates, but the demo balance could not cover the size.",
  "skipped::live_blocked": "Live execution is not allowed right now (profile, confirmation, wallet or RPC).",
  "skipped::micro_sim": "The live pre-trade check rejected slippage or depth.",
  decision_committed: "The bot sent the buy.",
  "skipped::fill_rejected": "The buy was sent but not filled.",
  entry: "Positions opened in the window, or held during it.",
  "entry::paper": "Paper positions opened in the window, or held during it.",
  "entry::live": "Live positions (including dry-run) opened in the window, or held during it.",
  "exit::take_profit": "Closed by the take-profit.",
  "exit::trailing_stop": "Closed by the trailing stop after a gain.",
  "exit::flat_cut": "Closed for going nowhere (stagnation cut).",
  "exit::stop_loss": "Closed by the stop-loss.",
  "exit::max_hold": "Closed at the maximum hold time.",
  "exit::forced_close": "Closed by something other than the exit policy: session end, restart, stale sweep or a manual sell.",
  outcome: "Positions closed in the window.",
};

/** Where a leak happens, from the stage it leaves. */
export const LEAK_WHERE: Record<string, string> = {
  ingested: "Before scoring",
  scored: "At the gates",
  gate_passed: "After the gates",
  decision_committed: "At the fill",
};
