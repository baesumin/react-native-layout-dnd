import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { PanGestureConfig } from 'react-native-gesture-handler';

import { DndProvider } from '../../src/components/DndProvider';
import { SortableList } from '../../src/components/SortableList';
import { SortableGrid } from '../../src/components/SortableGrid';
import { DragHandle } from '../../src/components/DragHandle';
import { DndGestureHost } from '../../src/gesture/DndGestureHost';
import {
  DndGestureGroup,
  type DndGestureGroupProps,
} from '../../src/gesture/DndGestureGroup';
import {
  EMPTY_DND_MOTION,
  DndItemContext,
  DndRuntimeContext,
  readListViewports,
  type DndHandleRegistration,
  type DndMotion,
  type DndRuntime,
} from '../../src/runtime/dndRuntime';
import type {
  DndPreviewArgs,
  DndProviderHandle,
  DndProviderProps,
  SortableListProps,
  DragHandleProps,
  SortableGridProps,
} from '../../src/components/dndTypes';
import type {
  GridLayoutZone,
  LayoutRect,
  LayoutState,
} from '../../src/contracts';
import type { DndSessionOptions } from '../../src/controller/dndSession';
import type { GridDiagnosticEvent } from '../../src/types';
import { presentationRect } from '../../src/runtime/dndPresentation';
import { createDndStateStore } from '../../src/controller/dndState';

type Hook = {
  value?: unknown;
  set?: (next: unknown) => void;
  dependencies?: readonly unknown[];
  cleanup?: () => void;
};
type Effect = () => void | (() => void);
type FrameInfo = { timestamp: number; timeSincePreviousFrame: number | null };
type Scope = string;
type NativeMeasurement = {
  pageX: number;
  pageY: number;
  width: number;
  height: number;
};

// Real Provider, SortableList, target adapter and coordinator; only hooks/native
// measurements and the UI/RN queues are simulated. This is not a native gesture test.
const mockScopes: Record<Scope, Hook[]> = {
  provider: [],
  source: [],
  destination: [],
};
const mockLayoutEffects: Array<() => void> = [];
const mockPassiveEffects: Array<() => void> = [];
const mockUiTasks: Array<() => void> = [];
const mockRnTasks: Array<() => void> = [];
const mockRunOnUISync = jest.fn((task: () => unknown) => task());
const mockMeasurements = new Map<object, NativeMeasurement | null>();
const mockScrollTo = jest.fn();
const mockDndItemContext = DndItemContext;
const mockDndRuntimeContext = DndRuntimeContext;
const mockContexts = new Map<unknown, unknown>();
const mockDirtyScopes = new Set<Scope>();
const mockRenderCounts = new Map<Scope, number>();
const mockComposeGestures = jest.fn(
  (...gestures: Array<{ handlerTag: number }>) => ({
    gestures,
    handlerTags: gestures.map(gesture => gesture.handlerTag),
  }),
);
const mockBuildPan = jest.fn(
  (handlerTag: number, config: PanGestureConfig) => ({
    handlerTag,
    config,
  }),
);
const mockGestureFail = jest.fn();
const mockDroppedGestures: number[] = [];
const mockPans = new Map<number, PanGestureConfig>();
type MockTiming = {
  mockTiming: true;
  to: number;
  options: { duration?: number; reduceMotion?: string };
  callback?: (finished: boolean) => void;
};
type MockAnimation = {
  owner: object;
  from: number;
  to: number;
  write(value: number): void;
  callback?: (finished: boolean) => void;
  finished: boolean;
  cancelled: boolean;
};
const mockAnimations: MockAnimation[] = [];
const mockTiming = jest.fn(
  (
    to: number,
    options: MockTiming['options'] = {},
    callback?: MockTiming['callback'],
  ): MockTiming => ({ mockTiming: true, to, options, callback }),
);
const mockCancelAnimation = jest.fn((owner: object) => {
  for (const animation of mockAnimations) {
    if (animation.owner !== owner || animation.finished || animation.cancelled)
      continue;
    animation.cancelled = true;
    animation.callback?.(false);
  }
});
let mockNextHandlerTag = 0;
let mockTimestamp = 0;
let mockItemScope: React.ContextType<typeof DndItemContext> = null;
let mockScope: Scope = 'provider';
let mockCursor = 0;
let mockDirty = false;
let mockFreezeSharedTargets = false;
let mockFrame: (info: FrameInfo) => void;
let mockRuntime: DndRuntime;

function mockFreezeUiTarget(target: unknown): void {
  if (!target || typeof target !== 'object') return;
  for (const key of Object.keys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    if (!('value' in descriptor)) continue;
    if (key === 'position') mockFreezeUiTarget(descriptor.value);
    Object.defineProperty(target, key, {
      enumerable: descriptor.enumerable,
      configurable: false,
      get: () => descriptor.value,
      set: () => {},
    });
  }
  Object.preventExtensions(target);
}

function mockState<T>(initial: T | (() => T)) {
  const scope = mockScope;
  const index = mockCursor++;
  const hooks = mockScopes[mockScope] ?? (mockScopes[mockScope] = []);
  if (!hooks[index]) {
    const hook: Hook = {
      value: typeof initial === 'function' ? (initial as () => T)() : initial,
    };
    hook.set = next => {
      const value = typeof next === 'function' ? next(hook.value) : next;
      if (!Object.is(value, hook.value)) {
        hook.value = value;
        mockDirty = true;
        mockDirtyScopes.add(scope);
      }
    };
    hooks[index] = hook;
  }
  const hook = hooks[index];
  return [
    hook.value as T,
    hook.set as (next: T | ((current: T) => T)) => void,
  ] as const;
}

function mockEffect(
  queue: Array<() => void>,
  effect: Effect,
  dependencies?: readonly unknown[],
) {
  const hooks = mockScopes[mockScope];
  const index = mockCursor++;
  const hook = hooks[index] ?? (hooks[index] = {});
  if (
    !dependencies ||
    !hook.dependencies ||
    dependencies.some((value, i) => !Object.is(value, hook.dependencies?.[i]))
  ) {
    queue.push(() => {
      hook.cleanup?.();
      hook.dependencies = dependencies;
      hook.cleanup = effect() || undefined;
    });
  }
}

function mockMemo<T>(factory: () => T, dependencies: readonly unknown[]): T {
  const hooks = mockScopes[mockScope];
  const index = mockCursor++;
  const hook = hooks[index] ?? (hooks[index] = {});
  if (
    !hook.dependencies ||
    dependencies.some((value, i) => !Object.is(value, hook.dependencies?.[i]))
  ) {
    hook.value = factory();
    hook.dependencies = dependencies;
  }
  return hook.value as T;
}

function mockSharedValue<T>(initial: T) {
  return mockState(() => {
    let value = initial;
    const shared = {
      get: () => value,
      set: (next: T | ((current: T) => T)) => {
        // Reanimated replaces an existing animation when assigning its mutable.
        for (const animation of mockAnimations) {
          if (
            animation.owner !== shared ||
            animation.finished ||
            animation.cancelled
          )
            continue;
          animation.cancelled = true;
          animation.callback?.(false);
        }
        const result =
          typeof next === 'function'
            ? (next as (current: T) => T)(value)
            : next;
        if (mockFreezeSharedTargets && result && typeof result === 'object') {
          // Worklets DEV serialization replaces data properties with accessors.
          // Exercise both the initial sent target and presentation publication.
          if ('releaseTarget' in result) {
            const approved = result.releaseTarget as
              { target: unknown } | undefined;
            mockFreezeUiTarget(approved?.target);
          } else if ('state' in result && 'target' in result)
            mockFreezeUiTarget(result.target);
        }
        const timing = result as unknown as MockTiming | undefined;
        if (timing?.mockTiming) {
          const animation: MockAnimation = {
            owner: shared,
            from: value as number,
            to: timing.to,
            write: current => {
              value = current as T;
            },
            callback: timing.callback,
            cancelled: false,
            finished:
              timing.options.duration === 0 ||
              timing.options.reduceMotion === 'always',
          };
          mockAnimations.push(animation);
          if (animation.finished) {
            animation.write(animation.to);
            animation.callback?.(true);
          }
        } else value = result;
      },
    };
    return shared;
  })[0];
}

jest.mock('react/compiler-runtime', () => ({
  c: (size: number) =>
    mockState(() =>
      Array(size).fill(Symbol.for('react.memo_cache_sentinel')),
    )[0],
}));
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: mockState,
  useImperativeHandle: (
    ref: { current: unknown } | ((value: unknown) => void) | null | undefined,
    create: () => unknown,
  ) => {
    if (typeof ref === 'function') ref(create());
    else if (ref) ref.current = create();
  },
  useRef: (current: unknown) => mockState({ current })[0],
  useCallback: (callback: unknown, dependencies: readonly unknown[]) =>
    mockMemo(() => callback, dependencies),
  useMemo: mockMemo,
  useContext: (context: unknown) =>
    context === mockDndItemContext
      ? mockItemScope
      : context === mockDndRuntimeContext
        ? mockRuntime
        : mockContexts.get(context),
  useLayoutEffect: (effect: Effect, dependencies?: readonly unknown[]) =>
    mockEffect(mockLayoutEffects, effect, dependencies),
  useEffect: (effect: Effect, dependencies?: readonly unknown[]) =>
    mockEffect(mockPassiveEffects, effect, dependencies),
  useSyncExternalStore: (
    subscribe: (callback: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => {
    const scope = mockScope;
    const selected = mockState(() => ({
      value: getSnapshot(),
      getSnapshot,
    }))[0];
    selected.getSnapshot = getSnapshot;
    selected.value = getSnapshot();
    mockEffect(mockLayoutEffects, () => {
      const check = () => {
        const next = selected.getSnapshot();
        if (Object.is(selected.value, next)) return;
        selected.value = next;
        mockDirty = true;
        mockDirtyScopes.add(scope);
      };
      const unsubscribe = subscribe(check);
      check();
      return unsubscribe;
    }, [subscribe]);
    return selected.value;
  },
}));
jest.mock('react-native', () => ({
  PixelRatio: { get: () => 1 },
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: 'Animated.View',
    ScrollView: 'Animated.ScrollView',
    FlatList: 'Animated.FlatList',
  },
  useSharedValue: mockSharedValue,
  useDerivedValue: (get: () => unknown) => {
    const current = mockState(() => ({
      get: () => current.read(),
      read: get,
    }))[0];
    current.read = get;
    return current;
  },
  useAnimatedRef: () => mockState({ current: null })[0],
  useAnimatedStyle: (get: () => unknown) =>
    new Proxy(get() as object, {
      get: (_target, key) => (get() as Record<string | symbol, unknown>)[key],
    }),
  useAnimatedScrollHandler: (handlers: { onScroll: unknown }) =>
    handlers.onScroll,
  useAnimatedReaction: () => {},
  useFrameCallback: (callback: (info: FrameInfo) => void) => {
    if (mockScope === 'provider') mockFrame = callback;
  },
  measure: (ref: object) => mockMeasurements.get(ref) ?? null,
  scrollTo: (...args: unknown[]) => mockScrollTo(...args),
  withTiming: (...args: Parameters<typeof mockTiming>) => mockTiming(...args),
  cancelAnimation: (owner: object) => mockCancelAnimation(owner),
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: 'GestureDetector',
  GestureStateManager: {
    fail: (...args: unknown[]) => mockGestureFail(...args),
  },
  useManualGesture: () =>
    mockState(() => ({
      handlerTag: ++mockNextHandlerTag,
      config: { shouldUseReanimatedDetector: true },
    }))[0],
  useCompetingGestures: (...gestures: Array<{ handlerTag: number }>) =>
    mockComposeGestures(...gestures),
  usePanGesture: (config: PanGestureConfig) => {
    const handlerTag = mockState(() => ++mockNextHandlerTag)[0];
    mockPans.set(handlerTag, config);
    mockEffect(
      mockPassiveEffects,
      () => () => {
        mockDroppedGestures.push(handlerTag);
        mockPans.delete(handlerTag);
      },
      [handlerTag],
    );
    return mockMemo(
      () => mockBuildPan(handlerTag, config),
      [handlerTag, config],
    );
  },
}));
jest.mock('react-native-worklets', () => ({
  runOnUISync: (task: () => unknown) => mockRunOnUISync(task),
  scheduleOnUI: (task: (...args: unknown[]) => void, ...args: unknown[]) => {
    mockUiTasks.push(() => task(...args));
  },
  scheduleOnRN: (task: (...args: unknown[]) => void, ...args: unknown[]) => {
    mockRnTasks.push(() => task(...args));
  },
}));

const rootRect: LayoutRect = { x: 0, y: 0, width: 300, height: 200 };
let props: DndProviderProps<string>;
let listProps: Record<'source' | 'destination', SortableListProps<string>>;
const listRenderContexts = new Map<
  string,
  Array<{ type: unknown; value: unknown }>
>();
let output: ReturnType<typeof DndProvider<string>>;
let previousProviderProps: DndProviderProps<string> | undefined;
type GestureHostProps = Omit<Parameters<typeof DndGestureHost>[0], 'children'>;
type NativeDetectorProps = {
  nativeGestures: Map<number, unknown>;
};
type NativeDetectorTree = ReactElement<{
  gesture: { handlerTags: number[] };
  children: ReactElement;
}>;
type HostTree = ReactElement<{
  children: [
    ReactElement<NativeDetectorProps>,
    Array<ReactElement<DndGestureGroupProps>>,
  ];
}>;
let hostOutput: HostTree;
let detectorOutput: NativeDetectorTree;
let previousNativeGestures: NativeDetectorProps['nativeGestures'] | undefined;
let previousHostProps: GestureHostProps | undefined;
let rootOutput: ReactElement<{
  children: ReactNode[];
  onLayout(event: LayoutChangeEvent): void;
}>;
let previousRootContent: ReactElement | undefined;
const previousGroupProps = new Map<number, DndGestureGroupProps>();
let lists: Record<
  'source' | 'destination',
  ReturnType<typeof SortableList<string>>
>;
let mountedLists: Set<'source' | 'destination'>;
let mountedHandles: Map<
  string,
  {
    props: DragHandleProps;
    scope: NonNullable<React.ContextType<typeof DndItemContext>>;
    output?: ReturnType<typeof DragHandle>;
  }
>;
let groupScopes: Set<string>;
let mountedGrids: Map<
  string,
  {
    props: SortableGridProps<string>;
    output?: ReturnType<typeof SortableGrid<string>>;
  }
>;
const onDragEnd = jest.fn();
const onDragSettled = jest.fn();
const renderPreview = jest.fn((_args: DndPreviewArgs<string>) => null);

function initialLayout(): LayoutState<string> {
  return {
    revision: 0,
    items: ['a', 'b', 'c', 'd'].map(id => ({ id, data: id })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['a', 'b', 'c', 'd'],
      },
      { id: 'destination', kind: 'list', orientation: 'vertical', itemIds: [] },
    ],
  };
}

function renderScope<T>(scope: Scope, renderComponent: () => T): T {
  mockScope = scope;
  mockCursor = 0;
  mockScopes[scope] ??= [];
  mockDirtyScopes.delete(scope);
  mockRenderCounts.set(scope, (mockRenderCounts.get(scope) ?? 0) + 1);
  return renderComponent();
}

