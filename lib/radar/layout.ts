/**
 * Coin Journey radar geometry (pure, no dependencies). Six spine columns at x_i = left + i * innerWidth / 5, spine nodes
 * top-aligned; rejections and skips stack below the spine in the column after their parent stage, and exit doors stand
 * midway between entry and outcome. Node height = max(MIN_NODE_HEIGHT, count * scale), where scale is the
 * largest at which every column's stack (spine node + branches + gaps) fits the inner height.
 * Edges are closed ribbons (render with fill, not stroke) whose ends tile the node sides they attach to.
 */

export type Count = { stage: string; sub_stage: string | null; count: number };

/** Mapped to Tailwind classes by the component. */
export type ColorToken = "ingest" | "score" | "pass" | "reject" | "profit" | "trailing" | "skipped";

export type LayoutInput = {
  counts: Count[];
  width: number;
  height: number;
  padding?: { top: number; right: number; bottom: number; left: number };
};

export type LayoutNode = {
  id: string;
  label: string;
  value: number;
  x: number;
  y: number;
  w: number;
  h: number;
  colorToken: ColorToken;
};

export type LayoutEdge = {
  id: string;
  source: string;
  target: string;
  value: number;
  path: string;
  colorToken: ColorToken;
  opacity: number;
};

export type Layout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
};

export const MIN_NODE_HEIGHT = 2;
export const NODE_GAP = 8;
export const SPINE_OPACITY = 0.55;
export const BRANCH_OPACITY = 0.35;
const NODE_WIDTH = 10;
const DEFAULT_PADDING = { top: 16, right: 16, bottom: 16, left: 16 };

const SPINE = ["ingested", "scored", "gate_passed", "decision_committed", "entry", "outcome"] as const;
type SpineId = (typeof SPINE)[number];

/**
 * The spine stage each known branch leaves from, in the order the worker applies them (lib/workers/auto-trader.ts
 * handleEntries): every entry gate runs on a scored BUY decision, so gates and capacity skips leave `scored`; only
 * checks made after all gates pass leave `gate_passed` / `decision_committed`. Listing order breaks count ties.
 */
const BRANCH_PARENT: Record<string, SpineId> = {
  "rejected::not_scored": "ingested",
  "rejected::avoid": "scored",
  "skipped::already_in": "scored",
  "skipped::max_positions": "scored",
  "rejected::strictness": "scored",
  "rejected::rug_label": "scored",
  "rejected::no_price": "scored",
  "rejected::curve_band": "scored",
  "rejected::bundle_veto": "scored",
  "rejected::age_limit": "scored",
  "rejected::flow": "scored",
  "rejected::smart_money": "scored",
  "rejected::activity_floor": "scored",
  "rejected::entry_filter": "scored",
  "rejected::mcap_ceiling": "scored",
  "rejected::stale": "scored",
  "skipped::insufficient_balance": "gate_passed",
  "skipped::live_blocked": "gate_passed",
  "skipped::micro_sim": "gate_passed",
  "skipped::fill_rejected": "decision_committed",
  "exit::take_profit": "entry",
  "exit::trailing_stop": "entry",
  "exit::flat_cut": "entry",
  "exit::stop_loss": "entry",
  "exit::max_hold": "entry",
  "exit::forced_close": "entry",
};

/** Where an unlisted sub-stage of a known family attaches, so a new reason is drawn rather than hidden. */
const FAMILY_PARENT: Record<string, SpineId> = {
  rejected: "scored",
  skipped: "decision_committed",
  exit: "entry",
};

const KNOWN_ORDER = [...Object.keys(BRANCH_PARENT), "entry::paper", "entry::live"];

