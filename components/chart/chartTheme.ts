/** Axiom-inspired dark terminal chart palette. */
export const CHART_THEME = {
  bg: "#0b0f14",
  panel: "#111820",
  border: "rgba(148,163,184,0.12)",
  text: "#9aa4b2",
  textBright: "#e8edf4",
  grid: "rgba(148,163,184,0.04)",
  crosshair: "rgba(148,163,184,0.35)",
  crosshairLabel: "#1a2230",
  up: "#22c55e",
  down: "#ef4444",
  upVol: "rgba(34,197,94,0.45)",
  downVol: "rgba(239,68,68,0.45)",
  ma7: "#f59e0b",
  ma25: "#8b5cf6",
  rsi: "#38bdf8",
  live: "#22c55e",
  accent: "#3b82f6",
  buyMarker: "#00c278",
  buyMarkerRing: "#2ee59a",
  sellMarker: "#f6465d",
  sellMarkerRing: "#ff6b7d",
} as const;

export type ChartIndicatorState = {
  ma7: boolean;
  ma25: boolean;
  rsi: boolean;
  volume: boolean;
};

export const DEFAULT_INDICATORS: ChartIndicatorState = {
  ma7: false,
  ma25: false,
  rsi: false,
  volume: true,
};
