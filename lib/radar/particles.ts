/**
 * Particle geometry for the radar (PURE). A coin that newly reached a stage travels along the centre line of the
 * ribbon feeding that stage: the cubic halfway between the ribbon's top and bottom edges (lib/radar/layout.ts).
 */
export type Point = { x: number; y: number };
export type Cubic = [Point, Point, Point, Point];

/** Centre line of a layout ribbon "M x1 sTop C .. .., .. .., x2 tTop L x2 tBot C .. .., .. .., x1 sBot Z", or null. */
export function ribbonCenterline(path: string): Cubic | null {
  const n = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (n.length !== 16 || n.some((v) => !Number.isFinite(v))) return null;
  // Top edge runs source -> target (points 0..3), bottom edge target -> source (points 4..7), so the bottom edge's
  // points pair with the top edge's in reverse order.
  const top: Point[] = [0, 2, 4, 6].map((i) => ({ x: n[i], y: n[i + 1] }));
  const bottom: Point[] = [14, 12, 10, 8].map((i) => ({ x: n[i], y: n[i + 1] }));
  const mid = (k: number): Point => ({ x: (top[k].x + bottom[k].x) / 2, y: (top[k].y + bottom[k].y) / 2 });
  return [mid(0), mid(1), mid(2), mid(3)];
}

export function pointOnCubic([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Deterministic value in [0, 1) for a string (FNV-1a), for per-coin jitter that does not change between renders. */
export function unitHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

type SampleLike = { stage: string; sub_stage: string | null; mint: string; created_at: string };

/** Layout node id a sample belongs to, e.g. "rejected::mcap_ceiling". */
export function sampleNodeId(s: SampleLike): string {
  return s.sub_stage ? `${s.stage}::${s.sub_stage}` : s.stage;
}

/** Identity of one arrival: the same coin reaching the same stage again later is a new arrival. */
export function sampleKey(s: SampleLike): string {
  return `${sampleNodeId(s)}|${s.mint}|${s.created_at}`;
}
