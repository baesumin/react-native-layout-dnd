import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRafCadence, excludeInvalidRafMetrics } from './metrics.mjs';

const framesFrom = gaps => {
  let elapsed = 0;
  return gaps.map(gapMs => {
    const fromWall = Math.floor(elapsed);
    elapsed += gapMs;
    return { fromWall, wall: Math.floor(elapsed), gapMs };
  });
};

test('60/120/240 Hz and isolated catch-up callbacks remain valid', () => {
  for (const hz of [60, 120, 240]) {
    const gaps = Array.from({ length: hz * 3 }, () => 1000 / hz);
    gaps[0] = 0.1;
    gaps[12] = 0.5;
    assert.equal(assessRafCadence(framesFrom(gaps)).valid, true);
  }
});

test('slow or entirely blocked stages remain valid performance observations', () => {
  const result = assessRafCadence(framesFrom([16.7, 1100, 16.7, 700, 16.7]));
  assert.equal(result.valid, true);
});

test('a timer-speed rAF chain cannot masquerade as excellent frame pacing', () => {
  const result = assessRafCadence(
    framesFrom([...Array(72400).fill(0.02), 170, 100]),
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some(reason => reason.includes('32 consecutive')));
  assert.ok(result.reasons.some(reason => reason.includes('240 callbacks/s')));
});

test('sustained rapid cadence is rejected even without 32 consecutive tiny gaps', () => {
  const gaps = Array.from({ length: 1000 }, (_, index) =>
    index % 10 === 0 ? 3 : 1.1,
  );
  const result = assessRafCadence(framesFrom(gaps));
  assert.equal(result.longestSubMillisecondRun, 0);
  assert.equal(result.valid, false);
});

test('overlapping monitors and changed scheduling functions are disclosed', () => {
  const frames = framesFrom([16.7, 16.7]);
  frames[1].fromWall = 0;
  assert.equal(assessRafCadence(frames).valid, false);
  assert.equal(
    assessRafCadence(framesFrom([16.7]), { requestFunctionChanged: true })
      .valid,
    false,
  );
});

test('a stopped runaway monitor remains invalid after retaining a short sample', () => {
  assert.equal(
    assessRafCadence(framesFrom([16.7]), {
      stoppedReason: 'monitor stopped after rapid callbacks',
    }).valid,
    false,
  );
});

test('invalid timings are excluded while scenario/commit evidence stays intact', () => {
  const stage = {
    name: 'drag',
    reactCommits: 9,
    jsRafSamples: 72000,
    jsRafP95Ms: 0.04,
    jsRafMaxMs: 170,
    jsRafOver33: 2,
    jsRafOverlappingMaxMs: 170,
    jsRafOverlappingOver33: 3,
  };
  const [excluded] = excludeInvalidRafMetrics([stage], {
    valid: false,
    reasons: ['invalid cadence'],
  });
  assert.equal(excluded.reactCommits, 9);
  assert.equal(excluded.jsRafSamples, 72000);
  assert.equal(excluded.jsRafMetricsValid, false);
  assert.equal(excluded.jsRafP95Ms, null);
  assert.equal(excluded.jsRafOverlappingOver33, null);
  assert.equal(stage.jsRafP95Ms, 0.04);
});
