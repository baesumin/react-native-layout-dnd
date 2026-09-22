#!/usr/bin/env node
// Interleaved Release touch measurement over any number of build variants.
// Usage: node scripts/perf/release/touch-ab.mjs <buildDir> <outDir> <plan.json>
// plan.json: [{ "method": "testFlatListEdgeDrag", "name": "edge", "variants": ["base","cand",...] }, ...]
// Each variant is a directory under buildDir holding LayoutDndExample.app and bundle-manifest.json.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [buildDir, outDir, planPath] = process.argv.slice(2);
if (!buildDir || !outDir || !planPath) throw new Error('Usage: node release-ab3.mjs <buildDir> <outDir> <plan.json>');
mkdirSync(outDir, { recursive: true });
// Env: DND_SIM_UDID (defaults to the booted simulator), DND_APP_ID, DND_DEBUG_APP
// (the built Debug .app restored after the run), DND_XCTESTRUN, DND_BUNDLE_MANIFEST.
const simulator = process.env.DND_SIM_UDID ?? 'booted';
const app = process.env.DND_APP_ID ?? 'layoutdnd.example';
const debugApp = process.env.DND_DEBUG_APP;
if (!debugApp) throw new Error('Set DND_DEBUG_APP to the built Debug .app directory');
const xctestrun =
  process.env.DND_XCTESTRUN ??
  '/tmp/layout-dnd-touch-harness/DerivedData/Build/Products/LayoutDndTouchHarness-prepared.xctestrun';
const manifestPath =
  process.env.DND_BUNDLE_MANIFEST ?? '/tmp/dnd-native-release-perf/bundle-manifest.json';
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
const plan = [];
for (const group of JSON.parse(readFileSync(planPath, 'utf8')))
  group.variants.forEach((variant, index) => plan.push({ method: group.method, name: `${group.name}-${variant}-${index + 1}`, variant }));
const summary = [];
let installed = null;
try {
  for (const step of plan) {
    if (installed !== step.variant) {
      copyFileSync(`${buildDir}/${step.variant}/bundle-manifest.json`, manifestPath);
      await run('xcrun', ['simctl', 'terminate', simulator, app]);
      const install = await run('xcrun', ['simctl', 'install', simulator, `${buildDir}/${step.variant}/LayoutDndExample.app`]);
      if (install.code !== 0) throw new Error(`install ${step.variant} failed: ${install.output}`);
      installed = step.variant;
    }
    const output = `${outDir}/${step.name}.json`;
    const started = Date.now();
    const executed = await run('node', [
      '/tmp/dnd-native-release-perf/collect.mjs',
      `LayoutDndTouchTests/LayoutDndTouchTests/${step.method}`,
      xctestrun,
      output,
    ]);
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(output, 'utf8'));
    } catch {
      summary.push({ name: step.name, variant: step.variant, method: step.method, valid: false, failure: `no artifact: ${executed.output.slice(-1500)}` });
      writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
      console.log(`NO ARTIFACT ${step.name}: ${executed.output.slice(-800)}`);
      continue;
    }
    const row = {
      name: step.name,
      variant: step.variant,
      method: step.method,
      file: output,
      valid: artifact.valid,
      code: artifact.code,
      failure: artifact.failure,
      stages: (artifact.stages ?? []).map(stage => ({
        name: stage.name,
        durationMs: stage.durationMs,
        maxMs: stage.maxMs,
        p95Ms: stage.p95Ms,
        over33: stage.over33,
        samples: stage.samples,
        metricValid: stage.metricValid,
      })),
      cadenceValid: artifact.cadence?.valid,
      dev: artifact.metadata?.__DEV__,
      hermes: artifact.metadata?.hermes,
      bundleNonce: artifact.bundleNonce ?? artifact.manifest?.bundleNonce,
      elapsedMs: Date.now() - started,
    };
    summary.push(row);
    writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(row));
    if (executed.code !== 0 || !artifact.valid) console.log(`INVALID run ${step.name} (kept): ${executed.output.slice(-1500)}`);
  }
} finally {
  await run('xcrun', ['simctl', 'terminate', simulator, app]);
  const install = await run('xcrun', ['simctl', 'install', simulator, debugApp]);
  const launch = install.code === 0 ? await run('xcrun', ['simctl', 'launch', simulator, app]) : { code: -1, output: install.output };
  console.log(JSON.stringify({ restoredDebug: launch.code === 0, output: launch.output.slice(-300) }));
}
