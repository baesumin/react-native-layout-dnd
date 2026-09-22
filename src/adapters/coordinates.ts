import type {
  CoordinateResult,
  LayoutPoint,
  LayoutRect,
  MeasurementFreshness,
  RectMeasurement,
  ZoneCoordinateContext,
} from '../contracts';

import { isRecord } from '../engine/validation';

function isPoint(value: unknown): value is LayoutPoint {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function isRect(value: unknown): value is LayoutRect {
  return (
    isPoint(value) &&
    'width' in value &&
    typeof value.width === 'number' &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    'height' in value &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Estimates remain estimates after validation; callers must inspect source. */
export function validateRectMeasurement<Measurement extends RectMeasurement>(
  measurement: Measurement,
  freshness: MeasurementFreshness,
): CoordinateResult<Measurement> {
  if (
    !isRecord(freshness) ||
    !Number.isSafeInteger(freshness.revision) ||
    freshness.revision < 0 ||
    (freshness.nowMs === undefined) !== (freshness.maxAgeMs === undefined) ||
    (freshness.nowMs !== undefined &&
      (!isNonnegativeFinite(freshness.nowMs) ||
        !isNonnegativeFinite(freshness.maxAgeMs)))
  ) {
    return { valid: false, reason: 'invalid-freshness' };
  }
  if (
    !isRecord(measurement) ||
    (measurement.source !== 'measured' && measurement.source !== 'estimated') ||
    (measurement.space !== 'screen' && measurement.space !== 'content') ||
    !isRect(measurement.rect) ||
    !Number.isSafeInteger(measurement.revision) ||
    measurement.revision < 0 ||
    !isNonnegativeFinite(measurement.timestampMs)
  ) {
    return { valid: false, reason: 'invalid-measurement' };
  }
  if (
    measurement.revision !== freshness.revision ||
    (freshness.nowMs !== undefined &&
      (measurement.timestampMs > freshness.nowMs ||
        freshness.nowMs - measurement.timestampMs > freshness.maxAgeMs!))
  ) {
    return { valid: false, reason: 'stale-measurement' };
  }
  return { valid: true, value: measurement };
}

function validateContext(
  context: ZoneCoordinateContext,
  freshness: MeasurementFreshness,
): CoordinateResult<ZoneCoordinateContext> {
  if (!isRecord(context) || !isPoint(context.scrollOffset)) {
    return { valid: false, reason: 'invalid-context' };
  }
  const measurement = validateRectMeasurement(context.viewport, freshness);
  if (!measurement.valid) return measurement;
  if (
    measurement.value.source !== 'measured' ||
    measurement.value.space !== 'screen'
  ) {
    return { valid: false, reason: 'invalid-context' };
  }
  return { valid: true, value: context };
}

function convertPoint(
  point: LayoutPoint,
  context: ZoneCoordinateContext,
  freshness: MeasurementFreshness,
  direction: 'to-content' | 'to-screen',
): CoordinateResult<LayoutPoint> {
  if (!isPoint(point)) return { valid: false, reason: 'invalid-coordinate' };
  const validation = validateContext(context, freshness);
  if (!validation.valid) return validation;
  const { rect } = context.viewport;
  const { scrollOffset } = context;
  const value =
    direction === 'to-content'
      ? {
          x: point.x - rect.x + scrollOffset.x,
          y: point.y - rect.y + scrollOffset.y,
        }
      : {
          x: point.x - scrollOffset.x + rect.x,
          y: point.y - scrollOffset.y + rect.y,
        };
  return isPoint(value)
    ? { valid: true, value }
    : { valid: false, reason: 'invalid-coordinate' };
}

/** Convert absolute screen pixels to zone content pixels using the current offset. */
export function screenToContent(
  point: LayoutPoint,
  context: ZoneCoordinateContext,
  freshness: MeasurementFreshness,
): CoordinateResult<LayoutPoint> {
  return convertPoint(point, context, freshness, 'to-content');
}

export function contentToScreen(
  point: LayoutPoint,
  context: ZoneCoordinateContext,
  freshness: MeasurementFreshness,
): CoordinateResult<LayoutPoint> {
  return convertPoint(point, context, freshness, 'to-screen');
}

export function screenRectToContent(
  measurement: RectMeasurement<'screen'>,
  context: ZoneCoordinateContext,
  freshness: MeasurementFreshness,
): CoordinateResult<RectMeasurement<'content'>> {
  const validation = validateRectMeasurement(measurement, freshness);
  if (!validation.valid) return validation;
  if (measurement.space !== 'screen')
    return { valid: false, reason: 'invalid-measurement' };
  const converted = screenToContent(measurement.rect, context, freshness);
  return converted.valid
    ? {
        valid: true,
        value: {
          ...measurement,
          space: 'content',
          rect: { ...measurement.rect, ...converted.value },
        },
      }
    : converted;
}

export function contentRectToScreen(
  measurement: RectMeasurement<'content'>,
  context: ZoneCoordinateContext,
  freshness: MeasurementFreshness,
): CoordinateResult<RectMeasurement<'screen'>> {
  const validation = validateRectMeasurement(measurement, freshness);
  if (!validation.valid) return validation;
  if (measurement.space !== 'content')
    return { valid: false, reason: 'invalid-measurement' };
  const converted = contentToScreen(measurement.rect, context, freshness);
  return converted.valid
    ? {
        valid: true,
        value: {
          ...measurement,
          space: 'screen',
          rect: { ...measurement.rect, ...converted.value },
        },
      }
    : converted;
}
