#!/usr/bin/env node
// Compact per-run table + per-scenario medians for trace.mjs artifacts.
// Usage: node scripts/perf/table.mjs <dir-or-files...>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assessRafCadence } from './metrics.mjs';

const inputs = process.argv.slice(2);
const files = [];
for (const input of inputs) {
  if (statSync(input).isDirectory())
    for (const name of readdirSync(input).sort())
      if (name.endsWith('.json')) files.push(join(input, name));
  else files.push(input);
}
const round = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const median = values => {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
};
const rows = [];
for (const file of files) {
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    rows.push({ file, error: String(error) });
    continue;
  }
  const result = artifact.result;
  const cadence = result?.activity?.frames
    ? assessRafCadence(result.activity.frames, result.activity.monitor)
    : null;
  const stages = Object.fromEntries((result?.stages ?? []).map(s => [s.name, s]));
  const stressMax = Math.max(
    ...['source-unmount', 'settle']
      .map(name => stages[name]?.jsRafOverlappingMaxMs)
      .filter(Number.isFinite),
  );
  rows.push({
    file,
    screen: artifact.options?.screen,
    scenario: artifact.options?.scenario,
    trace: artifact.options?.trace,
    valid: artifact.valid && cadence?.valid !== false,
    scenarioValid: artifact.scenarioValid,
    metricValid: cadence?.valid ?? artifact.metricValid,
    warnings: artifact.warnings?.length ?? 0,
    failure: artifact.failure ?? result?.error ?? null,
    assertions: result?.assertions,
    firstVisualMovementMs: round(result?.firstVisualMovementMs),
    firstNativeIdleMs: round(result?.firstNativeIdleMs),
    stages: Object.fromEntries(
      Object.values(stages).map(s => [
        s.name,
        {
          dur: s.durationMs,
          commits: s.reactCommits,
          max: round(s.jsRafMaxMs),
          ovlMax: round(s.jsRafOverlappingMaxMs),
          p95: round(s.jsRafP95Ms),
          over33: s.jsRafOver33,
        },
      ]),
    ),
    stressMax: Number.isFinite(stressMax) ? round(stressMax) : null,
  });
}
for (const row of rows) {
  if (row.error) {
    console.log(`${row.file}: ${row.error}`);
    continue;
  }
  const failedAssertions = row.assertions
    ? Object.entries(row.assertions).filter(([, ok]) => !ok).map(([k]) => k)
    : [];
  console.log(
    `${row.screen}/${row.scenario} ${row.file.split('/').pop()} valid=${row.valid} warn=${row.warnings}` +
      (row.failure ? ` FAIL=${row.failure}` : '') +
      (failedAssertions.length ? ` failedAssertions=${failedAssertions.join(',')}` : '') +
      (row.firstVisualMovementMs !== null && row.firstVisualMovementMs !== undefined
        ? ` firstMove=${row.firstVisualMovementMs} nativeIdle=${row.firstNativeIdleMs}`
        : '') +
      (row.stressMax !== null ? ` STRESS(unmount+settle ovlMax)=${row.stressMax}` : ''),
  );
  for (const [name, s] of Object.entries(row.stages))
    console.log(
      `    ${name.padEnd(15)} dur=${String(s.dur).padStart(6)} commits=${String(s.commits).padStart(4)} max=${String(s.max).padStart(7)} ovlMax=${String(s.ovlMax).padStart(7)} p95=${String(s.p95).padStart(6)} over33=${s.over33}`,
    );
}
// Medians of per-run maxima by scenario/stage (valid runs only).
console.log('\n== medians of per-run values (valid runs only) ==');
const groups = new Map();
for (const row of rows) {
  if (row.error || !row.valid) continue;
  const key = `${row.screen}/${row.scenario}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
for (const [key, list] of groups) {
  console.log(`${key} (n=${list.length})`);
  const stageNames = [...new Set(list.flatMap(r => Object.keys(r.stages)))];
  for (const name of stageNames) {
    const pick = f => list.map(r => r.stages[name]?.[f]);
    console.log(
      `    ${name.padEnd(15)} ovlMax med=${String(median(pick('ovlMax'))).padStart(7)} [${pick('ovlMax').map(round).join(' / ')}]  max med=${String(median(pick('max'))).padStart(7)}  p95 med=${String(median(pick('p95'))).padStart(6)}  commits med=${median(pick('commits'))}  over33 med=${median(pick('over33'))}`,
    );
  }
  if (list.some(r => r.stressMax !== null))
    console.log(
      `    STRESS ovlMax(unmount+settle) med=${median(list.map(r => r.stressMax))} [${list.map(r => r.stressMax).join(' / ')}]`,
    );
  if (list.some(r => r.firstVisualMovementMs !== null && r.firstVisualMovementMs !== undefined))
    console.log(
      `    firstVisualMovement med=${median(list.map(r => r.firstVisualMovementMs))} [${list.map(r => r.firstVisualMovementMs).join(' / ')}]  nativeIdle med=${median(list.map(r => r.firstNativeIdleMs))}`,
    );
}
