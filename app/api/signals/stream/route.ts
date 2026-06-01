import { bootDb } from "@/lib/db/client";
import { fetchSignalFeed } from "@/lib/db/repos/decisions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

function sseLine(data: unknown, event?: string): Uint8Array {
  const lines = event ? `event: ${event}\n` : "";
  return encoder.encode(`${lines}data: ${JSON.stringify(data)}\n\n`);
}

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const intelligenceOnly = url.searchParams.get("intelligenceOnly") === "1";
  const autoGateOnly = url.searchParams.get("autoGateOnly") === "1";

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const abort = () => {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", abort);

      const push = async () => {
        if (closed) return;
        try {
          const signals = await fetchSignalFeed({
            hours: 6,
            limit: 80,
            intelligenceOnly,
            autoGateOnly,
            sortBy: "time",
            smartMoneyCap: 40,
          });
          controller.enqueue(
            sseLine({
              ts: Date.now(),
              signals,
              summary: {
                total: signals.length,
                autoEligible: signals.filter((s) => s.autoTradeAllowed).length,
              },
            }),
          );
        } catch (e) {
          controller.enqueue(sseLine({ error: String(e) }, "error"));
        }
      };

      await push();
      const id = setInterval(() => void push(), 5_000);
      req.signal.addEventListener("abort", () => clearInterval(id));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