function renderGestureHost() {
  const host = output.props.children as ReactElement<
    Parameters<typeof DndGestureHost>[0]
  >;
  const context = renderScope('gesture-content', () =>
    DndGestureHost(host.props),
  );
  mockContexts.set(context.type, context.props.value);
  const nativeHost = context.props.children as ReactElement<GestureHostProps>;
  if (
    !previousHostProps ||
    mockDirtyScopes.has('gesture-host') ||
    previousHostProps.registry !== nativeHost.props.registry ||
    previousHostProps.runtime !== nativeHost.props.runtime
  ) {
    const Component = nativeHost.type as unknown as {
      type(props: GestureHostProps): HostTree;
    };
    hostOutput = renderScope('gesture-host', () =>
      Component.type(nativeHost.props),
    );
    previousHostProps = nativeHost.props;
  }
  const detector = hostOutput.props.children[0];
  if (previousNativeGestures !== detector.props.nativeGestures) {
    const Component = detector.type as unknown as {
      type(props: NativeDetectorProps): NativeDetectorTree;
    };
    detectorOutput = renderScope('native-detector', () =>
      Component.type(detector.props),
    );
    previousNativeGestures = detector.props.nativeGestures;
  }
  if (previousRootContent !== context.props.value) {
    const nativeRoot = detectorOutput.props.children;
    const Component = nativeRoot.type as () => typeof rootOutput;
    rootOutput = renderScope('native-root', Component);
    previousRootContent = context.props.value;
  }
  const groups = hostOutput.props.children[1];
  const nextGroupScopes = new Set(
    groups.map(group => `group:${group.props.groupId}`),
  );
  for (const key of groupScopes) {
    if (!nextGroupScopes.has(key)) {
      mockScopes[key]?.forEach(hook => hook.cleanup?.());
      delete mockScopes[key];
      mockDirtyScopes.delete(key);
      previousGroupProps.delete(Number(key.slice('group:'.length)));
    }
  }
  groupScopes = nextGroupScopes;
  for (const group of groups) {
    const previous = previousGroupProps.get(group.props.groupId);
    const scope = `group:${group.props.groupId}`;
    if (
      !previous ||
      mockDirtyScopes.has(scope) ||
      (Object.keys(group.props) as Array<keyof DndGestureGroupProps>).some(
        key => !Object.is(previous[key], group.props[key]),
      )
    ) {
      renderScope(scope, () => DndGestureGroup(group.props));
      previousGroupProps.set(group.props.groupId, group.props);
    }
  }
}

function render() {
  let commits = 0;
  do {
    if (++commits > 20) throw new Error('Unexpected repeated state updates');
    mockDirty = false;
    if (previousProviderProps !== props || mockDirtyScopes.has('provider')) {
      output = renderScope('provider', () => DndProvider(props));
      mockRuntime = output.props.value as DndRuntime;
      previousProviderProps = props;
    }
    for (const zoneId of mountedLists) {
      let rendered = renderScope(zoneId, () => SortableList(listProps[zoneId]));
      const contexts = [];
      while ('value' in rendered.props) {
        contexts.push({
          type: rendered.type,
          value: rendered.props.value,
        });
        rendered = rendered.props.children;
      }
      listRenderContexts.set(zoneId, contexts);
      lists[zoneId] = rendered;
    }
    for (const [key, grid] of mountedGrids) {
      grid.output = renderScope(`grid:${key}`, () => SortableGrid(grid.props));
    }
    for (const [key, handle] of mountedHandles) {
      mockItemScope = handle.scope;
      handle.output = renderScope(`handle:${key}`, () =>
        DragHandle(handle.props),
      );
    }
    renderGestureHost();
    mockLayoutEffects.splice(0).forEach(effect => effect());
    mockPassiveEffects.splice(0).forEach(effect => effect());
    // Commit-batched registrations run before the next native input/frame.
    jest.runAllTicks();
  } while (mockDirty);
}

function measure(ref: object, rect: LayoutRect | null) {
  mockMeasurements.set(
    ref,
    rect && {
      pageX: rect.x,
      pageY: rect.y,
      width: rect.width,
      height: rect.height,
    },
  );
}

function layoutList(zoneId: 'source' | 'destination', rect: LayoutRect) {
  const list = lists[zoneId];
  measure(list.props.ref, rect);
  list.props.onLayout({ nativeEvent: { layout: rect } } as LayoutChangeEvent);
  render();
}

function listCell(zoneId: 'source' | 'destination', itemId: string) {
  const list = lists[zoneId];
  type CellProps = {
    item: { id: string };
    start: number;
    size: number;
    onSize(id: string, size: number): void;
  };
  const contexts = listRenderContexts.get(zoneId)!;
  for (const context of contexts) mockContexts.set(context.type, context.value);
  const measurement = contexts
    .map(context => context.value as Partial<CellProps>)
    .find(context => typeof context.onSize === 'function');
  // Model the callback consumed by the inner cell's measurement context.
  const withMeasurement = (cell: ReactElement<CellProps>) => ({
    ...cell,
    props: {
      ...cell.props,
      onSize: measurement?.onSize ?? cell.props.onSize,
    },
  });
  if (listProps[zoneId].virtualization) {
    const data = list.props.data as readonly string[];
    const index = data.indexOf(itemId);
    const bridge = list.props.renderItem({
      item: data[index],
      index,
    }) as ReactElement<{ itemId: string }>;
    const Component = bridge.type as (props: {
      itemId: string;
    }) => ReactElement<CellProps>;
    return withMeasurement(
      renderScope(`cell-bridge:${zoneId}:${itemId}`, () =>
        Component(bridge.props),
      ),
    );
  }
  const cells = list.props.children.props.children as ReactNode[];
  const cell = cells.find(
    child => isValidElement<CellProps>(child) && child.props.item.id === itemId,
  );
  if (!isValidElement<CellProps>(cell))
    throw new Error(`Missing cell ${itemId} in ${zoneId}`);
  return withMeasurement(cell);
}

function mountGrid(
  zone: GridLayoutZone = {
    id: 'grid',
    kind: 'grid',
    rows: 2,
    columns: 2,
    placements: [],
  },
  rect: LayoutRect = { x: 120, y: 110, width: 80, height: 80 },
  overrides: Partial<SortableGridProps<string>> = {},
) {
  const gridIds = new Set(zone.placements.map(item => item.itemId));
  const missing = [...gridIds].filter(
    id => !props.value.items.some(item => item.id === id),
  );
  props = {
    ...props,
    value: {
      ...props.value,
      items: [...props.value.items, ...missing.map(id => ({ id, data: id }))],
      zones: [
        ...props.value.zones.map(current =>
          current.kind === 'list'
            ? {
                ...current,
                itemIds: current.itemIds.filter(id => !gridIds.has(id)),
              }
            : current,
        ),
        zone,
      ],
    },
  };
  const grid = {
    props: {
      zoneId: zone.id,
      renderItem: jest.fn(() => null),
      geometry: {
        mode: 'fixed' as const,
        cellWidth: 40,
        cellHeight: 40,
        rowGap: 0,
        columnGap: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      },
      ...overrides,
    },
    output: undefined as ReturnType<typeof SortableGrid<string>> | undefined,
  };
  mountedGrids.set(zone.id, grid);
  render();
  measure(grid.output!.props.ref, rect);
  grid.output!.props.onLayout({
    nativeEvent: { layout: rect },
  } as LayoutChangeEvent);
  render();
  flushUi();
  return grid;
}

function unmountGrid(zoneId: string) {
  mountedGrids.delete(zoneId);
  mockScopes[`grid:${zoneId}`].forEach(hook => hook.cleanup?.());
  delete mockScopes[`grid:${zoneId}`];
  render();
  flushUi();
}

function flushUi() {
  mockUiTasks.splice(0).forEach(task => task());
}
function flushRn() {
  mockRnTasks.splice(0).forEach(task => task());
  render();
  flushUi();
}

function thresholdsOf(zoneId: string) {
  const zone = mockRuntime.zones.get().find(entry => entry.zoneId === zoneId);
  return zone?.kind === 'list' && zone.targetIndex
    ? Array.from(zone.targetIndex.thresholds)
    : undefined;
}

function state(patch: Partial<DndMotion> = {}): DndMotion {
  return {
    ...EMPTY_DND_MOTION,
    token: 1,
    seq: 1,
    phase: 'dragging',
    itemId: 'a',
    sourceZoneId: 'source',
    revision: props.value.revision,
    axis: mockRuntime.dragAxis,
    activationDelayMs: mockRuntime.activationDelayMs,
    configRevision: mockRuntime.gestureConfigRevision,
    pointer: { x: 20, y: 20 },
    origin: { x: 20, y: 20 },
    grip: { x: 20, y: 20 },
    width: 100,
    height: 40,
    root: rootRect,
    zones: readListViewports(mockRuntime.zones.get()),
    ...patch,
  };
}

function begin(patch: Partial<DndMotion> = {}) {
  const next = state(patch);
  mockRuntime.motion.set(next);
  mockRuntime.begin(next);
  render();
  flushUi();
  return next;
}

function move(pointer: { x: number; y: number }) {
  const next = {
    ...mockRuntime.motion.get(),
    pointer,
    seq: mockRuntime.motion.get().seq + 1,
    zones: readListViewports(mockRuntime.zones.get()),
  };
  mockRuntime.motion.set(next);
  mockRuntime.move(next);
  render();
  flushUi();
}

function release(cancelled: Parameters<DndRuntime['release']>[1] = false) {
  const next: DndMotion = {
    ...mockRuntime.motion.get(),
    phase: 'released',
    seq: mockRuntime.motion.get().seq + 1,
    zones: readListViewports(mockRuntime.zones.get()),
  };
  mockRuntime.motion.set(next);
  mockRuntime.release(next, cancelled);
  render();
  flushUi();
}

function tickFrame(deltaTimeMs = 16) {
  mockTimestamp += deltaTimeMs;
  mockFrame({ timestamp: mockTimestamp, timeSincePreviousFrame: deltaTimeMs });
}

function advanceAnimations(progress = 1) {
  for (const animation of mockAnimations) {
    if (animation.finished || animation.cancelled) continue;
    animation.write(
      animation.from + (animation.to - animation.from) * progress,
    );
    if (progress === 1) {
      animation.finished = true;
      animation.callback?.(true);
    }
  }
}

function expectClearedMotion(runtime = mockRuntime) {
  expect(runtime.motion.get()).toEqual({
    ...EMPTY_DND_MOTION,
    // Retain the previous generation so queued UI publications cannot revive it.
    token: expect.any(Number),
  });
}

function previewOverlay() {
  const scope = rootOutput.props.children[1];
  if (!isValidElement<{ children: ReactElement<{ style: unknown }> }>(scope))
    return null;
  return scope.props.children;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  return Array.isArray(style)
    ? Object.assign({}, ...style.map(flattenStyle))
    : style && typeof style === 'object'
      ? (style as Record<string, unknown>)
      : {};
}

function detectorTags(): number[] {
  return detectorOutput.props.gesture.handlerTags;
}

function gestureRegistry() {
  return (
    output.props.children as ReactElement<Parameters<typeof DndGestureHost>[0]>
  ).props.registry;
}

function mountHandle(key = 'a', handleProps: Partial<DragHandleProps> = {}) {
  const sourceRef = { current: null } as unknown as NonNullable<
    React.ContextType<typeof DndItemContext>
  >['ref'];
  mountedHandles.set(key, {
    props: { children: null, ...handleProps },
    scope: { itemId: 'a', zoneId: 'source', ref: sourceRef },
  });
  measure(sourceRef, { x: 0, y: 0, width: 100, height: 40 });
  render();
  const handle = mountedHandles.get(key)!;
  measure(handle.output!.props.ref, { x: 10, y: 5, width: 40, height: 30 });
  return {
    handle,
    sourceRef,
    tag: detectorTags().find(tag => mockPans.has(tag))!,
  };
}

function unmountHandle(key: string) {
  const handle = mountedHandles.get(key)!;
  measure(handle.output!.props.ref, null);
  measure(handle.scope.ref, null);
  mountedHandles.delete(key);
  mockScopes[`handle:${key}`].forEach(hook => hook.cleanup?.());
  delete mockScopes[`handle:${key}`];
  render();
  flushUi();
}

function firePan(
  tag: number,
  key:
    | 'onBegin'
    | 'onTouchesDown'
    | 'onActivate'
    | 'onUpdate'
    | 'onDeactivate'
    | 'onFinalize',
  event: object = {},
) {
  const callback = mockPans.get(tag)?.[key] as
    ((value: unknown) => void) | undefined;
  if (!callback) throw new Error(`Missing native callback ${key} on ${tag}`);
  callback({
    handlerTag: tag,
    absoluteX: 20,
    absoluteY: 20,
    numberOfPointers: 1,
    numberOfTouches: 1,
    changedTouches: [{ absoluteX: 20, absoluteY: 20 }],
    ...event,
  });
}

function activateHandle(tag: number) {
  firePan(tag, 'onBegin');
  firePan(tag, 'onTouchesDown');
  firePan(tag, 'onActivate');
  flushRn();
}

function unmountList(zoneId: 'source' | 'destination') {
  mountedLists.delete(zoneId);
  mockScopes[zoneId].forEach(hook => hook.cleanup?.());
  mockScopes[zoneId].length = 0;
  render();
  flushUi();
}

function unmount() {
  for (const hooks of Object.values(mockScopes)) {
    hooks.forEach(hook => hook.cleanup?.());
    hooks.length = 0;
  }
  flushUi();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  Object.values(mockScopes).forEach(hooks => {
    hooks.length = 0;
  });
  mockLayoutEffects.length = 0;
  mockPassiveEffects.length = 0;
  mockUiTasks.length = 0;
  mockRnTasks.length = 0;
  mockMeasurements.clear();
  mockPans.clear();
  mockAnimations.length = 0;
  mockDroppedGestures.length = 0;
  mockNextHandlerTag = 0;
  mockDirtyScopes.clear();
  mockRenderCounts.clear();
  mockContexts.clear();
  previousProviderProps = undefined;
  previousHostProps = undefined;
  previousNativeGestures = undefined;
  previousRootContent = undefined;
  previousGroupProps.clear();
  mockTimestamp = 0;
  mockFreezeSharedTargets = false;
  mountedHandles = new Map();
  mountedGrids = new Map();
  groupScopes = new Set();
  props = {
    value: initialLayout(),
    onChange: jest.fn(),
    onDragEnd,
    onDragSettled,
    renderDragPreview: renderPreview,
    activation: { delayMs: 250 },
    motion: { durationMs: 0 },
    children: null,
  };
  listProps = {
    source: { zoneId: 'source', renderItem: () => null, itemSize: 40 },
    destination: {
      zoneId: 'destination',
      renderItem: () => null,
      itemSize: 40,
    },
  };
  lists = {} as typeof lists;
  mountedLists = new Set(['source', 'destination']);
  render();
  measure(mockRuntime.rootRef, rootRect);
  layoutList('source', { x: 0, y: 0, width: 100, height: 100 });
  layoutList('destination', { x: 120, y: 0, width: 100, height: 100 });
  flushUi();
});
afterEach(() => {
  unmount();
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('keeps the overlay alive outside all lists and recalculates when it returns', () => {
  begin();
  move({ x: 20, y: 95 });
  expect(mockRuntime.snapshot.target).toEqual({
    kind: 'list',
    zoneId: 'source',
    index: 1,
  });
  move({ x: 290, y: 180 });
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  expect(mockRuntime.snapshot.validity).toBe('invalid');
  expect(mockRuntime.motion.get().visible).toBe(true);
  expect(renderPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      item: props.value.items[0],
      validity: 'invalid',
    }),
  );
  move({ x: 140, y: 20 });
  expect(mockRuntime.snapshot.target).toEqual({
    kind: 'list',
    zoneId: 'destination',
    index: 0,
  });
  expect(onDragEnd).not.toHaveBeenCalled();
});

