import { anchorEventDiscriminator } from "@/lib/rpc/anchor";

export const PUMP_BONDING_CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/**
 * PumpSwap AMM — where pump.fun coins trade after graduation (T1.2). Discovered
 * + validated against on-chain ground truth; see lib/pump/__fixtures__/PUMPSWAP_LAYOUT.md.
 */
export const PUMP_SWAP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const PUMP_TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;

export const EVENT_DISCRIMINATORS = {
  trade: anchorEventDiscriminator("TradeEvent"),
  create: anchorEventDiscriminator("CreateEvent"),
  complete: anchorEventDiscriminator("CompleteEvent"),
};

/** PumpSwap swap event discriminators (Anchor `event:` namespace). */
export const PUMP_SWAP_DISCRIMINATORS = {
  buy: anchorEventDiscriminator("BuyEvent"),
  sell: anchorEventDiscriminator("SellEvent"),
};