const LABELS: Record<string, string> = {
  "rejected::not_scored": "Not scored",
  "rejected::avoid": "Avoided by scorer",
  "rejected::strictness": "Signal strictness",
  "rejected::rug_label": "Rug label",
  "rejected::curve_band": "Curve band",
  "rejected::flow": "Order-flow gate",
  "rejected::smart_money": "Smart money required",
  "rejected::entry_filter": "Entry filter",
  "skipped::insufficient_balance": "Not enough balance",
  "skipped::live_blocked": "Live blocked",
  "skipped::micro_sim": "Slippage check",
  "skipped::fill_rejected": "Fill rejected",
  "exit::stop_loss": "Stop loss",
  "exit::max_hold": "Max hold",
  "rejected::no_price": "No on-chain price",
  "rejected::mcap_ceiling": "Market cap ceiling",
  "rejected::activity_floor": "Activity floor",
  "rejected::age_limit": "Entry-age limit",
  "rejected::bundle_veto": "Bundle veto",
  "rejected::stale": "Stale >15s",
  "skipped::max_positions": "Max positions",
  "skipped::already_in": "Already in position",
  "exit::take_profit": "Take profit",
  "exit::trailing_stop": "Trailing stop",
  "exit::flat_cut": "Flat cut",
  "exit::forced_close": "Forced close",
};

type Slot = { id: string; value: number };
type Band = [top: number, bottom: number];
type Link = { source: string; target: string; value: number; opacity: number };