it.each(['revision', 'axis', 'delay'] as const)(
  'rejects queued activation after a committed %s change',
  change => {
    const capturedRuntime = mockRuntime;
    const captured = state();
    capturedRuntime.motion.set(captured);
    props =
      change === 'revision'
        ? { ...props, value: { ...props.value, revision: 1 } }
        : change === 'axis'
          ? { ...props, dragAxis: 'y' }
          : { ...props, activation: { delayMs: 500 } };
    render();
    capturedRuntime.begin(captured);
    render();
    flushUi();
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expectClearedMotion();
    expect(onDragEnd).not.toHaveBeenCalled();
  },
);

it('uses the actual onScroll offset in the next frame request without cancelling the drag', () => {
  const onScrollOffsetChange = jest.fn();
  listProps.source = { ...listProps.source, onScrollOffsetChange };
  render();
  begin();
  move({ x: 20, y: 95 });
  tickFrame();
  expect(mockScrollTo).toHaveBeenCalledWith(
    lists.source.props.ref,
    0,
    expect.any(Number),
    false,
  );
  const requestedOffset = mockScrollTo.mock.calls[0][2] as number;
  expect(requestedOffset).toBeGreaterThan(5);
  expect(mockRuntime.snapshot.target).toHaveProperty('index', 1);
  expect(mockRuntime.motion.get().zones[0].offset).toBe(0);
  lists.source.props.onScroll({ contentOffset: { x: 0, y: requestedOffset } });
  expect(onScrollOffsetChange).not.toHaveBeenCalled();
  tickFrame();
  expect(mockRuntime.snapshot.target).toHaveProperty('index', 1);
  flushRn();
  expect(onScrollOffsetChange).toHaveBeenCalledWith({
    x: 0,
    y: requestedOffset,
  });
  // The earlier queued move must acknowledge before the next frame publishes
  // the latest native scroll geometry, without needing another pointer event.
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.target).toHaveProperty('index', 2);
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  expect(onDragEnd).not.toHaveBeenCalled();
});

it('scrolls a horizontal list on x and reads its native x offset', () => {
  props = {
    ...props,
    value: {
      ...props.value,
      zones: props.value.zones.map(zone =>
        zone.id === 'source' && zone.kind === 'list'
          ? { ...zone, orientation: 'horizontal' }
          : zone,
      ),
    },
  };
  render();
  begin({ width: 40, height: 100 });
  move({ x: 95, y: 20 });
  expect(lists.source.props.horizontal).toBe(true);
  expect(mockRuntime.snapshot.target).toHaveProperty('index', 1);
  tickFrame();
  const requestedOffset = mockScrollTo.mock.calls[0][1] as number;
  expect(mockScrollTo).toHaveBeenCalledWith(
    lists.source.props.ref,
    expect.any(Number),
    0,
    false,
  );
  lists.source.props.onScroll({ contentOffset: { x: requestedOffset, y: 37 } });
  tickFrame();
  flushRn();
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.target).toHaveProperty('index', 2);
  expect(
    mockRuntime.motion.get().zones.find(zone => zone.zoneId === 'source')
      ?.offset,
  ).toBe(requestedOffset);
});

it.each([true, false])(
  'finishes an explicitly %s cross-list proposal without losing owner data',
  accepted => {
    const store = createDndStateStore(props.value);
    const onChange = jest.fn((_next, proposal) => {
      store.respond(proposal, accepted);
      props = { ...props, value: store.getSnapshot() };
    });
    props = { ...props, value: store.getSnapshot(), onChange };
    render();
    begin();
    move({ x: 140, y: 20 });
    release();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'proposed',
        response: accepted ? 'accepted' : 'rejected',
      }),
    );
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expectClearedMotion();
    expect(props.value.items).toBe(store.getSnapshot().items);
    expect(props.value.zones[0]).toHaveProperty(
      'itemIds',
      accepted ? ['b', 'c', 'd'] : ['a', 'b', 'c', 'd'],
    );
    expect(props.value.zones[1]).toHaveProperty(
      'itemIds',
      accepted ? ['a'] : [],
    );
  },
);

it('invalidates a disappeared target measurement and cannot release its previous valid preview', () => {
  begin();
  move({ x: 140, y: 20 });
  measure(lists.destination.props.ref, null);
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.validity).toBe('invalid');
  release();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'outside-zones' }),
  );
  expectClearedMotion();
});

it('invalidates the candidate while the root cannot be measured and honors a failed release measurement', () => {
  begin();
  move({ x: 20, y: 95 });
  measure(mockRuntime.rootRef, null);
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.validity).toBe('invalid');
  expect(mockRuntime.motion.get().visible).toBe(true);
  expect(mockScrollTo).not.toHaveBeenCalled();
  release('measure-failed');
  expect(props.onChange).not.toHaveBeenCalled();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'measure-failed' }),
  );
});

it('rejects a viewport resize first observed in the release measurements', () => {
  begin();
  move({ x: 20, y: 95 });
  measure(lists.source.props.ref, { x: 0, y: 0, width: 100, height: 130 });
  release();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'geometry-changed' }),
  );
});

describe('queued native release after a measured layout update', () => {
  function queueRelease(evicted = false, cancelled = false) {
    listProps.source = {
      ...listProps.source,
      itemSize: undefined,
      estimatedItemSize: 40,
      virtualization: true,
    };
    render();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    expect(mockRuntime.snapshot.target).toEqual({
      kind: 'list',
      zoneId: 'source',
      index: 1,
    });
    if (evicted) unmountHandle('a');
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: cancelled });
    expect(mockRnTasks).toHaveLength(1);
    const captured = mockRuntime.motion.get();
    const queuedRelease = mockRnTasks.shift()!;

    // A native size callback commits after UI captures release but before RN
    // processes it. Its new layout version must not invalidate this valid drop.
    listCell('source', 'b').props.onSize('b', 80);
    jest.advanceTimersByTime(20);
    render();
    const registered = mockRuntime.zones
      .get()
      .find(zone => zone.zoneId === 'source')!;
    expect(registered.layoutVersion).toBeGreaterThan(
      captured.zones.find(zone => zone.zoneId === 'source')!.layoutVersion,
    );
    expect(mockRuntime.snapshot.value?.revision).toBe(captured.revision);
    mockRunOnUISync.mockClear();
    return { tag, captured, queuedRelease };
  }

  it.each([false, true])(
    'remeasures current viewports and offsets before approval (source evicted: %s)',
    evicted => {
      const store = createDndStateStore(props.value);
      props = {
        ...props,
        onChange: jest.fn((next, proposal) => {
          store.onChange(next, proposal);
          props = { ...props, value: store.getSnapshot() };
        }),
      };
      const { tag, captured, queuedRelease } = queueRelease(evicted);
      lists.source.props.onScroll({ contentOffset: { x: 0, y: 60 } });
      expect(
        captured.zones.find(zone => zone.zoneId === 'source')!.offset,
      ).toBe(0);
      if (evicted) expect(mockDroppedGestures).not.toContain(tag);

      queuedRelease();
      render();
      flushUi();

      expect(mockRunOnUISync).toHaveBeenCalled();
      expect(props.onChange).toHaveBeenCalledTimes(1);
      expect((props.onChange as jest.Mock).mock.calls[0][1].to).toEqual({
        kind: 'list',
        zoneId: 'source',
        index: 2,
      });
      expect(props.value.zones[0]).toHaveProperty('itemIds', [
        'b',
        'c',
        'a',
        'd',
      ]);
      expect(onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'accepted' }),
      );
      expectClearedMotion();
      if (evicted) expect(mockDroppedGestures).toContain(tag);
    },
  );

  it.each(['root', 'viewport'] as const)(
    'rejects a %s resize first observed by the synchronous refresh',
    resized => {
      const { queuedRelease } = queueRelease();
      if (resized === 'root')
        measure(mockRuntime.rootRef, { ...rootRect, width: 400 });
      else
        measure(lists.source.props.ref, {
          x: 0,
          y: 0,
          width: 100,
          height: 130,
        });

      queuedRelease();
      render();
      flushUi();

      expect(mockRunOnUISync).toHaveBeenCalledTimes(1);
      expect(props.onChange).not.toHaveBeenCalled();
      expect(onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'geometry-changed' }),
      );
      expectClearedMotion();
    },
  );

  it.each(['root', 'viewport'] as const)(
    'rejects a missing %s measurement during the synchronous refresh',
    missing => {
      const { queuedRelease } = queueRelease();
      measure(
        missing === 'root' ? mockRuntime.rootRef : lists.source.props.ref,
        null,
      );

      queuedRelease();
      render();
      flushUi();

      expect(mockRunOnUISync).toHaveBeenCalledTimes(1);
      expect(props.onChange).not.toHaveBeenCalled();
      expect(mockRuntime.snapshot.phase).toBe('idle');
      expect(onDragEnd).toHaveBeenCalledTimes(1);
      expectClearedMotion();
    },
  );

  it('preserves explicit cancellation without refreshing a changed layout', () => {
    const { queuedRelease } = queueRelease(false, true);

    queuedRelease();
    render();
    flushUi();

    expect(mockRunOnUISync).not.toHaveBeenCalled();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'gesture-interrupted' }),
    );
    expectClearedMotion();
  });

  it('preserves an external revision without refreshing its obsolete release', () => {
    const { queuedRelease } = queueRelease();
    const external = {
      ...props.value,
      revision: 1,
      items: props.value.items.map(item => ({ ...item, data: 'external' })),
    };
    props = { ...props, value: external };
    render();
    flushUi();
    mockRunOnUISync.mockClear();

    queuedRelease();
    render();
    flushUi();

    expect(mockRunOnUISync).not.toHaveBeenCalled();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(mockRuntime.snapshot.value).toBe(external);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expectClearedMotion();
  });
});

it('cancels a root size change detected by the frame before the onLayout callback', () => {
  begin();
  move({ x: 20, y: 95 });
  measure(mockRuntime.rootRef, { ...rootRect, width: 400 });
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'geometry-changed' }),
  );
});

it('preserves an external data revision that arrives while a proposal awaits response', () => {
  begin();
  move({ x: 20, y: 95 });
  release();
  expect(mockRuntime.snapshot.phase).toBe('awaiting-response');
  const external = {
    ...props.value,
    revision: 1,
    items: props.value.items.map(item => ({ ...item, data: 'external' })),
  };
  props = { ...props, value: external };
  render();
  flushUi();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expect(mockRuntime.snapshot.displayValue).toBe(external);
  expect(mockRuntime.snapshot.value?.items[0].data).toBe('external');
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({
      response: 'interrupted',
      reason: 'input-changed',
    }),
  );
});

it('cancels when a mounted target zone is removed and ignores its queued frame request', () => {
  begin();
  move({ x: 140, y: 20 });
  lists.destination.props.onScroll({ contentOffset: { x: 0, y: 10 } });
  tickFrame();
  expect(mockRnTasks.length).toBeGreaterThan(0);
  unmountList('destination');
  flushRn();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'zone-removed' }),
  );
  expect(onDragEnd).toHaveBeenCalledTimes(1);
  expect(props.onChange).not.toHaveBeenCalled();
});

it('keeps no-op registration versions stable and does not queue spurious frame requests', () => {
  begin();
  const before = mockRuntime.zones.get().map(zone => zone.layoutVersion);
  for (let index = 0; index < 3; index++) {
    listProps.source = { ...listProps.source, renderItem: () => null };
    render();
    tickFrame();
  }
  expect(mockRuntime.zones.get().map(zone => zone.layoutVersion)).toEqual(
    before,
  );
  expect(mockRnTasks).toHaveLength(0);
  expect(onDragEnd).not.toHaveBeenCalled();
});

it('keeps the same preview and context for pointer updates within one target', () => {
  const canDrop = jest.fn(() => ({ allowed: true as const }));
  props = { ...props, canDrop };
  render();
  begin();
  move({ x: 20, y: 70 });
  const runtime = mockRuntime;
  const snapshot = runtime.snapshot;
  const calls = canDrop.mock.calls.length;
  for (let index = 0; index < 240; index++) {
    move({ x: 20 + (index % 10), y: 70 });
    expect(mockRuntime.snapshot).toBe(snapshot);
    expect(mockRuntime).toBe(runtime);
  }
  expect(canDrop).toHaveBeenCalledTimes(calls);
  release();
  expect(canDrop).toHaveBeenCalledTimes(calls + 1);
  expect(props.onChange).toHaveBeenCalledTimes(1);
});

it('changes same-zone targets without rendering the Provider or composing gestures', () => {
  const { tag } = mountHandle();
  activateHandle(tag);
  const providerRenders = mockRenderCounts.get('provider');
  const hostRenders = mockRenderCounts.get('gesture-host');
  const compositionCount = mockComposeGestures.mock.calls.length;
  const panBuildCount = mockBuildPan.mock.calls.length;
  const runtime = mockRuntime;
  const tags = detectorTags();

  for (const index of [1, 0, 1, 0, 1]) {
    firePan(tag, 'onUpdate', { absoluteY: index === 0 ? 20 : 70 });
    tickFrame();
    flushRn();
    expect(mockRuntime.snapshot.target).toEqual({
      kind: 'list',
      zoneId: 'source',
      index,
    });
    expect(
      presentationRect(mockRuntime.presentation!.get(), 'source', 'a')!.y,
    ).toBe(index * 40);
  }

  expect(mockRuntime).toBe(runtime);
  expect(mockRenderCounts.get('provider')).toBe(providerRenders);
  expect(mockRenderCounts.get('gesture-host')).toBe(hostRenders);
  expect(mockComposeGestures).toHaveBeenCalledTimes(compositionCount);
  expect(mockBuildPan).toHaveBeenCalledTimes(panBuildCount);
  expect(detectorTags()).toEqual(tags);
});

it('updates preview content across zones without rendering the native gesture host', () => {
  const { tag } = mountHandle();
  activateHandle(tag);
  const providerRenders = mockRenderCounts.get('provider')!;
  const hostRenders = mockRenderCounts.get('gesture-host');
  const compositionCount = mockComposeGestures.mock.calls.length;
  const panBuildCount = mockBuildPan.mock.calls.length;

  firePan(tag, 'onUpdate', { absoluteX: 140, absoluteY: 20 });
  tickFrame();
  flushRn();

  expect(mockRuntime.snapshot.targetZoneId).toBe('destination');
  expect(renderPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({ targetZoneId: 'destination' }),
  );
  expect(mockRenderCounts.get('provider')!).toBeGreaterThan(providerRenders);
  expect(mockRenderCounts.get('gesture-host')).toBe(hostRenders);
  expect(mockComposeGestures).toHaveBeenCalledTimes(compositionCount);
  expect(mockBuildPan).toHaveBeenCalledTimes(panBuildCount);
});

