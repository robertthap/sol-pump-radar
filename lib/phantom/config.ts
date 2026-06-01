/** Client-safe Phantom Connect settings (NEXT_PUBLIC_* only). */

export function phantomConnectEnabled(): boolean {
  const id = process.env.NEXT_PUBLIC_PHANTOM_APP_ID?.trim();
  return Boolean(id);
}

export function phantomAppId(): string {
  return process.env.NEXT_PUBLIC_PHANTOM_APP_ID?.trim() ?? "";
}

/** When set to `1`, show encrypted local vault alongside Phantom Connect in Real mode. */
export function localVaultFallbackEnabled(): boolean {
  return process.env.NEXT_PUBLIC_USE_LOCAL_VAULT === "1";
}
