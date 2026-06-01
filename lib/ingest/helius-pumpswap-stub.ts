import "server-only";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";

const log = logger("helius-pumpswap-stub");

/** Env-gated stub — logs only until Helius ingest is expanded. */
export function heliusPumpswapStubEnabled(): boolean {
  return Boolean(env().HELIUS_API_KEY?.trim());
}

export function logHeliusPumpswapStub(mint: string, note: string) {
  if (!heliusPumpswapStubEnabled()) return;
  log.debug("helius pumpswap stub", { mint: mint.slice(0, 12), note });
}
