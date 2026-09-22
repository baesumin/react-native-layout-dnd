#!/usr/bin/env node
// Summarize touch-ab runs: per plan group and variant, per-run max/p95/over33 plus medians.
import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2];
const summary = JSON.parse(readFileSync(`${dir}/summary.json`, 'utf8'));
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const groups = new Map();
for (const row of summary) {
  const group = row.name.replace(/-(base|cand|noc2|c1|e\d)-\d+$/, '');
  const key = `${group}|${row.variant}`;
  if (!groups.has(key)) groups.set(key, []);
  const stage = (row.stages ?? [])[0];
  let info = '';
  try { const log = readFileSync(`${row.file}.log`, 'utf8'); const m = log.match(/DND_TOUCH_INFO \S+ (.*)/); if (m) info = m[1]; } catch {}
  groups.get(key).push({ name: row.name, valid: row.valid, max: stage?.maxMs, p95: stage?.p95Ms, over33: stage?.over33, samples: stage?.samples, duration: stage?.durationMs, info });
}
for (const [key, rows] of [...groups].sort()) {
  const valid = rows.filter(r => r.valid);
  console.log(`== ${key}  runs=${rows.length} valid=${valid.length}`);
  for (const r of rows) console.log(`   ${r.name.padEnd(18)} valid=${r.valid} max=${r.max?.toFixed(1)} p95=${r.p95?.toFixed(1)} over33=${r.over33} samples=${r.samples} dur=${r.duration}ms ${r.info}`);
  if (valid.length) console.log(`   median: max=${median(valid.map(r => r.max)).toFixed(1)} p95=${median(valid.map(r => r.p95)).toFixed(1)} over33=${median(valid.map(r => r.over33))}  range max=${Math.min(...valid.map(r => r.max)).toFixed(1)}–${Math.max(...valid.map(r => r.max)).toFixed(1)}`);
}
