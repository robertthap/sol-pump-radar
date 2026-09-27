"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { computeLayout, type Count, type Layout, type LayoutNode } from "@/lib/radar/layout";
import { exitSubStage, type RadarSample } from "@/lib/radar/snapshot";
import { pointOnCubic, ribbonCenterline, sampleKey, sampleNodeId, unitHash, type Cubic } from "@/lib/radar/particles";
import { LIVE_LANE_COLOR, RADAR_COLOR } from "@/components/radar/stage-copy";

/**
 * The live flow: stages as bars, streams as ribbons whose width is the number of coins, and one particle per coin
 * that newly reached a stage since the last poll. Geometry comes from lib/radar/layout.ts (pure); this file only
 * draws it. Ribbons and bars are SVG so they can transition smoothly between polls; particles are one canvas on
 * top, so hundreds of them cost one element instead of hundreds.
 */
type Props = {
  counts: Count[];
  samples: RadarSample[];
  /** Hovered or pinned stage: its streams stay lit and the rest dim. */
  focusId: string | null;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
  /** Changing this (the window) reseeds the particle memory instead of firing one per coin already on screen. */
  resetKey: string;
  emptyMessage: string;
};

type Particle = {
  edgeId: string | null;
  nodeId: string;
  kind: "flow" | "ember" | "birth";
  start: number;
  dur: number;
  color: string;
  core: string;
  r: number;
  jitter: number;
};

const PADDING = { top: 30, right: 148, bottom: 14, left: 14 };
const MIN_WIDTH = 820;
const MAX_NEW_PARTICLES = 80;
const MAX_PARTICLES = 420;
const SEEN_CAP = 8_000;
const EMPTY: Layout = { nodes: [], edges: [] };