describe('commit-batched Provider handle registration', () => {
  function registry() {
    return (
      output.props.children as ReactElement<
        Parameters<typeof DndGestureHost>[0]
      >
    ).props.registry;
  }

  function entries(count = 40) {
    return Array.from({ length: count }, () => {
      const registration: DndHandleRegistration = {
        itemId: 'a',
        zoneId: 'source',
        ref: { current: null } as DndHandleRegistration['ref'],
        sourceRef: { current: null } as DndHandleRegistration['sourceRef'],
        disabled: false,
      };
      measure(registration.ref, { x: 10, y: 5, width: 40, height: 30 });
      measure(registration.sourceRef, { x: 0, y: 0, width: 100, height: 40 });
      return { identity: {}, registration };
    });
  }

  function publish(batch: ReturnType<typeof entries>) {
    for (const entry of batch)
      mockRuntime.registerHandle(entry.registration, entry.identity);
    jest.runAllTicks();
    render();
    flushUi();
  }

  afterEach(() => jest.restoreAllMocks());

  it('publishes forty mounts once after their immediate registrations', () => {
    const batch = entries();
    const owners = registry();
    const previous = owners.getSnapshot();
    const publication = jest.spyOn(owners, 'setOwners');
    const motionRead = jest.spyOn(mockRuntime.motion, 'get');
    const notified = jest.fn();
    const unsubscribe = owners.subscribe(notified);
    const providerRenders = mockRenderCounts.get('provider');

    for (const entry of batch)
      mockRuntime.registerHandle(entry.registration, entry.identity);

    expect(owners.getSnapshot()).toBe(previous);
    expect(publication).not.toHaveBeenCalled();
    expect(motionRead).not.toHaveBeenCalled();
    jest.runAllTicks();
    expect(publication).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(motionRead.mock.calls.length).toBeLessThanOrEqual(1);
    expect(new Set(owners.getSnapshot().map(owner => owner.id))).toHaveProperty(
      'size',
      40,
    );
    expect(owners.getSnapshot().map(owner => owner.registration)).toEqual(
      batch.map(entry => entry.registration),
    );
    render();
    // Forty handles with one relation signature share one native recognizer.
    expect(mockPans.size).toBe(1);
    expect(detectorTags()).toHaveLength(2);
    expect(mockRenderCounts.get('provider')).toBe(providerRenders);
    unsubscribe();
  });

  it('removes forty idle owners with one shared read and one publication', () => {
    const batch = entries();
    publish(batch);
    const owners = registry();
    const previous = owners.getSnapshot();
    const publication = jest.spyOn(owners, 'setOwners');
    const motionRead = jest.spyOn(mockRuntime.motion, 'get');

    for (const entry of batch) mockRuntime.unregisterHandle(entry.identity);

    expect(owners.getSnapshot()).toBe(previous);
    expect(publication).not.toHaveBeenCalled();
    expect(motionRead).not.toHaveBeenCalled();
    jest.runAllTicks();
    expect(motionRead).toHaveBeenCalledTimes(1);
    expect(publication).toHaveBeenCalledTimes(1);
    expect(owners.getSnapshot()).toEqual([]);
    render();
    expect(mockDroppedGestures).toHaveLength(1);
    expect(mockPans.size).toBe(0);
    expect(detectorTags()).toHaveLength(1);

    publication.mockClear();
    motionRead.mockClear();
    for (const entry of batch) mockRuntime.unregisterHandle(entry.identity);
    jest.runAllTicks();
    expect(publication).not.toHaveBeenCalled();
    expect(motionRead).not.toHaveBeenCalled();
  });

  it.each([{ disabled: true }, { itemId: 'b' }, { zoneId: 'destination' }])(
    'validates the latest registration before publication: %o',
    replacement => {
      const batch = entries(1);
      publish(batch);
      const entry = batch[0]!;
      const owners = registry();
      const previous = owners.getSnapshot();
      const tag = detectorTags()[1]!;
      firePan(tag, 'onBegin');
      firePan(tag, 'onTouchesDown');
      firePan(tag, 'onActivate');
      expect(mockRnTasks).toHaveLength(1);
      const next = { ...entry.registration, ...replacement };

      mockRuntime.registerHandle(next, entry.identity);
      expect(owners.getSnapshot()).toBe(previous);
      // Process only the captured begin. flushRn() would also drain the commit.
      mockRnTasks.shift()!();

      expect(mockRuntime.snapshot.phase).toBe('idle');
      expect(props.onChange).not.toHaveBeenCalled();
      expect(onDragEnd).not.toHaveBeenCalled();
      flushUi();
      expectClearedMotion();
      jest.runAllTicks();
      expect(owners.getSnapshot()[0]!.registration).toBe(next);
    },
  );

  it('retains only the UI-active owner when forty cells evict before JS begin', () => {
    const batch = entries();
    publish(batch);
    const owners = registry();
    const activeOwner = owners.getSnapshot()[0]!;
    const tag = detectorTags()[1]!;
    firePan(tag, 'onBegin');
    firePan(tag, 'onTouchesDown');
    firePan(tag, 'onActivate');
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expect(mockRuntime.motion.get().handleId).toBe(activeOwner.id);
    const publication = jest.spyOn(owners, 'setOwners');
    const motionRead = jest.spyOn(mockRuntime.motion, 'get');

    for (const entry of batch) {
      measure(entry.registration.ref, null);
      measure(entry.registration.sourceRef, null);
      mockRuntime.unregisterHandle(entry.identity);
    }
    expect(motionRead).not.toHaveBeenCalled();
    jest.runAllTicks();
    expect(publication).toHaveBeenCalledTimes(1);
    expect(motionRead).toHaveBeenCalledTimes(1);
    expect(owners.getSnapshot()).toEqual([activeOwner]);
    render();
    expect(detectorTags()).toContain(tag);
    expect(mockDroppedGestures).not.toContain(tag);
    expect(mockDroppedGestures).toHaveLength(0);
    flushRn();
    expect(mockRuntime.snapshot.phase).toBe('dragging');
    firePan(tag, 'onUpdate', { absoluteY: 80 });
    tickFrame();
    flushRn();
    expect(mockRuntime.snapshot.target).toHaveProperty('index', 1);
    firePan(tag, 'onFinalize');
    flushRn();
    expect(owners.getSnapshot()).toEqual([]);
    expect(mockDroppedGestures.filter(dropped => dropped === tag)).toHaveLength(
      1,
    );
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'gesture-interrupted' }),
    );
  });

  it('keeps the owner and registration for equivalent same-commit remounts', () => {
    const batch = entries();
    publish(batch);
    const owners = registry();
    const previous = owners.getSnapshot();
    const tags = detectorTags();
    const publication = jest.spyOn(owners, 'setOwners');
    const motionRead = jest.spyOn(mockRuntime.motion, 'get');
    const notified = jest.fn();
    const unsubscribe = owners.subscribe(notified);
    mockBuildPan.mockClear();

    for (const entry of batch) {
      mockRuntime.unregisterHandle(entry.identity);
      mockRuntime.registerHandle({ ...entry.registration }, entry.identity);
    }
    jest.runAllTicks();

    expect(publication).toHaveBeenCalledTimes(1);
    expect(motionRead).not.toHaveBeenCalled();
    expect(owners.getSnapshot()).toBe(previous);
    expect(notified).not.toHaveBeenCalled();
    render();
    expect(detectorTags()).toEqual(tags);
    expect(mockBuildPan).not.toHaveBeenCalled();
    expect(mockDroppedGestures).toEqual([]);
    unsubscribe();
  });

  it.each([false, true])(
    'retains a released owner evicted before JS begin and final validation (cancelled: %s)',
    cancelled => {
      const batch = entries(1);
      publish(batch);
      const entry = batch[0]!;
      const owners = registry();
      const previous = owners.getSnapshot();
      const tag = detectorTags()[1]!;
      firePan(tag, 'onBegin');
      firePan(tag, 'onTouchesDown');
      firePan(tag, 'onActivate');
      firePan(tag, 'onUpdate', { absoluteY: 80 });
      firePan(tag, 'onDeactivate', { absoluteY: 80, canceled: cancelled });
      expect(mockRuntime.motion.get().phase).toBe('released');
      expect(mockRuntime.snapshot.phase).toBe('idle');
      expect(mockRnTasks).toHaveLength(2);
      measure(entry.registration.ref, null);
      measure(entry.registration.sourceRef, null);

      mockRuntime.unregisterHandle(entry.identity);
      jest.runAllTicks();
      render();

      expect(owners.getSnapshot()).toBe(previous);
      expect(mockDroppedGestures).not.toContain(tag);
      flushRn();
      if (cancelled) {
        expect(props.onChange).not.toHaveBeenCalled();
        expect(onDragEnd).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'gesture-interrupted' }),
        );
      } else {
        expect(props.onChange).toHaveBeenCalledTimes(1);
        const proposal = (props.onChange as jest.Mock).mock.calls[0][1];
        expect(proposal.to).toEqual({
          kind: 'list',
          zoneId: 'source',
          index: 1,
        });
        expect(mockRuntime.snapshot.phase).toBe('awaiting-response');
        expect(mockDroppedGestures).not.toContain(tag);
        props = {
          ...props,
          value: {
            ...proposal.value,
            proposalResponse: {
              sessionId: proposal.sessionId,
              baseRevision: proposal.baseRevision,
              accepted: true,
            },
          },
        };
        render();
        flushUi();
        expect(onDragEnd).toHaveBeenCalledWith(
          expect.objectContaining({ response: 'accepted' }),
        );
      }
      expect(mockRuntime.snapshot.phase).toBe('idle');
      expect(owners.getSnapshot()).toEqual([]);
      expect(
        mockDroppedGestures.filter(dropped => dropped === tag),
      ).toHaveLength(1);
    },
  );

  it('keeps latest replacement refs and the active tag through a same-commit remount', () => {
    const batch = entries(1);
    publish(batch);
    const entry = batch[0]!;
    const owners = registry();
    const id = owners.getSnapshot()[0]!.id;
    const tag = detectorTags()[1]!;
    activateHandle(tag);
    const token = mockRuntime.motion.get().token;
    const replacement = entries(1)[0]!.registration;
    const publication = jest.spyOn(owners, 'setOwners');

    mockRuntime.unregisterHandle(entry.identity);
    mockRuntime.registerHandle(replacement, entry.identity);
    jest.runAllTicks();

    expect(publication).toHaveBeenCalledTimes(1);
    expect(owners.getSnapshot()).toEqual([{ id, registration: replacement }]);
    expect(owners.getSnapshot()[0]!.registration).toBe(replacement);
    render();
    expect(detectorTags()).toContain(tag);
    expect(mockDroppedGestures).not.toContain(tag);
    firePan(tag, 'onUpdate', { absoluteY: 80 });
    tickFrame();
    flushRn();
    expect(mockRuntime.motion.get().token).toBe(token);
    expect(mockRuntime.snapshot.target).toHaveProperty('index', 1);
  });

  it('reads the latest UI owner when the removal batch executes', () => {
    const batch = entries(2);
    publish(batch);
    const owners = registry();
    const first = owners.getSnapshot()[0]!;
    const second = owners.getSnapshot()[1]!;
    mockRuntime.motion.set(state({ handleId: first.id }));
    const motionRead = jest.spyOn(mockRuntime.motion, 'get');
    for (const entry of batch) mockRuntime.unregisterHandle(entry.identity);
    expect(motionRead).not.toHaveBeenCalled();
    mockRuntime.motion.set(state({ handleId: second.id, token: 2 }));

    jest.runAllTicks();

    expect(motionRead).toHaveBeenCalledTimes(1);
    expect(owners.getSnapshot()).toEqual([second]);
  });

  it('ignores an old Provider publication delivered after a new Provider mounts', () => {
    const oldRuntime = mockRuntime;
    const oldOwners = registry();
    const oldPublication = jest.spyOn(oldOwners, 'setOwners');
    const oldMotionRead = jest.spyOn(oldRuntime.motion, 'get');
    const oldTasks: Array<() => void> = [];
    const queue = jest
      .spyOn(
        globalThis as typeof globalThis & {
          queueMicrotask(callback: () => void): void;
        },
        'queueMicrotask',
      )
      .mockImplementation(callback => oldTasks.push(callback));
    const [entry] = entries(1);
    oldRuntime.registerHandle(entry!.registration, entry!.identity);
    oldRuntime.unregisterHandle(entry!.identity);
    expect(oldTasks).toHaveLength(1);
    unmount();
    queue.mockRestore();
    oldPublication.mockClear();
    oldMotionRead.mockClear();

    props = { ...props };
    render();
    const currentOwners = registry();
    expect(currentOwners).not.toBe(oldOwners);
    publish(entries(1));
    const currentSnapshot = currentOwners.getSnapshot();
    const currentPublication = jest.spyOn(currentOwners, 'setOwners');

    oldTasks.forEach(task => task());
    oldRuntime.registerHandle(entry!.registration, entry!.identity);
    oldRuntime.unregisterHandle(entry!.identity);
    jest.runAllTicks();

    expect(oldPublication).not.toHaveBeenCalled();
    expect(oldMotionRead).not.toHaveBeenCalled();
    expect(currentPublication).not.toHaveBeenCalled();
    expect(currentOwners.getSnapshot()).toBe(currentSnapshot);
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expect(mockPans.size).toBe(1);
  });
});

it('registers newly visible handles in the host without rendering the Provider', () => {
  const providerRenders = mockRenderCounts.get('provider');
  mountHandle('first');
  const firstTag = detectorTags().find(tag => mockPans.has(tag))!;
  const firstConfig = mockPans.get(firstTag);
  const firstBuildCount = mockBuildPan.mock.calls.length;

  mountHandle('second');

  expect(mockRenderCounts.get('provider')).toBe(providerRenders);
  // The second handle joins the first recognizer's hit targets.
  expect(mockPans).toHaveProperty('size', 1);
  expect(mockBuildPan).toHaveBeenCalledTimes(firstBuildCount);
  expect(mockPans.get(firstTag)).toBe(firstConfig);
  expect(detectorTags()).toContain(firstTag);
  unmountHandle('second');
  expect(mockRenderCounts.get('provider')).toBe(providerRenders);
  expect(mockPans).toHaveProperty('size', 1);
  expect(mockPans.get(firstTag)).toBe(firstConfig);
});

it('reuses native owner configuration after an accepted revision and activates with the new revision', () => {
  const store = createDndStateStore(props.value);
  props = {
    ...props,
    onChange: jest.fn((next, proposal) => {
      store.onChange(next, proposal);
      props = { ...props, value: store.getSnapshot() };
    }),
  };
  render();
  const { tag, sourceRef, handle } = mountHandle();
  activateHandle(tag);
  const config = mockPans.get(tag);
  const panBuildCount = mockBuildPan.mock.calls.length;
  const compositionCount = mockComposeGestures.mock.calls.length;
  move({ x: 20, y: 70 });
  release();

  expect(props.value.revision).toBe(1);
  expect(mockPans.get(tag)).toBe(config);
  expect(mockBuildPan).toHaveBeenCalledTimes(panBuildCount);
  expect(mockComposeGestures).toHaveBeenCalledTimes(compositionCount);
  expectClearedMotion();
  measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
  measure(handle.output!.props.ref, { x: 10, y: 45, width: 40, height: 30 });
  firePan(tag, 'onBegin');
  firePan(tag, 'onTouchesDown', {
    changedTouches: [{ absoluteX: 20, absoluteY: 60 }],
  });
  firePan(tag, 'onActivate', { absoluteY: 60 });
  flushRn();

  expect(mockGestureFail).not.toHaveBeenCalled();
  expect(mockRuntime.motion.get()).toMatchObject({
    revision: 1,
    phase: 'dragging',
    itemId: 'a',
  });
  expect(mockPans.get(tag)).toBe(config);
});

