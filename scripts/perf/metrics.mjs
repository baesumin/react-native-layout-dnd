// These checks identify a broken sampling cadence, not a slow application.
// Long gaps remain valid observations; a self-scheduled monitor must not spin.
export function assessRafCadence(frames, monitor = {}) {
  const reasons = [];
  let subMillisecondIntervals = 0;
  let underTwoMillisecondIntervals = 0;
  let consecutiveFast = 0;
  let longestFastRun = 0;
  let malformed = false;
  let discontinuous = false;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (
      !Number.isFinite(frame.gapMs) ||
      frame.gapMs < 0 ||
      !Number.isFinite(frame.fromWall) ||
      !Number.isFinite(frame.wall) ||
      frame.wall < frame.fromWall
    )
      malformed = true;
    if (index && frame.fromWall !== frames[index - 1].wall)
      discontinuous = true;
    if (frame.gapMs >= 0 && frame.gapMs < 1) {
      subMillisecondIntervals++;
      consecutiveFast++;
      longestFastRun = Math.max(longestFastRun, consecutiveFast);
    } else consecutiveFast = 0;
    if (frame.gapMs >= 0 && frame.gapMs < 2) underTwoMillisecondIntervals++;
  }
  const elapsedMs = frames.length ? frames.at(-1).wall - frames[0].fromWall : 0;
  const callbacksPerSecond =
    elapsedMs > 0 ? (frames.length * 1000) / elapsedMs : null;
  if (!frames.length) reasons.push('No JS rAF observations were recorded');
  if (malformed) reasons.push('JS rAF timestamps are invalid or move backward');
  if (discontinuous)
    reasons.push(
      'JS rAF observations do not form one consecutive callback chain',
    );
  if (longestFastRun >= 32)
    reasons.push('At least 32 consecutive JS rAF intervals were below 1 ms');
  if (
    elapsedMs >= 250 &&
    callbacksPerSecond > 240 &&
    underTwoMillisecondIntervals / frames.length > 0.5
  )
    reasons.push(
      'JS rAF exceeded 240 callbacks/s with most intervals below 2 ms',
    );
  if (monitor.stoppedReason) reasons.push(monitor.stoppedReason);
  if (monitor.requestFunctionChanged)
    reasons.push(
      'The JS requestAnimationFrame function changed during capture',
    );
  return {
    valid: reasons.length === 0,
    reasons,
    samples: frames.length,
    elapsedMs,
    callbacksPerSecond,
    subMillisecondIntervals,
    longestSubMillisecondRun: longestFastRun,
  };
}

export function excludeInvalidRafMetrics(stages, cadence) {
  return stages.map(stage => {
    const result = { ...stage, jsRafMetricsValid: cadence.valid };
    if (!cadence.valid) {
      result.jsRafMetricInvalid = cadence.reasons;
      // Keep sample counts for diagnosis, but do not expose invalid timing or
      // over-budget counts as comparable performance results.
      for (const key of Object.keys(result))
        if (/^jsRaf.*(?:Ms|Over33)$/.test(key)) result[key] = null;
      if (result.jsRaf)
        result.jsRaf = {
          ...result.jsRaf,
          p95Ms: null,
          maxMs: null,
          over33Ms: null,
        };
    }
    return result;
  });
}
