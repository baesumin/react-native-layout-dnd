import { useEffect, useState } from 'react';
import {
  makeMutable,
  startMapper,
  stopMapper,
  withTiming,
  type ReduceMotion,
  type SharedValue,
} from 'react-native-reanimated';

import {
  presentationRect,
  type DndPresentation,
} from '../runtime/dndPresentation';
import type { DndRuntime } from '../runtime/dndRuntime';

type ListCellMotionArgs = {
  zoneId: string;
  itemId: string;
  vertical: boolean;
  fixed: boolean;
  /** Committed main-axis start used when no validated candidate rect exists. */
  start: number | SharedValue<number>;
  /** Committed main-axis size used when no validated candidate rect exists. */
  size: number;
  presentation: DndRuntime['presentation'];
  revision: number | SharedValue<number>;
  hiddenItemId: SharedValue<string | null>;
  animation: DndRuntime['animation'];
  /**
   * JS view of the geometry the Provider has already scheduled for the UI
   * runtime. It is read once at mount for the initial style; the UI mapper
   * adopts the actual UI geometry on its first run without animating.
   */
  initial: {
    presentation: DndPresentation | undefined;
    revision: number;
    start: number;
  };
};

type ListCellMotion = {
  /** Animated main-axis content start in list content coordinates. */
  animatedStart: SharedValue<number>;
  /** Validated main-axis size for authoritative (fixed) item sizes. */
  targetSize: SharedValue<number>;
};

/** Resolve the mount-time geometry from JS-owned data without UI reads. */
function resolveInitialListCellGeometry({
  initial,
  zoneId,
  itemId,
  vertical,
  fixed,
  size,
}: Pick<
  ListCellMotionArgs,
  'initial' | 'zoneId' | 'itemId' | 'vertical' | 'fixed' | 'size'
>): { start: number; size: number } {
  const rect =
    initial.presentation !== undefined &&
    initial.presentation.revision === initial.revision
      ? presentationRect(initial.presentation, zoneId, itemId)
      : undefined;
  return {
    start: rect ? (vertical ? rect.y : rect.x) : initial.start,
    size: fixed && rect ? (vertical ? rect.height : rect.width) : size,
  };
}

/**
 * One UI mapper per cell selects the validated candidate rect and animates the
 * content start. Mount reads no UI state: a synchronous shared-value read from
 * JS blocks on the UI runtime and copies the whole presentation table. The
 * first UI evaluation snaps to the UI geometry so a stale estimate never
 * becomes the start of a timing animation.
 */
export function useListCellMotion(args: ListCellMotionArgs): ListCellMotion {
  const [values] = useState(() => {
    const geometry = resolveInitialListCellGeometry(args);
    return {
      // NaN marks a target the UI runtime has not evaluated yet.
      target: makeMutable(Number.NaN),
      animatedStart: makeMutable(geometry.start),
      targetSize: makeMutable(geometry.size),
    };
  });
  const { target, animatedStart, targetSize } = values;
  const {
    zoneId,
    itemId,
    vertical,
    fixed,
    start,
    size,
    presentation,
    revision,
    hiddenItemId,
  } = args;
  const { durationMs, reduceMotion } = args.animation;
  useEffect(() => {
    const mapper = () => {
      'worklet';
      const current = presentation?.get();
      const committed =
        typeof revision === 'number' ? revision : revision.get();
      const rect =
        current !== undefined && current.revision === committed
          ? presentationRect(current, zoneId, itemId)
          : undefined;
      const nextTarget = rect
        ? vertical
          ? rect.y
          : rect.x
        : typeof start === 'number'
          ? start
          : start.get();
      if (fixed) {
        const nextSize = rect ? (vertical ? rect.height : rect.width) : size;
        if (targetSize.get() !== nextSize) targetSize.set(nextSize);
      }
      const hidden = hiddenItemId.get() === itemId;
      const previous = target.get();
      if (Number.isNaN(previous)) {
        // Adopt validated UI geometry without animating away from the JS
        // estimate that produced the initial style.
        target.set(nextTarget);
        animatedStart.set(nextTarget);
        return;
      }
      if (previous !== nextTarget) {
        target.set(nextTarget);
        animatedStart.set(
          hidden
            ? nextTarget
            : withTiming(nextTarget, {
                duration: durationMs,
                reduceMotion: reduceMotion as ReduceMotion,
              }),
        );
      } else if (hidden && animatedStart.get() !== nextTarget) {
        // The hidden source sits exactly in its slot; stop in-flight motion.
        animatedStart.set(nextTarget);
      }
    };
    const mapperId = startMapper(
      mapper,
      [presentation, revision, start, hiddenItemId],
      [
        target as SharedValue<unknown>,
        animatedStart as SharedValue<unknown>,
        targetSize as SharedValue<unknown>,
      ],
    );
    return () => stopMapper(mapperId);
  }, [
    animatedStart,
    durationMs,
    fixed,
    hiddenItemId,
    itemId,
    presentation,
    reduceMotion,
    revision,
    size,
    start,
    target,
    targetSize,
    vertical,
    zoneId,
  ]);
  return { animatedStart, targetSize };
}
