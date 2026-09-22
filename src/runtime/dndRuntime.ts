import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { HostInstance } from 'react-native';
import {
  measure,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';

import type { AutoScrollOptions, DragAxis } from '../adapters/scroll';
import type {
  GridLayoutZone,
  DndItem,
  LayoutPoint,
  LayoutRect,
  ListLayoutZone,
  MeasuredRect,
} from '../contracts';
import type { DndSessionSnapshot } from '../controller/dndSession';
import type { ListLayout } from '../engine/list';
import type { ListTargetIndex } from '../engine/listIndex';
import type { PreparedGridTarget } from '../pointer/layoutTarget';
import type { DndPresentation, DndZonePresentation } from './dndPresentation';
import type { LayoutValidationIssue } from '../contracts';
import type { CancelReason } from '../types';
import type { GridMotionConfig } from '../pointer/motion';
import type { ListItemRenderArgs } from '../components/dndTypes';
import type { GestureRelations, ZoneGeometry } from '../components/gridTypes';
import type { CellGeometry } from './gridRuntime';
import {
  DndRenderStore,
  type DndZoneSnapshot,
  type RetainSlotsRule,
} from './dndRenderStore';

type UiListRegistration = {
  kind: 'list';
  zoneId: string;
  orientation: 'vertical' | 'horizontal';
  revision: number;
  layoutVersion: number;
  ref: AnimatedRef<HostInstance>;
  offset: SharedValue<number>;
  contentSize: number;
  autoScroll?: AutoScrollOptions;
  targetIndex?: ListTargetIndex;
};
type UiGridRegistration = {
  kind: 'grid';
  zoneId: string;
  revision: number;
  layoutVersion: number;
  ref: AnimatedRef<HostInstance>;
  targetGrid?: PreparedGridTarget;
};
export type UiZoneRegistration = UiListRegistration | UiGridRegistration;
export type ListRegistration = Omit<UiListRegistration, 'layoutVersion'> & {
  layout: ListLayout;
  dataIdentity?: readonly DndItem<unknown>[];
  prepareDisplay?(
    zone: ListLayoutZone,
    revision: number,
  ): DndZonePresentation | null;
  renderItem(args: ListItemRenderArgs<unknown>): ReactNode;
};
export type GridRegistration = Omit<UiGridRegistration, 'layoutVersion'> & {
  layout: GridLayoutZone;
  geometry: ZoneGeometry;
  cells: CellGeometry;
  pixelRatio: number;
  renderItem(args: ListItemRenderArgs<unknown>): ReactNode;
};
export type ZoneRegistration = ListRegistration | GridRegistration;
export type ListViewport = {
  zoneId: string;
  viewport: MeasuredRect<'screen'>;
  offset: number;
  layoutVersion: number;
};
export type DndMotion = {
  token: number;
  /** Provider-owned native recognizer; independent of virtual cell lifetime. */
  handleId: number | null;
  seq: number;
  phase: 'idle' | 'dragging' | 'released';
  itemId: string | null;
  sourceZoneId: string | null;
  revision: number;
  pointer: LayoutPoint;
  origin: LayoutPoint;
  axis: DragAxis;
  activationDelayMs: number;
  configRevision: number;
  grip: LayoutPoint;
  width: number;
  height: number;
  root: LayoutRect;
  zones: ListViewport[];
  visible: boolean;
};
export const EMPTY_DND_MOTION: DndMotion = {
  token: 0,
  handleId: null,
  seq: 0,
  phase: 'idle',
  itemId: null,
  sourceZoneId: null,
  revision: 0,
  pointer: { x: 0, y: 0 },
  origin: { x: 0, y: 0 },
  axis: 'both',
  activationDelayMs: 250,
  configRevision: 0,
  grip: { x: 0, y: 0 },
  width: 0,
  height: 0,
  root: { x: 0, y: 0, width: 0, height: 0 },
  zones: [],
  visible: false,
};
export type DndRuntime = {
  snapshot: DndSessionSnapshot<unknown>;
  renderStore?: DndRenderStore;
  motion: SharedValue<DndMotion>;
  presentation?: SharedValue<DndPresentation>;
  /** JS view of the presentation most recently scheduled for the UI runtime. */
  presentationSnapshot?(): DndPresentation;
  /** Shared committed revision keeps unchanged cell worklets stable on approval. */
  committedRevision?: SharedValue<number>;
  /** Provider frame owns measurements and semantic dispatch when enabled. */
  frameDriven?: boolean;
  zones: SharedValue<UiZoneRegistration[]>;
  disabled: SharedValue<boolean>;
  token: SharedValue<number>;
  rootRef: AnimatedRef<HostInstance>;
  dragAxis: DragAxis;
  activationDelayMs: number;
  gestureConfigRevision: number;
  animation: Required<GridMotionConfig>;
  begin(state: DndMotion): void;
  move(state: DndMotion): void;
  release(state: DndMotion, cancelled: boolean | CancelReason): void;
  cancel(reason: CancelReason): void;
  registerZone(registration: ZoneRegistration, identity: object): void;
  unregisterZone(zoneId: string, identity: object): void;
  registerHandle(registration: DndHandleRegistration, identity: object): void;
  unregisterHandle(identity: object): void;
  reportIssues(owner: string, issues: LayoutValidationIssue[]): void;
};
export type DndHandleRegistration = {
  itemId: string;
  zoneId: string;
  ref: AnimatedRef<HostInstance>;
  sourceRef: AnimatedRef<HostInstance>;
  disabled: boolean;
  gestureRelations?: GestureRelations;
};
export const DndRuntimeContext = createContext<DndRuntime | null>(null);
export const DndItemContext = createContext<{
  itemId: string;
  zoneId: string;
  ref: AnimatedRef<HostInstance>;
  preview?: boolean;
} | null>(null);
export function useDndRuntime(): DndRuntime {
  const runtime = useContext(DndRuntimeContext);
  if (!runtime)
    throw new Error(
      'SortableList, SortableGrid and DragHandle must be inside DndProvider.',
    );
  return runtime;
}

function renderStoreFor(runtime: DndRuntime): DndRenderStore {
  return (
    runtime.renderStore ??
    new DndRenderStore({
      getSnapshot: () => runtime.snapshot,
      subscribe: () => () => {},
    })
  );
}

const inactiveHandleSelection = {
  get: () => false,
  subscribe: (_listener: () => void) => () => {},
};

export function useDndZoneSnapshot(
  runtime: DndRuntime,
  zoneId: string,
  preserveSlots: boolean | RetainSlotsRule = true,
): DndZoneSnapshot {
  const selection = useMemo(() => {
    const store = renderStoreFor(runtime);
    // Without shared presentation nothing moves retained slots on the UI
    // runtime, so React must follow the candidate order itself.
    const get = () =>
      store.getZoneSnapshot(
        zoneId,
        runtime.presentation ? preserveSlots : false,
      );
    return {
      get,
      subscribe: (listener: () => void) =>
        store.subscribeSelection(get, listener),
    };
  }, [runtime, zoneId, preserveSlots]);
  return useSyncExternalStore(selection.subscribe, selection.get);
}

export function useDndHandleActive(
  runtime: DndRuntime,
  itemId: string | undefined,
  disabled: boolean,
): boolean {
  const selection = useMemo(() => {
    if (!disabled) return inactiveHandleSelection;
    const store = renderStoreFor(runtime);
    const get = () => store.getSnapshot().itemId === itemId;
    return {
      get,
      subscribe: (listener: () => void) =>
        store.subscribeSelection(get, listener),
    };
  }, [runtime, itemId, disabled]);
  return useSyncExternalStore(selection.subscribe, selection.get);
}

/** Public render arguments follow approved previews independently of native slots. */
export function useDndItemSnapshot(
  runtime: DndRuntime,
  zoneId: string,
  itemId: string,
) {
  const selection = useMemo(() => {
    const store = renderStoreFor(runtime);
    const get = () => store.getItemSnapshot(zoneId, itemId);
    return {
      get,
      subscribe: (listener: () => void) =>
        store.subscribeSelection(get, listener),
    };
  }, [runtime, zoneId, itemId]);
  return useSyncExternalStore(selection.subscribe, selection.get);
}

export function measureDndRect(
  ref: AnimatedRef<HostInstance>,
): LayoutRect | null {
  'worklet';
  const result = measure(ref);
  if (
    !result ||
    ![result.pageX, result.pageY, result.width, result.height].every(
      Number.isFinite,
    ) ||
    result.width <= 0 ||
    result.height <= 0
  )
    return null;
  return {
    x: result.pageX,
    y: result.pageY,
    width: result.width,
    height: result.height,
  };
}

export function readListViewports(
  zones: readonly UiZoneRegistration[],
): ListViewport[] {
  'worklet';
  const timestampMs = (
    globalThis as typeof globalThis & { performance: { now(): number } }
  ).performance.now();
  const measured: ListViewport[] = [];
  for (const zone of zones) {
    const rect = measureDndRect(zone.ref);
    const offset = zone.kind === 'grid' ? 0 : zone.offset.get();
    if (rect && Number.isFinite(offset))
      measured.push({
        zoneId: zone.zoneId,
        offset,
        layoutVersion: zone.layoutVersion,
        viewport: {
          source: 'measured',
          space: 'screen',
          rect,
          revision: zone.revision,
          timestampMs,
        },
      });
  }
  return measured;
}

export function pointInRect(point: LayoutPoint, rect: LayoutRect): boolean {
  'worklet';
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
