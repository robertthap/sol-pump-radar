import type { CommitBundle, RegimeSwitchPayload, StreamStateRow } from "@/lib/chart/types";
import type { RawTradeInput } from "@/lib/chart/data/priceResolver";
import { commitTrade } from "@/lib/chart/data/priceResolver";
import { MultiTfAggregator } from "@/lib/chart/data/candleBuilder";
import { COMMIT_BATCH_MS } from "@/lib/chart/constants";

const MAX_STAGED_PER_MINT = 200;

type StagedMint = {
  raw: RawTradeInput[];
  timer: ReturnType<typeof setTimeout> | null;
};

export type CommitSink = (bundle: CommitBundle) => void;

export class CommitPipeline {
  private readonly staged = new Map<string, StagedMint>();
  private readonly aggregators = new Map<string, MultiTfAggregator>();
  private readonly streamState = new Map<string, StreamStateRow>();
  private readonly dexQuotes = new Map<string, import("@/lib/chart/types").DexQuoteRow[]>();

  constructor(
    private readonly sink: CommitSink,
    private readonly batchMs = COMMIT_BATCH_MS,
  ) {}

  setStreamState(mint: string, state: StreamStateRow): void {
    this.streamState.set(mint, state);
  }

  getStreamState(mint: string): StreamStateRow {
    return (
      this.streamState.get(mint) ?? {
        mint,
        epoch: 1,
        lastTradeId: 0n,
        lastSeq: 0,
        graduationAt: null,
        regime: "bonding_curve",
      }
    );
  }

  setDexQuotes(mint: string, quotes: import("@/lib/chart/types").DexQuoteRow[]): void {
    this.dexQuotes.set(mint, quotes);
  }

  getAggregator(mint: string): MultiTfAggregator {
    let agg = this.aggregators.get(mint);
    if (!agg) {
      agg = new MultiTfAggregator();
      this.aggregators.set(mint, agg);
    }
    return agg;
  }

  stage(mint: string, raw: RawTradeInput): void {
    let s = this.staged.get(mint);
    if (!s) {
      s = { raw: [], timer: null };
      this.staged.set(mint, s);
    }
    s.raw.push(raw);
    if (s.raw.length >= MAX_STAGED_PER_MINT) {
      this.flush(mint);
      return;
    }
    if (s.timer) return;
    s.timer = setTimeout(() => this.flush(mint), this.batchMs);
  }

  flush(mint: string): void {
    const s = this.staged.get(mint);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (!s.raw.length) return;

    const batch = s.raw.splice(0).sort((a, b) => {
      const ai = BigInt(a.tradeId);
      const bi = BigInt(b.tradeId);
      if (ai < bi) return -1;
      if (ai > bi) return 1;
      return a.timestamp - b.timestamp;
    });

    const quotes = this.dexQuotes.get(mint) ?? [];
    const agg = this.getAggregator(mint);
    const stream = { ...this.getStreamState(mint) };
    const committed: import("@/lib/chart/types").CommittedTrade[] = [];
    let regimeSwitch: RegimeSwitchPayload | undefined;

    for (const r of batch) {
      const t = commitTrade(r, stream, quotes);
      committed.push(t);
      if (t.regime === "dex" && stream.regime === "bonding_curve") {
        stream.regime = "dex";
        stream.graduationAt = stream.graduationAt ?? new Date(t.timestamp);
        regimeSwitch = {
          mint,
          from: "bonding_curve",
          to: "dex",
          atTradeId: t.tradeId,
          effectivePrice: t.price,
          graduationAt: stream.graduationAt.getTime(),
        };
      }
    }

    const candlePatches = agg.applyBatch(committed);
    const last = committed[committed.length - 1]!;
    stream.lastTradeId = BigInt(last.tradeId);
    stream.lastSeq += committed.length;
    this.streamState.set(mint, stream);

    const bundle: CommitBundle = {
      mint,
      epoch: stream.epoch,
      seq: stream.lastSeq,
      lastTradeId: last.tradeId,
      trades: committed,
      candlePatches,
      marketCap: last.marketCap,
      regime: stream.regime,
      regimeSwitch,
    };
    this.sink(bundle);
  }

  flushAll(): void {
    for (const mint of this.staged.keys()) this.flush(mint);
  }

  /** Reserve monotonic seq for reconcile / patch envelopes. */
  advanceSeq(mint: string, by = 1): StreamStateRow {
    const st = { ...this.getStreamState(mint) };
    st.lastSeq += by;
    this.streamState.set(mint, st);
    return st;
  }
}