export function computeLayout(input: LayoutInput): Layout {
  const pad = input.padding ?? DEFAULT_PADDING;
  const innerW = input.width - pad.left - pad.right;
  const innerH = input.height - pad.top - pad.bottom;
  if (!Number.isFinite(innerW) || !Number.isFinite(innerH) || innerW <= 0 || innerH <= 0) {
    return { nodes: [], edges: [] };
  }

  const totals = new Map<string, number>();
  for (const { stage, sub_stage, count } of input.counts) {
    if (!Number.isFinite(count) || count <= 0) continue; // NaN, negative and zero draw nothing
    const id = sub_stage ? `${stage}::${sub_stage}` : stage;
    totals.set(id, (totals.get(id) ?? 0) + count);
  }

  const lanes: Slot[] = [];
  const branches = new Map<SpineId, Slot[]>();
  for (const [id, value] of totals) {
    if (id.startsWith("entry::")) {
      lanes.push({ id, value });
      continue;
    }
    const parent = parentOf(id);
    if (parent) branches.set(parent, [...(branches.get(parent) ?? []), { id, value }]);
  }
  lanes.sort(byKnownOrder);

  const spineValue = new Map<SpineId, number>();
  for (const id of SPINE) {
    const own = totals.get(id) ?? 0;
    const value = id === "entry" ? Math.max(own, sum(lanes.map((l) => l.value))) : own;
    if (value > 0) spineValue.set(id, value);
  }

  for (const [parent, list] of branches) {
    // A branch whose parent stage has no count would float with nothing feeding it.
    if (!spineValue.has(parent)) branches.delete(parent);
    // Exit doors keep a fixed order so they never swap places between polls; leaks sort biggest first.
    else list.sort(parent === "entry" ? byKnownOrder : byCountDesc);
  }

  const step = innerW / (SPINE.length - 1);
  const columns: Slot[][] = [];
  const centers: number[] = [];
  SPINE.forEach((id, i) => {
    const cx = pad.left + i * step;
    if (id === "outcome") {
      columns.push(branches.get("entry") ?? []);
      centers.push(cx - step / 2);
    }
    const slots: Slot[] = [];
    const value = spineValue.get(id);
    if (value !== undefined) slots.push({ id, value });
    const feeder = i > 0 ? SPINE[i - 1] : undefined;
    if (feeder !== undefined && feeder !== "entry") slots.push(...(branches.get(feeder) ?? []));
    columns.push(slots);
    centers.push(cx);
  });

  const filled = columns.filter((slots) => slots.length > 0);
  if (filled.length === 0) return { nodes: [], edges: [] };

  // The entry node grows to hold each lane at the floor, which adds at most (lanes - 1) floors to its column.
  const laneReserve = Math.max(0, lanes.length - 1) * MIN_NODE_HEIGHT;
  const scale = Math.min(
    ...filled.map((slots) =>
      fitScale(
        slots.map((s) => s.value),
        slots.some((s) => s.id === "entry") ? innerH - laneReserve : innerH,
      ),
    ),
  );
  const thickness = (value: number) => Math.max(MIN_NODE_HEIGHT, value * scale);
  const laneHeights = lanes.map((l) => thickness(l.value));
  const w = Math.min(NODE_WIDTH, step / 4);

  const nodes: LayoutNode[] = [];
  const byId = new Map<string, LayoutNode>();
  const addNode = (id: string, value: number, x: number, y: number, h: number): LayoutNode => {
    const node: LayoutNode = { id, label: labelFor(id), value, x, y, w, h, colorToken: colorTokenFor(id) };
    nodes.push(node);
    byId.set(id, node);
    return node;
  };

  columns.forEach((slots, c) => {
    const x = Math.min(Math.max(centers[c] - w / 2, 0), input.width - w);
    let y = pad.top;
    for (const slot of slots) {
      const isEntry = slot.id === "entry";
      const h = isEntry ? Math.max(thickness(slot.value), sum(laneHeights)) : thickness(slot.value);
      const node = addNode(slot.id, slot.value, x, y, h);
      y += node.h + NODE_GAP;
      if (isEntry) {
        // Paper and live are partitions of the entry node: stacked inside its rect, not beside it.
        stack(node, laneHeights).forEach(([top, bottom], k) => {
          addNode(lanes[k].id, lanes[k].value, x, top, bottom - top);
        });
      }
    }
  });

  const links: Link[] = [];
  const link = (source: string, target: string, opacity: number, value?: number) => {
    const to = byId.get(target);
    if (byId.has(source) && to) links.push({ source, target, value: value ?? to.value, opacity });
  };
  for (let i = 0; i < SPINE.length - 1; i++) {
    const id = SPINE[i];
    const next = SPINE[i + 1];
    const out = branches.get(id) ?? [];
    if (id === "entry") {
      if (out.length === 0) link(id, next, SPINE_OPACITY);
      for (const exit of out) link(id, exit.id, SPINE_OPACITY);
      for (const exit of out) link(exit.id, next, SPINE_OPACITY, exit.value);
      continue;
    }
    if (next === "entry" && lanes.length > 0) for (const lane of lanes) link(id, lane.id, SPINE_OPACITY);
    else link(id, next, SPINE_OPACITY);
    for (const branch of out) link(id, branch.id, BRANCH_OPACITY);
  }

  const fromBands = endBands(links, "source", byId, thickness);
  const toBands = endBands(links, "target", byId, thickness);
  const edges: LayoutEdge[] = links.flatMap((l, i) => {
    const from = byId.get(l.source);
    const to = byId.get(l.target);
    if (!from || !to) return [];
    return [
      {
        id: `${l.source}->${l.target}`,
        source: l.source,
        target: l.target,
        value: l.value,
        path: ribbon(from.x + from.w, fromBands[i], to.x, toBands[i]),
        colorToken: to.colorToken,
        opacity: l.opacity,
      },
    ];
  });

  return { nodes, edges };
}

/** Label, colour token and parent spine stage for any stage id, for lists and tables that show stages without a layout. */
export { labelFor as stageLabel, colorTokenFor as stageColorToken, parentOf as stageParent };

function parentOf(id: string): SpineId | null {
  if (!id.includes("::")) return null;
  return BRANCH_PARENT[id] ?? FAMILY_PARENT[familyOf(id)] ?? null;
}

function familyOf(id: string): string {
  return id.split("::")[0];
}

function colorTokenFor(id: string): ColorToken {
  if (id === "ingested") return "ingest";
  if (id === "scored") return "score";
  if (id === "exit::take_profit") return "profit";
  if (id === "exit::trailing_stop") return "trailing";
  const family = familyOf(id);
  if (family === "rejected" || family === "exit") return "reject";
  if (family === "skipped") return "skipped";
  return "pass"; // gate_passed, decision_committed, entry and its lanes, outcome
}

