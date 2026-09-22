import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type FlatList,
  type HostInstance,
  type LayoutChangeEvent,
  type ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, {
  type AnimatedRef,
  type SharedValue,
  makeMutable,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { validateAutoScrollOptions } from '../adapters/scroll';
import { resolveListVirtualization } from '../adapters/virtualizedList';
import type { DndItem, ListLayoutZone } from '../contracts';
import {
  computeListLayout,
  ListSizeCache,
  type ListLayoutEntry,
  type ListLayoutResult,
} from '../engine/list';
import {
  DndItemContext,
  useDndRuntime,
  useDndZoneSnapshot,
  useDndItemSnapshot,
  type DndRuntime,
} from '../runtime/dndRuntime';
import {
  createZonePresentation,
  type DndZonePresentation,
} from '../runtime/dndPresentation';
import type { RetainSlotsRule } from '../runtime/dndRenderStore';
import type { ListItemRenderArgs, SortableListProps } from './dndTypes';
import { useListCellMotion } from '../pointer/listCellMotion';

type ListCellProps<T> = {
  item: DndItem<T>;
  index: number;
  zoneId: string;
  committedRevision?: SharedValue<number>;
  start: number;
  size: number;
  orientation: 'vertical' | 'horizontal';
  crossSize: number;
  fixed: boolean;
  measurementIdentity: object;
  renderItem(args: ListItemRenderArgs<T>): React.ReactNode;
  hiddenItemId: SharedValue<string | null>;
  animation: DndRuntime['animation'];
  presentation: DndRuntime['presentation'];
  isDragging: boolean;
};

type ListMeasurementState = {
  revision: number;
  onSize(itemId: string, size: number): void;
};

const ListMeasurementContext = createContext<ListMeasurementState | null>(null);

function ListCellContent<T>({
  item,
  index,
  zoneId,
  committedRevision,
  start,
  size,
  orientation,
  crossSize,
  fixed,
  measurementIdentity,
  slotStart,
  expectedStart,
  renderItem,
  hiddenItemId,
  animation,
  presentation,
  isDragging,
}: ListCellProps<T> & {
  /**
   * Flow start of the enclosing native slot in list content coordinates. It
   * is applied as a plain style in the React commit that positions the slot,
   * so the slot move and its compensation reach the screen in one mount
   * transaction. A measured correction would lag that commit by a frame and
   * show the cell at its new slot before its content start has moved.
   */
  slotStart?: number;
  /** UI copy of the slot's flow start for the motion fallback target. */
  expectedStart?: SharedValue<number>;
}) {
  const measurement = useContext(ListMeasurementContext);
  if (!measurement)
    throw new Error('ListCell requires its measurement context.');
  const { revision, onSize } = measurement;
  const ref = useAnimatedRef();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const itemId = item.id;
  const runtime = useDndRuntime();
  const publicSlot = useDndItemSnapshot(runtime, zoneId, itemId);
  const itemContext = useMemo(
    () => ({ itemId, zoneId, ref }),
    [itemId, zoneId, ref],
  );
  const publicIndex = publicSlot?.index ?? index;
  const content = useMemo(
    () => renderItem({ item, index: publicIndex, zoneId, isDragging }),
    [item, publicIndex, zoneId, isDragging, renderItem],
  );
  const vertical = orientation === 'vertical';
  const revisionSource = committedRevision ?? revision;
  // Mount uses the Provider's JS view of the scheduled UI geometry. Reading the
  // shared presentation from JS would block on the UI runtime and copy every
  // rect for each new cell; the UI mapper adopts actual UI geometry first.
  const { animatedStart, targetSize } = useListCellMotion({
    zoneId,
    itemId,
    vertical,
    fixed,
    start: expectedStart ?? start,
    size,
    presentation,
    revision: revisionSource,
    hiddenItemId,
    animation,
    initial: {
      presentation: runtime.presentationSnapshot?.(),
      revision:
        typeof revisionSource === 'number'
          ? revisionSource
          : (runtime.snapshot.value?.revision ?? 0),
      start,
    },
  });
  // Natural-size cells never consume a target dimension; only authoritative
  // sizes read the validated size, so measurements do not restart this mapper.
  // The transform is the content start itself; the slot offset below cancels
  // the native flow position, so no per-frame slot measurement is involved.
  const animated = useAnimatedStyle(() => ({
    opacity: hiddenItemId.get() === itemId ? 0 : 1,
    ...(fixed
      ? vertical
        ? { height: targetSize.get() }
        : { width: targetSize.get() }
      : {}),
    transform: [
      { translateX: vertical ? 0 : animatedStart.get() },
      { translateY: vertical ? animatedStart.get() : 0 },
    ],
  }));
  const measured = useCallback(
    (width: number, height: number) => {
      if (mounted.current && !fixed) onSize(itemId, vertical ? height : width);
    },
    [fixed, itemId, onSize, vertical],
  );
  const measurementRequest = useRef<{
    identity: object;
    itemId: string;
    fixed: boolean;
    pending: boolean;
  } | null>(null);
  useEffect(() => {
    const previous = measurementRequest.current;
    const request = {
      identity: measurementIdentity,
      itemId,
      fixed,
      pending:
        !fixed &&
        previous !== null &&
        (previous.identity !== measurementIdentity ||
          previous.itemId !== itemId ||
          previous.fixed ||
          previous.pending),
    };
    measurementRequest.current = request;
    // A new native cell reports its initial size through onLayout. Asking for
    // the same measurement here doubles native callbacks while windowing.
    // An existing cell needs a fallback only when its cache context changes,
    // since unchanged native dimensions may not produce another onLayout.
    if (!request.pending) return;
    let current = true;
    ref.current?.measure((_x, _y, width, height) => {
      if (current) {
        request.pending = false;
        measured(width, height);
      }
    });
    return () => {
      current = false;
    };
  }, [fixed, itemId, measured, measurementIdentity, ref]);
  return (
    <DndItemContext value={itemContext}>
      <Animated.View
        ref={ref}
        collapsable={false}
        style={[
          styles.cell,
          vertical
            ? {
                width: crossSize,
                ...(slotStart !== undefined ? { top: negate(slotStart) } : {}),
                ...(fixed ? { height: size } : {}),
              }
            : {
                height: crossSize,
                ...(slotStart !== undefined ? { left: negate(slotStart) } : {}),
                ...(fixed ? { width: size } : {}),
              },
          animated,
        ]}
        onLayout={event =>
          measured(
            event.nativeEvent.layout.width,
            event.nativeEvent.layout.height,
          )
        }
      >
        {content}
      </Animated.View>
    </DndItemContext>
  );
}

// Pointer/session updates must not rerender every mounted card. Pass only the
// cell's visible state and primitive geometry; entries are rebuilt together
// when an item is measured or moved, including entries that did not change.
const ListCell = memo(ListCellContent) as typeof ListCellContent;

type ExpectedStartUpdate = { shared: SharedValue<number>; start: number };
/** Queue a slot's new flow start for the UI runtime; `null` drops it. */
type PublishExpectedStart = (
  shared: SharedValue<number>,
  start: number | null,
) => void;

function applyExpectedStarts(updates: ExpectedStartUpdate[]) {
  'worklet';
  for (const update of updates) update.shared.set(update.start);
}

function negate(value: number) {
  return value === 0 ? 0 : -value;
}

function VirtualListCellContent<T>({
  publishExpectedStart,
  slotSize,
  ...cellProps
}: ListCellProps<T> & {
  publishExpectedStart: PublishExpectedStart;
  slotSize: number;
}) {
  const style = useMemo(
    () =>
      cellProps.orientation === 'vertical'
        ? { width: cellProps.crossSize, height: slotSize }
        : [
            styles.horizontalSlot,
            { height: cellProps.crossSize, width: slotSize },
          ],
    [cellProps.orientation, cellProps.crossSize, slotSize],
  );
  // The flow start is only ever assigned plain numbers. A plain mutable skips
  // the per-value cancelAnimation UI task that useSharedValue schedules on
  // unmount. It feeds the cell's motion fallback target; positioning itself
  // uses the React-committed slot offset, so nothing waits for a native measure.
  const [expectedStart] = useState(() => makeMutable(cellProps.start));
  const published = useRef(cellProps.start);
  useLayoutEffect(() => {
    if (published.current === cellProps.start) return;
    published.current = cellProps.start;
    publishExpectedStart(expectedStart, cellProps.start);
  }, [cellProps.start, expectedStart, publishExpectedStart]);
  useLayoutEffect(
    () => () => publishExpectedStart(expectedStart, null),
    [expectedStart, publishExpectedStart],
  );
  return (
    <View collapsable={false} style={style}>
      <ListCell
        {...cellProps}
        slotStart={cellProps.start}
        expectedStart={expectedStart}
      />
    </View>
  );
}

const VirtualListCell = memo(
  VirtualListCellContent,
) as typeof VirtualListCellContent;

type VirtualListRenderState = {
  entriesById: ReadonlyMap<string, ListLayoutEntry>;
  data: ReadonlyMap<string, DndItem<unknown>>;
  activeItemId: string | null;
  slotSize(entry: ListLayoutEntry): number;
  cellProps: Omit<
    ListCellProps<unknown>,
    'item' | 'index' | 'start' | 'size' | 'isDragging'
  > & {
    publishExpectedStart: PublishExpectedStart;
  };
};

const VirtualListContext = createContext<VirtualListRenderState | null>(null);

function VirtualItemBridge({ itemId }: { itemId: string }) {
  const state = useContext(VirtualListContext);
  const entry = state?.entriesById.get(itemId);
  const item = state?.data.get(itemId);
  if (!state || !entry || !item) return null;
  return (
    <VirtualListCell
      {...state.cellProps}
      slotSize={state.slotSize(entry)}
      item={item}
      index={entry.index}
      start={entry.start}
      size={entry.size}
      isDragging={state.activeItemId === itemId}
    />
  );
}

// Context updates reach the bridge even when FlatList's native cell wrapper
// skips rendering. Geometry and getItemLayout use the same React snapshot.
const renderVirtualItem = ({ item }: { item: string }) => (
  <VirtualItemBridge itemId={item} />
);
// Our pinned RN 0.87 FlatList supports this in its Flow implementation, but
// omits it from FlatListProps.d.ts. Its default renderer recreates a callback
// on every metrics update; strictMode memoizes that internal callback too.
const FLAT_LIST_RENDERER_OPTIONS = { strictMode: true };

const EMPTY_ENTRIES: ListLayoutEntry[] = [];
const EMPTY_IDS: string[] = [];
const itemKey = (itemId: string) => itemId;
type PreparedListDisplay = {
  zone: ListLayoutZone;
  revision: number;
  measurementVersion: number;
  layout: ListLayoutResult;
  presentation: DndZonePresentation | null;
};

type RetainSlotsInputs = {
  layout: ListLayoutResult | null;
  gap: number;
  windowSize: number;
  viewportLength: number;
};

/**
 * FlatList mounts cells by slot order, so it can keep committed slots during a
 * same-list preview only when its render window already holds every cell the
 * preview can expose. Slots between the source and the target are displaced
 * by at most the dragged slot (item plus gap), and VirtualizedList renders
 * (windowSize - 1) / 2 viewport lengths beyond each viewport edge. A larger
 * displacement falls back to candidate-order slots for that drag. Items of
 * other lists change this list's membership, which the store resolves itself.
 */
function retainsCommittedSlots(
  inputs: RetainSlotsInputs,
  itemId: string,
): boolean {
  if (!inputs.layout?.valid) return false;
  const entry = inputs.layout.entries.find(
    candidate => candidate.itemId === itemId,
  );
  if (!entry) return true;
  return (
    inputs.viewportLength > 0 &&
    entry.size + inputs.gap <=
      ((inputs.windowSize - 1) / 2) * inputs.viewportLength
  );
}

/** Shared measured layout for ScrollView and FlatList adapters. */
export function SortableList<T>({
  zoneId,
  renderItem,
  estimatedItemSize = 48,
  itemSize,
  gap = 0,
  paddingStart = 0,
  paddingEnd = 0,
  autoScroll,
  scrollEnabled = true,
  showsScrollIndicator = true,
  onScrollOffsetChange,
  virtualization = false,
  onLayout,
  style,
  ...viewProps
}: SortableListProps<T>) {
  const runtime = useDndRuntime();
  const { registerZone, unregisterZone, reportIssues } = runtime;
  const windowing = resolveListVirtualization(virtualization);
  const virtualized = windowing.valid && windowing.options !== null;
  // Native slots keep their committed order through a same-list preview and
  // the shared presentation moves the cells, so a candidate change renders
  // nothing here. An index-dependent size recipe must update its native slot
  // lengths too. FlatList keeps committed slots only while its render window
  // covers the preview's displacement; the rule answers once per drag session.
  const retainInputs = useRef<RetainSlotsInputs>({
    layout: null,
    gap: 0,
    windowSize: 0,
    viewportLength: 0,
  });
  const retainSlots = useCallback<RetainSlotsRule>(
    itemId => retainsCommittedSlots(retainInputs.current, itemId),
    [],
  );
  const snapshot = useDndZoneSnapshot(
    runtime,
    zoneId,
    typeof itemSize === 'function' ? false : virtualized ? retainSlots : true,
  );
  const identity = useRef({}).current;
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const zone = snapshot.zone;
  const displayZone = snapshot.display;
  const orientation = zone?.kind === 'list' ? zone.orientation : 'vertical';
  const vertical = orientation === 'vertical';
  const crossSize = vertical ? viewportSize.width : viewportSize.height;
  const items = snapshot.items;
  const revision = snapshot.revision;
  const displayRevision = snapshot.displayRevision;
  const cache = useMemo(
    () => new ListSizeCache(),
    // A new geometry/data context must not reuse old native measurements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [crossSize, orientation, items],
  );
  const measurements = useMemo(
    () => ({
      cache,
      version: 0,
      committedVersion: 0,
      frame: null as number | null,
      active: false,
    }),
    [cache],
  );
  const measurementContext = useRef<{
    cache: ListSizeCache;
    revision: number;
  } | null>(null);
  const scheduleMeasurementRender = useCallback(() => {
    if (
      !measurements.active ||
      measurements.frame !== null ||
      measurements.version <= measurements.committedVersion
    )
      return;
    const frame = requestAnimationFrame(() => {
      // A cancelled native frame can already be queued for RN delivery.
      if (measurements.frame !== frame) return;
      measurements.frame = null;
      if (
        !measurements.active ||
        measurementContext.current?.cache !== measurements.cache ||
        measurements.version <= measurements.committedVersion
      )
        return;
      setMeasurementVersion(current => current + 1);
    });
    measurements.frame = frame;
  }, [measurements]);
  useLayoutEffect(() => {
    measurements.active = true;
    scheduleMeasurementRender();
    return () => {
      measurements.active = false;
      if (measurements.frame !== null) cancelAnimationFrame(measurements.frame);
      measurements.frame = null;
    };
  }, [measurements, scheduleMeasurementRender]);
  const renderedMeasurementVersion = useMemo(
    () => measurements.version,
    // An unrelated render may reuse memoized layout; only a measurement signal
    // guarantees that the layout consumed the newest cached dimensions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measurements, measurementVersion],
  );
  useLayoutEffect(() => {
    measurements.committedVersion = renderedMeasurementVersion;
    // A callback arriving between render and commit already reserved the next
    // frame. Its newer version must not be acknowledged by this older render.
  }, [measurements, renderedMeasurementVersion]);
  const scrollRef = useAnimatedRef<ScrollView>();
  const offset = useSharedValue(0);
  const { motion, animation, presentation, committedRevision } = runtime;
  // Virtual cells position their content with a React-committed slot offset
  // plus the animated content start. The UI runtime only needs each slot's
  // flow start as the motion fallback target; changed starts of one commit
  // travel together in one UI task, without RN shared-value reads.
  const expectedStarts = useMemo(
    () => ({
      pending: new Map<SharedValue<number>, number>(),
      queued: false,
      active: false,
    }),
    // Native viewports and their cells are replaced when these change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orientation, virtualized, zoneId],
  );
  const flushExpectedStarts = useCallback(() => {
    expectedStarts.queued = false;
    if (!expectedStarts.active || expectedStarts.pending.size === 0) return;
    const updates = Array.from(
      expectedStarts.pending,
      ([shared, start]): ExpectedStartUpdate => ({ shared, start }),
    );
    expectedStarts.pending.clear();
    scheduleOnUI(applyExpectedStarts, updates);
  }, [expectedStarts]);
  const publishExpectedStart = useCallback<PublishExpectedStart>(
    (shared, start) => {
      if (start === null) {
        expectedStarts.pending.delete(shared);
        return;
      }
      expectedStarts.pending.set(shared, start);
      if (expectedStarts.queued) return;
      expectedStarts.queued = true;
      (
        globalThis as typeof globalThis & {
          queueMicrotask(callback: () => void): void;
        }
      ).queueMicrotask(flushExpectedStarts);
    },
    [expectedStarts, flushExpectedStarts],
  );
  useLayoutEffect(() => {
    expectedStarts.active = true;
    return () => {
      expectedStarts.active = false;
      expectedStarts.pending.clear();
    };
  }, [expectedStarts]);
  const prepareLayout = useMemo(() => {
    let previous: PreparedListDisplay | undefined;
    let entries = new Map<string, ListLayoutEntry>();
    return (candidate: ListLayoutZone, candidateRevision: number) => {
      if (candidate.orientation !== orientation || crossSize <= 0) return null;
      if (
        previous?.zone === candidate &&
        previous.revision === candidateRevision &&
        previous.measurementVersion === measurements.version
      )
        return previous;
      const layout = computeListLayout({
        itemIds: candidate.itemIds,
        orientation,
        crossSize,
        estimatedItemSize,
        itemSize,
        gap,
        paddingStart,
        paddingEnd,
        revision: candidateRevision,
        cache,
      });
      if (layout.valid) {
        const nextEntries = new Map<string, ListLayoutEntry>();
        layout.entries = layout.entries.map(entry => {
          const old = entries.get(entry.itemId);
          const sameRect =
            old &&
            old.rect.x === entry.rect.x &&
            old.rect.y === entry.rect.y &&
            old.rect.width === entry.rect.width &&
            old.rect.height === entry.rect.height;
          // Rects contain only coordinates. Preserve their immutable identity
          // across revision/source changes so UI need not receive them again;
          // the new entry still carries its current index and revision.
          if (sameRect) entry.rect = old.rect;
          const same =
            old &&
            old.index === entry.index &&
            old.start === entry.start &&
            old.size === entry.size &&
            old.source === entry.source &&
            old.revision === entry.revision &&
            sameRect;
          const retained = same ? old : entry;
          nextEntries.set(entry.itemId, retained);
          return retained;
        });
        entries = nextEntries;
      }
      previous = {
        zone: candidate,
        revision: candidateRevision,
        measurementVersion: measurements.version,
        layout,
        // Candidates of one item set share the slot map; only coordinates cross
        // to UI again.
        presentation: layout.valid
          ? createZonePresentation(
              layout.entries.map(entry => [entry.itemId, entry.rect] as const),
              previous?.presentation,
            )
          : null,
      };
      return previous;
    };
  }, [
    cache,
    crossSize,
    estimatedItemSize,
    gap,
    itemSize,
    measurements,
    orientation,
    paddingEnd,
    paddingStart,
  ]);
  const prepareDisplay = useCallback(
    (candidate: ListLayoutZone, candidateRevision: number) =>
      prepareLayout(candidate, candidateRevision)?.presentation ?? null,
    [prepareLayout],
  );
  const base = useMemo(
    () =>
      zone?.kind === 'list'
        ? (prepareLayout(zone, revision)?.layout ?? null)
        : null,
    // Cache writes are mutable; the version explicitly invalidates this result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zone, revision, prepareLayout, measurementVersion],
  );
  const viewportLength = vertical ? viewportSize.height : viewportSize.width;
  const windowSize = windowing.valid ? (windowing.options?.windowSize ?? 0) : 0;
  useLayoutEffect(() => {
    // Read by the retain rule when a drag starts. The committed layout does
    // not change between idle and the first preview of a session.
    retainInputs.current = { layout: base, gap, windowSize, viewportLength };
  }, [base, gap, viewportLength, windowSize]);
  const display = useMemo(
    () =>
      displayZone === zone
        ? base
        : displayZone?.kind === 'list'
          ? (prepareLayout(displayZone, displayRevision)?.layout ?? null)
          : null,
    // Candidate rects must also be recomputed after an accepted measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      displayZone,
      zone,
      base,
      displayRevision,
      prepareLayout,
      measurementVersion,
    ],
  );
  const validScroll =
    validateAutoScrollOptions(autoScroll).valid &&
    typeof scrollEnabled === 'boolean';
  useLayoutEffect(() => {
    measurementContext.current = { cache, revision };
    return () => {
      measurementContext.current = null;
    };
  }, [cache, revision]);
  useLayoutEffect(() => {
    // Switching adapter/direction remounts the native viewport.
    offset.set(0);
    return () => unregisterZone(zoneId, identity);
  }, [identity, offset, orientation, unregisterZone, virtualized, zoneId]);
  useLayoutEffect(() => {
    reportIssues(
      `list:${zoneId}`,
      zone?.kind !== 'list'
        ? [
            {
              code: 'invalid-configuration',
              zoneId,
              message: 'SortableList requires an existing list zone.',
            },
          ]
        : !windowing.valid
          ? windowing.issues
          : !validScroll
            ? [
                {
                  code: 'invalid-configuration',
                  zoneId,
                  message: 'List scrolling options are invalid.',
                },
              ]
            : base && !base.valid
              ? base.issues
              : [],
    );
  });
  useLayoutEffect(() => {
    if (!base?.valid || !display?.valid || !validScroll || !windowing.valid) {
      unregisterZone(zoneId, identity);
      return;
    }
    registerZone(
      {
        kind: 'list',
        zoneId,
        orientation,
        revision,
        ref: scrollRef as unknown as AnimatedRef<HostInstance>,
        offset,
        contentSize: display.totalSize,
        autoScroll: {
          ...autoScroll,
          enabled: scrollEnabled && autoScroll?.enabled !== false,
        },
        layout: base,
        dataIdentity: items,
        prepareDisplay,
        renderItem: args => renderItem(args as ListItemRenderArgs<T>),
      },
      identity,
    );
  }, [
    registerZone,
    unregisterZone,
    zoneId,
    orientation,
    revision,
    scrollRef,
    offset,
    display,
    base,
    autoScroll,
    validScroll,
    scrollEnabled,
    renderItem,
    identity,
    windowing.valid,
    virtualized,
    prepareDisplay,
    items,
  ]);
  useLayoutEffect(
    () => () => {
      unregisterZone(zoneId, identity);
      reportIssues(`list:${zoneId}`, []);
    },
    [zoneId, identity, unregisterZone, reportIssues],
  );
  const onSize = useCallback(
    (itemId: string, size: number) => {
      if (
        measurementContext.current?.cache !== cache ||
        measurementContext.current.revision !== revision
      )
        return;
      const previous = cache.get(itemId, { orientation, crossSize });
      if (previous !== undefined && Math.abs(previous - size) < 0.001) return;
      if (
        cache.set(itemId, size, { orientation, crossSize }, revision) &&
        previous !== size
      ) {
        // Invalidate before React renders, since the Provider may ask for a
        // validated presentation while this native measurement is still batched.
        measurements.version++;
        scheduleMeasurementRender();
      }
    },
    [
      cache,
      orientation,
      crossSize,
      revision,
      measurements,
      scheduleMeasurementRender,
    ],
  );
  const cellMeasurements = useMemo(
    () => ({ revision, onSize }),
    [revision, onSize],
  );
  const scrollHandler = useAnimatedScrollHandler({
    onScroll: event => {
      const nextOffset = vertical
        ? event.contentOffset.y
        : event.contentOffset.x;
      offset.set(nextOffset);
      if (onScrollOffsetChange)
        scheduleOnRN(onScrollOffsetChange, {
          x: event.contentOffset.x,
          y: event.contentOffset.y,
        });
    },
  });
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setViewportSize(current =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
      onLayout?.(event);
    },
    [onLayout],
  );
  const data = useMemo(
    () => new Map(items?.map(item => [item.id, item]) ?? []),
    [items],
  );
  const contentSize = display?.valid ? display.totalSize : 0;
  const visibleEntries = display?.valid ? display.entries : EMPTY_ENTRIES;
  const visibleIds =
    display?.valid && displayZone?.kind === 'list'
      ? displayZone.itemIds
      : EMPTY_IDS;
  const entriesById = useMemo(
    () => new Map(visibleEntries.map(entry => [entry.itemId, entry])),
    [visibleEntries],
  );
  const entryCount = visibleEntries.length;
  const slotSize = useCallback(
    (entry: ListLayoutEntry) =>
      entry.size + (entry.index < entryCount - 1 ? gap : 0),
    [entryCount, gap],
  );
  const getItemLayout = useCallback(
    (_itemIds: ArrayLike<string> | null | undefined, index: number) => {
      const entry = visibleEntries[index];
      return { index, offset: entry.start, length: slotSize(entry) };
    },
    [slotSize, visibleEntries],
  );
  // Cells only need the active source's visibility, not the pointer and all
  // measured viewports copied into motion on every frame.
  const hiddenItemId = useDerivedValue(() => {
    const state = motion.get();
    return state.visible ? state.itemId : null;
  });
  const activeItemId = snapshot.activeItemId;
  const fixed = itemSize !== undefined;
  const virtualRenderState = useMemo<VirtualListRenderState>(
    () => ({
      entriesById,
      data,
      activeItemId,
      slotSize,
      cellProps: {
        publishExpectedStart,
        zoneId,
        committedRevision,
        orientation,
        crossSize,
        fixed,
        measurementIdentity: cache,
        renderItem,
        hiddenItemId,
        animation,
        presentation,
      },
    }),
    [
      activeItemId,
      animation,
      cache,
      committedRevision,
      crossSize,
      data,
      entriesById,
      fixed,
      hiddenItemId,
      orientation,
      renderItem,
      slotSize,
      zoneId,
      presentation,
      publishExpectedStart,
    ],
  );
  const contentContainerStyle = useMemo(
    () =>
      vertical
        ? { paddingTop: paddingStart, paddingBottom: paddingEnd }
        : { paddingLeft: paddingStart, paddingRight: paddingEnd },
    [paddingEnd, paddingStart, vertical],
  );
  if (virtualized && windowing.valid && windowing.options) {
    // These are actual native flow slots, including the trailing inter-item gap.
    // The natural-size child is absolute so an estimate cannot constrain its
    // measurement. Cache updates change both native slots and getItemLayout.
    return (
      <ListMeasurementContext value={cellMeasurements}>
        <VirtualListContext value={virtualRenderState}>
          <Animated.FlatList<string>
            {...viewProps}
            {...windowing.options}
            {...FLAT_LIST_RENDERER_OPTIONS}
            key={`${zoneId}:${orientation}:flat`}
            ref={scrollRef as unknown as AnimatedRef<FlatList<string>>}
            data={visibleIds}
            keyExtractor={itemKey}
            horizontal={!vertical}
            style={style}
            contentContainerStyle={contentContainerStyle}
            onLayout={handleLayout}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            scrollEnabled={scrollEnabled && snapshot.scrollEnabled}
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={showsScrollIndicator}
            showsHorizontalScrollIndicator={showsScrollIndicator}
            contentInsetAdjustmentBehavior="never"
            getItemLayout={getItemLayout}
            renderItem={renderVirtualItem}
          />
        </VirtualListContext>
      </ListMeasurementContext>
    );
  }
  const entries = new Map(
    display?.valid ? display.entries.map(entry => [entry.itemId, entry]) : [],
  );
  // The ScrollView adapter retains source cells through cross-list previews.
  // FlatList may unmount them; the provider owns the gesture and overlay.
  const renderIds = new Set([
    ...(zone?.kind === 'list' ? zone.itemIds : []),
    ...(displayZone?.kind === 'list' ? displayZone.itemIds : []),
  ]);
  return (
    <ListMeasurementContext value={cellMeasurements}>
      <Animated.ScrollView
        {...viewProps}
        key={`${zoneId}:${orientation}:scroll`}
        ref={scrollRef}
        horizontal={!vertical}
        style={style}
        onLayout={handleLayout}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        scrollEnabled={scrollEnabled && snapshot.scrollEnabled}
        removeClippedSubviews={false}
        showsVerticalScrollIndicator={showsScrollIndicator}
        showsHorizontalScrollIndicator={showsScrollIndicator}
        contentInsetAdjustmentBehavior="never"
      >
        <View
          style={
            vertical
              ? { width: crossSize, height: contentSize }
              : [
                  styles.horizontalSlot,
                  { height: crossSize, width: contentSize },
                ]
          }
        >
          {base?.valid &&
            display?.valid &&
            Array.from(renderIds).map(itemId => {
              const item = data.get(itemId);
              const entry =
                entries.get(itemId) ??
                base.entries.find(candidate => candidate.itemId === itemId);
              if (!item || !entry) return null;
              return (
                <ListCell
                  key={itemId}
                  item={item as DndItem<T>}
                  index={entry.index}
                  zoneId={zoneId}
                  committedRevision={committedRevision}
                  start={entry.start}
                  size={entry.size}
                  orientation={orientation}
                  crossSize={crossSize}
                  fixed={fixed}
                  measurementIdentity={cache}
                  renderItem={renderItem}
                  hiddenItemId={hiddenItemId}
                  animation={animation}
                  presentation={presentation}
                  isDragging={activeItemId === item.id}
                />
              );
            })}
        </View>
      </Animated.ScrollView>
    </ListMeasurementContext>
  );
}

const styles = StyleSheet.create({
  cell: { position: 'absolute', left: 0, top: 0 },
  // Yoga otherwise fits an auto-width absolute child to a column parent's
  // estimated width. A row leaves the measured main axis unconstrained.
  horizontalSlot: { flexDirection: 'row' },
});
