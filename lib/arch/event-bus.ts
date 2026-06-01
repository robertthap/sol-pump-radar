/**
 * Lightweight in-process event bus (no Redis/Kafka).
 * Coordinates cache invalidation and worker wake hints.
 */

export type SprBusEvent =
  | { type: "universe:refreshed"; at: number; candidates: number }
  | { type: "intel:committed"; at: number; mint: string; signal: string }
  | { type: "ingest:flush"; at: number; creates: number }
  | { type: "events:detected"; at: number; mint: string; kind: string };

type Handler = (ev: SprBusEvent) => void;

const handlers = new Set<Handler>();
let last: SprBusEvent | null = null;

export function emitBusEvent(ev: SprBusEvent): void {
  last = ev;
  for (const h of handlers) {
    try {
      h(ev);
    } catch {
      /* isolate handler failures */
    }
  }
}

export function onBusEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function lastBusEvent(): SprBusEvent | null {
  return last;
}