export function RadarFlow({ counts, samples, focusId, onHover, onPick, resetKey, emptyMessage }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [measured, setMeasured] = useState(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setMeasured(Math.round(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const width = Math.max(measured, MIN_WIDTH);
  const height = measured > 0 && measured < 640 ? 380 : 460;
  const layout = useMemo(
    () => (measured > 0 ? computeLayout({ counts, width, height, padding: PADDING }) : EMPTY),
    [counts, measured, width, height],
  );

  // Ribbon centre lines and half-thicknesses, so a particle can ride a stream and stay inside it.
  const geom = useMemo(() => {
    const m = new Map<string, { curve: Cubic; halfStart: number; halfEnd: number }>();
    for (const e of layout.edges) {
      const curve = ribbonCenterline(e.path);
      if (!curve) continue;
      const n = (e.path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      m.set(e.id, { curve, halfStart: Math.abs(n[15] - n[1]) / 2, halfEnd: Math.abs(n[9] - n[7]) / 2 });
    }
    return m;
  }, [layout]);
  const nodesById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const geomRef = useRef(geom);
  geomRef.current = geom;
  const nodesRef = useRef(nodesById);
  nodesRef.current = nodesById;
  const particlesRef = useRef<Particle[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    seenRef.current = null;
    particlesRef.current = [];
  }, [resetKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || measured <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    sizeRef.current = { width, height, dpr };
  }, [measured, width, height]);

  // One particle per coin that newly reached a stage. The first snapshot only seeds the memory: firing a particle
  // for every coin already in the window would be a burst that says nothing about right now.
  useEffect(() => {
    if (layout.nodes.length === 0) return;
    const keys = samples.map(sampleKey);
    if (seenRef.current == null) {
      seenRef.current = new Set(keys);
      return;
    }
    const seen = seenRef.current;
    const fresh = samples.filter((s) => !seen.has(sampleKey(s)));
    for (const k of keys) seen.add(k);
    if (seen.size > SEEN_CAP) seenRef.current = new Set(keys);
    if (reduced || fresh.length === 0) return;

    const now = performance.now();
    const batch = fresh.slice(0, MAX_NEW_PARTICLES);
    for (const [i, s] of batch.entries()) {
      const nodeId = sampleNodeId(s);
      const node = nodesById.get(nodeId);
      if (!node) continue;
      const edgeId = inboundEdgeId(s, nodeId, layout);
      const stopped = s.stage === "rejected" || s.stage === "skipped";
      const kind: Particle["kind"] = edgeId == null ? "birth" : stopped ? "ember" : "flow";
      const color = nodeId === "entry::live" ? LIVE_LANE_COLOR : RADAR_COLOR[node.colorToken];
      const jitter = unitHash(`${s.mint}${nodeId}`);
      particlesRef.current.push({
        edgeId,
        nodeId,
        kind,
        // Spread arrivals across the poll interval so they read as a flow, not a volley.
        start: now + (i / Math.max(1, batch.length)) * 1_700,
        dur: kind === "birth" ? 900 : 1_200 + jitter * 600,
        color,
        core: kind === "flow" ? "rgb(240 248 255)" : color,
        r: 1.5 + (s.score ?? 0.3) * 2.2,
        jitter,
      });
    }
    if (particlesRef.current.length > MAX_PARTICLES) {
      particlesRef.current = particlesRef.current.slice(-MAX_PARTICLES);
    }
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(drawFrame);
    // drawFrame is stable via refs; re-running on every samples change is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, layout, nodesById, reduced]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  function drawFrame(t: number) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const { width: cw, height: ch, dpr } = sizeRef.current;
    if (!ctx || cw === 0) {
      rafRef.current = null;
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = "lighter";
    const geoms = geomRef.current;
    const nodes = nodesRef.current;
    const alive: Particle[] = [];

    for (const p of particlesRef.current) {
      const age = t - p.start;
      if (age < 0) {
        alive.push(p);
        continue;
      }
      if (p.kind === "birth") {
        const node = nodes.get(p.nodeId);
        if (!node) continue;
        const k = age / p.dur;
        if (k >= 1) continue;
        ctx.globalAlpha = (1 - k) * 0.7;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(node.x + node.w / 2, node.y + p.jitter * node.h, 1.5 + k * 9, 0, Math.PI * 2);
        ctx.stroke();
        alive.push(p);
        continue;
      }
      const g = p.edgeId != null ? geoms.get(p.edgeId) : undefined;
      if (!g) continue;
      const k = Math.min(1, age / p.dur);
      // Accepted coins accelerate forward; rejected ones drift.
      const eased = p.kind === "flow" ? k * k : k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
      const point = pointOnCubic(g.curve, eased);
      const half = g.halfStart + (g.halfEnd - g.halfStart) * eased;
      let x = point.x;
      let y = point.y + (p.jitter - 0.5) * 2 * Math.max(0, half - 1);
      let alpha = 1;
      let r = p.r;
      if (k >= 1) {
        const after = age - p.dur;
        if (p.kind === "ember") {
          // Embers fall out of the lane and fade.
          const f = after / 900;
          if (f >= 1) continue;
          y += f * f * 26;
          x += (p.jitter - 0.5) * 10 * f;
          alpha = 1 - f;
          r = p.r * (1 - f * 0.5);
        } else {
          const f = after / 300;
          if (f >= 1) continue;
          alpha = 1 - f;
          r = p.r * (1 + f * 1.6);
        }
      }
      ctx.globalAlpha = alpha * 0.22;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.core;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      alive.push(p);
    }

    particlesRef.current = alive;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    rafRef.current = alive.length > 0 ? requestAnimationFrame(drawFrame) : null;
  }

  const labels = useMemo(() => placeLabels(layout.nodes), [layout]);
  const summary = layout.nodes.length
    ? `Coin flow: ${layout.nodes.map((n) => `${n.label} ${n.value}`).join(", ")}.`
    : emptyMessage;

  return (
    <div ref={wrapRef} className="relative overflow-x-auto">
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img" aria-label={summary}>
          <g>
            {layout.edges.map((e) => (
              <path
                key={e.id}
                className="radar-ribbon"
                d={e.path}
                style={{ d: `path("${e.path}")` } as CSSProperties}
                fill={e.target === "entry::live" ? LIVE_LANE_COLOR : RADAR_COLOR[e.colorToken]}
                fillOpacity={e.opacity * (focusId == null || e.source === focusId || e.target === focusId ? 1 : 0.18)}
                onPointerEnter={() => onHover(e.target)}
                onClick={() => onPick(e.target)}
              />
            ))}
          </g>
          <g>
            {layout.nodes.map((n) => (
              <rect
                key={n.id}
                className={`radar-node ${n.id === "entry::live" ? "radar-live" : ""}`}
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={1.5}
                style={{ x: n.x, y: n.y, width: n.w, height: n.h } as CSSProperties}
                fill={n.id === "entry::live" ? LIVE_LANE_COLOR : RADAR_COLOR[n.colorToken]}
                fillOpacity={focusId == null || focusId === n.id ? 1 : 0.5}
              />
            ))}
          </g>
          <g>
            {labels.map((l) => {
              const hidden = !l.show && focusId !== l.id;
              return (
                <g
                  key={l.id}
                  className="radar-label"
                  style={{ transform: `translate(${l.x}px, ${l.y}px)`, opacity: hidden ? 0 : 1 }}
                  onPointerEnter={() => onHover(l.id)}
                  onClick={() => onPick(l.id)}
                >
                  <text textAnchor={l.anchor} dominantBaseline="middle" className={focusId === l.id ? "radar-label-on" : ""}>
                    <tspan>{l.label} </tspan>
                    <tspan className="radar-label-value">{l.value.toLocaleString("en-US")}</tspan>
                  </text>
                </g>
              );
            })}
          </g>
          {/* Bars are 10px wide and can be 2px tall: a padded transparent target makes them reachable. */}
          <g>
            {layout.nodes.map((n) => (
              <rect
                key={`hit-${n.id}`}
                x={n.x - 9}
                y={n.y - 5}
                width={n.w + 18}
                height={n.h + 10}
                fill="transparent"
                className="cursor-pointer"
                onPointerEnter={() => onHover(n.id)}
                onClick={() => onPick(n.id)}
              />
            ))}
          </g>
        </svg>
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0"
          style={{ width, height }}
        />
        {measured > 0 && layout.nodes.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted">{emptyMessage}</p>
        )}
      </div>
    </div>
  );
}

/** The stream a coin rode to reach this stage: exits converge on the outcome, so an outcome uses its own door. */
function inboundEdgeId(s: RadarSample, nodeId: string, layout: Layout): string | null {
  if (s.stage === "outcome") {
    const viaDoor = layout.edges.find((e) => e.id === `exit::${exitSubStage(s.detail)}->outcome`);
    if (viaDoor) return viaDoor.id;
  }
  return layout.edges.find((e) => e.target === nodeId)?.id ?? null;
}

type PlacedLabel = { id: string; x: number; y: number; anchor: "start" | "end"; label: string; value: number; show: boolean };

/**
 * Spine names sit above their bar, leaks to the right, skips, lanes and exit doors to the left. Where the funnel is
 * only a few pixels tall the names would overlap, so one is kept every 12px and the rest appear on hover.
 */
function placeLabels(nodes: LayoutNode[]): PlacedLabel[] {
  const lastY = new Map<string, number>();
  return nodes.map((n) => {
    const family = n.id.includes("::") ? n.id.slice(0, n.id.indexOf("::")) : "spine";
    const spine = family === "spine";
    const right = family === "rejected";
    const side = `${Math.round(n.x)}|${spine ? "t" : right ? "r" : "l"}`;
    const y = spine ? n.y - 9 : n.y + n.h / 2;
    const prev = lastY.get(side);
    const show = prev == null || Math.abs(y - prev) >= 12;
    if (show) lastY.set(side, y);
    return {
      id: n.id,
      x: spine ? n.x : right ? n.x + n.w + 6 : n.x - 6,
      y,
      anchor: spine || right ? "start" : "end",
      label: n.label,
      value: n.value,
      show,
    };
  });
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
