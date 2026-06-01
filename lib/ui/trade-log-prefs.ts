const LS_VISIBLE = "spr_live_trade_log_visible";

export function loadLiveTradeLogVisible(): boolean {
  if (typeof window === "undefined") return true;
  const raw = localStorage.getItem(LS_VISIBLE);
  if (raw === "0" || raw === "false") return false;
  return true;
}

export function saveLiveTradeLogVisible(visible: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_VISIBLE, visible ? "1" : "0");
}