function labelFor(id: string): string {
  const known = LABELS[id];
  if (known) return known;
  const key = id.split("::").pop() ?? id;
  return key
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function knownRank(id: string): number {
  const i = KNOWN_ORDER.indexOf(id);
  return i === -1 ? KNOWN_ORDER.length : i;
}

function byKnownOrder(a: Slot, b: Slot): number {
  return knownRank(a.id) - knownRank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function byCountDesc(a: Slot, b: Slot): number {
  return b.value - a.value || byKnownOrder(a, b);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * The largest scale at which a column fits `space`: the sum of max(MIN_NODE_HEIGHT, value * scale)
 * plus the gaps between nodes.
 */
function fitScale(values: number[], space: number): number {
  const room = space - (values.length - 1) * NODE_GAP;
  const sorted = [...values].sort((a, b) => b - a);
  const n = sorted.length;
  // Total height grows piecewise-linearly with scale. At the exact fit the j largest values sit above the
  // floor and the rest on it, so scale = (room - (n - j) * MIN) / (sum of the j largest). Try j = 1..n and
  // keep the first whose split is self-consistent.
  let largest = 0;
  for (let j = 1; j <= n; j++) {
    largest += sorted[j - 1];
    const s = (room - (n - j) * MIN_NODE_HEIGHT) / largest;
    const restOnFloor = j === n || sorted[j] * s <= MIN_NODE_HEIGHT;
    if (s > 0 && sorted[j - 1] * s >= MIN_NODE_HEIGHT && restOnFloor) return s;
  }
  // No exact fit (too many nodes for the space, or a float tie): a scale that always fits, or 0.
  return Math.max(0, (room - n * MIN_NODE_HEIGHT) / sum(sorted));
}

/**
 * Stack thicknesses down from the node's top. When they add up to more than the node (floors, or a window
 * where a later stage counted more coins than its parent), squeeze them so they stay inside its rect.
 */
function stack(node: LayoutNode, thicknesses: number[]): Band[] {
  const total = sum(thicknesses);
  const squeeze = total > node.h ? node.h / total : 1;
  let y = node.y;
  return thicknesses.map((t) => {
    const top = y;
    y += t * squeeze;
    return [top, y];
  });
}

/** For each link, the band it occupies on its source or target node; links sharing a node stack in order. */
function endBands(
  links: Link[],
  end: "source" | "target",
  nodes: Map<string, LayoutNode>,
  thickness: (value: number) => number,
): Band[] {
  const bands: Band[] = links.map(() => [0, 0]);
  const groups = new Map<string, number[]>();
  links.forEach((l, i) => groups.set(l[end], [...(groups.get(l[end]) ?? []), i]));
  for (const [id, indexes] of groups) {
    const node = nodes.get(id);
    if (!node) continue;
    stack(node, indexes.map((i) => thickness(links[i].value))).forEach((band, k) => {
      bands[indexes[k]] = band;
    });
  }
  return bands;
}

function ribbon(x1: number, from: Band, x2: number, to: Band): string {
  // Each bezier's control points sit half the run in from its ends, level with the end they belong to, so
  // the ribbon leaves and enters horizontally and does all its bending mid-span: water, not wire.
  const dx = (x2 - x1) * 0.5;
  const p = (x: number, y: number) => `${num(x)} ${num(y)}`;
  return (
    `M ${p(x1, from[0])} C ${p(x1 + dx, from[0])}, ${p(x2 - dx, to[0])}, ${p(x2, to[0])} ` +
    `L ${p(x2, to[1])} C ${p(x2 - dx, to[1])}, ${p(x1 + dx, from[1])}, ${p(x1, from[1])} Z`
  );
}

/** Two decimals: short, stable path strings with no float noise. */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}