it('keeps idle measurements lightweight and publishes full target tables at activation', () => {
  listProps.source = {
    ...listProps.source,
    itemSize: undefined,
    estimatedItemSize: 40,
    virtualization: true,
  };
  render();
  mountGrid();
  flushUi();
  const idlePresentation = mockRuntime.presentation!.get();
  const initial = mockRuntime.zones.get();
  const source = initial.find(zone => zone.zoneId === 'source')!;
  expect(idlePresentation.zones).toEqual({});
  expect(
    initial.every(zone =>
      zone.kind === 'list' ? !zone.targetIndex : !zone.targetGrid,
    ),
  ).toBe(true);

  listCell('source', 'b').props.onSize('b', 80);
  jest.advanceTimersByTime(20);
  render();
  flushUi();

  const measured = mockRuntime.zones
    .get()
    .find(zone => zone.zoneId === 'source')!;
  expect(measured).toMatchObject({ contentSize: 200, targetIndex: undefined });
  expect(measured.layoutVersion).toBeGreaterThan(source.layoutVersion);
  expect(mockRuntime.presentation!.get()).toBe(idlePresentation);
  expect(listCell('source', 'c').props.start).toBe(120);
  const { tag } = mountHandle();
  activateHandle(tag);

  const active = mockRuntime.zones.get();
  expect(
    active.every(zone =>
      zone.kind === 'list' ? !!zone.targetIndex : !!zone.targetGrid,
    ),
  ).toBe(true);
  expect(thresholdsOf('source')).toEqual([20, 80, 140, 180]);
  expect(
    presentationRect(mockRuntime.presentation!.get(), 'source', 'b'),
  ).toMatchObject({
    y: 40,
    height: 80,
  });
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  expect(mockRuntime.motion.get().visible).toBe(true);
});

it('keeps measured target tables through active drag and settlement, then clears them at idle', () => {
  props = { ...props, motion: { durationMs: 180 } };
  listProps.source = {
    ...listProps.source,
    itemSize: undefined,
    estimatedItemSize: 40,
    virtualization: true,
  };
  render();
  const { tag } = mountHandle();
  activateHandle(tag);
  move({ x: 20, y: 70 });
  listCell('source', 'b').props.onSize('b', 80);
  jest.advanceTimersByTime(20);
  render();
  flushUi();
  expect(
    presentationRect(mockRuntime.presentation!.get(), 'source', 'a')!.y,
  ).toBe(80);
  expect(thresholdsOf('source')).toEqual([20, 80, 140, 180]);

  release(true);
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expect(mockRuntime.motion.get().visible).toBe(true);
  listCell('source', 'b').props.onSize('b', 100);
  jest.advanceTimersByTime(20);
  render();
  flushUi();
  expect(
    presentationRect(mockRuntime.presentation!.get(), 'source', 'b'),
  ).toMatchObject({
    y: 40,
    height: 100,
  });
  expect(thresholdsOf('source')).toEqual([20, 90, 160, 200]);
  tickFrame();
  advanceAnimations();
  tickFrame();
  flushRn();

  expectClearedMotion();
  expect(mockRuntime.presentation!.get().zones).toEqual({});
  expect(
    mockRuntime.zones
      .get()
      .every(zone =>
        zone.kind === 'list' ? !zone.targetIndex : !zone.targetGrid,
      ),
  ).toBe(true);
});

it.each(['list', 'grid'] as const)(
  'keeps coordinator %s targets plain when Worklets freezes the detached UI copies',
  kind => {
    mockFreezeSharedTargets = true;
    const canDrop = jest.fn(() => ({ allowed: true }));
    props = {
      ...props,
      canDrop,
      getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
    };
    render();
    if (kind === 'grid') mountGrid();
    begin();
    expect(
      Object.getOwnPropertyDescriptor(mockRuntime.snapshot.target!, 'kind'),
    ).toHaveProperty('value', 'list');
    const pointer = kind === 'list' ? { x: 20, y: 70 } : { x: 140, y: 130 };
    move(pointer);
    const runtime = mockRuntime;
    const snapshot = runtime.snapshot;
    const published = runtime.presentation!.get().releaseTarget!.target;
    expect(published).not.toBe(snapshot.target);
    expect(Object.getOwnPropertyDescriptor(published, 'kind')).toHaveProperty(
      'get',
      expect.any(Function),
    );
    expect(
      Object.getOwnPropertyDescriptor(snapshot.target!, 'kind'),
    ).toHaveProperty('value', kind);
    if (snapshot.target?.kind === 'grid' && published.kind === 'grid') {
      expect(published.position).not.toBe(snapshot.target.position);
      expect(
        Object.getOwnPropertyDescriptor(published.position, 'row'),
      ).toHaveProperty('get', expect.any(Function));
      expect(
        Object.getOwnPropertyDescriptor(snapshot.target.position, 'row'),
      ).toHaveProperty('value', 0);
    }
    const calls = canDrop.mock.calls.length;
    lists.source.props.onScroll({ contentOffset: { x: 0, y: 1 } });
    move(pointer);
    expect(canDrop).toHaveBeenCalledTimes(calls + 1);
    expect(mockRuntime.snapshot).toBe(snapshot);
    expect(mockRuntime).toBe(runtime);
  },
);

it('sends no repeated JS target work while native pointer updates stay in the same slot', () => {
  const canDrop = jest.fn(() => ({ allowed: true }));
  props = { ...props, canDrop };
  render();
  const { tag } = mountHandle();
  activateHandle(tag);
  firePan(tag, 'onUpdate', { absoluteY: 70 });
  tickFrame();
  expect(mockRnTasks).toHaveLength(1);
  flushRn();
  const snapshot = mockRuntime.snapshot;
  const calls = canDrop.mock.calls.length;
  for (let index = 0; index < 240; index++) {
    firePan(tag, 'onUpdate', { absoluteX: 20 + (index % 10), absoluteY: 70 });
    tickFrame();
  }
  expect(mockRnTasks).toHaveLength(0);
  expect(mockRuntime.snapshot).toBe(snapshot);
  expect(canDrop).toHaveBeenCalledTimes(calls);
  expect(mockRuntime.motion.get().pointer).toEqual({ x: 29, y: 70 });
  firePan(tag, 'onDeactivate', {
    absoluteX: 29,
    absoluteY: 70,
    canceled: false,
  });
  flushRn();
  expect(canDrop).toHaveBeenCalledTimes(calls + 1);
});

it('bounds queued target work while JS is busy and processes the latest pointer after acknowledgement', () => {
  const { tag } = mountHandle();
  activateHandle(tag);
  firePan(tag, 'onUpdate', { absoluteY: 70 });
  tickFrame();
  expect(mockRnTasks).toHaveLength(1);
  for (let index = 0; index < 120; index++) {
    firePan(tag, 'onUpdate', {
      absoluteX: index % 2 === 0 ? 20 : 140,
      absoluteY: 70,
    });
    tickFrame();
  }
  expect(mockRnTasks).toHaveLength(1);
  expect(mockRuntime.motion.get().pointer).toEqual({ x: 140, y: 70 });
  flushRn();
  tickFrame();
  expect(mockRnTasks).toHaveLength(1);
  flushRn();
  expect(mockRuntime.snapshot.target).toEqual({
    kind: 'list',
    zoneId: 'destination',
    index: 0,
  });
  tickFrame();
  expect(mockRnTasks).toHaveLength(0);
});

it('validates the release pointer even when an older move is waiting in the JS queue', () => {
  const store = createDndStateStore(props.value);
  props = {
    ...props,
    onChange: jest.fn((next, proposal) => {
      store.onChange(next, proposal);
      props = { ...props, value: store.getSnapshot() };
    }),
  };
  render();
  const { tag } = mountHandle();
  activateHandle(tag);
  firePan(tag, 'onUpdate', { absoluteY: 70 });
  tickFrame();
  for (let index = 0; index < 120; index++) {
    firePan(tag, 'onUpdate', {
      absoluteX: index % 2 === 0 ? 20 : 140,
      absoluteY: 70,
    });
    tickFrame();
  }
  expect(mockRnTasks).toHaveLength(1);
  firePan(tag, 'onDeactivate', {
    absoluteX: 140,
    absoluteY: 70,
    canceled: false,
  });
  expect(mockRnTasks).toHaveLength(2);
  flushRn();
  expect(props.value.zones[0]).toHaveProperty('itemIds', ['b', 'c', 'd']);
  expect(props.value.zones[1]).toHaveProperty('itemIds', ['a']);
  expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ response: 'accepted' }),
  );
  expectClearedMotion();
});

it.each([false, true])(
  'skips obsolete queued move work after native release while preserving final validation (cancelled: %s)',
  cancelled => {
    const canDrop = jest.fn(() => ({ allowed: true }));
    const store = createDndStateStore(props.value);
    props = {
      ...props,
      canDrop,
      onChange: jest.fn((next, proposal) => {
        store.onChange(next, proposal);
        props = { ...props, value: store.getSnapshot() };
      }),
    };
    render();
    const { tag } = mountHandle();
    activateHandle(tag);
    canDrop.mockClear();
    const presentation = mockRuntime.presentation!.get();
    firePan(tag, 'onUpdate', { absoluteY: 70 });
    tickFrame();
    expect(mockRnTasks).toHaveLength(1);
    firePan(tag, 'onDeactivate', {
      absoluteX: 140,
      absoluteY: 70,
      canceled: cancelled,
    });
    expect(mockRnTasks).toHaveLength(2);
    const [queuedMove, queuedRelease] = mockRnTasks.splice(0);
    expect(mockDirty).toBe(false);
    queuedMove();
    flushUi();
    expect(canDrop).not.toHaveBeenCalled();
    expect(mockDirty).toBe(false);
    expect(mockRuntime.presentation!.get()).toBe(presentation);
    expect(props.onChange).not.toHaveBeenCalled();
    queuedRelease();
    render();
    flushUi();
    expect(canDrop).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    expect(props.onChange).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    expect(props.value.zones[1]).toHaveProperty(
      'itemIds',
      cancelled ? [] : ['a'],
    );
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining(
        cancelled
          ? { outcome: 'cancelled', reason: 'gesture-interrupted' }
          : { response: 'accepted' },
      ),
    );
    expectClearedMotion();
  },
);

it.each([true, false])(
  'publishes only a policy-validated layout before React commits (allowed: %s)',
  allowed => {
    const canDrop = jest.fn(() => ({ allowed }));
    props = { ...props, canDrop };
    render();
    const { tag } = mountHandle();
    activateHandle(tag);
    const providerRenders = mockRenderCounts.get('provider');
    canDrop.mockClear();
    firePan(tag, 'onUpdate', { absoluteY: 70 });
    tickFrame();
    flushUi();
    expect(canDrop).not.toHaveBeenCalled();
    expect(
      presentationRect(mockRuntime.presentation!.get(), 'source', 'a')!.y,
    ).toBe(0);
    // Run the policy work but deliberately leave React's queued commit pending.
    mockRnTasks.splice(0).forEach(task => task());
    flushUi();
    expect(canDrop).toHaveBeenCalledTimes(1);
    expect(mockRenderCounts.get('provider')).toBe(providerRenders);
    expect(mockRuntime.snapshot.target).toEqual({
      kind: 'list',
      zoneId: 'source',
      index: 1,
    });
    expect(
      presentationRect(mockRuntime.presentation!.get(), 'source', 'a')!.y,
    ).toBe(allowed ? 40 : 0);
    render();
    flushUi();
  },
);

