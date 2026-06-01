import "server-only";
import { fetchTokenAnalysis } from "@/lib/api/token-analysis";
import { fetchTokenChart, fetchTokenTxs } from "@/lib/api/token-bundle-data";
import { fetchSignalFeed } from "@/lib/db/repos/decisions";
import { cached } from "@/lib/api/short-cache";

export async function fetchTokenBundle(mint: string, hours: number) {
  return cached(`bundle:${mint}:${hours}`, 5_000, async () => {
    const [analysis, chart, txs, signals] = await Promise.all([
      fetchTokenAnalysis(mint),
      fetchTokenChart(mint, hours),
      fetchTokenTxs(mint, 40),
      fetchSignalFeed({ mint, hours: 24, limit: 20, smartMoneyCap: 20 }),
    ]);
    return { analysis, chart, txs, signals, hours };
  });
}

/** Terminal compact chart — skips txs + per-mint signal list (loaded separately). */
export async function fetchTokenBundleLite(mint: string, hours: number) {
  const h = Math.min(hours, 3);
  return cached(`bundle:lite:${mint}:${h}`, 6_000, async () => {
    const [analysis, chart] = await Promise.all([
      fetchTokenAnalysis(mint, { skipPump: true, skipInsider: true }),
      fetchTokenChart(mint, h),
    ]);
    return { analysis, chart, txs: [], signals: [], hours: h };
  });
}
