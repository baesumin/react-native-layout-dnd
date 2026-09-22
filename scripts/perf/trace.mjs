#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessRafCadence, excludeInvalidRafMetrics } from './metrics.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const babel = require('@babel/core');
const WebSocket = require('ws');
const args = process.argv.slice(2);
const options = {
  screen: 'FlatList',
  scenario: 'drag',
  target: 'iPhone 17 Pro Max',
  metro: 'http://localhost:8081',
  output: resolve('dnd-perf.json'),
  warmupMs: 2500,
  durationMs: 5000,
  updates: 180,
  dropTimeoutMs: 2500,
  trace: true,
};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  if (key === '--help') {
    console.log(
      'node scripts/perf/trace.mjs --screen Lists|FlatList|Mixed --scenario idle|scroll|drag|edge-drop|source-unmount --output /tmp/result.json [--target "iPhone 17 Pro Max"] [--warmup-ms 2500] [--duration-ms 5000] [--updates 180] [--trace true|false]',
    );
    process.exit(0);
  }
  const names = {
    '--screen': 'screen',
    '--scenario': 'scenario',
    '--target': 'target',
    '--metro': 'metro',
    '--output': 'output',
    '--warmup-ms': 'warmupMs',
    '--duration-ms': 'durationMs',
    '--updates': 'updates',
    '--drop-timeout-ms': 'dropTimeoutMs',
    '--trace': 'trace',
  };
  const name = names[key];
  if (!name || args[index + 1] === undefined)
    throw new Error(`Invalid argument: ${key}`);
  if (typeof options[name] === 'boolean') {
    if (!['true', 'false'].includes(args[index + 1]))
      throw new Error(`${key} must be true or false`);
    options[name] = args[index + 1] === 'true';
  } else
    options[name] =
      typeof options[name] === 'number'
        ? Number(args[index + 1])
        : args[index + 1];
}
if (
  !['Lists', 'FlatList', 'Mixed'].includes(options.screen) ||
  !['idle', 'scroll', 'drag', 'edge-drop', 'source-unmount'].includes(
    options.scenario,
  )
)
  throw new Error('Unsupported screen or scenario');
if (options.scenario === 'source-unmount' && options.screen !== 'FlatList')
  throw new Error('source-unmount requires the FlatList example');
for (const key of ['warmupMs', 'durationMs', 'updates', 'dropTimeoutMs'])
  if (
    !Number.isInteger(options[key]) ||
    options[key] < 1 ||
    options[key] > 15000
  )
    throw new Error(`${key} must be an integer from 1 to 15000`);

const runtimePath = fileURLToPath(new URL('./runtime.js', import.meta.url));
const runtimeSource = readFileSync(runtimePath, 'utf8');
const sourceRoot = new URL('../../src/', import.meta.url);
const sourceManifest = () =>
  Object.fromEntries(
    readdirSync(sourceRoot, { recursive: true })
      .filter(path => /\.[jt]sx?$/.test(path))
      .sort()
      .map(path => [
        `src/${path}`,
        createHash('sha256')
          .update(readFileSync(new URL(path, sourceRoot)))
          .digest('hex'),
      ]),
  );
const beforeManifest = sourceManifest();
const compiled = babel
  .transformSync(runtimeSource, {
    filename: runtimePath,
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('react-native-worklets/plugin')],
    sourceMaps: false,
  })
  .code.replaceAll('new global.Error(', 'new globalThis.Error(');
const targets = await (
  await fetch(`${options.metro}/json/list`, {
    signal: AbortSignal.timeout(5000),
  })
).json();
const matching = targets.filter(target =>
  target.title?.includes(options.target),
);
if (matching.length !== 1)
  throw new Error(
    `Expected one target matching ${options.target}; found ${matching.length}`,
  );