describe('native drop settlement', () => {
  function acceptChanges(durationMs = 180) {
    const store = createDndStateStore(props.value);
    props = {
      ...props,
      motion: { durationMs },
      onChange: jest.fn((next, proposal) => {
        store.onChange(next, proposal);
        props = { ...props, value: store.getSnapshot() };
      }),
    };
    render();
  }

  it('animates an accepted drop immediately and waits at the destination until its native cell is ready', () => {
    acceptChanges();
    const { tag, sourceRef } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'accepted' }),
    );
    expect(mockRuntime.motion.get()).toMatchObject({
      phase: 'released',
      visible: true,
      itemId: 'a',
    });
    expect(previewOverlay()).not.toBeNull();
    tickFrame();
    expect(mockTiming).toHaveBeenLastCalledWith(
      1,
      { duration: 180, reduceMotion: 'system' },
      expect.any(Function),
    );
    expect(flattenStyle(previewOverlay()!.props.style)).toMatchObject({
      opacity: 1,
      transform: [
        { translateX: 0 },
        { translateY: 75 },
        { scaleX: 1 },
        { scaleY: 1 },
      ],
    });
    advanceAnimations(0.5);
    expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
      { translateX: 0 },
      { translateY: 57.5 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
    expect(mockRuntime.motion.get().visible).toBe(true);
    advanceAnimations();
    tickFrame();
    // A still-mounted cell in the old position cannot receive the handoff,
    // but it must not delay the overlay's movement to the committed slot.
    expect(mockRuntime.motion.get().visible).toBe(true);
    expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
      { translateX: 0 },
      { translateY: 40 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
    measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
    tickFrame();
    expectClearedMotion();
    flushRn();
    expect(previewOverlay()).toBeNull();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('repeats the end event through onDragSettled only once the preview has settled', () => {
    acceptChanges();
    const { tag, sourceRef } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragSettled).not.toHaveBeenCalled();
    tickFrame();
    advanceAnimations();
    tickFrame();
    flushRn();
    expect(onDragSettled).not.toHaveBeenCalled();
    measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
    tickFrame();
    flushRn();
    expect(previewOverlay()).toBeNull();
    expect(onDragSettled).toHaveBeenCalledTimes(1);
    expect(onDragSettled).toHaveBeenCalledWith(onDragEnd.mock.calls[0][0]);
    expect(onDragSettled.mock.invocationCallOrder[0]).toBeGreaterThan(
      onDragEnd.mock.invocationCallOrder[0],
    );
  });

  it('reports onDragSettled right after onDragEnd when nothing animates', () => {
    acceptChanges(0);
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragSettled).toHaveBeenCalledTimes(1);
    expect(onDragSettled).toHaveBeenCalledWith(onDragEnd.mock.calls[0][0]);
    expect(onDragSettled.mock.invocationCallOrder[0]).toBeGreaterThan(
      onDragEnd.mock.invocationCallOrder[0],
    );
  });

  it('flushes a pending onDragSettled when the provider unmounts mid-settlement', () => {
    acceptChanges();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    tickFrame();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragSettled).not.toHaveBeenCalled();
    unmount();
    expect(onDragSettled).toHaveBeenCalledTimes(1);
    expect(onDragSettled).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'accepted' }),
    );
  });

  it.each(['complete', 'timeout'] as const)(
    'retains an evicted native owner through settlement and cleans it after %s',
    outcome => {
      acceptChanges();
      const { tag } = mountHandle();
      const sentinel = detectorTags()[0];
      activateHandle(tag);
      const evictedOwner = mockRuntime.motion.get().handleId;
      unmountHandle('a');
      firePan(tag, 'onUpdate', { absoluteY: 95 });
      tickFrame();
      flushRn();
      firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
      flushRn();
      expect(mockRuntime.snapshot.phase).toBe('idle');
      expect(mockRuntime.motion.get().visible).toBe(true);
      expect(detectorTags()).toEqual([sentinel, tag]);
      expect(
        gestureRegistry()
          .getSnapshot()
          .map(owner => owner.id),
      ).toEqual([evictedOwner]);
      expect(mockDroppedGestures).not.toContain(tag);
      tickFrame();
      expect(mockTiming).toHaveBeenCalledTimes(1);
      advanceAnimations();
      tickFrame();
      expect(mockRuntime.motion.get().visible).toBe(true);
      if (outcome === 'complete') {
        const destination = mountHandle('remounted');
        measure(destination.sourceRef, { x: 0, y: 40, width: 100, height: 40 });
        flushUi();
        tickFrame();
        expect(mockTiming).toHaveBeenCalledTimes(1);
      } else {
        tickFrame(1000);
        expect(mockTiming).toHaveBeenCalledTimes(1);
      }
      expectClearedMotion();
      flushRn();
      expect(previewOverlay()).toBeNull();
      expect(
        gestureRegistry()
          .getSnapshot()
          .map(owner => owner.id),
      ).not.toContain(evictedOwner);
      if (outcome === 'complete') {
        // The remounted handle keeps the shared recognizer alive.
        expect(detectorTags()).toContain(tag);
        expect(mockDroppedGestures).not.toContain(tag);
      } else {
        expect(detectorTags()).not.toContain(tag);
        expect(mockDroppedGestures).toContain(tag);
      }
      expect(onDragEnd).toHaveBeenCalledTimes(1);
    },
  );

  it('starts validated preview motion before JS processes release and retains it until delayed approval', () => {
    const store = createDndStateStore(props.value);
    props = { ...props, motion: { durationMs: 180 } };
    render();
    const { tag, sourceRef } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    // JS has not processed the release or invoked the consumer's onChange yet.
    tickFrame();
    expect(mockRuntime.snapshot.phase).toBe('dragging');
    expect(props.onChange).not.toHaveBeenCalled();
    expect(mockTiming).toHaveBeenLastCalledWith(
      1,
      { duration: 180, reduceMotion: 'system' },
      expect.any(Function),
    );
    advanceAnimations(0.5);
    expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
      { translateX: 0 },
      { translateY: 57.5 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
    flushRn();
    expect(mockRuntime.snapshot.phase).toBe('awaiting-response');
    advanceAnimations();
    tickFrame(300);
    expect(mockTiming).toHaveBeenCalledTimes(1);
    expect(mockRuntime.motion.get().visible).toBe(true);
    expect(previewOverlay()).not.toBeNull();
    expect(onDragEnd).not.toHaveBeenCalled();
    const proposal = (props.onChange as jest.Mock).mock.calls[0][1];
    store.respond(proposal, true);
    props = { ...props, value: store.getSnapshot() };
    render();
    flushUi();
    tickFrame();
    expect(mockTiming).toHaveBeenCalledTimes(1);
    expect(mockRuntime.motion.get().visible).toBe(true);
    measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
    tickFrame();
    flushRn();
    expectClearedMotion();
    expect(previewOverlay()).toBeNull();
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'accepted' }),
    );
  });

  it('animates a rejected delayed proposal back from the completed preview without hiding the overlay', () => {
    const store = createDndStateStore(props.value);
    props = { ...props, motion: { durationMs: 180 } };
    render();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    tickFrame();
    advanceAnimations();
    flushRn();
    tickFrame(300);
    expect(mockRuntime.snapshot.phase).toBe('awaiting-response');
    expect(mockRuntime.motion.get().visible).toBe(true);
    expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
      { translateX: 0 },
      { translateY: 40 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
    const proposal = (props.onChange as jest.Mock).mock.calls[0][1];
    store.respond(proposal, false);
    props = { ...props, value: store.getSnapshot() };
    render();
    flushUi();
    tickFrame();
    expect(
      mockTiming.mock.calls.map(([, options]) => options?.duration),
    ).toEqual([180, 180]);
    expect(mockRuntime.motion.get().visible).toBe(true);
    advanceAnimations(0.5);
    expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
      { translateX: 0 },
      { translateY: 20 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
    advanceAnimations();
    tickFrame();
    flushRn();
    expectClearedMotion();
    expect(previewOverlay()).toBeNull();
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'rejected' }),
    );
  });

  it.each([true, false])(
    'animates a newly validated release target while its proposal awaits response (accepted: %s)',
    accepted => {
      const store = createDndStateStore(props.value);
      props = { ...props, motion: { durationMs: 180 } };
      render();
      const { tag, handle, sourceRef } = mountHandle();
      activateHandle(tag);
      firePan(tag, 'onUpdate', { absoluteY: 70 });
      tickFrame();
      flushRn();
      expect(mockRuntime.snapshot.target).toHaveProperty('zoneId', 'source');
      // The final pointer jumps to a zone that the previous preview never approved.
      firePan(tag, 'onDeactivate', {
        absoluteX: 140,
        absoluteY: 70,
        canceled: false,
      });
      tickFrame();
      expect(mockTiming).not.toHaveBeenCalled();
      expect(props.onChange).not.toHaveBeenCalled();
      flushRn();
      expect(mockRuntime.snapshot.phase).toBe('awaiting-response');
      expect(mockRuntime.snapshot.target).toEqual({
        kind: 'list',
        zoneId: 'destination',
        index: 0,
      });
      expect(props.value.revision).toBe(0);
      tickFrame();
      expect(mockTiming).toHaveBeenCalledTimes(1);
      advanceAnimations();
      tickFrame();
      expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
        { translateX: 120 },
        { translateY: 0 },
        { scaleX: 1 },
        { scaleY: 1 },
      ]);
      expect(mockRuntime.motion.get().visible).toBe(true);
      expect(onDragEnd).not.toHaveBeenCalled();
      const proposal = (props.onChange as jest.Mock).mock.calls[0][1];
      store.respond(proposal, accepted);
      props = { ...props, value: store.getSnapshot() };
      if (accepted) {
        handle.scope = { ...handle.scope, zoneId: 'destination' };
        measure(sourceRef, { x: 120, y: 0, width: 100, height: 40 });
      }
      render();
      flushUi();
      tickFrame();
      expect(mockTiming).toHaveBeenCalledTimes(accepted ? 1 : 2);
      if (!accepted) {
        expect(mockRuntime.motion.get().visible).toBe(true);
        advanceAnimations(0.5);
        expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
          { translateX: 60 },
          { translateY: 0 },
          { scaleX: 1 },
          { scaleY: 1 },
        ]);
        advanceAnimations();
        tickFrame();
      }
      flushRn();
      expectClearedMotion();
      expect(previewOverlay()).toBeNull();
      expect(onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          response: accepted ? 'accepted' : 'rejected',
        }),
      );
    },
  );

  it('does not let a late final-validation publication authorize a different release sequence and target', () => {
    props = { ...props, motion: { durationMs: 180 } };
    render();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 70 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', {
      absoluteX: 140,
      absoluteY: 70,
      canceled: false,
    });
    const released = mockRuntime.motion.get();
    mockRuntime.motion.set({
      ...released,
      seq: released.seq + 1,
      pointer: { x: 20, y: 70 },
    });
    mockRnTasks.splice(0).forEach(task => task());
    flushUi();
    tickFrame();
    expect(mockTiming).not.toHaveBeenCalled();
    expect(mockRuntime.motion.get().visible).toBe(true);
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it('starts a final validated release without waiting for the queued UI publications or React commit', () => {
    props = { ...props, motion: { durationMs: 180 } };
    render();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 70 });
    tickFrame();
    mockRnTasks.splice(0).forEach(task => task());
    render();
    expect(mockUiTasks.length).toBeGreaterThan(0);
    expect(mockRunOnUISync).not.toHaveBeenCalled();
    firePan(tag, 'onDeactivate', {
      absoluteX: 140,
      absoluteY: 70,
      canceled: false,
    });
    tickFrame();
    expect(mockTiming).not.toHaveBeenCalled();
    // Process final JS policy validation but do not flush UI tasks or render React.
    const providerRenders = mockRenderCounts.get('provider');
    mockRnTasks.splice(0).forEach(task => task());
    expect(props.onChange).toHaveBeenCalledTimes(1);
    expect(props.value.revision).toBe(0);
    expect(mockRenderCounts.get('provider')).toBe(providerRenders);
    expect(mockRuntime.snapshot.phase).toBe('awaiting-response');
    expect(mockRunOnUISync).toHaveBeenCalled();
    expect(mockRuntime.presentation!.get().releaseTarget).toMatchObject({
      target: { kind: 'list', zoneId: 'destination', index: 0 },
      releasedSeq: mockRuntime.motion.get().seq,
    });
    const finalPresentation = mockRuntime.presentation!.get();
    tickFrame();
    expect(mockTiming).toHaveBeenCalledTimes(1);
    advanceAnimations();
    expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
      { translateX: 120 },
      { translateY: 0 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
    expect(mockRuntime.motion.get().visible).toBe(true);
    expect(onDragEnd).not.toHaveBeenCalled();
    // An earlier async drag publication cannot overwrite the final sync result.
    flushUi();
    expect(mockRuntime.presentation!.get()).toBe(finalPresentation);
  });

  it.each(['cancelled', 'new-target', 'new-policy'] as const)(
    'does not start an unvalidated release preview while JS is busy (%s)',
    change => {
      props = { ...props, motion: { durationMs: 180 } };
      render();
      const { tag } = mountHandle();
      activateHandle(tag);
      firePan(tag, 'onUpdate', { absoluteY: 95 });
      tickFrame();
      flushRn();
      if (change === 'new-policy') {
        props = { ...props, canDrop: () => ({ allowed: false }) };
        render();
        flushUi();
      }
      firePan(tag, 'onDeactivate', {
        absoluteX: change === 'new-target' ? 140 : 20,
        absoluteY: 95,
        canceled: change === 'cancelled',
      });
      tickFrame();
      advanceAnimations();
      expect(mockTiming).not.toHaveBeenCalled();
      expect(props.onChange).not.toHaveBeenCalled();
      expect(mockRuntime.motion.get().visible).toBe(true);
    },
  );

  it('follows the native destination when scrolling moves it during settlement', () => {
    acceptChanges();
    const { tag, sourceRef } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
    tickFrame();
    advanceAnimations(0.5);
    lists.source.props.onScroll({ contentOffset: { x: 0, y: 10 } });
    measure(sourceRef, { x: 0, y: 30, width: 100, height: 40 });
    tickFrame();
    advanceAnimations();
    expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
      { translateX: 0 },
      { translateY: 30 },
      { scaleX: 1 },
      { scaleY: 1 },
    ]);
    tickFrame();
    flushRn();
    expectClearedMotion();
    expect(previewOverlay()).toBeNull();
  });

  it('bounds settlement even while scrolling retargets its destination every frame', () => {
    acceptChanges();
    const { tag, sourceRef } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
    tickFrame();
    const startedAt = mockTimestamp;
    for (
      let frame = 0;
      frame < 12 && mockRuntime.motion.get().visible;
      frame++
    ) {
      const offset = frame % 2 === 0 ? 10 : 0;
      advanceAnimations(0.1);
      lists.source.props.onScroll({ contentOffset: { x: 0, y: offset } });
      measure(sourceRef, { x: 0, y: 40 - offset, width: 100, height: 40 });
      tickFrame(100);
    }
    expectClearedMotion();
    expect(mockTimestamp - startedAt).toBeLessThanOrEqual(1000);
    flushRn();
    expect(previewOverlay()).toBeNull();
  });

  it('bounds native handoff after a preview is accepted and retargeted on every committed frame', () => {
    acceptChanges();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    tickFrame();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(mockTiming).toHaveBeenCalledTimes(1);
    advanceAnimations(0.1);
    flushRn();
    expect(mockRuntime.snapshot.phase).toBe('idle');
    // Retarget the first committed frame, when the handoff timeout is initialized.
    // The native cell stays in its old slot throughout this test.
    lists.source.props.onScroll({ contentOffset: { x: 0, y: 10 } });
    tickFrame();
    const committedAt = mockTimestamp;
    for (
      let frame = 0;
      frame < 12 && mockRuntime.motion.get().visible;
      frame++
    ) {
      advanceAnimations(0.1);
      lists.source.props.onScroll({
        contentOffset: { x: 0, y: frame % 2 === 0 ? 0 : 10 },
      });
      tickFrame(100);
    }
    expectClearedMotion();
    expect(mockTimestamp - committedAt).toBeLessThanOrEqual(1000);
    flushRn();
    expect(previewOverlay()).toBeNull();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps the original animation deadline when scrolling repeatedly retargets a drop', () => {
    acceptChanges();
    const { tag, sourceRef } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
    tickFrame();
    for (const offset of [10, 0, 10]) {
      advanceAnimations(0.1);
      lists.source.props.onScroll({ contentOffset: { x: 0, y: offset } });
      measure(sourceRef, { x: 0, y: 40 - offset, width: 100, height: 40 });
      tickFrame(40);
    }
    expect(
      mockTiming.mock.calls.map(([, options]) => options?.duration),
    ).toEqual([180, 140, 100, 60]);
    advanceAnimations();
    tickFrame();
    flushRn();
    expectClearedMotion();
    expect(previewOverlay()).toBeNull();
  });

  it('cleans up a committed drop immediately when scrolling moves its destination offscreen', () => {
    acceptChanges();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    lists.source.props.onScroll({ contentOffset: { x: 0, y: 100 } });
    tickFrame();
    expect(mockTiming).not.toHaveBeenCalled();
    expectClearedMotion();
    flushRn();
    expect(previewOverlay()).toBeNull();
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'accepted' }),
    );
  });

  it('ignores old animation and queued handoff cleanup after another drag has started', () => {
    props = { ...props, motion: { durationMs: 180 } };
    render();
    const { tag } = mountHandle();
    activateHandle(tag);
    firePan(tag, 'onUpdate', { absoluteY: 70 });
    tickFrame();
    flushRn();
    release(true);
    tickFrame();
    expect(mockAnimations).toHaveLength(1);
    const oldAnimation = mockAnimations[0];
    const oldToken = mockRuntime.motion.get().token;
    advanceAnimations();
    tickFrame();
    const oldCleanup = mockRnTasks.splice(0);
    expect(oldCleanup).toHaveLength(1);
    expectClearedMotion();
    activateHandle(tag);
    const currentSession = mockRuntime.snapshot.sessionId;
    expect(mockRuntime.motion.get().token).toBeGreaterThan(oldToken);
    oldAnimation.callback?.(true);
    oldCleanup.forEach(task => task());
    render();
    flushUi();
    expect(mockRuntime.snapshot).toMatchObject({
      phase: 'dragging',
      sessionId: currentSession,
    });
    expect(mockRuntime.motion.get().visible).toBe(true);
    expect(previewOverlay()).not.toBeNull();
    expect(detectorTags()).toContain(tag);
  });

  it.each([false, true])(
    'clears settlement when an external revision arrives (native cell ready: %s)',
    nativeReady => {
      acceptChanges();
      const { tag, sourceRef } = mountHandle();
      activateHandle(tag);
      firePan(tag, 'onUpdate', { absoluteY: 95 });
      tickFrame();
      flushRn();
      firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
      flushRn();
      if (nativeReady)
        measure(sourceRef, { x: 0, y: 40, width: 100, height: 40 });
      tickFrame();
      expect(mockRuntime.motion.get().visible).toBe(true);
      props = {
        ...props,
        value: { ...props.value, revision: props.value.revision + 1 },
      };
      render();
      flushUi();
      expectClearedMotion();
      expect(previewOverlay()).toBeNull();
      advanceAnimations();
      tickFrame();
      flushRn();
      expectClearedMotion();
      expect(onDragEnd).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['cancelled', 'rejected'] as const)(
    'settles a %s drag back to its committed source slot',
    outcome => {
      const store = createDndStateStore(props.value);
      props = {
        ...props,
        motion: { durationMs: 180 },
        onChange: jest.fn((_next, proposal) => {
          store.respond(proposal, false);
          props = { ...props, value: store.getSnapshot() };
        }),
      };
      render();
      const { tag } = mountHandle();
      activateHandle(tag);
      firePan(tag, 'onUpdate', { absoluteY: 95 });
      tickFrame();
      flushRn();
      firePan(tag, 'onDeactivate', {
        absoluteY: 95,
        canceled: outcome === 'cancelled',
      });
      flushRn();
      expect(mockRuntime.snapshot.phase).toBe('idle');
      expect(mockRuntime.motion.get().visible).toBe(true);
      tickFrame();
      advanceAnimations();
      expect(flattenStyle(previewOverlay()!.props.style).transform).toEqual([
        { translateX: 0 },
        { translateY: 0 },
        { scaleX: 1 },
        { scaleY: 1 },
      ]);
      tickFrame();
      flushRn();
      expectClearedMotion();
      expect(previewOverlay()).toBeNull();
      expect(onDragEnd).toHaveBeenCalledTimes(1);
      expect(onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining(
          outcome === 'cancelled'
            ? { outcome: 'cancelled', reason: 'gesture-interrupted' }
            : { response: 'rejected' },
        ),
      );
      expect(props.value.revision).toBe(0);
    },
  );
});

