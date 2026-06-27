export type ChartTimeframe = "1s" | "5s" | "15s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1D";

export type PriceRegime = "bonding_curve" | "dex";

export type CandleState = "open" | "soft" | "final";

export type Trade = {
  token: string;
  wallet: string;
  side: "buy" | "sell";
  price: number;
  amount: number;
  timestamp: number;
  txHash: string;
  tradeId: string;
};

export type CommittedTrade = Trade & {
  regime: PriceRegime;
  marketCap: number;
  committedAt: number;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  state: CandleState;
};

export type UserTrade = {
  wallet: string;
  token: string;
  side: "buy" | "sell";
  price: number;
  amount: number;
  timestamp: number;
  txHash: string;
  positionId: string;
  tradeId?: string;
};

export type CandlePatchKind = "update" | "correction" | "finalize";

export type CandlePatch = {
  tf: ChartTimeframe;
  bucketTime: number;
  candle: Candle;
  kind: CandlePatchKind;
};

export type RegimeSwitchPayload = {
  mint: string;
  from: PriceRegime;
  to: PriceRegime;
  atTradeId: string;
  effectivePrice: number;
  graduationAt: number;
};

export type CommitBundle = {
  mint: string;
  epoch: number;
  seq: number;
  lastTradeId: string;
  trades: CommittedTrade[];
  candlePatches: CandlePatch[];
  marketCap: number;
  regime: PriceRegime;
  regimeSwitch?: RegimeSwitchPayload;
};

export type ChartSeq = {
  mint: string;
  epoch: number;
  seq: number;
  lastTradeId: string;
};

export type ChartMarkerInstance = {
  id: string;
  tradeId: string;
  bucketTime: number;
  anchorTime: number;
  side: "buy" | "sell";
  price: number;
  amount: number;
  lane: number;
  pnl?: number;
};

export type WsMessageType =
  | "COMMIT_BUNDLE"
  | "SYNC_SNAPSHOT"
  | "RECONCILE_PATCH"
  | "REGIME_SWITCH"
  | "CLIENT_HELLO"
  | "CLIENT_ACK"
  | "RESYNC_REQUEST";

export type SyncSnapshot = {
  mint: string;
  tf: ChartTimeframe;
  epoch: number;
  lastTradeId: string;
  candles: Candle[];
  marketCap: number;
  regime: PriceRegime;
  graduationAt: number | null;
};

export type StreamStateRow = {
  mint: string;
  epoch: number;
  lastTradeId: bigint;
  lastSeq: number;
  graduationAt: Date | null;
  regime: PriceRegime;
};

export type DexQuoteRow = {
  mint: string;
  ts: Date;
  priceUsd: number;
  mcapUsd: number | null;
  source: string;
};
