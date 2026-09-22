import type { LayoutPoint } from '../contracts';

/** The permitted drag direction is independent of a list's orientation. */
export type DragAxis = 'x' | 'y' | 'both';

export type AutoScrollOptions = {
  enabled?: boolean;
  /** Edge activation distance in logical pixels. Defaults to 48. */
  edgeThreshold?: number;
  /** Maximum speed in logical pixels per second. Defaults to 600. */
  maxSpeed?: number;
};

/** One axis of a measured scroll viewport, using logical pixels throughout. */
export type AutoScrollInput = {
  /** Absolute screen coordinate on the scrolling axis. */
  pointer: number;
  viewportStart: number;
  viewportSize: number;
  /** Current native scroll offset; temporary bounce offsets are accepted. */
  offset: number;
  contentSize: number;
  deltaTimeMs: number;
  options?: AutoScrollOptions;
};

export type AutoScrollResult =
  | {
      valid: true;
      /** Bounded native scroll target, including when velocity is zero. */
      offset: number;
      /** Actual speed after clamping, in logical pixels per second. */
      velocity: number;
    }
  | { valid: false; reason: 'invalid-input' | 'invalid-options' };

export type AutoScrollOptionsValidationResult =
  { valid: true } | { valid: false; reason: 'invalid-options' };

/** Validate public options before activating a gesture or executing a frame. */
export function validateAutoScrollOptions(
  options?: AutoScrollOptions,
): AutoScrollOptionsValidationResult {
  'worklet';
  if (
    options !== undefined &&
    (!options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
      (options.edgeThreshold !== undefined &&
        (!Number.isFinite(options.edgeThreshold) ||
          options.edgeThreshold <= 0)) ||
      (options.maxSpeed !== undefined &&
        (!Number.isFinite(options.maxSpeed) || options.maxSpeed < 0)))
  )
    return { valid: false, reason: 'invalid-options' };
  return { valid: true };
}

/**
 * Compute one frame of edge scrolling for either orientation. Adapters should
 * call scrollTo only for nonzero velocity, preserving native bounce while idle.
 * Call only during an active drag, and re-read its candidate after scrolling.
 */
export function computeAutoScroll(input: AutoScrollInput): AutoScrollResult {
  'worklet';
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Number.isFinite(input.pointer) ||
    !Number.isFinite(input.viewportStart) ||
    !Number.isFinite(input.viewportSize) ||
    input.viewportSize <= 0 ||
    !Number.isFinite(input.offset) ||
    !Number.isFinite(input.contentSize) ||
    input.contentSize < 0 ||
    !Number.isFinite(input.deltaTimeMs) ||
    input.deltaTimeMs < 0
  )
    return { valid: false, reason: 'invalid-input' };

  const { options } = input;
  const validation = validateAutoScrollOptions(options);
  if (!validation.valid) return validation;

  const maximum = Math.max(0, input.contentSize - input.viewportSize);
  const offset = Math.max(0, Math.min(maximum, input.offset));
  const idle: AutoScrollResult = { valid: true, offset, velocity: 0 };
  const pointer = input.pointer - input.viewportStart;
  if (!Number.isFinite(pointer))
    return { valid: false, reason: 'invalid-input' };

  if (
    options?.enabled === false ||
    pointer < 0 ||
    pointer > input.viewportSize ||
    maximum === 0 ||
    input.deltaTimeMs === 0
  )
    return idle;

  // Cap overlapping edge bands at the midpoint so tiny viewports do not bias
  // toward the first edge. The exact midpoint has no preferred direction.
  const threshold = Math.min(
    options?.edgeThreshold ?? 48,
    input.viewportSize / 2,
  );
  if (threshold === 0) return idle;
  const trailingDistance = input.viewportSize - pointer;
  const direction =
    pointer < threshold ? -1 : trailingDistance < threshold ? 1 : 0;
  if (direction === 0) return idle;

  const distance = direction < 0 ? pointer : trailingDistance;
  const speed = (options?.maxSpeed ?? 600) * (1 - distance / threshold);
  // A paused/resumed frame must not skip a large portion of the list.
  const seconds = Math.min(input.deltaTimeMs, 64) / 1000;
  if (seconds === 0 || speed === 0) return idle;
  const nextOffset = Math.max(
    0,
    Math.min(maximum, offset + direction * speed * seconds),
  );
  const movement = nextOffset - offset;
  return {
    valid: true,
    offset: nextOffset,
    velocity:
      movement === 0
        ? 0
        : direction * Math.min(speed, Math.abs(movement / seconds)),
  };
}

/** Project a validated screen point onto the configured axis through origin. */
export function constrainDragPoint(
  point: LayoutPoint,
  origin: LayoutPoint,
  axis: DragAxis,
): LayoutPoint {
  'worklet';
  return {
    x: axis === 'y' ? origin.x : point.x,
    y: axis === 'x' ? origin.y : point.y,
  };
}