const target = matching[0];
const socket = new WebSocket(target.webSocketDebuggerUrl, {
  origin: options.metro,
});
await new Promise((accept, reject) => {
  const timeout = setTimeout(
    () => reject(new Error('CDP connection timed out')),
    5000,
  );
  socket.once('open', () => {
    clearTimeout(timeout);
    accept();
  });
  socket.once('error', error => {
    clearTimeout(timeout);
    reject(error);
  });
});
const pending = new Map();
const traceEvents = [];
const warnings = [];
let serial = 0;
let finishTrace;
const traceFinished = new Promise(accept => {
  finishTrace = accept;
});
socket.on('message', data => {
  const message = JSON.parse(String(data));
  if (message.id) {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timeout);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.accept(message.result);
  } else if (message.method === 'Tracing.dataCollected')
    traceEvents.push(...message.params.value);
  else if (message.method === 'Tracing.tracingComplete')
    finishTrace(message.params);
  else if (
    message.method === 'Runtime.consoleAPICalled' &&
    ['warning', 'error'].includes(message.params.type)
  )
    warnings.push(message.params);
});
const send = (method, params = {}, timeoutMs = 15000) =>
  new Promise((accept, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { accept, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression, timeoutMs) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
let taskSequence = 0;
const evaluateAsync = async (expression, timeoutMs = 15000) => {
  const id = ++taskSequence;
  await evaluate(
    `(() => {
    const task = { id: ${id}, status: 'pending' };
    globalThis.__layoutDndPerfTask = task;
    Promise.resolve().then(() => (${expression})).then(
      value => { if (globalThis.__layoutDndPerfTask === task) {
        task.value = value; task.status = 'complete';
      } },
      error => { if (globalThis.__layoutDndPerfTask === task) {
        task.error = String(error); task.stack = error?.stack; task.status = 'error';
      } },
    );
    return true;
  })()`,
    Math.min(timeoutMs, 5000),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await evaluate(
      'globalThis.__layoutDndPerfTask',
      Math.min(5000, deadline - Date.now()),
    );
    if (task?.id !== id)
      throw new Error('Diagnostic task was replaced by another run');
    if (task.status === 'complete') return task.value;
    if (task.status === 'error')
      throw new Error(`${task.error}\n${task.stack ?? ''}`);
    await new Promise(accept => setTimeout(accept, 150));
  }
  throw new Error(`Diagnostic task ${id} timed out after ${timeoutMs} ms`);
};
const bounded = (promise, timeoutMs) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Tracing completion timed out')),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
let tracing = false;
let result;
let failure;
try {
  await send('Runtime.enable');
  await evaluate(compiled);
  await evaluateAsync(
    `globalThis.__layoutDndPerf.prepare(${JSON.stringify(options)})`,
    options.warmupMs + 12000,
  );
  if (options.trace) {
    await send('Tracing.start', {
      categories:
        'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler,v8.execute,blink.user_timing',
    });
    tracing = true;
  }
  result = await evaluateAsync('globalThis.__layoutDndPerf.run()', 45000);
  const cadence = assessRafCadence(
    result.activity?.frames ?? [],
    result.activity?.monitor,
  );
  result.scenarioValid = result.valid;
  result.metrics = { jsRaf: cadence };
  result.metricValid = cadence.valid;
  result.valid = result.scenarioValid && result.metricValid;
  result.stages = excludeInvalidRafMetrics(result.stages, cadence);
} catch (error) {
  failure = String(error);
} finally {
  if (tracing) {
    try {
      await send('Tracing.end');
      await bounded(traceFinished, 10000);
    } catch (error) {
      failure ??= String(error);
    }
  }
  try {
    await evaluateAsync('globalThis.__layoutDndPerf?.dispose()', 5000);
  } catch (error) {
    failure ??= String(error);
  }
  const manifest = sourceManifest();
  if (JSON.stringify(beforeManifest) !== JSON.stringify(manifest))
    failure ??= 'Library source changed during the sample; rerun without HMR';
  const artifact = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    options,
    target: { title: target.title, description: target.description },
    sourceSha256: manifest,
    runtimeSha256: createHash('sha256').update(runtimeSource).digest('hex'),
    valid: !failure && result?.valid === true,
    scenarioValid: !failure && result?.scenarioValid === true,
    metricValid: result?.metricValid ?? false,
    failure,
    result,
    warnings,
    traceEvents,
    limitations: [
      'Development runtime with CDP/monitor overhead.',
      options.trace
        ? 'CPU tracing enabled; tracing itself can add substantial overhead.'
        : 'CPU tracing disabled for this sample.',
      'Driver calls actual UI gesture callbacks; it does not exercise touch recognition.',
      'JS rAF gaps are not display FPS.',
    ],
  };
  writeFileSync(options.output, `${JSON.stringify(artifact)}\n`);
  socket.close();
  for (const task of pending.values()) clearTimeout(task.timeout);
  console.log(
    JSON.stringify(
      {
        output: options.output,
        valid: artifact.valid,
        scenarioValid: artifact.scenarioValid,
        metricValid: artifact.metricValid,
        metrics: result?.metrics,
        failure,
        stages: result?.stages,
        assertions: result?.assertions,
        warnings: warnings.length,
        events: traceEvents.length,
      },
      null,
      2,
    ),
  );
  if (!artifact.valid) process.exitCode = 1;
}
