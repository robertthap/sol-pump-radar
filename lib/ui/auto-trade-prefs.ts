const LS_DAILY_CAP = "spr_auto_daily_loss_cap_enabled";
const LS_DAILY_SOL = "spr_auto_daily_loss_cap_sol";

export function loadAutoDailyLossCapEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LS_DAILY_CAP) === "1";
}

export function saveAutoDailyLossCapEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_DAILY_CAP, enabled ? "1" : "0");
}

export function loadAutoDailyLossCapSol(): number {
  if (typeof window === "undefined") return 0.3;
  const raw = localStorage.getItem(LS_DAILY_SOL);
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= 1000) return n;
  return 0.3;
}

export function saveAutoDailyLossCapSol(sol: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_DAILY_SOL, String(sol));
}
