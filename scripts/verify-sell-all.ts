/**
 * Integration smoke for sell-all API + sellable positions query.
 * Run: pnpm exec tsx --tsconfig tsconfig.cli.json --import ./scripts/preload-cli.ts scripts/verify-sell-all.ts
 */
import { bootDb } from "@/lib/db/client";
import { fetchSellableOpenPaperPositions } from "@/lib/paper/sellable-positions";
import { POST as sellAllPost } from "@/app/api/trade/sell-all/route";
import { GET as autoPositionsGet } from "@/app/api/auto/positions/route";

async function main() {
  await bootDb();

  const sellable = await fetchSellableOpenPaperPositions({ sessionId: null });
  console.log("[verify] sellable open paper positions:", sellable.length);

  const autoRes = await autoPositionsGet(new Request("http://127.0.0.1/api/auto/positions?limit=10"));
  const autoJson = (await autoRes.json()) as {
    sessionId: string | null;
    open: unknown[];
    closed: unknown[];
  };
  console.log(
    "[verify] auto/positions:",
    autoRes.status,
    "open=",
    autoJson.open?.length ?? 0,
    "closed=",
    autoJson.closed?.length ?? 0,
  );

  const sellAllRes = await sellAllPost(
    new Request("http://127.0.0.1/api/trade/sell-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    }),
  );
  const sellAllJson = await sellAllRes.json();
  console.log("[verify] sell-all (scope=all):", sellAllRes.status, sellAllJson);

  if (sellable.length === 0 && sellAllRes.status === 200 && sellAllJson.message === "no_open_positions") {
    console.log("[verify] PASS — empty holdings returns no_open_positions");
  } else if (sellAllRes.status === 202 && sellAllJson.correlationId) {
    console.log("[verify] PASS — sell-all queued", sellAllJson.correlationId);
    console.log("[verify] NOTE: restart worker if not running to process the queue");
  } else if (sellAllRes.status >= 400) {
    console.error("[verify] FAIL — unexpected error response");
    process.exit(1);
  } else {
    console.log("[verify] PASS — API responded OK");
  }
}

main().catch((e) => {
  console.error("[verify] FAIL", e);
  process.exit(1);
});
