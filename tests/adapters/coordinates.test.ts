import {
  contentRectToScreen,
  contentToScreen,
  screenRectToContent,
  screenToContent,
  validateRectMeasurement,
} from '../../src/adapters/coordinates';
import type {
  LayoutPoint,
  MeasurementFreshness,
  RectMeasurement,
  ZoneCoordinateContext,
} from '../../src/contracts';

function context(): ZoneCoordinateContext {
  return {
    viewport: {
      source: 'measured',
      space: 'screen',
      revision: 4,
      timestampMs: 100,
      rect: { x: 20, y: 80, width: 200, height: 300 },
    },
    scrollOffset: { x: 10, y: 150 },
  };
}

describe('screen and content coordinates', () => {
  it('round-trips points with horizontal and vertical scrolling', () => {
    const frame = context();
    const result = screenToContent({ x: 65, y: 125 }, frame, { revision: 4 });
    expect(result).toEqual({ valid: true, value: { x: 55, y: 195 } });
    if (!result.valid) return;
    expect(contentToScreen(result.value, frame, { revision: 4 })).toEqual({
      valid: true,
      value: { x: 65, y: 125 },
    });
  });

  it('updates stationary-pointer content coordinates after scrolling without changing revision', () => {
    const frame = context();
    expect(screenToContent({ x: 20, y: 80 }, frame, { revision: 4 })).toEqual({
      valid: true,
      value: { x: 10, y: 150 },
    });
    frame.scrollOffset.y = 350;
    expect(screenToContent({ x: 20, y: 80 }, frame, { revision: 4 })).toEqual({
      valid: true,
      value: { x: 10, y: 350 },
    });
  });

  it('keeps offscreen content and negative bounce offsets instead of clamping', () => {
    const frame = context();
    frame.scrollOffset = { x: -10, y: -30 };
    expect(screenToContent({ x: 20, y: 80 }, frame, { revision: 4 })).toEqual({
      valid: true,
      value: { x: -10, y: -30 },
    });
    expect(
      contentToScreen({ x: 400, y: 2000 }, frame, { revision: 4 }),
    ).toEqual({ valid: true, value: { x: 430, y: 2110 } });
  });

  it('converts estimated item rectangles without falsely making them measured', () => {
    const measurement: RectMeasurement<'content'> = {
      source: 'estimated',
      space: 'content',
      revision: 4,
      timestampMs: 110,
      rect: { x: 40, y: 2000, width: 60, height: 95 },
    };
    Object.freeze(measurement.rect);
    Object.freeze(measurement);
    const result = contentRectToScreen(measurement, context(), { revision: 4 });
    expect(result).toEqual({
      valid: true,
      value: {
        ...measurement,
        space: 'screen',
        rect: { x: 50, y: 1930, width: 60, height: 95 },
      },
    });
    if (!result.valid) return;
    expect(
      screenRectToContent(result.value, context(), { revision: 4 }),
    ).toEqual({ valid: true, value: measurement });
  });

  it('rejects stale item rectangles even when the viewport is current', () => {
    const measurement: RectMeasurement<'content'> = {
      source: 'measured',
      space: 'content',
      revision: 3,
      timestampMs: 100,
      rect: { x: 0, y: 0, width: 60, height: 95 },
    };
    expect(
      contentRectToScreen(measurement, context(), { revision: 4 }),
    ).toEqual({ valid: false, reason: 'stale-measurement' });
  });

  it('rejects stale viewport measurements instead of applying old positions to a new layout', () => {
    expect(
      screenToContent({ x: 10, y: 10 }, context(), { revision: 5 }),
    ).toEqual({ valid: false, reason: 'stale-measurement' });
    expect(
      screenToContent({ x: 10, y: 10 }, context(), { revision: 3 }),
    ).toEqual({ valid: false, reason: 'stale-measurement' });
  });

  it.each([
    null,
    [],
    {},
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
    { x: '0', y: 0 },
  ])('rejects malformed points: %p', point => {
    expect(
      screenToContent(point as unknown as LayoutPoint, context(), {
        revision: 4,
      }),
    ).toEqual({ valid: false, reason: 'invalid-coordinate' });
  });

  it('rejects nonfinite arithmetic results', () => {
    const frame = context();
    frame.viewport.rect.x = -Number.MAX_VALUE;
    expect(
      screenToContent({ x: Number.MAX_VALUE, y: 0 }, frame, { revision: 4 }),
    ).toEqual({ valid: false, reason: 'invalid-coordinate' });
  });

  it.each([
    null,
    { ...context(), scrollOffset: { x: NaN, y: 0 } },
    { ...context(), viewport: { ...context().viewport, source: 'estimated' } },
    { ...context(), viewport: { ...context().viewport, space: 'content' } },
  ])('rejects unmeasured or malformed screen frames: %p', frame => {
    expect(
      screenToContent({ x: 0, y: 0 }, frame as ZoneCoordinateContext, {
        revision: 4,
      }),
    ).toEqual({ valid: false, reason: 'invalid-context' });
  });
});

describe('measurement freshness', () => {
  it('checks age boundaries in the supplied monotonic clock domain', () => {
    const measurement = context().viewport;
    expect(
      validateRectMeasurement(measurement, {
        revision: 4,
        nowMs: 150,
        maxAgeMs: 50,
      }),
    ).toEqual({ valid: true, value: measurement });
    expect(
      validateRectMeasurement(measurement, {
        revision: 4,
        nowMs: 151,
        maxAgeMs: 50,
      }),
    ).toEqual({ valid: false, reason: 'stale-measurement' });
    expect(
      validateRectMeasurement(measurement, {
        revision: 4,
        nowMs: 99,
        maxAgeMs: 50,
      }),
    ).toEqual({ valid: false, reason: 'stale-measurement' });
  });

  it.each([
    null,
    {},
    { revision: -1 },
    { revision: 4.5 },
    { revision: 4, nowMs: 200 },
    { revision: 4, maxAgeMs: 20 },
    { revision: 4, nowMs: Infinity, maxAgeMs: 20 },
    { revision: 4, nowMs: 200, maxAgeMs: -1 },
  ])('rejects incomplete or malformed freshness criteria: %p', freshness => {
    expect(
      validateRectMeasurement(
        context().viewport,
        freshness as MeasurementFreshness,
      ),
    ).toEqual({ valid: false, reason: 'invalid-freshness' });
  });

  it.each([
    null,
    {},
    { ...context().viewport, revision: -1 },
    { ...context().viewport, timestampMs: -1 },
    { ...context().viewport, source: 'cached' },
    { ...context().viewport, rect: { x: 0, y: 0, width: 0, height: 10 } },
    {
      ...context().viewport,
      rect: { x: 0, y: 0, width: 10, height: Infinity },
    },
  ])('rejects malformed measurements: %p', measurement => {
    expect(
      validateRectMeasurement(measurement as RectMeasurement, { revision: 4 }),
    ).toEqual({ valid: false, reason: 'invalid-measurement' });
  });
});
