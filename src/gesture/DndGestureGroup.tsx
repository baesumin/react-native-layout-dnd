import { useLayoutEffect, useMemo, useRef } from 'react';
import type { HostInstance } from 'react-native';
import {
  GestureStateManager,
  usePanGesture,
  type PanGestureConfig,
} from 'react-native-gesture-handler';
import {
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { constrainDragPoint } from '../adapters/scroll';
import {
  EMPTY_DND_MOTION,
  measureDndRect,
  pointInRect,
  readListViewports,
  type DndMotion,
  type DndRuntime,
} from '../runtime/dndRuntime';
import {
  createTargetChannel as createChannel,
  type GestureGroupProps,
  type PublishedTargetChannel,
} from './gestureGrouping';

export type DndGestureRuntime = Pick<
  DndRuntime,
  | 'motion'
  | 'token'
  | 'zones'
  | 'disabled'
  | 'rootRef'
  | 'begin'
  | 'move'
  | 'release'
  | 'dragAxis'
  | 'activationDelayMs'
  | 'gestureConfigRevision'
  | 'frameDriven'
> & {
  enabled: SharedValue<boolean>;
  revision: number | SharedValue<number>;
  prepareRelease?(state: DndMotion): void;
};

/**
 * UI-thread hit target of one registered handle. The host keeps the object
 * identical while its registration is unchanged, so Worklets reuses the
 * serialized copy when the group's target list is published again.
 */
export type DndHandleTarget = {
  id: number;
  itemId: string;
  zoneId: string;
  ref: AnimatedRef<HostInstance>;
  sourceRef: AnimatedRef<HostInstance>;
  disabled: boolean;
};

/** Delivers a group's hit targets without re-rendering the group. */
export function createTargetChannel(
  initial: readonly DndHandleTarget[],
): PublishedTargetChannel<DndHandleTarget> {
  return createChannel(initial);
}

export type DndGestureGroupProps = GestureGroupProps<
  DndGestureRuntime,
  DndHandleTarget
>;

/**
 * One native Pan serves every handle that shares a gesture relation signature.
 * The recognizer belongs to the Provider, so a source cell can leave the
 * virtualized window or remount without touching the active gesture; the hit
 * target list only decides which handle an initial touch may activate.
 */
export function DndGestureGroup({
  groupId,
  relations,
  channel,
  runtime,
  publish,
}: DndGestureGroupProps) {
  const ownToken = useSharedValue(0);
  const ownHandle = useSharedValue(-1);
  const uiTargets = useSharedValue<readonly DndHandleTarget[]>(channel.targets);
  const publishedTargets = useRef(channel.targets);
  useLayoutEffect(() => {
    const sync = (targets: readonly DndHandleTarget[]) => {
      if (publishedTargets.current === targets) return;
      publishedTargets.current = targets;
      uiTargets.set(targets);
    };
    sync(channel.targets);
    return channel.subscribe(sync);
  }, [channel, uiTargets]);
  const {
    motion,
    token,
    zones,
    disabled: providerDisabled,
    rootRef,
    begin,
    move,
    release,
    prepareRelease,
    dragAxis,
    revision,
    activationDelayMs,
    gestureConfigRevision,
    frameDriven,
    enabled,
  } = runtime;
  const config = useMemo<PanGestureConfig>(() => {
    const currentRevision = () => {
      'worklet';
      return typeof revision === 'number' ? revision : revision.get();
    };
    // Every provider-owned recognizer receives the initial root touch. Find the
    // enabled handle under the pointer before measuring the root or any scroll
    // viewport; a handle that does not contain the pointer costs one measure.
    const hit = (
      x: number,
      y: number,
      committedRevision: number,
    ): DndHandleTarget | null => {
      'worklet';
      if (!Number.isFinite(x) || !Number.isFinite(y) || providerDisabled.get())
        return null;
      const pointer = { x, y };
      const list = uiTargets.get();
      let target: DndHandleTarget | null = null;
      for (let index = 0; index < list.length; index++) {
        const candidate = list[index]!;
        if (candidate.disabled) continue;
        const handle = measureDndRect(candidate.ref);
        if (handle && pointInRect(pointer, handle)) {
          target = candidate;
          break;
        }
      }
      if (!target) return null;
      const root = measureDndRect(rootRef);
      if (!root || !pointInRect(pointer, root)) return null;
      const sourceZoneId = target.zoneId;
      const source = zones.get().find(zone => zone.zoneId === sourceZoneId);
      if (
        !source ||
        source.revision !== committedRevision ||
        (source.kind === 'list' && !Number.isFinite(source.offset.get()))
      )
        return null;
      const viewport = measureDndRect(source.ref);
      return viewport && pointInRect(pointer, viewport) ? target : null;
    };
    const owned = (current: DndMotion) => {
      'worklet';
      return (
        current.phase === 'dragging' &&
        current.token === ownToken.get() &&
        current.handleId === ownHandle.get()
      );
    };
    const cancelOwned = () => {
      'worklet';
      const current = motion.get();
      if (!owned(current)) return;
      const next: DndMotion = {
        ...current,
        phase: 'released',
        seq: current.seq + 1,
      };
      motion.set(next);
      scheduleOnRN(release, next, true);
    };
    return {
      block: relations?.block,
      requireToFail: relations?.requireToFail,
      simultaneousWith: relations?.simultaneousWith,
      enabled,
      maxPointers: 1,
      activateAfterLongPress: activationDelayMs,
      cancelsTouchesInView: true,
      onBegin: () => {
        'worklet';
        ownToken.set(0);
        ownHandle.set(-1);
      },
      onTouchesDown: event => {
        'worklet';
        if (event.numberOfTouches > 1) {
          cancelOwned();
          GestureStateManager.fail(event.handlerTag);
          return;
        }
        const touch = event.changedTouches[0];
        // Root-attached recognizers must restrict activation to a visible handle.
        if (
          !touch ||
          !hit(touch.absoluteX, touch.absoluteY, currentRevision()) ||
          motion.get().phase !== 'idle'
        ) {
          GestureStateManager.fail(event.handlerTag);
        }
      },
      onActivate: event => {
        'worklet';
        // Read committed state at activation without rebuilding the native
        // handler when another drop advances the layout revision.
        const committedRevision = currentRevision();
        const target =
          motion.get().phase === 'idle'
            ? hit(event.absoluteX, event.absoluteY, committedRevision)
            : null;
        if (!target) {
          GestureStateManager.fail(event.handlerTag);
          return;
        }
        const source = measureDndRect(target.sourceRef);
        const root = measureDndRect(rootRef);
        if (!source || !root) {
          GestureStateManager.fail(event.handlerTag);
          return;
        }
        const nextToken = token.get() + 1;
        token.set(nextToken);
        ownToken.set(nextToken);
        ownHandle.set(target.id);
        const pointer = { x: event.absoluteX, y: event.absoluteY };
        const next: DndMotion = {
          ...EMPTY_DND_MOTION,
          token: nextToken,
          handleId: target.id,
          seq: 1,
          phase: 'dragging',
          itemId: target.itemId,
          sourceZoneId: target.zoneId,
          revision: committedRevision,
          pointer,
          origin: pointer,
          axis: dragAxis,
          activationDelayMs,
          configRevision: gestureConfigRevision,
          grip: { x: pointer.x - source.x, y: pointer.y - source.y },
          width: source.width,
          height: source.height,
          root,
          zones: readListViewports(zones.get()),
        };
        motion.set(next);
        scheduleOnRN(begin, next);
      },
      onUpdate: event => {
        'worklet';
        if (
          !Number.isFinite(event.absoluteX) ||
          !Number.isFinite(event.absoluteY)
        )
          return;
        const current = motion.get();
        if (!owned(current)) return;
        if (providerDisabled.get() || event.numberOfPointers > 1) {
          cancelOwned();
          return;
        }
        const root = frameDriven ? current.root : measureDndRect(rootRef);
        const next: DndMotion = {
          ...current,
          pointer: constrainDragPoint(
            { x: event.absoluteX, y: event.absoluteY },
            current.origin,
            current.axis,
          ),
          zones: frameDriven
            ? current.zones
            : root
              ? readListViewports(zones.get())
              : [],
          root: root ?? current.root,
          seq: current.seq + 1,
        };
        motion.set(next);
        if (!frameDriven) scheduleOnRN(move, next);
      },
      onDeactivate: event => {
        'worklet';
        if (
          !Number.isFinite(event.absoluteX) ||
          !Number.isFinite(event.absoluteY)
        ) {
          cancelOwned();
          return;
        }
        const current = motion.get();
        if (!owned(current)) return;
        if (event.canceled || providerDisabled.get()) {
          cancelOwned();
          return;
        }
        const root = measureDndRect(rootRef);
        const next: DndMotion = {
          ...current,
          phase: 'released',
          pointer: constrainDragPoint(
            { x: event.absoluteX, y: event.absoluteY },
            current.origin,
            current.axis,
          ),
          zones: root ? readListViewports(zones.get()) : [],
          root: root ?? current.root,
          seq: current.seq + 1,
        };
        if (root) prepareRelease?.(next);
        motion.set(next);
        scheduleOnRN(release, next, root ? false : 'measure-failed');
      },
      onTouchesCancel: cancelOwned,
      onFinalize: () => {
        'worklet';
        cancelOwned();
        ownToken.set(0);
        ownHandle.set(-1);
      },
    };
  }, [
    relations,
    motion,
    token,
    zones,
    providerDisabled,
    rootRef,
    begin,
    move,
    release,
    prepareRelease,
    dragAxis,
    revision,
    activationDelayMs,
    gestureConfigRevision,
    frameDriven,
    enabled,
    ownToken,
    ownHandle,
    uiTargets,
  ]);
  const pan = usePanGesture(config);
  useLayoutEffect(() => {
    publish(groupId, pan);
  }, [groupId, pan, publish]);
  useLayoutEffect(() => () => publish(groupId, null), [groupId, publish]);
  return null;
}
