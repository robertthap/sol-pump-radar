import { anchorEventDiscriminator } from "@/lib/rpc/anchor";

export const PUMP_BONDING_CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const PUMP_TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;

export const EVENT_DISCRIMINATORS = {
  trade: anchorEventDiscriminator("TradeEvent"),
  create: anchorEventDiscriminator("CreateEvent"),
  complete: anchorEventDiscriminator("CompleteEvent"),
};
