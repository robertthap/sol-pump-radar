import type { CommitBundle, SyncSnapshot, WsMessageType, RegimeSwitchPayload } from "@/lib/chart/types";

export type WsEnvelope = {
  mint: string;
  epoch: number;
  seq: number;
  lastTradeId: string;
  type: WsMessageType;
  payload: CommitBundle | SyncSnapshot | RegimeSwitchPayload | { lastTradeId: string; tf?: string } | null;
};

export function envelope(
  type: WsMessageType,
  bundle: Partial<WsEnvelope> & Pick<WsEnvelope, "mint" | "epoch" | "lastTradeId">,
  payload: WsEnvelope["payload"],
): WsEnvelope {
  return {
    mint: bundle.mint,
    epoch: bundle.epoch,
    seq: bundle.seq ?? 0,
    lastTradeId: bundle.lastTradeId,
    type,
    payload,
  };
}

export function shouldAcceptSeq(
  prev: { epoch: number; seq: number; lastTradeId: string },
  next: { epoch: number; seq: number; lastTradeId: string },
): boolean {
  if (next.epoch < prev.epoch) return false;
  if (next.epoch > prev.epoch) return true;
  if (next.seq <= prev.seq) return false;
  if (BigInt(next.lastTradeId) <= BigInt(prev.lastTradeId)) return false;
  return true;
}

export function hasGap(prevTradeId: string, nextTradeId: string, firstTradeId?: string): boolean {
  if (!prevTradeId || prevTradeId === "0") return false;
  const prev = BigInt(prevTradeId);
  const next = BigInt(nextTradeId);
  if (next <= prev) return false;
  const first = firstTradeId ? BigInt(firstTradeId) : next;
  return first > prev + 1n;
}
