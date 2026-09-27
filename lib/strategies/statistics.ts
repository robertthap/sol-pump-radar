import { randomFor } from "./pool";
export type Observation = { mint: string; group: string; value: number; selected: boolean };
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const interval = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return [s[Math.floor((s.length - 1) * 0.025)], s[Math.ceil((s.length - 1) * 0.975)]] as [number, number];
};
function groups(rows: Observation[]) {
  const result = new Map<string, Observation[]>();
  for (const row of rows) { const list = result.get(row.group) ?? []; list.push(row); result.set(row.group, list); }
  return result;
}
function excess(rows: Observation[]): number | null {
  const strata = groups(rows), values: number[] = [];
  for (const group of strata.values()) {
    // Controls come from the same universe, including eligible rule selections.
    // Never compare a mint to itself, whose price path is shared across episodes.
    for (const row of group.filter((r) => r.selected)) {
      const control = mean(group.filter((r) => r.mint !== row.mint).map((r) => r.value));
      if (control != null) values.push(row.value - control);
    }
  }
  return mean(values);
}
export function summarize(rows: Observation[], seed: number) {
  const chosen = rows.filter((r) => r.selected), strata = groups(rows);
  const matched = chosen.map((r) => ({ row: r, controls: (strata.get(r.group) ?? []).filter((c) => c.mint !== r.mint) })).filter((p) => p.controls.length);
  const rng = randomFor("matched-controls", seed), randomMeans: number[] = [];
  for (let i = 0; i < 1000 && matched.length; i++) {
    randomMeans.push(mean(matched.map((p) => p.controls[Math.floor(rng() * p.controls.length)].value))!);
  }
  const matchedMean = mean(matched.map((p) => p.row.value));
  const clusters = new Map<string, Observation[]>();
  for (const row of rows) { const list = clusters.get(row.mint) ?? []; list.push(row); clusters.set(row.mint, list); }
  const mints = [...clusters.keys()], bootstrap: number[] = [];
  // Resample entire mints in both selected and control cohorts, retaining all their episodes.
  // Matching remains on the original mint identity, preventing self-controls after resampling.
  if (new Set(matched.map((p) => p.row.mint)).size >= 2) {
    for (let i = 0; i < 1000; i++) {
      const sample: Observation[] = [];
      for (let j = 0; j < mints.length; j++) sample.push(...clusters.get(mints[Math.floor(rng() * mints.length)])!);
      const value = excess(sample); if (value != null) bootstrap.push(value);
    }
  }
  const tails = [0, 0.01, 0.05, 0.1].map((trim) => {
    const trimmed: Observation[] = [];
    for (const group of strata.values()) {
      const sorted = [...group].sort((a, b) => a.value - b.value);
      trimmed.push(...sorted.slice(0, Math.max(0, sorted.length - Math.ceil(sorted.length * trim))));
    }
    return { trim, excess: excess(trimmed), selected: trimmed.filter((r) => r.selected).length };
  });
  return { selectedMean: mean(chosen.map((r) => r.value)), matchedSelectedMean: matchedMean,
    controlMean: mean(randomMeans), excess: matchedMean == null || !randomMeans.length ? null : matchedMean - mean(randomMeans)!,
    randomInterval: interval(randomMeans), bootstrapInterval: interval(bootstrap), bootstrapReplicates: bootstrap.length,
    matched: matched.length, unmatched: chosen.length - matched.length,
    selectedMints: new Set(chosen.map((r) => r.mint)).size, draws: randomMeans.length, tails };
}
