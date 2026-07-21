import { PUMP_SUPPLY } from "@/lib/chart/constants";

/** marketCap = price * circulatingSupply (playbook §2). */
export function marketCapFromPrice(price: number, supply = PUMP_SUPPLY): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return price * supply;
}

export function unitPriceFromMcap(mcap: number, supply = PUMP_SUPPLY): number {
  if (!Number.isFinite(mcap) || mcap <= 0 || supply <= 0) return 0;
  return mcap / supply;
}
