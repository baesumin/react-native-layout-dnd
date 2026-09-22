#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { assessRafCadence, excludeInvalidRafMetrics } from './metrics.mjs';

const arguments_ = process.argv.slice(2);
const files = [];
let top = 20;
let match;
for (let index = 0; index < arguments_.length; index++) {
  const argument = arguments_[index];
  if (argument === '--top') top = Number(arguments_[++index]);
  else if (argument === '--match') match = new RegExp(arguments_[++index], 'i');
  else if (argument === '--help') {
    console.log(
      'node scripts/perf/summarize.mjs /tmp/trace.json [...] [--top 20] [--match "Dnd|List|Gesture"]',
    );
    process.exit(0);
  } else if (argument.startsWith('--'))
    throw new Error(`Unknown option: ${argument}`);
  else files.push(argument);
}
if (!files.length || !Number.isInteger(top) || top < 1 || top > 200)
  throw new Error('Pass at least one trace file and --top between 1 and 200');

const round = value => Math.round(value * 1000) / 1000;
const parseIfString = value => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const gapsSummary = values => {
  const gaps = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    samples: gaps.length,
    p95Ms: gaps.length ? round(gaps[Math.floor(gaps.length * 0.95)]) : null,
    maxMs: gaps.length ? round(gaps.at(-1)) : null,
    over33Ms: gaps.filter(gap => gap > 33).length,
  };
};
const profileKey = event =>
  JSON.stringify([event.pid, event.tid, event.id ?? event.id2]);
function cpuSummary(events) {
  const profiles = new Map();
  for (const event of events) {
    if (event.name !== 'Profile' && event.name !== 'ProfileChunk') continue;
    const key = profileKey(event);
    if (!profiles.has(key)) profiles.set(key, { nodes: new Map(), chunks: [] });
    const profile = profiles.get(key);
    const data = event.args?.data;
    if (event.name === 'ProfileChunk' && data?.cpuProfile) {
      profile.chunks.push(data);
      for (const node of data.cpuProfile.nodes ?? [])
        profile.nodes.set(node.id, node);
    }
  }
  const totals = new Map();
  const byName = name => {
    if (!totals.has(name))
      totals.set(name, {
        name,
        selfUs: 0,
        inclusiveUs: 0,
        selfSamples: 0,
        inclusiveSamples: 0,
        locations: new Set(),
      });
    return totals.get(name);
  };
  let samples = 0;
  let sampledUs = 0;
  let missingWeights = 0;
  let missingNodes = 0;
  for (const { nodes, chunks } of profiles.values()) {
    // RN/Hermes emits parent IDs. Also accept V8-style children arrays.
    for (const node of nodes.values())
      for (const childId of node.children ?? []) {
        const child = nodes.get(childId);
        if (child && child.parent === undefined) child.parent = node.id;
      }
    for (const chunk of chunks) {
      const ids = chunk.cpuProfile.samples ?? [];
      for (let index = 0; index < ids.length; index++) {
        const weight = chunk.timeDeltas?.[index];
        if (!Number.isFinite(weight) || weight < 0) {
          missingWeights++;
          continue;
        }
        samples++;
        sampledUs += weight;
        const leaf = nodes.get(ids[index]);
        if (!leaf) {
          missingNodes++;
          continue;
        }
        const leafName = leaf.callFrame?.functionName || '(anonymous)';
        const self = byName(leafName);
        self.selfUs += weight;
        self.selfSamples++;
        const names = new Set();
        const visited = new Set();
        for (
          let node = leaf;
          node && !visited.has(node.id);
          node = nodes.get(node.parent)
        ) {
          visited.add(node.id);
          const frame = node.callFrame ?? {};
          const name = frame.functionName || '(anonymous)';
          const total = byName(name);
          if (!names.has(name)) {
            // A recursive function contributes at most once per sample.
            names.add(name);
            total.inclusiveUs += weight;
            total.inclusiveSamples++;
          }
          if (frame.url)
            total.locations.add(`${frame.url}:${(frame.lineNumber ?? 0) + 1}`);
        }
      }
    }
  }
  const idleUs = totals.get('(idle)')?.selfUs ?? 0;
  const nonIdleUs = sampledUs - idleUs;
  const ignored = new Set(['(root)', '(idle)', '(program)']);
  const functions = [...totals.values()].filter(
    row => !ignored.has(row.name) && (!match || match.test(row.name)),
  );
  const summarize = row => ({
    name: row.name,
    selfMs: round(row.selfUs / 1000),
    inclusiveMs: round(row.inclusiveUs / 1000),
    selfSamples: row.selfSamples,
    inclusiveSamples: row.inclusiveSamples,
    inclusiveNonIdlePercent: nonIdleUs
      ? round((row.inclusiveUs / nonIdleUs) * 100)
      : 0,
    distinctLocations: row.locations.size,
  });
  return {
    profiles: profiles.size,
    samples,
    sampledMs: round(sampledUs / 1000),
    idleMs: round(idleUs / 1000),
    nonIdleMs: round(nonIdleUs / 1000),
    missingWeights,
    missingNodes,
    self: [...functions]
      .sort((a, b) => b.selfUs - a.selfUs)
      .slice(0, top)
      .map(summarize),
    inclusive: [...functions]
      .sort((a, b) => b.inclusiveUs - a.inclusiveUs)
      .slice(0, top)
      .map(summarize),
    note: 'Time-delta-weighted sampled stacks across the whole trace. Inclusive function names count once per sample; inclusive rows overlap and cannot be summed. Names shared by multiple locations are grouped.',
  };
}

