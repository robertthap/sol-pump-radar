import "server-only";
import { fetchDemoAccount, getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { env } from "@/lib/env";
import { getStatus } from "@/lib/wallet/session";

export async function fetchModeLiteSnapshot() {
  const mode = await getUiTradingMode();
  const demo = await fetchDemoAccount();
  const wallet = await getStatus();
  const e = env();
  return {
    mode,
    needsSelection: mode == null,
    demo,
    real: {
      walletUnlocked: wallet.isUnlocked,
      hasWallet: wallet.hasWallet,
      liveExecution: e.LIVE_EXECUTION,
      liveDryRun: e.LIVE_DRY_RUN,
    },
    shadowLearner: {
      enabled: e.SHADOW_LEARNER === "on",
      sizeSol: e.SHADOW_LEARN_SIZE_SOL,
    },
  };
}