it('refreshes an unchanged target after its scroll geometry or policy changes', () => {
  const canDrop = jest.fn(() => ({ allowed: true as const }));
  props = { ...props, canDrop };
  render();
  begin();
  move({ x: 20, y: 70 });
  const target = mockRuntime.snapshot.target;
  const calls = canDrop.mock.calls.length;
  lists.source.props.onScroll({ contentOffset: { x: 0, y: 1 } });
  move({ x: 20, y: 70 });
  expect(mockRuntime.snapshot.target).toEqual(target);
  expect(canDrop).toHaveBeenCalledTimes(calls + 1);
  props = { ...props, canDrop: () => ({ allowed: false, reason: 'changed' }) };
  render();
  move({ x: 20, y: 70 });
  expect(mockRuntime.snapshot.validity).toBe('invalid');
  expect(mockRuntime.snapshot.candidate).toBeNull();
});

it('does not republish unchanged UI geometry when only the renderer changes', () => {
  const zones = mockRuntime.zones.get();
  const runtime = mockRuntime;
  listProps.source = { ...listProps.source, renderItem: () => null };
  render();
  expect(mockRuntime.zones.get()).toBe(zones);
  expect(mockRuntime).toBe(runtime);
});

it('keeps the current target while a UI zone measurement predates the registered layout version', () => {
  listProps.source = {
    ...listProps.source,
    itemSize: undefined,
    estimatedItemSize: 40,
    virtualization: true,
  };
  render();
  begin();
  move({ x: 20, y: 70 });
  const target = mockRuntime.snapshot.target;
  expect(target).toMatchObject({ kind: 'list', zoneId: 'source' });
  expect(mockRuntime.snapshot.validity).toBe('valid');
  const published = mockRuntime.snapshot;
  const before = readListViewports(mockRuntime.zones.get());

  // A cell measurement bumps the registered layout version on JS.
  listCell('source', 'b').props.onSize('b', 80);
  jest.advanceTimersByTime(20);
  render();
  const registered = mockRuntime.zones
    .get()
    .find(zone => zone.zoneId === 'source')!;
  expect(registered.layoutVersion).toBeGreaterThan(
    before.find(zone => zone.zoneId === 'source')!.layoutVersion,
  );

  // A pointer packet the UI captured before that version arrived must not
  // publish an outside target and revert the preview.
  const stale = {
    ...mockRuntime.motion.get(),
    seq: mockRuntime.motion.get().seq + 1,
    zones: before,
  };
  mockRuntime.motion.set(stale);
  mockRuntime.move(stale);
  render();
  flushUi();
  expect(mockRuntime.snapshot).toBe(published);
  expect(mockRuntime.snapshot.target).toEqual(target);

  // A packet carrying the new version recomputes against the grown cell.
  move({ x: 20, y: 70 });
  expect(mockRuntime.snapshot.validity).toBe('valid');
  expect(mockRuntime.snapshot.target).toMatchObject({
    kind: 'list',
    zoneId: 'source',
  });
});

it('does not let a stale pointer packet consume a pending policy refresh', () => {
  begin();
  move({ x: 20, y: 70 });
  const stale = mockRuntime.motion.get();
  props = { ...props, canDrop: () => ({ allowed: false }) };
  render();
  mockRuntime.move(stale);
  move({ x: 20, y: 70 });
  expect(mockRuntime.snapshot.validity).toBe('invalid');
  expect(mockRuntime.snapshot.candidate).toBeNull();
});

it('does not let delayed visibility or frame work revive a cancelled overlay', () => {
  begin();
  lists.source.props.onScroll({ contentOffset: { x: 0, y: 10 } });
  tickFrame();
  const lateUi = mockUiTasks.splice(0);
  release(true);
  lateUi.forEach(task => task());
  flushRn();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expectClearedMotion();
  expect(onDragEnd).toHaveBeenCalledTimes(1);
  expect(props.onChange).not.toHaveBeenCalled();
});

it.each([false, true])(
  'clears a rapid begin/release before React renders an active snapshot (cancelled: %s)',
  cancelled => {
    const active = state();
    mockRuntime.motion.set(active);
    mockRuntime.begin(active);
    const released: DndMotion = { ...active, phase: 'released', seq: 2 };
    mockRuntime.motion.set(released);
    mockRuntime.release(released, cancelled);
    render();
    flushUi();
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expectClearedMotion();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    begin({ token: 2 });
    expect(mockRuntime.snapshot.phase).toBe('dragging');
    expect(mockRuntime.motion.get().token).toBe(2);
  },
);

it('clears a policy failure during begin before React can render the active session', () => {
  const canDrop = jest
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('policy');
    })
    .mockReturnValue({ allowed: true });
  props = { ...props, canDrop };
  render();
  const active = state();
  mockRuntime.motion.set(active);
  mockRuntime.begin(active);
  render();
  flushUi();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expectClearedMotion();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'policy-error' }),
  );
  begin({ token: 2 });
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  expect(mockRuntime.motion.get().token).toBe(2);
});

it('reports the session lifecycle and timings through onDiagnostic', () => {
  const events: GridDiagnosticEvent[] = [];
  const store = createDndStateStore(props.value);
  props = {
    ...props,
    value: store.getSnapshot(),
    onChange: (_next, proposal) => {
      store.respond(proposal, true);
      props = { ...props, value: store.getSnapshot() };
    },
    onDiagnostic: event => events.push(event),
  };
  render();
  begin();
  const sessionId = mockRuntime.snapshot.sessionId;
  move({ x: 140, y: 20 });
  release();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId, response: 'accepted' }),
  );
  expect(events.length).toBeGreaterThan(0);
  expect(events.map(event => event.name)).toEqual(
    expect.arrayContaining([
      'request',
      'compute-move',
      'release',
      'proposal',
      'response',
      'end',
    ]),
  );
  expect(events.every(event => event.sessionId === sessionId)).toBe(true);
});

// Session options belong to the coordinator, never to the root view. An option
// the Provider forgets to destructure is spread onto the native view and
// silently dropped, as `onDiagnostic` was. The typed map keeps this list
// complete: a new session option fails to compile until it is added here.
it('keeps every session option off the root view', () => {
  const sessionOptions: Record<keyof DndSessionOptions<string>, true> = {
    value: true,
    onChange: true,
    canDrop: true,
    onDragStart: true,
    onDragEnd: true,
    onValidationError: true,
    onDiagnostic: true,
    responseTimeoutMs: true,
    disabled: true,
    movementPolicy: true,
    searchBudget: true,
    getGridItemLayout: true,
  };
  props = {
    ...props,
    canDrop: () => ({ allowed: true }),
    onDragStart: jest.fn(),
    onValidationError: jest.fn(),
    onDiagnostic: jest.fn(),
    responseTimeoutMs: 2000,
    disabled: false,
    movementPolicy: {},
    searchBudget: 1000,
    getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
  };
  render();
  expect(
    Object.keys(sessionOptions).filter(key => key in rootOutput.props),
  ).toEqual([]);
  expect(props.onValidationError).not.toHaveBeenCalled();
});

it('cancels root geometry changes and cleans up after unmount', () => {
  begin();
  const root = rootOutput;
  root.props.onLayout({
    nativeEvent: { layout: rootRect },
  } as LayoutChangeEvent);
  root.props.onLayout({
    nativeEvent: { layout: { ...rootRect, width: 400 } },
  } as LayoutChangeEvent);
  render();
  flushUi();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'geometry-changed' }),
  );
  const saved = mockRuntime;
  unmount();
  mockDirty = false;
  saved.begin(state({ token: 2 }));
  expect(mockDirty).toBe(false);
  expectClearedMotion(saved);
});

it.each(['accepted', 'rejected', 'expired'] as const)(
  'keeps the native owner after source eviction until the %s response',
  response => {
    const { tag } = mountHandle();
    const sentinel = detectorTags()[0];
    activateHandle(tag);
    expect(mockRuntime.snapshot.phase).toBe('dragging');
    expect(mockRuntime.motion.get().handleId).not.toBeNull();
    unmountHandle('a');
    expect(detectorTags()).toEqual([sentinel, tag]);
    expect(mockDroppedGestures).not.toContain(tag);
    expect(mockPans.has(tag)).toBe(true);
    // Source/handle refs no longer measure. Updates only need the stable root and zones.
    firePan(tag, 'onUpdate', { absoluteY: 95 });
    tickFrame();
    flushRn();
    expect(mockRuntime.snapshot.target).toHaveProperty('index', 1);
    lists.source.props.onScroll({ contentOffset: { x: 0, y: 20 } });
    tickFrame();
    flushRn();
    expect(mockRuntime.snapshot.target).toHaveProperty('index', 2);
    firePan(tag, 'onDeactivate', { absoluteY: 95, canceled: false });
    flushRn();
    expect(props.onChange).toHaveBeenCalledTimes(1);
    expect(mockRuntime.snapshot.phase).toBe('awaiting-response');
    expect(mockDroppedGestures).not.toContain(tag);
    const proposal = (props.onChange as jest.Mock).mock.calls[0][1];
    if (response === 'expired') jest.advanceTimersByTime(2000);
    else
      props = {
        ...props,
        value: {
          ...(response === 'accepted' ? proposal.value : props.value),
          proposalResponse: {
            sessionId: proposal.sessionId,
            baseRevision: 0,
            accepted: response === 'accepted',
          },
        },
      };
    render();
    flushUi();
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expect(detectorTags()).toEqual([sentinel]);
    expect(mockDroppedGestures).toContain(tag);
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response }),
    );
  },
);

it('preserves the active native handler while other virtual handles mount and unmount', () => {
  const { tag } = mountHandle();
  activateHandle(tag);
  const second = mountHandle('second');
  expect(detectorTags()).toHaveLength(2);
  unmountHandle('a');
  expect(detectorTags()).toContain(tag);
  unmountHandle('second');
  expect(detectorTags()).toContain(tag);
  expect(mockDroppedGestures).not.toContain(tag);
  expect(mockDroppedGestures).toHaveLength(0);
  expect(second.handle.scope.itemId).toBe('a');
  firePan(tag, 'onUpdate', { absoluteY: 80 });
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.phase).toBe('dragging');
});

it.each(['handle', 'viewport', 'root'] as const)(
  'fails root-attached recognizers for touches outside the visible %s',
  outside => {
    const { tag, handle } = mountHandle();
    if (outside === 'handle')
      measure(handle.output!.props.ref, { x: 40, y: 5, width: 40, height: 30 });
    if (outside === 'viewport')
      measure(lists.source.props.ref, { x: 0, y: 40, width: 100, height: 100 });
    if (outside === 'root')
      measure(mockRuntime.rootRef, { ...rootRect, x: 40 });
    firePan(tag, 'onTouchesDown');
    expect(mockGestureFail).toHaveBeenCalledWith(tag);
    firePan(tag, 'onActivate');
    flushRn();
    expectClearedMotion();
    expect(mockRuntime.snapshot.phase).toBe('idle');
  },
);

it('forwards accessibility and test attributes to the handle view and its preview copy', () => {
  const onAccessibilityAction = jest.fn();
  const { handle } = mountHandle('a', {
    accessible: true,
    accessibilityRole: 'button',
    accessibilityLabel: 'Move task A',
    accessibilityHint: 'Double tap and hold, then drag',
    accessibilityActions: [{ name: 'activate' }],
    onAccessibilityAction,
    testID: 'handle-a',
  });
  expect(handle.output!.props).toMatchObject({
    accessible: true,
    accessibilityRole: 'button',
    accessibilityLabel: 'Move task A',
    accessibilityHint: 'Double tap and hold, then drag',
    accessibilityActions: [{ name: 'activate' }],
    onAccessibilityAction,
    testID: 'handle-a',
    collapsable: false,
  });
  expect(Object.keys(handle.output!.props)).not.toContain('itemId');
  expect(Object.keys(handle.output!.props)).not.toContain('gestureRelations');

  mockItemScope = { ...handle.scope, preview: true };
  const preview = renderScope('handle:preview', () =>
    DragHandle({
      accessibilityLabel: 'Move task A',
      testID: 'handle-a',
      children: null,
    }),
  );
  mockItemScope = null;
  expect(preview.props).toMatchObject({
    accessibilityLabel: 'Move task A',
    testID: 'handle-a',
  });
  expect(preview.props.ref).toBeUndefined();
});

it('preserves handle disabled, long press and gesture relation configuration in its native owner', () => {
  const external = {
    type: 'Pan',
    handlerTag: 900,
    config: {},
    detectorCallbacks: {},
    gestureRelations: {
      simultaneousHandlers: [],
      waitFor: [],
      blocksHandlers: [],
    },
  };
  const { tag, handle } = mountHandle('a', {
    disabled: true,
    gestureRelations: { simultaneousWith: external as never },
  });
  expect(mockPans.get(tag)?.simultaneousWith).toEqual([external]);
  expect(mockPans.get(tag)?.activateAfterLongPress).toBe(250);
  activateHandle(tag);
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expect(mockGestureFail).toHaveBeenCalledWith(tag);
  handle.props = { ...handle.props, disabled: false };
  render();
  expect(detectorTags()).toContain(tag);
  activateHandle(tag);
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  handle.props = { ...handle.props, disabled: true };
  render();
  flushUi();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'disabled' }),
  );
  expectClearedMotion();
});

