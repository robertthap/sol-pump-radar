const LS_KEY = "spr_trade_size_presets";
export const DEFAULT_TRADE_SIZE_PRESETS = [0.03, 0.05, 0.1, 0.25] as const;

export function normalizeTradeSizePresets(nums: number[]): number[] | null {
  const cleaned = nums.map((n) => Math.round(n * 10000) / 10000);
  const unique = [...new Set(cleaned)].sort((a, b) => a - b);
  if (unique.length !== 4 || unique.some((n) => !Number.isFinite(n) || n <= 0 || n > 5)) {
    return null;
  }
  return unique;
}

export function loadTradeSizePresets(): number[] {
  if (typeof window === "undefined") return [...DEFAULT_TRADE_SIZE_PRESETS];
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [...DEFAULT_TRADE_SIZE_PRESETS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return [...DEFAULT_TRADE_SIZE_PRESETS];
    const nums = parsed.map((v) => Number(v));
    const normalized = normalizeTradeSizePresets(nums);
    if (!normalized) return [...DEFAULT_TRADE_SIZE_PRESETS];
    return normalized;
  } catch {
    return [...DEFAULT_TRADE_SIZE_PRESETS];
  }
}

export function saveTradeSizePresets(presets: number[]): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeTradeSizePresets(presets);
  if (!normalized) return;
  localStorage.setItem(LS_KEY, JSON.stringify(normalized));
}

export function loadSelectedTradeSize(presets: number[]): number {
  if (typeof window === "undefined") return presets[1] ?? 0.05;
  const raw = localStorage.getItem("spr_trade_size_selected");
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && presets.includes(n)) return n;
  return presets[1] ?? presets[0] ?? 0.05;
}

export function saveSelectedTradeSize(size: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem("spr_trade_size_selected", String(size));
}

export function fmtTradeSize(n: number): string {
  if (n >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
  return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
