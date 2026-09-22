#!/usr/bin/env node
// Attribute sampled CPU time of a target function by ancestor stacks in a
// trace.mjs artifact (`--trace true`). Inclusive samples overlap; do not sum.
// Usage:
//   node scripts/perf/attribute.mjs <trace.json> --stacks <name> [--depth 12] [--top 20]
//   node scripts/perf/attribute.mjs <trace.json> --anon [--top 40]
//   node scripts/perf/attribute.mjs <trace.json> --callers <name> [--top 20]
//   node scripts/perf/attribute.mjs <trace.json> --self-under <name> [--top 30]   (self time of frames beneath <name>)
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.shift();
let top = 20;
let depth = 12;
let mode = null;
let name = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--top') top = Number(args[++i]);
  else if (args[i] === '--depth') depth = Number(args[++i]);
  else if (args[i] === '--stacks') { mode = 'stacks'; name = args[++i]; }
  else if (args[i] === '--anon') mode = 'anon';
  else if (args[i] === '--callers') { mode = 'callers'; name = args[++i]; }
  else if (args[i] === '--self-under') { mode = 'self-under'; name = args[++i]; }
}
const artifact = JSON.parse(readFileSync(file, 'utf8'));
const events = artifact.traceEvents ?? [];
const profiles = new Map();
const key = e => JSON.stringify([e.pid, e.tid, e.id ?? e.id2]);
for (const e of events) {
  if (e.name !== 'Profile' && e.name !== 'ProfileChunk') continue;
  const k = key(e);
  if (!profiles.has(k)) profiles.set(k, { nodes: new Map(), chunks: [] });
  const p = profiles.get(k);
  const d = e.args?.data;
  if (e.name === 'ProfileChunk' && d?.cpuProfile) {
    p.chunks.push(d);
    for (const n of d.cpuProfile.nodes ?? []) p.nodes.set(n.id, n);
  }
}
const urls = new Set();
const frameName = node => node?.callFrame?.functionName || '(anonymous)';
const frameLoc = node => {
  if (!node?.callFrame?.url) return '';
  urls.add(node.callFrame.url);
  return `@${(node.callFrame.lineNumber ?? 0) + 1}`;
};
const label = node => {
  const n = frameName(node);
  return n === '(anonymous)' ? `(anon${frameLoc(node)})` : n;
};
const add = (map, k, w) => map.set(k, (map.get(k) ?? 0) + w);
const stacks = new Map();
const callers = new Map();
const anonSelf = new Map();
const anonIncl = new Map();
const selfUnder = new Map();
let targetUs = 0;
let totalUs = 0;
for (const { nodes, chunks } of profiles.values()) {
  for (const node of nodes.values())
    for (const childId of node.children ?? []) {
      const child = nodes.get(childId);
      if (child && child.parent === undefined) child.parent = node.id;
    }
  for (const chunk of chunks) {
    const ids = chunk.cpuProfile.samples ?? [];
    for (let i = 0; i < ids.length; i++) {
      const w = chunk.timeDeltas?.[i];
      if (!Number.isFinite(w) || w < 0) continue;
      totalUs += w;
      const stack = [];
      const visited = new Set();
      for (let n = nodes.get(ids[i]); n && !visited.has(n.id); n = nodes.get(n.parent)) {
        visited.add(n.id);
        stack.push(n);
      }
      if (mode === 'anon') {
        const leaf = stack[0];
        if (leaf && frameName(leaf) === '(anonymous)') add(anonSelf, `(anon${frameLoc(leaf)})`, w);
        const seen = new Set();
        for (const n of stack)
          if (frameName(n) === '(anonymous)') {
            const loc = `(anon${frameLoc(n)})`;
            if (!seen.has(loc)) { seen.add(loc); add(anonIncl, loc, w); }
          }
        continue;
      }
      let idx = -1;
      for (let j = 0; j < stack.length; j++) if (frameName(stack[j]) === name) idx = j;
      if (idx < 0) continue;
      targetUs += w;
      if (mode === 'callers') {
        const parent = stack[idx + 1];
        add(callers, parent ? label(parent) : '(root)', w);
      } else if (mode === 'stacks') {
        const chain = [];
        for (let j = idx + 1; j < stack.length && chain.length < depth; j++) {
          const l = label(stack[j]);
          // collapse React internals noise a little
          if (/^(runWithFiberInDEV|_loop|arrayPrototype\w+|react_stack_bottom_frame)$/.test(l)) continue;
          chain.push(l);
        }
        add(stacks, chain.join(' < '), w);
      } else if (mode === 'self-under') {
        // self time of the leaf frame when <name> is on the stack
        add(selfUnder, label(stack[0]), w);
      }
    }
  }
}
const ms = us => (us / 1000).toFixed(1);
const print = (title, map, limit = top) => {
  console.log(`\n== ${title} ==`);
  for (const [k, v] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit))
    console.log(`${ms(v).padStart(8)} ms  ${k}`);
};
console.log(`file=${file.split('/').pop()} totalSampled=${ms(totalUs)} ms mode=${mode} name=${name ?? ''}`);
if (mode === 'anon') {
  print('anonymous frames by SELF', anonSelf);
  print('anonymous frames by INCLUSIVE', anonIncl);
} else if (mode === 'callers') {
  console.log(`inclusive(${name})=${ms(targetUs)} ms`);
  print(`immediate callers of ${name}`, callers);
} else if (mode === 'stacks') {
  console.log(`inclusive(${name})=${ms(targetUs)} ms`);
  print(`ancestor stacks of ${name} (nearest first)`, stacks);
} else if (mode === 'self-under') {
  console.log(`inclusive(${name})=${ms(targetUs)} ms`);
  print(`self time of leaf frames under ${name}`, selfUnder);
}
console.log(`\nbundle urls: ${[...urls].join(' | ')}`);