it('keeps axis and token ownership after source eviction and ignores obsolete native events', () => {
  props = { ...props, dragAxis: 'y' };
  render();
  const { tag } = mountHandle();
  activateHandle(tag);
  const oldUpdate = mockPans.get(tag)?.onUpdate as (event: unknown) => void;
  unmountHandle('a');
  firePan(tag, 'onUpdate', { absoluteX: 180, absoluteY: 90 });
  tickFrame();
  flushRn();
  expect(mockRuntime.motion.get().pointer).toEqual({ x: 20, y: 90 });
  firePan(tag, 'onFinalize');
  flushRn();
  expect(mockDroppedGestures).toContain(tag);
  expect(detectorTags()).not.toContain(tag);
  const next = mountHandle('next');
  activateHandle(next.tag);
  const newer = mockRuntime.motion.get();
  oldUpdate({ absoluteX: 20, absoluteY: 160, numberOfPointers: 1 });
  flushRn();
  expect(mockRuntime.motion.get().token).toBe(newer.token);
  expect(mockRuntime.motion.get().pointer).toEqual(newer.pointer);
});

it('retains an activated native owner evicted before the queued JS begin arrives', () => {
  const { tag } = mountHandle();
  firePan(tag, 'onBegin');
  firePan(tag, 'onTouchesDown');
  firePan(tag, 'onActivate');
  expect(mockRuntime.snapshot.phase).toBe('idle');
  unmountHandle('a');
  expect(mockDroppedGestures).not.toContain(tag);
  flushRn();
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  firePan(tag, 'onUpdate', { absoluteY: 80 });
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.target).toHaveProperty('index', 1);
});

it('rejects queued native activation when its handle is disabled before JS begin', () => {
  const { tag, handle } = mountHandle();
  firePan(tag, 'onBegin');
  firePan(tag, 'onTouchesDown');
  firePan(tag, 'onActivate');
  handle.props = { ...handle.props, disabled: true };
  render();
  flushRn();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expectClearedMotion();
  expect(onDragEnd).not.toHaveBeenCalled();
});

it.each([false, true])(
  'keeps idle revision metadata and fallback cell geometry after a rejected activation (before rejection: %s)',
  updateBeforeRejection => {
    const { tag, handle } = mountHandle();
    activateHandle(tag);
    release(true);
    const previousToken = mockRuntime.motion.get().token;
    expect(previousToken).toBeGreaterThan(0);
    firePan(tag, 'onBegin');
    firePan(tag, 'onTouchesDown');
    firePan(tag, 'onActivate');
    handle.props = { ...handle.props, disabled: true };
    const updateValue = () => {
      props = {
        ...props,
        value: {
          ...props.value,
          revision: 1,
          zones: props.value.zones.map(zone =>
            zone.id === 'source' && zone.kind === 'list'
              ? { ...zone, itemIds: ['b', 'a', 'c', 'd'] }
              : zone,
          ),
        },
      };
    };
    if (updateBeforeRejection) updateValue();
    render();
    flushRn();
    expectClearedMotion();
    if (!updateBeforeRejection) updateValue();
    render();
    flushUi();
    expect(mockRuntime.presentation!.get()).toMatchObject({
      token: previousToken,
      revision: 1,
      zones: {},
    });
    expect(listCell('source', 'a').props.start).toBe(40);
  },
);

it('ignores an obsolete queued begin without resetting a newer active native token', () => {
  const { tag } = mountHandle();
  activateHandle(tag);
  const old = mockRuntime.motion.get();
  firePan(tag, 'onFinalize');
  flushRn();
  activateHandle(tag);
  const current = mockRuntime.motion.get();
  mockRuntime.begin(old);
  render();
  flushUi();
  expect(current.token).toBeGreaterThan(old.token);
  expect(mockRuntime.motion.get().token).toBe(current.token);
  expect(mockRuntime.snapshot.phase).toBe('dragging');
});

it.each(['policy', 'budget', 'mapper', 'timeout'] as const)(
  'rejects queued native activation after committed %s settings change',
  setting => {
    const { tag } = mountHandle();
    firePan(tag, 'onBegin');
    firePan(tag, 'onTouchesDown');
    firePan(tag, 'onActivate');
    const capturedRevision = mockRuntime.motion.get().configRevision;
    props = {
      ...props,
      ...(setting === 'policy'
        ? { movementPolicy: { rowRotation: 'full-width' } }
        : setting === 'budget'
          ? { searchBudget: 5 }
          : setting === 'timeout'
            ? { responseTimeoutMs: 3000 }
            : { getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }) }),
    };
    render();
    flushRn();
    expect(mockRuntime.gestureConfigRevision).toBeGreaterThan(capturedRevision);
    expect(mockRuntime.snapshot.phase).toBe('idle');
    expectClearedMotion();
    expect(onDragEnd).not.toHaveBeenCalled();
  },
);

it('keeps the activation configuration version for an equivalent policy object', () => {
  const { tag } = mountHandle();
  firePan(tag, 'onBegin');
  firePan(tag, 'onTouchesDown');
  firePan(tag, 'onActivate');
  props = {
    ...props,
    movementPolicy: {
      rowRotation: 'disabled',
      adjacentInsertExchange: 'disabled',
    },
  };
  render();
  flushRn();
  expect(mockRuntime.gestureConfigRevision).toBe(0);
  expect(mockRuntime.snapshot.phase).toBe('dragging');
});

it.each(['searchBudget', 'responseTimeoutMs'] as const)(
  'reports a malformed %s without failing configuration serialization',
  setting => {
    const onValidationError = jest.fn();
    props = {
      ...props,
      [setting]: BigInt(5) as unknown as number,
      onValidationError,
    };
    expect(() => render()).not.toThrow();
    expect(mockRuntime.snapshot.disabled).toBe(true);
    expect(onValidationError).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          code:
            setting === 'searchBudget'
              ? 'invalid-budget'
              : 'invalid-configuration',
        }),
      ]),
    );
  },
);

it('does not convert an invalid caller canDrop response into approval', () => {
  props = { ...props, canDrop: () => undefined as never };
  render();
  begin();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'policy-error' }),
  );
});

it.each([true, false])(
  'atomically handles list-to-grid approval %s using the captured span',
  accepted => {
    const grid = mountGrid();
    const store = createDndStateStore(props.value);
    props = {
      ...props,
      value: store.getSnapshot(),
      getGridItemLayout: () => ({
        span: { rows: 1, cols: 2 },
        placement: 'insert',
      }),
      onChange: jest.fn((_next, proposal) => {
        store.respond(proposal, accepted);
        props = { ...props, value: store.getSnapshot() };
      }),
    };
    render();
    begin();
    move({ x: 130, y: 130 });
    expect(mockRuntime.snapshot.target).toEqual({
      kind: 'grid',
      zoneId: 'grid',
      position: { row: 0, col: 0 },
    });
    expect(mockRuntime.snapshot.validity).toBe('valid');
    const indicator = grid.output!.props.children[1];
    expect(flattenStyle(indicator.props.style)).toMatchObject({
      opacity: 1,
      left: 0,
      top: 0,
      width: 80,
      height: 40,
    });
    release();
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: accepted ? 'accepted' : 'rejected' }),
    );
    expect(store.getSnapshot().zones[0]).toHaveProperty(
      'itemIds',
      accepted ? ['b', 'c', 'd'] : ['a', 'b', 'c', 'd'],
    );
    expect(store.getSnapshot().zones[2]).toHaveProperty(
      'placements',
      accepted
        ? [
            {
              itemId: 'a',
              position: { row: 0, col: 0 },
              span: { rows: 1, cols: 2 },
              placement: 'insert',
            },
          ]
        : [],
    );
    expectClearedMotion();
  },
);

it('moves a grid item to a list and renders its source preview with grid geometry', () => {
  const renderGrid = jest.fn(() => null);
  mountGrid(
    {
      id: 'grid',
      kind: 'grid',
      rows: 2,
      columns: 2,
      placements: [
        {
          itemId: 'g',
          position: { row: 0, col: 0 },
          span: { rows: 1, cols: 2 },
        },
      ],
    },
    undefined,
    { renderItem: renderGrid },
  );
  const store = createDndStateStore(props.value);
  props = {
    ...props,
    renderDragPreview: undefined,
    value: store.getSnapshot(),
    onChange: jest.fn((next, proposal) => {
      store.onChange(next, proposal);
      props = { ...props, value: store.getSnapshot() };
    }),
  };
  render();
  begin({
    itemId: 'g',
    sourceZoneId: 'grid',
    pointer: { x: 140, y: 130 },
    origin: { x: 140, y: 130 },
    width: 80,
    height: 40,
  });
  expect(renderGrid).toHaveBeenCalledWith(
    expect.objectContaining({
      item: expect.objectContaining({ id: 'g' }),
      width: 80,
      height: 40,
      span: { rows: 1, cols: 2 },
      isDragging: true,
    }),
  );
  move({ x: 140, y: 20 });
  release();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ response: 'accepted' }),
  );
  expect(store.getSnapshot().zones[1]).toHaveProperty('itemIds', ['g']);
  expect(store.getSnapshot().zones[2]).toHaveProperty('placements', []);
});

it('keeps list moves enabled without a span resolver but refuses grid destinations', () => {
  mountGrid();
  begin();
  move({ x: 130, y: 130 });
  expect(mockRuntime.snapshot.validity).toBe('invalid');
  expect(mockRuntime.snapshot.gridItemLayouts.size).toBe(0);
  move({ x: 140, y: 20 });
  expect(mockRuntime.snapshot.validity).toBe('valid');
  release();
  expect(props.onChange).toHaveBeenCalledTimes(1);
});

it('reports a full grid as unresolvable while leaving both zones unchanged', () => {
  mountGrid(
    {
      id: 'grid',
      kind: 'grid',
      rows: 1,
      columns: 1,
      placements: [
        {
          itemId: 'b',
          position: { row: 0, col: 0 },
          span: { rows: 1, cols: 1 },
        },
      ],
    },
    { x: 120, y: 110, width: 40, height: 40 },
  );
  props = {
    ...props,
    getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
  };
  render();
  const original = props.value;
  begin();
  move({ x: 130, y: 130 });
  expect(mockRuntime.snapshot.failureReason).toBe('unresolvable');
  release();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'unresolvable' }),
  );
  expect(mockRuntime.snapshot.displayValue).toBe(original);
});

it('reports bounded grid search exhaustion through the pointer and provider bridge', () => {
  mountGrid(
    {
      id: 'grid',
      kind: 'grid',
      rows: 3,
      columns: 4,
      placements: [
        {
          itemId: 'a',
          position: { row: 2, col: 1 },
          span: { rows: 1, cols: 1 },
        },
        {
          itemId: 'Target',
          position: { row: 0, col: 0 },
          span: { rows: 1, cols: 2 },
        },
        {
          itemId: 'Crossing',
          position: { row: 2, col: 2 },
          span: { rows: 1, cols: 2 },
        },
      ],
    },
    { x: 120, y: 70, width: 160, height: 120 },
  );
  props = { ...props, searchBudget: 1 };
  render();
  begin({
    sourceZoneId: 'grid',
    pointer: { x: 180, y: 170 },
    origin: { x: 180, y: 170 },
    width: 40,
    height: 40,
  });
  move({ x: 140, y: 90 });
  expect(mockRuntime.snapshot.failureReason).toBe('search-budget');
  release();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'search-budget' }),
  );
});

it('refuses a grid footprint clipped by a static root even when the pointer remains inside', () => {
  mountGrid();
  props = {
    ...props,
    getGridItemLayout: () => ({ span: { rows: 1, cols: 2 } }),
  };
  render();
  const clipped = { ...rootRect, width: 150 };
  measure(mockRuntime.rootRef, clipped);
  begin({ root: clipped });
  move({ x: 140, y: 130 });
  expect(mockRuntime.snapshot.validity).toBe('invalid');
  release();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'cancelled' }),
  );
});

it('cancels an in-place grid geometry change and a mounted grid removal', () => {
  const grid = mountGrid(undefined, undefined, {
    geometry: {
      mode: 'fit',
      rowGap: 0,
      columnGap: 0,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    },
  });
  props = {
    ...props,
    getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
  };
  render();
  begin();
  move({ x: 130, y: 130 });
  grid.props.geometry.columnGap = 4;
  render();
  flushUi();
  expect(onDragEnd).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: 'geometry-changed' }),
  );
  begin({ token: 2 });
  move({ x: 130, y: 130 });
  unmountGrid('grid');
  expect(onDragEnd).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: 'zone-removed' }),
  );
  expectClearedMotion();
});

it('drops into a grid after a FlatList source handle unmounts during the active native gesture', () => {
  mountGrid();
  listProps.source = { ...listProps.source, virtualization: true };
  const store = createDndStateStore(props.value);
  props = {
    ...props,
    value: store.getSnapshot(),
    getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
    onChange: jest.fn((next, proposal) => {
      store.onChange(next, proposal);
      props = { ...props, value: store.getSnapshot() };
    }),
  };
  render();
  expect(lists.source.type).toBe('Animated.FlatList');
  const { tag } = mountHandle();
  activateHandle(tag);
  unmountHandle('a');
  firePan(tag, 'onUpdate', { absoluteX: 130, absoluteY: 130 });
  tickFrame();
  flushRn();
  expect(mockRuntime.snapshot.target).toHaveProperty('kind', 'grid');
  expect(lists.source.props.data).not.toContain('a');
  expect(mockDroppedGestures).not.toContain(tag);
  firePan(tag, 'onDeactivate', {
    absoluteX: 130,
    absoluteY: 130,
    canceled: false,
  });
  flushRn();
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({ response: 'accepted' }),
  );
  expect(store.getSnapshot().zones[2]).toHaveProperty('placements', [
    expect.objectContaining({ itemId: 'a' }),
  ]);
  expect(mockDroppedGestures).toContain(tag);
});

it('keeps the original visible until a custom preview reports ready when asked to wait', () => {
  props = { ...props, waitForDragPreviewReady: true };
  render();
  begin();
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  expect(mockRuntime.motion.get().visible).toBe(false);
  const args = renderPreview.mock.calls[renderPreview.mock.calls.length - 1][0];
  expect(typeof args.onReady).toBe('function');
  move({ x: 20, y: 95 });
  // Pointer requests never reveal the preview on their own.
  expect(mockRuntime.motion.get().visible).toBe(false);
  args.onReady();
  render();
  flushUi();
  expect(mockRuntime.motion.get().visible).toBe(true);
  release(true);
  expect(mockRuntime.snapshot.phase).toBe('idle');
  // The acknowledgement belongs to that session only.
  begin();
  expect(mockRuntime.motion.get().visible).toBe(false);
  const late = renderPreview.mock.calls[renderPreview.mock.calls.length - 1][0];
  expect(late.onReady).toBe(args.onReady);
  late.onReady();
  render();
  flushUi();
  expect(mockRuntime.motion.get().visible).toBe(true);
});

it('exposes a handle that cancels the drag when zone geometry moved under it', () => {
  const handle: { current: DndProviderHandle | null } = { current: null };
  props = { ...props, ref: handle };
  render();
  expect(handle.current).not.toBeNull();
  begin();
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  handle.current!.invalidateGeometry();
  render();
  flushUi();
  expect(mockRuntime.snapshot.phase).toBe('idle');
  expect(onDragEnd).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: 'cancelled',
      reason: 'geometry-changed',
    }),
  );
});
