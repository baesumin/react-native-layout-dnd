import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  type ReduceMotion,
  type FrameInfo,
  scrollTo,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { runOnUISync, scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { computeAutoScroll } from '../adapters/scroll';
import type {
  DndItem,
  LayoutLocation,
  LayoutRect,
  LayoutValidationIssue,
} from '../contracts';
import { createListTargetIndex } from '../engine/listIndex';
import type { DndProposal } from '../controller/dndState';
import {
  type DndDragEndEvent,
  DndSessionCoordinator,
} from '../controller/dndSession';
import { sameGestureRelations } from '../gesture/gestureConfig';
import {
  DEFAULT_ACTIVATION_DELAY_MS,
  DEFAULT_SEARCH_BUDGET,
} from '../defaults';
import {
  resolveGridMovementPolicy,
  validateGridMovementPolicy,
} from '../engine/movementPolicy';
import { isPositiveInteger } from '../engine/validation';
import { DEFAULT_GRID_MOTION, resolveGridMotion } from '../pointer/motion';
import {
  DndItemContext,
  DndRuntimeContext,
  EMPTY_DND_MOTION,
  measureDndRect,
  pointInRect,
  readListViewports,
  type DndMotion,
  type DndHandleRegistration,
  type DndRuntime,
  type ZoneRegistration,
  type UiZoneRegistration,
} from '../runtime/dndRuntime';
import {
  resolveLayoutTarget,
  isLayoutTargetVisible,
  prepareGridTarget,
} from '../pointer/layoutTarget';
import { itemRect } from '../pointer/geometry';
import {
  createZonePresentation,
  EMPTY_DND_PRESENTATION,
  presentationRect,
  type DndPresentation,
  type DndZonePresentation,
} from '../runtime/dndPresentation';
import {
  sameLayoutTarget,
  uiLayoutTarget,
  type DndTargetSession,
} from '../pointer/dndTarget';
import {
  interpolateSettlementRect,
  settlementDestination,
  settlementTarget,
} from '../runtime/dndSettlement';
import type { DndProviderProps, ListItemRenderArgs } from './dndTypes';
import type { CancelReason } from '../types';
import type { DndGestureRuntime } from '../gesture/DndGestureGroup';
import {
  createDndGestureRegistry,
  DndGestureHost,
} from '../gesture/DndGestureHost';
import { DndRenderStore } from '../runtime/dndRenderStore';

type RegisteredList = ZoneRegistration & {
  layoutVersion: number;
  identity: object;
  geometryKey: string | null;
};
type RegisteredHandle = {
  id: number;
  identity: object;
  registration: DndHandleRegistration;
  mounted: boolean;
};
type Settlement = {
  token: number;
  itemId: string;
  revision: number;
  from: LayoutRect;
  destination: LayoutRect | null;
  zone: UiZoneRegistration | null;
  contentRect: LayoutRect | null;
  itemRef: DndHandleRegistration['sourceRef'] | null;
  startedAt: number | null;
  animationStartedAt: number | null;
  animating: boolean;
  done: boolean;
  committed: boolean;
};
type RetainedPreview<T> = {
  token: number;
  item: DndItem<T>;
  sessionId: string;
  sourceZoneId: string;
  render(args: ListItemRenderArgs<unknown>): React.ReactNode;
  index: number;
  width: number;
  height: number;
};

function sameHandle(
  first: DndHandleRegistration,
  second: DndHandleRegistration,
): boolean {
  return (
    first.itemId === second.itemId &&
    first.zoneId === second.zoneId &&
    first.ref === second.ref &&
    first.sourceRef === second.sourceRef &&
    first.disabled === second.disabled &&
    sameGestureRelations(first.gestureRelations, second.gestureRelations)
  );
}

function geometryResized(previous: DndMotion | null, next: DndMotion): boolean {
  'worklet';
  return (
    !!previous &&
    (previous.root.width !== next.root.width ||
      previous.root.height !== next.root.height ||
      next.zones.some(measured => {
        const old = previous.zones.find(
          entry => entry.zoneId === measured.zoneId,
        );
        return (
          old &&
          (old.viewport.rect.width !== measured.viewport.rect.width ||
            old.viewport.rect.height !== measured.viewport.rect.height)
        );
      }))
  );
}

function targetEnvironmentChanged(previous: DndMotion | null, next: DndMotion) {
  'worklet';
  return (
    !previous ||
    previous.root.x !== next.root.x ||
    previous.root.y !== next.root.y ||
    previous.root.width !== next.root.width ||
    previous.root.height !== next.root.height ||
    previous.zones.length !== next.zones.length ||
    next.zones.some((zone, index) => {
      const old = previous.zones[index];
      return (
        !old ||
        old.zoneId !== zone.zoneId ||
        old.offset !== zone.offset ||
        old.layoutVersion !== zone.layoutVersion ||
        old.viewport.revision !== zone.viewport.revision ||
        old.viewport.rect.x !== zone.viewport.rect.x ||
        old.viewport.rect.y !== zone.viewport.rect.y ||
        old.viewport.rect.width !== zone.viewport.rect.width ||
        old.viewport.rect.height !== zone.viewport.rect.height
      );
    })
  );
}

function sameUiZone(a: UiZoneRegistration, b: UiZoneRegistration) {
  return (
    a.kind === b.kind &&
    a.zoneId === b.zoneId &&
    a.revision === b.revision &&
    a.layoutVersion === b.layoutVersion &&
    a.ref === b.ref &&
    ((a.kind === 'grid' &&
      b.kind === 'grid' &&
      a.targetGrid === b.targetGrid) ||
      (b.kind === 'list' &&
        a.kind === 'list' &&
        a.targetIndex === b.targetIndex &&
        a.orientation === b.orientation &&
        a.offset === b.offset &&
        a.contentSize === b.contentSize &&
        a.autoScroll?.enabled === b.autoScroll?.enabled &&
        a.autoScroll?.edgeThreshold === b.autoScroll?.edgeThreshold &&
        a.autoScroll?.maxSpeed === b.autoScroll?.maxSpeed))
  );
}

// Worklets rewrites shared objects into accessors in development. Never share
// the coordinator's JS snapshot objects themselves with the UI runtime.
function copyLayoutTarget(target: LayoutLocation): LayoutLocation {
  return target.kind === 'grid'
    ? { ...target, position: { ...target.position } }
    : { ...target };
}

/** Shared gesture, session and overlay for grid, ScrollView and FlatList zones. */
export function DndProvider<T>({
  value,
  onChange,
  canDrop,
  onDragStart,
  onDragEnd,
  onDragSettled,
  onValidationError,
  onDiagnostic,
  responseTimeoutMs,
  getGridItemLayout,
  movementPolicy,
  searchBudget,
  disabled = false,
  activation = { delayMs: DEFAULT_ACTIVATION_DELAY_MS },
  dragAxis = 'both',
  motion: motionConfig,
  renderDragPreview,
  waitForDragPreviewReady = false,
  dragPreviewStyle,
  ref,
  children,
  style,
  onLayout,
  ...viewProps
}: DndProviderProps<T>) {
  const pixelRatio = PixelRatio.get();
  const motionOptions = resolveGridMotion(motionConfig);
  const durationMs = motionOptions.valid
    ? motionOptions.motion.durationMs
    : DEFAULT_GRID_MOTION.durationMs;
  const reduceMotion = motionOptions.valid
    ? motionOptions.motion.reduceMotion
    : DEFAULT_GRID_MOTION.reduceMotion;
  const animation = useMemo(
    () => ({ durationMs, reduceMotion }),
    [durationMs, reduceMotion],
  );
  const configValid =
    Number.isSafeInteger(activation?.delayMs) &&
    activation.delayMs >= 0 &&
    ['both', 'x', 'y'].includes(dragAxis) &&
    (canDrop === undefined || typeof canDrop === 'function') &&
    motionOptions.valid;
  const currentCanDrop = useRef(canDrop);
  const policyRevision = useRef(0);
  const committedValue = useRef(value);
  const currentVisibility = useRef<(proposal: DndProposal<T>) => boolean>(
    () => true,
  );
  const checkDrop = useCallback(
    (proposal: DndProposal<T>) =>
      currentVisibility.current(proposal)
        ? currentCanDrop.current
          ? currentCanDrop.current(proposal)
          : { allowed: true as const }
        : { allowed: false as const, reason: 'clipped-target' },
    [],
  );
  const [registryInvalid, setRegistryInvalid] = useState(false);
  const preview = useRef<RetainedPreview<T> | null>(null);
  // `onDragEnd` is the coordinator's. `onDragSettled` repeats the event once
  // the retained preview of that session has finished settling (finishPreview),
  // or at once when no preview is retained; a new session or unmount flushes it.
  const currentDragEnd = useRef(onDragEnd);
  currentDragEnd.current = onDragEnd;
  const currentDragSettled = useRef(onDragSettled);
  currentDragSettled.current = onDragSettled;
  const pendingSettled = useRef<DndDragEndEvent<T>[]>([]);
  const reportSettled = useCallback((event: DndDragEndEvent<T>) => {
    try {
      currentDragSettled.current?.(event);
    } catch (error) {
      console.error('[LayoutDnD] onDragSettled callback failed', error);
    }
  }, []);
  const flushSettled = useCallback(() => {
    const queued = pendingSettled.current;
    if (queued.length === 0) return;
    pendingSettled.current = [];
    for (const event of queued) reportSettled(event);
  }, [reportSettled]);
  const endSession = useCallback(
    (event: DndDragEndEvent<T>) => {
      const deferred = preview.current?.sessionId === event.sessionId;
      if (deferred) pendingSettled.current.push(event);
      try {
        currentDragEnd.current?.(event);
      } finally {
        if (!deferred) reportSettled(event);
      }
    },
    [reportSettled],
  );
  const [coordinator] = useState(
    () =>
      new DndSessionCoordinator({
        value,
        onChange,
        canDrop: checkDrop,
        onDragStart,
        onDragEnd: endSession,
        onValidationError,
        onDiagnostic,
        responseTimeoutMs,
        getGridItemLayout,
        movementPolicy,
        searchBudget,
        disabled: disabled || !configValid,
      }),
  );
  const [renderStore] = useState(() => new DndRenderStore(coordinator));
  const snapshot = useSyncExternalStore(
    renderStore.subscribeProvider,
    renderStore.getProviderSnapshot,
  );
  const motion = useSharedValue(EMPTY_DND_MOTION);
  const nativeRevision = useSharedValue(snapshot.value?.revision ?? 0);
  const presentation = useSharedValue<DndPresentation>(EMPTY_DND_PRESENTATION);
  const appliedPresentationGeneration = useSharedValue(0);
  const presentationGeneration = useRef(0);
  const settlement = useSharedValue<Settlement | null>(null);
  const settleProgress = useSharedValue(0);
  const pendingMove = useSharedValue<{ token: number; seq: number } | null>(
    null,
  );
  const settlingToken = useRef<number | null>(null);
  const settlingRevision = useRef<number | null>(null);
  const refreshSettlement = useRef<() => void>(() => {});
  const targetSession = useSharedValue<DndTargetSession>({
    token: 0,
    policyRevision: 0,
    gridItems: {},
  });
  const sentTarget = useSharedValue<{
    state: DndMotion | null;
    target: LayoutLocation | null;
    policyRevision: number;
  }>({ state: null, target: null, policyRevision: -1 });
  const zones = useSharedValue<UiZoneRegistration[]>([]);
  const publishedZones = useRef<UiZoneRegistration[]>([]);
  const uiDisabled = useSharedValue(disabled || !configValid);
  const uiEnabled = useDerivedValue(() => !uiDisabled.get());
  // JS reads of a shared value block on the UI runtime whenever the UI has
  // written it since the last read. Motion changes every frame; these numbers
  // change only at activation, release and cleanup, so JS reads stay cached.
  const uiDragToken = useDerivedValue(() => {
    const state = motion.get();
    return state.phase === 'dragging' ? state.token : -1;
  });
  const uiActiveHandle = useDerivedValue(() => {
    const state = motion.get();
    return state.phase === 'idle' || state.handleId === null
      ? -1
      : state.handleId;
  });
  const token = useSharedValue(0);
  const rootRef = useAnimatedRef();
  const handles = useRef(new Map<object, RegisteredHandle>());
  const nextHandleId = useRef(0);
  const [gestureRegistry] = useState(createDndGestureRegistry);
  const registry = useRef(new Map<object, RegisteredList>());
  const issues = useRef(new Map<string, string>());
  const observer = useRef(onValidationError);
  const mounted = useRef(true);
  const handlePublication = useRef({
    queued: false,
    generation: 0,
    prune: false,
  }).current;
  const currentConfig = useRef({ dragAxis, delayMs: activation?.delayMs });
  const policyValid = validateGridMovementPolicy(movementPolicy).valid;
  const nativeSettingsKey = JSON.stringify([
    searchBudget === undefined
      ? DEFAULT_SEARCH_BUDGET
      : isPositiveInteger(searchBudget)
        ? searchBudget
        : null,
    responseTimeoutMs === undefined
      ? 2000
      : isPositiveInteger(responseTimeoutMs)
        ? responseTimeoutMs
        : null,
    policyValid ? resolveGridMovementPolicy(movementPolicy) : null,
  ]);
  const committedNativeSettings = useRef({
    key: nativeSettingsKey,
    mapper: getGridItemLayout,
    revision: 0,
  });
  const gestureConfigRevision =
    committedNativeSettings.current.key === nativeSettingsKey &&
    committedNativeSettings.current.mapper === getGridItemLayout
      ? committedNativeSettings.current.revision
      : committedNativeSettings.current.revision + 1;
  const bridge = useRef<{
    token: number;
    sessionId: string | null;
    state: DndMotion | null;
    policyRevision: number;
  }>({ token: 0, sessionId: null, state: null, policyRevision: 0 });
  const [retainedPreview, setRetainedPreview] =
    useState<RetainedPreview<T> | null>(null);
  // Readiness belongs to the session, not to pointer requests or target
  // validity. The default preview needs no application acknowledgement.
  const [readyPreviewSessionId, setReadyPreviewSessionId] = useState<
    string | null
  >(null);
  const previewReady =
    !waitForDragPreviewReady ||
    !renderDragPreview ||
    readyPreviewSessionId === snapshot.sessionId;
  const handlePreviewReady = useCallback(() => {
    const current = coordinator.getSnapshot();
    if (!mounted.current || current.sessionId === null) return;
    setReadyPreviewSessionId(current.sessionId);
  }, [coordinator]);
  useImperativeHandle(
    ref,
    () => ({
      invalidateGeometry: () => coordinator.cancel('geometry-changed'),
    }),
    [coordinator],
  );
  const rootLayout = useRef<{ width: number; height: number } | null>(null);
  const presentationCache = useRef(
    new Map<
      string,
      {
        zone: object;
        layout: object;
        geometryKey: string | null;
        prepare: import('../runtime/dndRuntime').ListRegistration['prepareDisplay'];
        result: DndZonePresentation;
      }
    >(),
  );
  const lastPresentation = useRef<DndPresentation>(EMPTY_DND_PRESENTATION);
  const presentationSnapshot = useCallback(() => lastPresentation.current, []);
  const prepareReleaseRef =
    useRef<DndGestureRuntime['prepareRelease']>(undefined);
  const publishPresentation = useCallback(() => {
    const current = coordinator.getSnapshot();
    const display = current.displayValue;
    const next: DndPresentation = {
      token: bridge.current.token,
      revision: current.value?.revision ?? 0,
      zones: {},
      ...((current.phase === 'dragging' ||
        current.phase === 'awaiting-response') &&
      current.validity === 'valid' &&
      current.target
        ? {
            releaseTarget: {
              target: copyLayoutTarget(current.target),
              policyRevision: policyRevision.current,
              ...(current.phase === 'awaiting-response'
                ? { releasedSeq: current.seq }
                : {}),
            },
          }
        : {}),
    };
    // Idle cells already own committed geometry. Sending every rect again for
    // each newly measured virtual cell copies the entire list onto UI.
    if (display && (current.phase !== 'idle' || preview.current !== null))
      for (const registration of registry.current.values()) {
        if (
          registration.revision !== current.value?.revision ||
          (registration.kind === 'list' &&
            registration.dataIdentity &&
            registration.dataIdentity !== current.value?.items)
        )
          continue;
        const zone = display.zones.find(
          entry => entry.id === registration.zoneId,
        );
        if (!zone) continue;
        const prepare =
          registration.kind === 'list'
            ? registration.prepareDisplay
            : undefined;
        const cached = presentationCache.current.get(zone.id);
        let result: DndZonePresentation | null = null;
        if (
          cached?.zone === zone &&
          cached.layout === registration.layout &&
          cached.geometryKey === registration.geometryKey &&
          cached.prepare === prepare
        ) {
          result = cached.result;
        } else if (registration.kind === 'list' && zone.kind === 'list') {
          result =
            registration.prepareDisplay?.(zone, display.revision) ?? null;
        } else if (registration.kind === 'grid' && zone.kind === 'grid') {
          result = createZonePresentation(
            zone.placements.map(
              placement =>
                [
                  placement.itemId,
                  itemRect(
                    placement.position,
                    placement.span,
                    registration.geometry,
                    registration.cells,
                  ),
                ] as const,
            ),
            cached?.result,
          );
        }
        if (result) {
          next.zones[`#${zone.id}`] = result;
          presentationCache.current.set(zone.id, {
            zone,
            layout: registration.layout,
            geometryKey: registration.geometryKey,
            prepare,
            result,
          });
        }
      }
    const previous = lastPresentation.current;
    for (const zoneId of presentationCache.current.keys()) {
      if (!next.zones[`#${zoneId}`]) presentationCache.current.delete(zoneId);
    }
    if (
      previous.token === next.token &&
      previous.revision === next.revision &&
      previous.releaseTarget?.policyRevision ===
        next.releaseTarget?.policyRevision &&
      previous.releaseTarget?.releasedSeq === next.releaseTarget?.releasedSeq &&
      sameLayoutTarget(
        previous.releaseTarget?.target ?? null,
        next.releaseTarget?.target ?? null,
      ) &&
      Object.keys(previous.zones).length === Object.keys(next.zones).length &&
      Object.keys(next.zones).every(
        key => previous.zones[key] === next.zones[key],
      )
    )
      return;
    lastPresentation.current = next;
    const generation = ++presentationGeneration.current;
    const animateRelease =
      current.phase === 'awaiting-response'
        ? prepareReleaseRef.current
        : undefined;
    const applyPresentation = () => {
      'worklet';
      const state = motion.get();
      if (
        state.token === next.token &&
        generation >= appliedPresentationGeneration.get()
      ) {
        appliedPresentationGeneration.set(generation);
        presentation.set(next);
        if (state.phase === 'released') animateRelease?.(state);
      }
    };
    // A final validated target must reach UI before React's synchronous commit
    // work delays the normal worklet microtask batch. This only shares geometry;
    // animation and native measurement still run on subsequent UI frames.
    if (animateRelease) runOnUISync(applyPresentation);
    else scheduleOnUI(applyPresentation);
  }, [coordinator, motion, presentation, appliedPresentationGeneration]);
  useLayoutEffect(
    () => coordinator.subscribe(publishPresentation),
    [coordinator, publishPresentation],
  );

  const publishHandles = useCallback(() => {
    if (!mounted.current || handlePublication.queued) return;
    handlePublication.queued = true;
    const generation = handlePublication.generation;
    (
      globalThis as typeof globalThis & {
        queueMicrotask(callback: () => void): void;
      }
    ).queueMicrotask(() => {
      if (!mounted.current || handlePublication.generation !== generation)
        return;
      handlePublication.queued = false;
      if (handlePublication.prune) {
        handlePublication.prune = false;
        // UI activation precedes its queued JS begin. Read the native owner
        // once for the whole commit, keeping that recognizer through eviction.
        let activeHandle: number | undefined;
        for (const [identity, owner] of handles.current) {
          if (owner.mounted) continue;
          activeHandle ??= uiActiveHandle.get();
          if (activeHandle !== owner.id) handles.current.delete(identity);
        }
      }
      gestureRegistry.setOwners(Array.from(handles.current.values()));
    });
  }, [gestureRegistry, handlePublication, uiActiveHandle]);

  const registerHandle = useCallback(
    (registration: DndHandleRegistration, identity: object) => {
      const previous = handles.current.get(identity);
      const same =
        !!previous && sameHandle(previous.registration, registration);
      if (previous?.mounted && same) return;
      handles.current.set(identity, {
        id: previous?.id ?? ++nextHandleId.current,
        identity,
        // A cleanup/setup pair in one commit can reuse the same native owner.
        registration: same ? previous!.registration : registration,
        mounted: true,
      });
      publishHandles();
      refreshSettlement.current();
    },
    [publishHandles],
  );
  const unregisterHandle = useCallback(
    (identity: object) => {
      const previous = handles.current.get(identity);
      if (!previous || !previous.mounted) return;
      handles.current.set(identity, { ...previous, mounted: false });
      handlePublication.prune = true;
      publishHandles();
    },
    [handlePublication, publishHandles],
  );

  const reportIssues = useCallback(
    (owner: string, next: LayoutValidationIssue[]) => {
      const key = JSON.stringify(next);
      const old = issues.current.get(owner);
      if (next.length) issues.current.set(owner, key);
      else issues.current.delete(owner);
      if (!mounted.current) return;
      setRegistryInvalid(issues.current.size > 0);
      if (next.length && old !== key) {
        coordinator.cancel('disabled');
        try {
          observer.current?.(next);
        } catch (error) {
          console.error('[LayoutDnD] Validation callback failed', error);
        }
      }
    },
    [coordinator],
  );
  useLayoutEffect(() => {
    mounted.current = true;
    if (currentCanDrop.current !== canDrop || committedValue.current !== value)
      policyRevision.current++;
    committedValue.current = value;
    currentCanDrop.current = canDrop;
    const nextPolicyRevision = policyRevision.current;
    scheduleOnUI(() => {
      const current = targetSession.get();
      if (current.policyRevision !== nextPolicyRevision)
        targetSession.set({ ...current, policyRevision: nextPolicyRevision });
    });
    observer.current = onValidationError;
    if (
      currentConfig.current.dragAxis !== dragAxis ||
      currentConfig.current.delayMs !== activation?.delayMs
    )
      coordinator.cancel('input-changed');
    currentConfig.current = { dragAxis, delayMs: activation?.delayMs };
    committedNativeSettings.current = {
      key: nativeSettingsKey,
      mapper: getGridItemLayout,
      revision: gestureConfigRevision,
    };
    coordinator.commit({
      value,
      onChange,
      canDrop: checkDrop,
      onDragStart,
      onDragEnd: endSession,
      onValidationError,
      onDiagnostic,
      responseTimeoutMs,
      getGridItemLayout,
      movementPolicy,
      searchBudget,
      disabled:
        disabled || !configValid || registryInvalid || issues.current.size > 0,
    });
    nativeRevision.set(coordinator.getSnapshot().value?.revision ?? 0);
    uiDisabled.set(coordinator.getSnapshot().disabled);
    reportIssues(
      'provider-config',
      configValid
        ? []
        : [
            {
              code: 'invalid-configuration',
              message:
                'Drag axis, activation delay or motion configuration is invalid.',
            },
          ],
    );
  });
  const registeredByZone = useCallback(
    () =>
      new Map(
        Array.from(registry.current.values()).map(entry => [
          entry.zoneId,
          entry,
        ]),
      ),
    [],
  );
  const publishZones = useCallback(() => {
    const needsTargets =
      coordinator.getSnapshot().phase !== 'idle' || preview.current !== null;
    const entries = Array.from(registry.current.values());
    const unique = entries.filter(
      (entry, index) =>
        entries.findIndex(other => other.zoneId === entry.zoneId) === index,
    );
    const next: UiZoneRegistration[] = unique.map(entry =>
      entry.kind === 'list'
        ? {
            kind: 'list' as const,
            orientation: entry.orientation,
            zoneId: entry.zoneId,
            revision: entry.revision,
            layoutVersion: entry.layoutVersion,
            ref: entry.ref,
            offset: entry.offset,
            contentSize: entry.contentSize,
            autoScroll: entry.autoScroll,
            targetIndex: needsTargets ? entry.targetIndex : undefined,
          }
        : {
            kind: 'grid' as const,
            zoneId: entry.zoneId,
            revision: entry.revision,
            layoutVersion: entry.layoutVersion,
            ref: entry.ref,
            targetGrid: needsTargets ? entry.targetGrid : undefined,
          },
    );
    if (
      next.length !== publishedZones.current.length ||
      next.some(
        (entry, index) => !sameUiZone(entry, publishedZones.current[index]),
      )
    ) {
      publishedZones.current = next;
      zones.set(next);
    }
    reportIssues(
      'duplicate-zones',
      entries.length === unique.length
        ? []
        : [
            {
              code: 'duplicate-id',
              message:
                'Each zone can have only one mounted sortable component.',
            },
          ],
    );
  }, [coordinator, zones, reportIssues]);
  const registerZone = useCallback(
    (entry: ZoneRegistration, identity: object) => {
      const previous = registry.current.get(identity);
      const geometryKey =
        entry.kind === 'grid'
          ? JSON.stringify([entry.geometry, entry.cells, entry.pixelRatio])
          : null;
      if (previous && previous.geometryKey !== geometryKey) {
        const active = coordinator.getSnapshot();
        if (
          active.sourceZoneId === entry.zoneId ||
          active.targetZoneId === entry.zoneId
        )
          coordinator.cancel('geometry-changed');
      }
      const layoutVersion =
        (previous?.layoutVersion ?? 0) +
        Number(
          previous?.layout !== entry.layout ||
            previous?.geometryKey !== geometryKey,
        );
      registry.current.set(identity, {
        ...entry,
        identity,
        geometryKey,
        layoutVersion,
        ...(entry.kind === 'list'
          ? {
              targetIndex:
                previous?.kind === 'list' && previous.layout === entry.layout
                  ? previous.targetIndex
                  : createListTargetIndex(
                      entry.layout,
                      previous?.kind === 'list'
                        ? previous.targetIndex
                        : undefined,
                    ),
            }
          : {
              targetGrid: prepareGridTarget({ ...entry, layoutVersion }),
            }),
      });
      publishZones();
      publishPresentation();
      refreshSettlement.current();
    },
    [coordinator, publishZones, publishPresentation],
  );
  const unregisterZone = useCallback(
    (zoneId: string, identity: object) => {
      if (!registry.current.delete(identity)) return;
      publishZones();
      const current = coordinator.getSnapshot();
      if (current.sourceZoneId === zoneId || current.targetZoneId === zoneId)
        coordinator.cancel('zone-removed');
    },
    [coordinator, publishZones],
  );
  const cancel = useCallback(
    (reason: CancelReason) => coordinator.cancel(reason),
    [coordinator],
  );
  const targetFor = useCallback(
    (state: DndMotion) => {
      const current = coordinator.getSnapshot();
      return resolveLayoutTarget(
        state,
        registeredByZone(),
        current.gridItemLayouts,
        current.movementPolicy,
        current.target,
      );
    },
    [coordinator, registeredByZone],
  );
  currentVisibility.current = proposal => {
    const state = bridge.current.state;
    return (
      !!state &&
      isLayoutTargetVisible(
        state,
        registeredByZone(),
        proposal.to,
        coordinator.getSnapshot().gridItemLayouts,
      )
    );
  };
  const begin = useCallback(
    (state: DndMotion) => {
      if (!mounted.current) return;
      const latest = motion.get();
      if (latest.token !== state.token || latest.handleId !== state.handleId)
        return;
      if (bridge.current.sessionId && bridge.current.token === state.token)
        return;
      const owner =
        state.handleId === null
          ? undefined
          : Array.from(handles.current.values()).find(
              entry => entry.id === state.handleId,
            );
      const validOwner =
        state.handleId === null ||
        (!!owner &&
          !owner.registration.disabled &&
          owner.registration.itemId === state.itemId &&
          owner.registration.zoneId === state.sourceZoneId);
      const source = registeredByZone().get(state.sourceZoneId ?? '');
      const measurement = state.zones.find(
        entry => entry.zoneId === state.sourceZoneId,
      );
      flushSettled();
      const id =
        validOwner &&
        state.axis === currentConfig.current.dragAxis &&
        state.activationDelayMs === currentConfig.current.delayMs &&
        state.configRevision === committedNativeSettings.current.revision &&
        source &&
        measurement?.layoutVersion === source.layoutVersion &&
        measurement.viewport.revision === state.revision &&
        state.itemId
          ? coordinator.start(state.itemId, state.revision)
          : null;
      if (!id) {
        if (owner && !owner.mounted) {
          handles.current.delete(owner.identity);
          publishHandles();
        }
        const previousToken = bridge.current.token;
        const idlePresentation = lastPresentation.current;
        const idleGeneration = presentationGeneration.current;
        scheduleOnUI(() => {
          if (motion.get().token === state.token) {
            motion.set({ ...EMPTY_DND_MOTION, token: previousToken });
            if (idlePresentation.token === previousToken) {
              appliedPresentationGeneration.set(idleGeneration);
              presentation.set(idlePresentation);
            }
          }
        });
        return;
      }
      bridge.current = {
        token: state.token,
        sessionId: id,
        state,
        policyRevision: policyRevision.current,
      };
      preview.current = {
        token: state.token,
        item: coordinator
          .getSnapshot()
          .value!.items.find(item => item.id === state.itemId)!,
        sessionId: id,
        sourceZoneId: state.sourceZoneId!,
        render: source!.renderItem,
        index:
          source!.kind === 'list'
            ? (source!.layout.entries.find(
                entry => entry.itemId === state.itemId,
              )?.index ?? 0)
            : source!.layout.placements.findIndex(
                entry => entry.itemId === state.itemId,
              ),
        width: state.width,
        height: state.height,
      };
      setRetainedPreview(preview.current);
      publishZones();
      const initial = targetFor(state);
      // A zone measured before its registered layout reached the UI has no
      // position to offer yet; the first pointer packet supplies it.
      if (initial.target !== null || !initial.stale)
        coordinator.requestTarget(id, state.seq, initial.target);
      const current = coordinator.getSnapshot();
      const gridItems: DndTargetSession['gridItems'] = {};
      for (const [zoneId, recipe] of current.gridItemLayouts)
        gridItems[`#${zoneId}`] = recipe;
      const prepared: DndTargetSession = {
        token: state.token,
        policyRevision: policyRevision.current,
        gridItems,
        movementPolicy: current.movementPolicy,
      };
      const target = current.target ? copyLayoutTarget(current.target) : null;
      scheduleOnUI(() => {
        if (motion.get().token !== state.token) return;
        targetSession.set(prepared);
        sentTarget.set({
          state,
          target,
          policyRevision: prepared.policyRevision,
        });
      });
      publishPresentation();
    },
    [
      coordinator,
      motion,
      presentation,
      appliedPresentationGeneration,
      publishHandles,
      registeredByZone,
      targetFor,
      targetSession,
      sentTarget,
      publishPresentation,
      publishZones,
      flushSettled,
    ],
  );
  const move = useCallback(
    (state: DndMotion) => {
      try {
        const active = bridge.current;
        if (
          !mounted.current ||
          active.token !== state.token ||
          !active.sessionId
        )
          return;
        // A queued move can reach JS after the finger has already lifted.
        // Release validates its own final geometry; rendering this old preview
        // first only delays that validation behind another React commit.
        if (uiDragToken.get() !== state.token) return;
        if (
          !Number.isSafeInteger(state.seq) ||
          (active.state && state.seq <= active.state.seq)
        )
          return;
        if (geometryResized(active.state, state)) {
          coordinator.cancel('geometry-changed');
          return;
        }
        const resolved = targetFor(state);
        // The UI measured this zone before the layout version registered by
        // the last candidate reached it. Publishing an outside target here
        // would revert and re-apply the preview once per target change; keep
        // the current target until a packet with the new version arrives.
        if (resolved.target === null && resolved.stale) return;
        const refresh =
          targetEnvironmentChanged(active.state, state) ||
          active.policyRevision !== policyRevision.current;
        active.state = state;
        active.policyRevision = policyRevision.current;
        coordinator.requestTarget(
          active.sessionId,
          state.seq,
          resolved.target,
          {
            refresh,
          },
        );
      } finally {
        const { token: completedToken, seq } = state;
        scheduleOnUI(() => {
          const pending = pendingMove.get();
          if (pending?.token === completedToken && pending.seq === seq)
            pendingMove.set(null);
        });
      }
    },
    [coordinator, targetFor, pendingMove, uiDragToken],
  );
  const release = useCallback(
    (state: DndMotion, cancelled: boolean | CancelReason) => {
      const active = bridge.current;
      if (!mounted.current || active.token !== state.token || !active.sessionId)
        return;
      if (cancelled) {
        active.state = state;
        coordinator.cancel(
          typeof cancelled === 'string' ? cancelled : 'gesture-interrupted',
        );
        return;
      }
      if (geometryResized(active.state, state)) {
        active.state = state;
        coordinator.cancel('geometry-changed');
        return;
      }
      let finalState = state;
      const registrations = registeredByZone();
      const measurementsChanged = state.zones.some(measured => {
        const current = registrations.get(measured.zoneId);
        return (
          current?.revision === state.revision &&
          current.layoutVersion !== measured.layoutVersion
        );
      });
      if (measurementsChanged) {
        // A native size event may commit after onDeactivate captured viewports,
        // but before its queued RN release runs. Refresh that one snapshot;
        // accepting the old layout version would bypass final target validation.
        const measureZones: UiZoneRegistration[] = Array.from(
          registrations.values(),
          entry =>
            entry.kind === 'list'
              ? {
                  kind: 'list',
                  zoneId: entry.zoneId,
                  orientation: entry.orientation,
                  revision: entry.revision,
                  layoutVersion: entry.layoutVersion,
                  ref: entry.ref,
                  offset: entry.offset,
                  contentSize: entry.contentSize,
                }
              : {
                  kind: 'grid',
                  zoneId: entry.zoneId,
                  revision: entry.revision,
                  layoutVersion: entry.layoutVersion,
                  ref: entry.ref,
                },
        );
        const refreshed = runOnUISync(() => {
          'worklet';
          const root = measureDndRect(rootRef);
          if (!root) return null;
          const next = {
            ...state,
            root,
            zones: readListViewports(measureZones),
          };
          const native = motion.get();
          if (
            native.token === state.token &&
            native.phase === 'released' &&
            native.seq === state.seq
          )
            motion.set(next);
          return next;
        });
        if (!refreshed) {
          coordinator.cancel('measure-failed');
          return;
        }
        if (
          geometryResized(state, refreshed) ||
          geometryResized(active.state, refreshed)
        ) {
          coordinator.cancel('geometry-changed');
          return;
        }
        finalState = refreshed;
      }
      active.state = finalState;
      const final = targetFor(finalState);
      // Release keeps the target the user saw when only the layout version
      // published to the UI lags behind; the engine validates the index.
      coordinator.release(
        active.sessionId,
        finalState.seq,
        final.target === null && final.stale
          ? coordinator.getSnapshot().target
          : final.target,
      );
    },
    [coordinator, targetFor, registeredByZone, motion, rootRef],
  );

  const prepareRelease = useCallback(
    (state: DndMotion) => {
      'worklet';
      if (
        durationMs <= 0 ||
        uiDisabled.get() ||
        settlement.get() ||
        geometryResized(motion.get(), state)
      )
        return;
      const approved = presentation.get();
      const releaseTarget = approved.releaseTarget;
      const prepared = targetSession.get();
      const registered = zones.get();
      // Continue the already validated preview immediately on UI. Final
      // policy checks and asynchronous approval still gate the handoff.
      if (
        releaseTarget &&
        state.itemId !== null &&
        approved.token === state.token &&
        approved.revision === state.revision &&
        prepared.token === state.token &&
        releaseTarget.policyRevision === prepared.policyRevision &&
        (releaseTarget.releasedSeq === state.seq ||
          sameLayoutTarget(
            releaseTarget.target,
            uiLayoutTarget(state, registered, prepared, releaseTarget.target),
          ))
      ) {
        const zone = registered.find(
          entry => entry.zoneId === releaseTarget.target.zoneId,
        );
        const contentRect = presentationRect(
          approved,
          releaseTarget.target.zoneId,
          state.itemId,
        );
        if (zone && contentRect) {
          const next: Settlement = {
            token: state.token,
            itemId: state.itemId,
            revision: state.revision,
            from: {
              x: state.pointer.x - state.grip.x - state.root.x,
              y: state.pointer.y - state.grip.y - state.root.y,
              width: state.width,
              height: state.height,
            },
            destination: null,
            zone,
            contentRect,
            itemRef: null,
            startedAt: null,
            animationStartedAt: null,
            animating: false,
            done: false,
            committed: false,
          };
          settlement.set(next);
        }
      }
    },
    [
      durationMs,
      uiDisabled,
      settlement,
      presentation,
      targetSession,
      zones,
      motion,
    ],
  );

  useLayoutEffect(() => {
    prepareReleaseRef.current = prepareRelease;
  }, [prepareRelease]);

  const gestureRuntime = useMemo<DndGestureRuntime>(
    () => ({
      motion,
      frameDriven: true,
      token,
      zones,
      disabled: uiDisabled,
      enabled: uiEnabled,
      rootRef,
      begin,
      move,
      release,
      prepareRelease,
      dragAxis,
      revision: nativeRevision,
      activationDelayMs: configValid ? activation.delayMs : 0,
      gestureConfigRevision,
    }),
    [
      motion,
      token,
      zones,
      uiDisabled,
      uiEnabled,
      rootRef,
      begin,
      move,
      release,
      prepareRelease,
      dragAxis,
      nativeRevision,
      configValid,
      activation?.delayMs,
      gestureConfigRevision,
    ],
  );
  const finishPreview = useCallback(
    (finishedToken: number) => {
      if (bridge.current.token !== finishedToken) return;
      const native = motion.get();
      if (native.phase !== 'idle' && native.token !== finishedToken) return;
      bridge.current.sessionId = null;
      settlingToken.current = null;
      settlingRevision.current = null;
      preview.current = null;
      setRetainedPreview(null);
      publishZones();
      publishPresentation();
      let removed = false;
      for (const [identity, owner] of handles.current) {
        if (!owner.mounted) {
          handles.current.delete(identity);
          removed = true;
        }
      }
      if (removed) publishHandles();
      flushSettled();
    },
    [motion, publishHandles, publishZones, publishPresentation, flushSettled],
  );

  refreshSettlement.current = () => {
    const retained = preview.current;
    const current = coordinator.getSnapshot();
    if (
      !retained ||
      settlingToken.current !== retained.token ||
      current.phase !== 'idle'
    )
      return;
    const zone = current.value?.zones.find(entry =>
      entry.kind === 'list'
        ? entry.itemIds.includes(retained.item.id)
        : entry.placements.some(item => item.itemId === retained.item.id),
    );
    const registration =
      zone &&
      Array.from(registry.current.values()).find(
        entry =>
          entry.zoneId === zone.id &&
          entry.revision === current.value?.revision,
      );
    let contentRect: LayoutRect | null = null;
    if (registration?.kind === 'list' && zone?.kind === 'list') {
      contentRect =
        registration.layout.entries.find(
          entry => entry.itemId === retained.item.id,
        )?.rect ?? null;
    } else if (registration?.kind === 'grid' && zone?.kind === 'grid') {
      const placement = zone.placements.find(
        entry => entry.itemId === retained.item.id,
      );
      if (placement)
        contentRect = itemRect(
          placement.position,
          placement.span,
          registration.geometry,
          registration.cells,
        );
    }
    const uiZone =
      publishedZones.current.find(entry => entry.zoneId === zone?.id) ?? null;
    const owner = Array.from(handles.current.values()).find(
      entry =>
        entry.mounted &&
        entry.registration.itemId === retained.item.id &&
        entry.registration.zoneId === zone?.id,
    );
    const itemRef = owner?.registration.sourceRef ?? null;
    const ownerToken = retained.token;
    scheduleOnUI(() => {
      const work = settlement.get();
      if (work?.token === ownerToken) {
        settlement.set({ ...work, zone: uiZone, contentRect, itemRef });
      }
    });
  };

  useFrameCallback(
    useCallback(
      (info: FrameInfo) => {
        'worklet';
        const state = motion.get();
        const work = settlement.get();
        if (work && work.token === state.token) {
          const startedAt = work.startedAt ?? info.timestamp;
          if (work.startedAt === null) settlement.set({ ...work, startedAt });
          const root = measureDndRect(rootRef);
          const viewport = work.zone ? measureDndRect(work.zone.ref) : null;
          const nativeRect = work.itemRef ? measureDndRect(work.itemRef) : null;
          const offset =
            work.zone?.kind === 'list' ? work.zone.offset.get() : 0;
          const geometry =
            root &&
            viewport &&
            work.contentRect &&
            work.zone?.revision === work.revision
              ? {
                  root,
                  viewport,
                  contentRect: work.contentRect,
                  nativeRect,
                  scrollOffset:
                    work.zone.kind === 'list' &&
                    work.zone.orientation === 'horizontal'
                      ? { x: offset, y: 0 }
                      : { x: 0, y: offset },
                  pixelRatio,
                }
              : null;
          const destination = geometry ? settlementTarget(geometry) : null;
          const ready = geometry ? settlementDestination(geometry) : null;
          if (
            work.committed &&
            ((geometry && !destination) ||
              (root &&
                (root.width !== state.root.width ||
                  root.height !== state.root.height)) ||
              info.timestamp - startedAt >
                (work.animating ? durationMs + 750 : 750))
          ) {
            cancelAnimation(settleProgress);
            settlement.set(null);
            motion.set({ ...EMPTY_DND_MOTION, token: work.token });
            scheduleOnRN(finishPreview, work.token);
          } else if (destination && !work.animating) {
            settlement.set({
              ...work,
              startedAt,
              animationStartedAt: info.timestamp,
              destination,
              animating: true,
            });
            settleProgress.set(0);
            settleProgress.set(
              withTiming(
                1,
                {
                  duration: durationMs,
                  reduceMotion: reduceMotion as ReduceMotion,
                },
                finished => {
                  const latest = settlement.get();
                  if (finished && latest?.token === work.token)
                    settlement.set({ ...latest, done: true });
                },
              ),
            );
          } else if (
            destination &&
            work.animating &&
            work.destination &&
            (Math.abs(destination.x - work.destination.x) > 1 / pixelRatio ||
              Math.abs(destination.y - work.destination.y) > 1 / pixelRatio ||
              Math.abs(destination.width - work.destination.width) >
                1 / pixelRatio ||
              Math.abs(destination.height - work.destination.height) >
                1 / pixelRatio)
          ) {
            const progress = settleProgress.get();
            const from =
              interpolateSettlementRect(
                work.from,
                work.destination,
                progress,
              ) ?? work.from;
            cancelAnimation(settleProgress);
            settlement.set({
              ...work,
              startedAt,
              from,
              destination,
              done: false,
              animationStartedAt: work.done
                ? info.timestamp
                : work.animationStartedAt,
            });
            settleProgress.set(0);
            settleProgress.set(
              withTiming(
                1,
                {
                  duration: work.done
                    ? durationMs
                    : Math.max(
                        0,
                        durationMs -
                          (info.timestamp -
                            (work.animationStartedAt ?? startedAt)),
                      ),
                  reduceMotion: reduceMotion as ReduceMotion,
                },
                finished => {
                  const latest = settlement.get();
                  if (finished && latest?.token === work.token)
                    settlement.set({ ...latest, done: true });
                },
              ),
            );
          } else if (work.committed && ready && work.done) {
            cancelAnimation(settleProgress);
            settlement.set(null);
            motion.set({ ...EMPTY_DND_MOTION, token: work.token });
            scheduleOnRN(finishPreview, work.token);
          }
          return;
        }
        if (state.phase !== 'dragging' || uiDisabled.get()) return;
        const registered = zones.get();
        // Gesture events update the pointer only. One frame owns native geometry,
        // target lookup, and auto-scroll, including a stationary pointer scrolling.
        const root = measureDndRect(rootRef);
        const measured = root ? readListViewports(registered) : [];
        let next = { ...state, root: root ?? state.root, zones: measured };
        if (targetEnvironmentChanged(state, next)) {
          next = { ...next, seq: state.seq + 1 };
          motion.set(next);
        }
        const prepared = targetSession.get();
        if (prepared.token === state.token) {
          const sent = sentTarget.get();
          const target = uiLayoutTarget(
            next,
            registered,
            prepared,
            sent.target,
          );
          if (
            pendingMove.get()?.token !== next.token &&
            (!sent.state ||
              sent.state.token !== next.token ||
              !sameLayoutTarget(sent.target, target) ||
              targetEnvironmentChanged(sent.state, next) ||
              sent.policyRevision !== prepared.policyRevision)
          ) {
            if (sent.state && next.seq <= sent.state.seq) {
              next = { ...next, seq: sent.state.seq + 1 };
              motion.set(next);
            }
            sentTarget.set({
              state: next,
              target,
              policyRevision: prepared.policyRevision,
            });
            pendingMove.set({ token: next.token, seq: next.seq });
            scheduleOnRN(move, next);
          }
        }
        if (!root) return;
        if (!pointInRect(state.pointer, root)) return;
        for (const viewport of measured) {
          if (!pointInRect(state.pointer, viewport.viewport.rect)) continue;
          const list = registered.find(
            entry => entry.zoneId === viewport.zoneId,
          );
          if (!list || list.kind !== 'list') break;
          const vertical = list.orientation === 'vertical';
          const result = computeAutoScroll({
            pointer: vertical ? state.pointer.y : state.pointer.x,
            viewportStart: vertical
              ? viewport.viewport.rect.y
              : viewport.viewport.rect.x,
            viewportSize: vertical
              ? viewport.viewport.rect.height
              : viewport.viewport.rect.width,
            offset: viewport.offset,
            contentSize: list.contentSize,
            deltaTimeMs: info.timeSincePreviousFrame ?? 0,
            options: list.autoScroll,
          });
          if (result.valid && result.velocity !== 0)
            scrollTo(
              list.ref,
              vertical ? 0 : result.offset,
              vertical ? result.offset : 0,
              false,
            );
          break;
        }
      },
      [
        motion,
        settlement,
        rootRef,
        settleProgress,
        durationMs,
        reduceMotion,
        pixelRatio,
        finishPreview,
        uiDisabled,
        zones,
        targetSession,
        sentTarget,
        pendingMove,
        move,
      ],
    ),
  );

  useLayoutEffect(() => {
    const active = bridge.current;
    if (snapshot.phase === 'idle') {
      const previousToken = active.token;
      const native = motion.get();
      const retained = preview.current;
      active.sessionId = null;
      if (
        retained &&
        native.visible &&
        native.token === previousToken &&
        durationMs > 0 &&
        !snapshot.disabled &&
        (settlingRevision.current === null ||
          settlingRevision.current === snapshot.value?.revision)
      ) {
        if (settlingToken.current !== previousToken) {
          settlingToken.current = previousToken;
          settlingRevision.current =
            snapshot.value?.revision ?? native.revision;
          const next: Settlement = {
            token: previousToken,
            itemId: retained.item.id,
            revision: snapshot.value?.revision ?? native.revision,
            from: {
              x: native.pointer.x - native.grip.x - native.root.x,
              y: native.pointer.y - native.grip.y - native.root.y,
              width: native.width,
              height: native.height,
            },
            destination: null,
            zone: null,
            contentRect: null,
            itemRef: null,
            startedAt: null,
            animationStartedAt: null,
            animating: false,
            done: false,
            committed: true,
          };
          scheduleOnUI(() => {
            if (motion.get().token !== previousToken) return;
            motion.set({ ...motion.get(), phase: 'released' });
            const current = settlement.get();
            settlement.set(
              current?.token === previousToken && !current.committed
                ? {
                    ...current,
                    committed: true,
                    revision: next.revision,
                    startedAt: null,
                    zone: null,
                    contentRect: null,
                    itemRef: null,
                  }
                : next,
            );
          });
        }
        refreshSettlement.current();
      } else {
        finishPreview(previousToken);
        scheduleOnUI(() => {
          if (motion.get().token !== previousToken) return;
          cancelAnimation(settleProgress);
          settlement.set(null);
          motion.set({ ...EMPTY_DND_MOTION, token: previousToken });
        });
      }
    } else if (previewReady) {
      const activeToken = active.token;
      scheduleOnUI(() => {
        const state = motion.get();
        if (
          state.token === activeToken &&
          state.phase !== 'idle' &&
          !state.visible
        )
          motion.set({ ...state, visible: true });
      });
    }
  }, [
    motion,
    snapshot,
    durationMs,
    settlement,
    settleProgress,
    finishPreview,
    previewReady,
  ]);
  useLayoutEffect(() => {
    mounted.current = true;
    // Child layout effects may register before the Provider is reactivated.
    publishHandles();
    return () => {
      mounted.current = false;
      handlePublication.generation++;
      handlePublication.queued = false;
      coordinator.dispose();
      flushSettled();
      scheduleOnUI(() => {
        cancelAnimation(settleProgress);
        settlement.set(null);
        motion.set(EMPTY_DND_MOTION);
      });
    };
  }, [
    coordinator,
    flushSettled,
    handlePublication,
    motion,
    publishHandles,
    settlement,
    settleProgress,
  ]);
  const overlayStyle = useAnimatedStyle(() => {
    const state = motion.get();
    const work = settlement.get();
    const destination = work?.destination;
    const rect =
      work && destination
        ? interpolateSettlementRect(
            work.from,
            destination,
            settleProgress.get(),
          )
        : null;
    const x = rect?.x ?? state.pointer.x - state.grip.x - state.root.x;
    const y = rect?.y ?? state.pointer.y - state.grip.y - state.root.y;
    const width = rect?.width ?? state.width;
    const height = rect?.height ?? state.height;
    return {
      opacity: state.visible ? 1 : 0,
      width: state.width,
      height: state.height,
      transform: [
        { translateX: x + (width - state.width) / 2 },
        { translateY: y + (height - state.height) / 2 },
        { scaleX: state.width > 0 ? width / state.width : 1 },
        { scaleY: state.height > 0 ? height / state.height : 1 },
      ],
    };
  });
  const activeItem = snapshot.value?.items.find(
    item => item.id === (snapshot.itemId ?? retainedPreview?.item.id),
  );
  const content = retainedPreview;
  const previewSessionId = snapshot.sessionId ?? content?.sessionId;
  const previewSourceZoneId = snapshot.sourceZoneId ?? content?.sourceZoneId;
  const runtime = useMemo<DndRuntime>(
    () => ({
      get snapshot() {
        return renderStore.getSnapshot();
      },
      renderStore,
      committedRevision: nativeRevision,
      motion,
      presentation,
      presentationSnapshot,
      zones,
      disabled: uiDisabled,
      token,
      rootRef,
      dragAxis,
      activationDelayMs: configValid ? activation.delayMs : 0,
      gestureConfigRevision,
      animation,
      begin,
      move,
      release,
      cancel,
      registerZone,
      unregisterZone,
      registerHandle,
      unregisterHandle,
      reportIssues,
    }),
    [
      renderStore,
      nativeRevision,
      motion,
      presentation,
      presentationSnapshot,
      zones,
      uiDisabled,
      token,
      rootRef,
      dragAxis,
      configValid,
      activation?.delayMs,
      gestureConfigRevision,
      animation,
      begin,
      move,
      release,
      cancel,
      registerZone,
      unregisterZone,
      registerHandle,
      unregisterHandle,
      reportIssues,
    ],
  );
  return (
    <DndRuntimeContext value={runtime}>
      <DndGestureHost registry={gestureRegistry} runtime={gestureRuntime}>
        <Animated.View
          {...viewProps}
          ref={rootRef}
          collapsable={false}
          style={[styles.root, style]}
          onLayout={event => {
            const { width, height } = event.nativeEvent.layout;
            if (
              rootLayout.current &&
              (rootLayout.current.width !== width ||
                rootLayout.current.height !== height)
            )
              coordinator.cancel('geometry-changed');
            rootLayout.current = { width, height };
            onLayout?.(event);
          }}
        >
          {children}
          {activeItem && content && previewSessionId && previewSourceZoneId && (
            <DndItemContext
              value={{
                itemId: activeItem.id,
                zoneId: previewSourceZoneId,
                ref: rootRef,
                preview: true,
              }}
            >
              <Animated.View
                pointerEvents="none"
                style={[styles.preview, overlayStyle, dragPreviewStyle]}
              >
                {renderDragPreview
                  ? renderDragPreview({
                      item: activeItem,
                      index: content.index,
                      zoneId: previewSourceZoneId,
                      isDragging: true,
                      sessionId: previewSessionId,
                      targetZoneId: snapshot.targetZoneId,
                      validity: snapshot.validity,
                      width: content.width,
                      height: content.height,
                      onReady: handlePreviewReady,
                    })
                  : content.render({
                      item: activeItem,
                      index: content.index,
                      zoneId: previewSourceZoneId,
                      isDragging: true,
                    })}
              </Animated.View>
            </DndItemContext>
          )}
        </Animated.View>
      </DndGestureHost>
    </DndRuntimeContext>
  );
}

const styles = StyleSheet.create({
  root: { position: 'relative' },
  preview: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 1000,
    elevation: 16,
  },
});
