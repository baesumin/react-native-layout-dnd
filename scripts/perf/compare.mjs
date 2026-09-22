#!/usr/bin/env node
// Compare interleaved base/cand artifacts: per-run key metrics and medians.
// Usage: node scripts/perf/compare.mjs <dir>   (files named <Screen>-<scenario>-<base|cand>-<n>.json)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assessRafCadence } from './metrics.mjs';

const dir = process.argv[2];
const hashFile = 'src/components/DndProvider.tsx';
const round = v => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const median = values => {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
};
const rows = [];
for (const name of readdirSync(dir).sort()) {
  const match = /^(\w+)-([\w-]+)-(base|cand)-(\d+)\.json$/.exec(name);
  if (!match) continue;
  const [, screen, scenario, variant, sample] = match;
  const artifact = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const result = artifact.result;
  const cadence = result?.activity?.frames ? assessRafCadence(result.activity.frames, result.activity.monitor) : null;
  const stages = Object.fromEntries((result?.stages ?? []).map(s => [s.name, s]));
  const stress = Math.max(...['source-unmount', 'settle'].map(n => stages[n]?.jsRafOverlappingMaxMs).filter(Number.isFinite));
  rows.push({
    screen, scenario, variant, sample: Number(sample),
    valid: artifact.valid && cadence?.valid !== false,
    warnings: artifact.warnings?.length ?? 0,
    failure: artifact.failure ?? result?.error ?? null,
    hash: artifact.sourceSha256?.[hashFile]?.slice(0, 8),
    stress: Number.isFinite(stress) ? round(stress) : null,
    drag: round(stages.drag?.jsRafOverlappingMaxMs),
    dragP95: round(stages.drag?.jsRafP95Ms),
    dragOver33: stages.drag?.jsRafOver33 ?? null,
    dragCommits: stages.drag?.reactCommits ?? null,
    drop: round(stages.drop?.jsRafOverlappingMaxMs),
    activation: round(stages.activation?.jsRafOverlappingMaxMs),
    scroll: round(stages.scroll?.jsRafOverlappingMaxMs),
    scrollP95: round(stages.scroll?.jsRafP95Ms),
    scrollOver33: stages.scroll?.jsRafOver33 ?? null,
    firstMove: round(result?.firstVisualMovementMs),
    nativeIdle: round(result?.firstNativeIdleMs),
  });
}
const hashes = new Map();
for (const row of rows) hashes.set(row.variant, new Set([...(hashes.get(row.variant) ?? []), row.hash]));
console.log('source hashes by variant:', Object.fromEntries([...hashes].map(([k, v]) => [k, [...v]])));
const groups = new Map();
for (const row of rows) {
  const key = `${row.screen}/${row.scenario}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const metricsByScenario = {
  'source-unmount': ['stress', 'drag', 'drop', 'activation', 'firstMove'],
  'edge-drop': ['drag', 'dragP95', 'dragOver33', 'dragCommits', 'drop', 'activation', 'firstMove'],
  drag: ['drag', 'drop', 'activation', 'firstMove'],
  scroll: ['scroll', 'scrollP95', 'scrollOver33'],
};
for (const [key, list] of groups) {
  const scenario = key.split('/')[1];
  console.log(`\n== ${key} ==`);
  for (const row of list.sort((a, b) => a.sample - b.sample))
    console.log(
      `  #${row.sample} ${row.variant} valid=${row.valid} warn=${row.warnings} hash=${row.hash}` +
        (row.failure ? ` FAIL=${row.failure}` : '') +
        ' ' +
        (metricsByScenario[scenario] ?? []).map(m => `${m}=${row[m]}`).join(' '),
    );
  for (const metric of metricsByScenario[scenario] ?? []) {
    const base = list.filter(r => r.variant === 'base' && r.valid).map(r => r[metric]);
    const cand = list.filter(r => r.variant === 'cand' && r.valid).map(r => r[metric]);
    const mb = median(base);
    const mc = median(cand);
    const delta = mb !== null && mc !== null ? round(mc - mb) : null;
    console.log(
      `  ${metric.padEnd(12)} base med=${String(mb).padStart(7)} [${base.join(' / ')}]   cand med=${String(mc).padStart(7)} [${cand.join(' / ')}]   delta=${delta}`,
    );
  }
}