const summaries = files.map(file => {
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  const events = artifact.traceEvents ?? [];
  if (!Array.isArray(events))
    throw new Error(`${file}: missing traceEvents array`);
  const legacyStats = parseIfString(artifact.stats);
  const legacyDriver = parseIfString(artifact.driverResult);
  const result = artifact.result;
  const originalStages =
    result?.stages ??
    (legacyStats
      ? [
          {
            name: 'legacy-whole-capture',
            durationMs: round(legacyStats.elapsedMs),
            reactCommits: legacyStats.commits,
            jsRaf: gapsSummary(legacyStats.gaps ?? []),
            note: 'Legacy capture includes driver preparation/tail. Its wall duration can exceed CPU trace duration when JS is busy.',
          },
        ]
      : []);
  let frames = result?.activity?.frames;
  if (!frames && Array.isArray(legacyStats?.gaps)) {
    let wall = 0;
    frames = legacyStats.gaps.map(gapMs => {
      const fromWall = wall;
      wall += gapMs;
      return { fromWall, wall, gapMs };
    });
  }
  const cadence = frames
    ? assessRafCadence(frames, result?.activity?.monitor)
    : null;
  const stages = cadence
    ? excludeInvalidRafMetrics(originalStages, cadence)
    : originalStages;
  return {
    file,
    schemaVersion: artifact.schemaVersion ?? 'legacy',
    recordedValid: artifact.valid ?? null,
    valid: cadence?.valid === false ? false : (artifact.valid ?? null),
    scenarioValid: artifact.scenarioValid ?? result?.scenarioValid ?? null,
    metricValid: cadence?.valid ?? null,
    metrics: { jsRaf: cadence },
    validation:
      artifact.valid === undefined
        ? 'Legacy artifact has no unified validity flag; inspect driver and scenario assertions.'
        : (artifact.failure ?? result?.assertions),
    screen: artifact.options?.screen ?? artifact.label,
    scenario: artifact.options?.scenario ?? artifact.mode,
    warnings: artifact.warnings?.length ?? 0,
    stages,
    drop: result
      ? {
          firstVisualMovementMs: result.firstVisualMovementMs,
          firstNativeIdleMs: result.firstNativeIdleMs,
          error: result.error,
        }
      : Array.isArray(legacyDriver)
        ? legacyDriver.map(driver => ({
            screen: driver.screen,
            firstVisualMovementMs: driver.firstVisualMovementMs,
            firstNativeIdleMs: driver.firstNativeIdleMs,
            cleanedUp: driver.cleanedUp,
            acceptedRevision: driver.acceptedRevision,
            error: driver.error,
          }))
        : legacyDriver,
    cpu: { enabled: artifact.options?.trace !== false, ...cpuSummary(events) },
  };
});
console.log(JSON.stringify(summaries, null, 2));
