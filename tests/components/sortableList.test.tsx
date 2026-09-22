import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { SortableList } from '../../src/components/SortableList';
import {
  DndItemContext,
  EMPTY_DND_MOTION,
  type DndRuntime,
  type ListRegistration,
} from '../../src/runtime/dndRuntime';
import {
  EMPTY_DND_PRESENTATION,
  presentationRect,
  zonePresentationFromRects,
  zonePresentationRects,
} from '../../src/runtime/dndPresentation';
import type { SortableListProps } from '../../src/components/dndTypes';
import type { LayoutState, ListLayoutZone } from '../../src/contracts';
import { computeLayoutMove } from '../../src/engine/layoutMove';

type Hook = {
  value?: unknown;
  set?: (value: unknown) => void;
  dependencies?: readonly unknown[];
  cleanup?: () => void;
  getSnapshot?: () => unknown;
};
type Effect = () => void | (() => void);
type Hooks = { hooks: Hook[]; layout: Effect[]; passive: Effect[] };
type MeasureCallback = (
  x: number,
  y: number,
  width: number,
  height: number,
) => void;
type HostProps = {
  children?: ReactNode;
  ref?: { current: { measure(callback: MeasureCallback): void } | null };
  onLayout?(event: LayoutChangeEvent): void;
  onScroll?(event: { contentOffset: { x: number; y: number } }): void;
  style?: unknown;
  collapsable?: boolean;
  horizontal?: boolean;
  scrollEnabled?: boolean;
  removeClippedSubviews?: boolean;
  data?: readonly string[];
  extraData?: unknown;
  renderItem?(args: { item: string; index: number }): ReactNode;
  keyExtractor?(item: string, index: number): string;
  getItemLayout?(
    data: readonly string[] | null | undefined,
    index: number,
  ): { index: number; length: number; offset: number };
  contentContainerStyle?: unknown;
  initialNumToRender?: number;
  maxToRenderPerBatch?: number;
  windowSize?: number;
  updateCellsBatchingPeriod?: number;
  initialScrollIndex?: number;
  strictMode?: boolean;
};

// Run the actual adapter with per-component hook state and child-first layout
// effects. Native measurements are delayed independently from React commits.
// This verifies adapter behavior, not Yoga layout or native gesture execution.
const mockFrames = new Map<string, Hooks>();
const mockMemoCells = new Map<
  string,
  { props: Record<string, unknown>; output: ReactNode }
>();
const mockCells = new Map<string, HostProps>();
const mockSlots = new Map<string, HostProps>();
const mockContexts = new Map<unknown, unknown>();
const mockFlatCells = new Map<
  string,
  {
    item: string;
    index: number;
    renderItem: HostProps['renderItem'];
    output: ReactNode;
  }
>();
let mockFlatCellRenders = 0;
const mockMeasurements: Array<{ itemId: string; callback: MeasureCallback }> =
  [];
let mockFrame: Hooks;
let mockCursor = 0;
let mockDirty = false;
let mockStateUpdates = 0;
let mockBeforeLayoutEffects: (() => void) | null = null;
const mockMeasurementFrames = new Map<number, (timestamp: number) => void>();
let mockNextMeasurementFrame = 0;
let mockRuntime: DndRuntime;
let mockVisibleRange: { first: number; last: number } | null = null;
let mockReadingStyle: Set<unknown> | null = null;
const mockStyleSubscriptions: Set<unknown>[] = [];
const mockUiStyles = new Map<object, () => object>();
let mockExecutingUi = false;
const mockMicrotasks: Array<() => void> = [];
const mockScheduledUi: Array<() => void> = [];
let mockScheduledUiCount = 0;
const mockSharedWrites: Array<{
  shared: unknown;
  value: unknown;
  onUi: boolean;
}> = [];
type MockShared = { get(): number; set(value: number): void };
// Flow-start mutables handed to each virtual cell, by item ID.
const mockExpectedStarts = new Map<string, MockShared>();
const mockTimingTargets: number[] = [];
const mockUiMappers = new Map<number, () => void>();
let mockNextMapperId = 0;

function flushMeasurementFrame() {
  const callbacks = [...mockMeasurementFrames];
  for (const [id, callback] of callbacks) {
    if (mockMeasurementFrames.get(id) !== callback) continue;
    mockMeasurementFrames.delete(id);
    callback(16);
  }
}

function flushScheduledUi() {
  const previous = mockExecutingUi;
  mockExecutingUi = true;
  try {
    while (mockScheduledUi.length)
      mockScheduledUi.splice(0).forEach(callback => callback());
  } finally {
    mockExecutingUi = previous;
  }
}

function flushMicrotasks(runUi = true) {
  while (mockMicrotasks.length)
    mockMicrotasks.splice(0).forEach(callback => callback());
  if (runUi) flushScheduledUi();
}

function flushUi() {
  flushMicrotasks();
  mockExecutingUi = true;
  try {
    for (const mapper of mockUiMappers.values()) mapper();
    for (const [style, read] of mockUiStyles) Object.assign(style, read());
  } finally {
    mockExecutingUi = false;
  }
}

function mockState<T>(initial: T | (() => T)) {
  const index = mockCursor++;
  if (!mockFrame.hooks[index]) {
    const hook: Hook = {
      value: typeof initial === 'function' ? (initial as () => T)() : initial,
    };
    hook.set = next => {
      const value = typeof next === 'function' ? next(hook.value) : next;
      if (!Object.is(value, hook.value)) {
        hook.value = value;
        mockDirty = true;
        mockStateUpdates++;
      }
    };
    mockFrame.hooks[index] = hook;
  }
  const hook = mockFrame.hooks[index];
  return [
    hook.value as T,
    hook.set as (next: T | ((old: T) => T)) => void,
  ] as const;
}

function mockMemo<T>(create: () => T, dependencies: readonly unknown[]) {
  const index = mockCursor++;
  const hook = mockFrame.hooks[index] ?? (mockFrame.hooks[index] = {});
  if (
    !hook.dependencies ||
    dependencies.length !== hook.dependencies.length ||
    dependencies.some((value, i) => !Object.is(value, hook.dependencies?.[i]))
  ) {
    hook.value = create();
    hook.dependencies = dependencies;
  }
  return hook.value as T;
}

function mockEffect(
  kind: 'layout' | 'passive',
  effect: Effect,
  dependencies?: readonly unknown[],
) {
  const index = mockCursor++;
  const hook = mockFrame.hooks[index] ?? (mockFrame.hooks[index] = {});
  if (
    !dependencies ||
    !hook.dependencies ||
    dependencies.some((value, i) => !Object.is(value, hook.dependencies?.[i]))
  ) {
    mockFrame[kind].push(() => {
      hook.cleanup?.();
      hook.dependencies = dependencies;
      hook.cleanup = effect() || undefined;
    });
  }
}

function mockShared<T>(initial: T) {
  let value = initial;
  const result = {
    get: () => {
      mockReadingStyle?.add(result);
      return value;
    },
    set: (next: T) => {
      mockSharedWrites.push({
        shared: result,
        value: next,
        onUi: mockExecutingUi,
      });
      value = next;
    },
  };
  return result;
}

// Reanimated's mutable setter ignores an identical primitive without notifying
// mappers; keep that so mapper no-ops do not register as shared writes.
function mockMutable<T>(initial: T) {
  let current = initial;
  const shared = mockShared(initial);
  return {
    get: shared.get,
    set: (next: T) => {
      if (next === current) return;
      current = next;
      shared.set(next);
    },
  };
}

// A started mapper runs on the UI runtime before the next frame.
function mockRunMapper(mapper: () => void) {
  const previous = mockExecutingUi;
  mockExecutingUi = true;
  try {
    mapper();
  } finally {
    mockExecutingUi = previous;
  }
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
  useRef: (current: unknown) => mockState({ current })[0],
  useContext: (context: unknown) => {
    const index = mockCursor++;
    const value = mockContexts.get(context);
    mockFrame.hooks[index] = {
      value,
      getSnapshot: () => mockContexts.get(context),
    };
    return value;
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => {
    const index = mockCursor++;
    const value = getSnapshot();
    mockFrame.hooks[index] = { getSnapshot, value };
    return value;
  },
  useMemo: mockMemo,
  useCallback: (callback: unknown, dependencies: readonly unknown[]) =>
    mockMemo(() => callback, dependencies),
  useLayoutEffect: (effect: Effect, dependencies?: readonly unknown[]) =>
    mockEffect('layout', effect, dependencies),
  useEffect: (effect: Effect, dependencies?: readonly unknown[]) =>
    mockEffect('passive', effect, dependencies),
}));
jest.mock('react-native', () => ({
  Platform: jest.requireActual('react-native/Libraries/Utilities/Platform')
    .default,
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
  useAnimatedRef: () => mockState({ current: null })[0],
  useSharedValue: (initial: unknown) => mockState(() => mockShared(initial))[0],
  useAnimatedStyle: (get: () => unknown) => {
    const style = mockState(() => ({}))[0];
    const reads = new Set<unknown>();
    mockReadingStyle = reads;
    const result = get();
    mockReadingStyle = null;
    mockStyleSubscriptions.push(reads);
    Object.assign(style, result);
    mockUiStyles.set(style, get as () => object);
    return style;
  },
  useDerivedValue: (get: () => unknown) => {
    const derivedState = mockState(() => {
      const derived = {
        read: get,
        get: () => {
          mockReadingStyle?.add(derived);
          const reading = mockReadingStyle;
          mockReadingStyle = null;
          const value = derived.read();
          mockReadingStyle = reading;
          return value;
        },
      };
      return derived;
    })[0];
    derivedState.read = get;
    return derivedState;
  },
  makeMutable: (initial: unknown) => mockMutable(initial),
  startMapper: (mapper: () => void) => {
    const id = ++mockNextMapperId;
    mockUiMappers.set(id, mapper);
    mockRunMapper(mapper);
    return id;
  },
  stopMapper: (id: number) => {
    mockUiMappers.delete(id);
  },
  useAnimatedScrollHandler: (handlers: { onScroll: unknown }) =>
    handlers.onScroll,
  withTiming: (value: number) => {
    mockTimingTargets.push(value);
    return value;
  },
}));
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
    callback(...args),
  scheduleOnUI: (
    callback: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => {
    mockScheduledUiCount++;
    mockScheduledUi.push(() => callback(...args));
  },
}));
jest.mock('../../src/runtime/dndRuntime', () => ({
  ...jest.requireActual('../../src/runtime/dndRuntime'),
  useDndRuntime: () => mockRuntime,
}));

let props: SortableListProps<{ label: string }>;
let output: ReactElement<HostProps>;
const registrations = new Map<string, ListRegistration>();
const registerZone = jest.fn((entry: ListRegistration, _identity: object) =>
  registrations.set(entry.zoneId, entry),
);
const unregisterZone = jest.fn((zoneId: string) =>
  registrations.delete(zoneId),
);
const reportIssues = jest.fn();

function state(): LayoutState<{ label: string }> {
  return {
    revision: 3,
    items: ['a', 'b', 'c', 'd'].map(id => ({ id, data: { label: id } })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['a', 'b', 'c'],
      },
      { id: 'target', kind: 'list', orientation: 'horizontal', itemIds: ['d'] },
    ],
  };
}

function setValue(value: LayoutState<{ label: string }>) {
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    value,
    displayValue: value,
  };
}

function render() {
  let commits = 0;
  do {
    if (++commits > 15) throw new Error('Unexpected repeated state updates');
    mockDirty = false;
    mockCells.clear();
    mockSlots.clear();
    const visited = new Set<string>();
    const order: Hooks[] = [];
    const enter = (key: string) => {
      let frame = mockFrames.get(key);
      if (!frame) {
        frame = { hooks: [], layout: [], passive: [] };
        mockFrames.set(key, frame);
      }
      visited.add(key);
      order.push(frame);
      mockFrame = frame;
      mockCursor = 0;
    };
    const children = (node: ReactNode, itemId?: string, path = '') => {
      Children.forEach(node, child => {
        if (!isValidElement<HostProps & { value?: { itemId: string } }>(child))
          return;
        const component = child.type as unknown as {
          $$typeof?: symbol;
          type?: (props: HostProps) => ReactNode;
        };
        if (component.$$typeof === Symbol.for('react.context')) {
          const previous = mockContexts.get(child.type);
          mockContexts.set(child.type, child.props.value);
          children(
            child.props.children,
            (child.type as unknown) === DndItemContext
              ? child.props.value?.itemId
              : itemId,
            path,
          );
          mockContexts.set(child.type, previous);
          return;
        }
        if (component.$$typeof === Symbol.for('react.memo') && component.type) {
          const key = `${path}/${String(child.key ?? component.type.name)}`;
          enter(key);
          const previous = mockMemoCells.get(key);
          const next = child.props as Record<string, unknown>;
          if (path.startsWith('flat:') && next.expectedStart)
            mockExpectedStarts.set(
              (next.item as { id: string }).id,
              next.expectedStart as MockShared,
            );
          const same =
            previous &&
            mockFrame.hooks.every(
              hook =>
                !hook.getSnapshot || Object.is(hook.value, hook.getSnapshot()),
            ) &&
            Object.keys(previous.props).length === Object.keys(next).length &&
            Object.keys(next).every(name =>
              Object.is(previous.props[name], next[name]),
            );
          const rendered = same ? previous.output : component.type(child.props);
          mockMemoCells.set(key, { props: next, output: rendered });
          children(rendered, itemId, path);
          return;
        }
        if (typeof child.type === 'function') {
          enter(`${path}/${String(child.key ?? child.type.name)}`);
          children(
            (child.type as (value: HostProps) => ReactNode)(child.props),
            itemId,
            path,
          );
          return;
        }
        if (child.type === ('Animated.FlatList' as unknown)) {
          output = child;
          const count = child.props.data?.length ?? 0;
          const initial = child.props.initialNumToRender ?? 10;
          const range = mockVisibleRange ?? { first: 0, last: initial - 1 };
          for (let index = 0; index < count; index += 1) {
            // RN retains its initial batch even when initialScrollIndex is 0.
            // Model this explicitly so unmount tests use non-pinned sources.
            const pinned =
              (child.props.initialScrollIndex ?? 0) <= 0 && index < initial;
            if (!pinned && (index < range.first || index > range.last))
              continue;
            const item = child.props.data![index];
            const key =
              child.props.keyExtractor?.(item, index) ?? String(index);
            const previous = mockFlatCells.get(key);
            // RN's CellRenderer is pure. Its element can stay the same while
            // descendants still receive updates from the surrounding context.
            const same =
              previous &&
              previous.item === item &&
              previous.index === index &&
              previous.renderItem === child.props.renderItem;
            let rendered = previous?.output;
            if (!same) {
              mockFlatCellRenders++;
              rendered = child.props.renderItem?.({ item, index });
              mockFlatCells.set(key, {
                item,
                index,
                renderItem: child.props.renderItem,
                output: rendered,
              });
            }
            children(rendered, undefined, `flat:${key}`);
          }
          return;
        }
        if (child.type === ('Animated.ScrollView' as unknown)) output = child;
        const scope =
          (child.type as unknown) === DndItemContext
            ? child.props.value?.itemId
            : itemId;
        if (scope && child.type === ('Animated.View' as unknown)) {
          mockCells.set(scope, child.props);
          if (child.props.ref && !child.props.ref.current) {
            child.props.ref.current = {
              measure: callback =>
                mockMeasurements.push({ itemId: scope, callback }),
            };
          }
        }
        if (
          !scope &&
          child.type === ('View' as unknown) &&
          path.startsWith('flat:') &&
          child.props.collapsable === false
        )
          mockSlots.set(path.slice(5), child.props);
        children(child.props.children, scope, path);
      });
    };
    enter('root');
    output = SortableList(props);
    children(output);
    for (const [key, frame] of mockFrames) {
      if (!visited.has(key)) {
        frame.hooks.forEach(hook => hook.cleanup?.());
        mockFrames.delete(key);
        mockMemoCells.delete(key);
      }
    }
    const beforeLayout = mockBeforeLayoutEffects;
    mockBeforeLayoutEffects = null;
    beforeLayout?.();
    for (const frame of [...order].reverse())
      frame.layout.splice(0).forEach(effect => effect());
    for (const frame of [...order].reverse())
      frame.passive.splice(0).forEach(effect => effect());
  } while (mockDirty);
}

function event(width: number, height: number): LayoutChangeEvent {
  return {
    nativeEvent: { layout: { width, height, x: 0, y: 0 } },
  } as LayoutChangeEvent;
}

function viewport(width = 200, height = 300) {
  output.props.onLayout?.(event(width, height));
  render();
}

function measure(itemId: string, width: number, height: number) {
  mockCells.get(itemId)?.onLayout?.(event(width, height));
  flushMeasurementFrame();
  render();
}

function flattenStyle(value: unknown): Record<string, unknown> {
  if (Array.isArray(value))
    return Object.assign({}, ...value.map(flattenStyle));
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function registration() {
  const entry = registrations.get(props.zoneId);
  if (!entry) throw new Error('Expected registered list');
  return entry;
}

function publishDisplay(value: LayoutState<unknown>) {
  const zone = value.zones.find(entry => entry.id === props.zoneId);
  if (zone?.kind !== 'list') throw new Error('Expected list');
  const display = registration().prepareDisplay?.(zone, value.revision);
  if (!display) throw new Error('Expected prepared presentation');
  mockRuntime.presentation!.set({
    token: 1,
    revision: mockRuntime.snapshot.value!.revision,
    zones: { [`#${zone.id}`]: display },
  });
}

function translation(itemId: string, axis: 'X' | 'Y' = 'Y') {
  const transform = flattenStyle(mockCells.get(itemId)!.style)
    .transform as Array<Record<string, number>>;
  return transform.find(entry => `translate${axis}` in entry)![
    `translate${axis}`
  ];
}

function unmount() {
  for (const frame of mockFrames.values())
    frame.hooks.forEach(hook => hook.cleanup?.());
  mockFrames.clear();
  mockMemoCells.clear();
  mockFlatCells.clear();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFrames.clear();
  mockMemoCells.clear();
  mockContexts.clear();
  mockFlatCells.clear();
  mockFlatCellRenders = 0;
  mockCells.clear();
  mockSlots.clear();
  mockVisibleRange = null;
  mockStyleSubscriptions.length = 0;
  mockUiStyles.clear();
  mockUiMappers.clear();
  mockNextMapperId = 0;
  mockExecutingUi = false;
  mockMicrotasks.length = 0;
  mockScheduledUi.length = 0;
  mockScheduledUiCount = 0;
  mockSharedWrites.length = 0;
  mockExpectedStarts.clear();
  jest
    .spyOn(
      globalThis as typeof globalThis & {
        queueMicrotask(callback: () => void): void;
      },
      'queueMicrotask',
    )
    .mockImplementation(callback => {
      mockMicrotasks.push(callback);
    });
  mockTimingTargets.length = 0;
  mockReadingStyle = null;
  mockStateUpdates = 0;
  mockBeforeLayoutEffects = null;
  mockMeasurementFrames.clear();
  mockNextMeasurementFrame = 0;
  jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation(callback => {
      const id = ++mockNextMeasurementFrame;
      mockMeasurementFrames.set(id, callback);
      return id;
    });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    if (id != null) mockMeasurementFrames.delete(id);
  });
  mockMeasurements.length = 0;
  registrations.clear();
  mockRuntime = {
    snapshot: {
      value: null,
      displayValue: null,
      candidate: null,
      phase: 'idle',
      sessionId: null,
      itemId: null,
      sourceZoneId: null,
      targetZoneId: null,
      target: null,
      seq: 0,
      validity: 'pending',
      disabled: false,
    },
    motion: mockShared(EMPTY_DND_MOTION),
    presentation: mockShared(EMPTY_DND_PRESENTATION),
    animation: { durationMs: 180, reduceMotion: 'system' },
    registerZone,
    unregisterZone,
    reportIssues,
  } as unknown as DndRuntime;
  setValue(state());
  props = {
    zoneId: 'source',
    estimatedItemSize: 40,
    gap: 8,
    renderItem: jest.fn(() => null),
  };
  render();
});

afterEach(() => {
  unmount();
  jest.restoreAllMocks();
});

it('waits for viewport geometry and registers estimated vertical content with identity cleanup', () => {
  expect(registrations.size).toBe(0);
  viewport();
  expect(registration()).toMatchObject({
    orientation: 'vertical',
    revision: 3,
    contentSize: 136,
  });
  expect(registration().dataIdentity).toBe(mockRuntime.snapshot.value!.items);
  expect(registration().layout.entries.map(entry => entry.source)).toEqual([
    'estimated',
    'estimated',
    'estimated',
  ]);
  expect(output.props.horizontal).toBe(false);
  expect(output.props.removeClippedSubviews).toBe(false);
  const identity = registerZone.mock.calls.at(-1)?.[1];
  unmount();
  expect(unregisterZone).toHaveBeenLastCalledWith('source', identity);
});

it('measures variable heights, preserves ID sizes across reorder, and does not loop on unchanged measurements', () => {
  viewport();
  measure('a', 200, 20);
  measure('b', 200, 80);
  measure('c', 200, 50);
  expect(registration().layout.entries.map(entry => entry.size)).toEqual([
    20, 80, 50,
  ]);
  const before = registerZone.mock.calls.length;
  measure('b', 200, 80);
  expect(registerZone).toHaveBeenCalledTimes(before);
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'source', index: 0 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  setValue(result.value as LayoutState<{ label: string }>);
  render();
  expect(
    registration().layout.entries.map(entry => [entry.itemId, entry.size]),
  ).toEqual([
    ['b', 80],
    ['a', 20],
    ['c', 50],
  ]);
  expect(registration().revision).toBe(4);
});

it('ignores subpixel measurement noise while accepting meaningful size changes', () => {
  viewport();
  measure('b', 200, 100);
  const baseline = registration().layout;
  const registrationsBefore = registerZone.mock.calls.length;
  for (const height of [
    100.00001525878906, 99.99996948242188, 100.00006103515625,
  ])
    measure('b', 200, height);
  expect(registration().layout).toBe(baseline);
  expect(registerZone).toHaveBeenCalledTimes(registrationsBefore);
  measure('b', 200, 100.01);
  expect(registration().layout.entries[1].size).toBe(100.01);
});

it('invalidates sizes on width or data changes and rejects stale layout callbacks', () => {
  viewport();
  const oldLayout = mockCells.get('a')!.onLayout!;
  measure('a', 200, 90);
  viewport(300, 300);
  expect(registration().layout.entries[0]).toMatchObject({
    size: 40,
    source: 'estimated',
  });
  oldLayout(event(200, 500));
  render();
  expect(registration().layout.entries[0].size).toBe(40);
  measure('a', 300, 60);
  const value = mockRuntime.snapshot.value!;
  setValue({
    ...value,
    revision: value.revision + 1,
    items: value.items.map(item => ({ ...item, data: { label: 'updated' } })),
  });
  render();
  expect(registration().layout.entries[0]).toMatchObject({
    size: 40,
    source: 'estimated',
  });
});

it('rejects a prior revision measurement even before the new native size arrives', () => {
  viewport();
  const stale = mockCells.get('a')!.onLayout!;
  measure('a', 200, 60);
  const value = mockRuntime.snapshot.value!;
  setValue({ ...value, revision: value.revision + 1 } as LayoutState<{
    label: string;
  }>);
  render();
  stale(event(200, 999));
  render();
  expect(registration().layout.entries[0].size).toBe(60);
});

it('remeasures after a data change with no native layout event and ignores superseded measurement callbacks', () => {
  viewport();
  expect(mockMeasurements).toHaveLength(0);
  const value = mockRuntime.snapshot.value!;
  setValue({
    ...value,
    revision: 4,
    items: value.items.map(item => ({ ...item, data: { label: 'new' } })),
  });
  render();
  const old = mockMeasurements.find(entry => entry.itemId === 'a')!;
  setValue({
    ...value,
    revision: 5,
    items: value.items.map(item => ({ ...item, data: { label: 'newer' } })),
  });
  render();
  const next = mockMeasurements.filter(entry => entry.itemId === 'a').at(-1)!;
  expect(next).not.toBe(old);
  old.callback(0, 0, 200, 999);
  next.callback(0, 0, 200, 65);
  flushMeasurementFrame();
  render();
  expect(registration().layout.entries[0]).toMatchObject({
    size: 65,
    source: 'measured',
  });
});

it.each([false, true])(
  'uses onLayout for new variable cells without requesting duplicate native measurements (virtualization: %s)',
  virtualization => {
    props = { ...props, virtualization };
    render();
    viewport();
    expect(mockMeasurements).toHaveLength(0);
    measure('a', 200, 65);
    expect(registration().layout.entries[0]).toMatchObject({
      size: 65,
      source: 'measured',
    });
    const value = mockRuntime.snapshot.value! as LayoutState<{ label: string }>;
    setValue({ ...value, revision: value.revision + 1 });
    render();
    expect(mockMeasurements).toHaveLength(0);
    expect(registration().layout.entries[0].size).toBe(65);
  },
);

it('retries a required context measurement superseded by a revision-only commit', () => {
  viewport();
  viewport(300, 300);
  const stale = mockMeasurements.find(entry => entry.itemId === 'a')!;
  const value = mockRuntime.snapshot.value! as LayoutState<{ label: string }>;
  setValue({ ...value, revision: value.revision + 1 });
  render();
  const current = mockMeasurements
    .filter(entry => entry.itemId === 'a')
    .at(-1)!;
  expect(current).not.toBe(stale);
  stale.callback(0, 0, 300, 999);
  current.callback(0, 0, 300, 65);
  flushMeasurementFrame();
  render();
  expect(registration().layout.entries[0].size).toBe(65);
});

it('batches separate native size events across intervening commits into one frame update', () => {
  viewport();
  const before = mockStateUpdates;
  mockCells.get('a')!.onLayout!(event(200, 60));
  render();
  mockCells.get('b')!.onLayout!(event(200, 80));
  render();
  mockCells.get('c')!.onLayout!(event(200, 90));
  expect(mockStateUpdates - before).toBe(0);
  expect(mockMeasurementFrames.size).toBe(1);
  flushMeasurementFrame();
  expect(mockStateUpdates - before).toBe(1);
  render();
  expect(registration().layout.entries.map(entry => entry.size)).toEqual([
    60, 80, 90,
  ]);
  const next = mockStateUpdates;
  measure('c', 200, 100);
  expect(mockStateUpdates - next).toBe(1);
  expect(registration().layout.entries[2].size).toBe(100);
});

it('keeps a newer native size received between layout preparation and commit', () => {
  viewport();
  mockCells.get('a')!.onLayout!(event(200, 60));
  flushMeasurementFrame();
  mockBeforeLayoutEffects = () => {
    mockCells.get('b')!.onLayout!(event(200, 80));
  };
  render();
  expect(registration().layout.entries.map(entry => entry.size)).toEqual([
    60, 40, 40,
  ]);
  expect(mockMeasurementFrames.size).toBe(1);
  flushMeasurementFrame();
  render();
  expect(registration().layout.entries.map(entry => entry.size)).toEqual([
    60, 80, 40,
  ]);
});

it('does not send a redundant frame signal when the prior render already included later measurements', () => {
  viewport();
  mockCells.get('a')!.onLayout!(event(200, 60));
  flushMeasurementFrame();
  mockCells.get('b')!.onLayout!(event(200, 80));
  render();
  expect(registration().layout.entries.map(entry => entry.size)).toEqual([
    60, 80, 40,
  ]);
  const before = mockStateUpdates;
  flushMeasurementFrame();
  expect(mockStateUpdates).toBe(before);
  expect(mockMeasurementFrames.size).toBe(0);
});

it.each(['width', 'data'] as const)(
  'cancels an obsolete measurement frame after a %s context replacement',
  change => {
    viewport();
    mockCells.get('a')!.onLayout!(event(200, 60));
    const [id, cancelled] = [...mockMeasurementFrames][0];
    if (change === 'width') viewport(300, 300);
    else {
      const value = mockRuntime.snapshot.value!;
      setValue({
        ...value,
        revision: value.revision + 1,
        items: value.items.map(item => ({
          ...item,
          data: { label: 'changed' },
        })),
      });
      render();
    }
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(id);
    expect(mockMeasurementFrames.size).toBe(0);
    expect(registration().layout.entries[0].size).toBe(40);
    mockCells.get('a')!.onLayout!(event(change === 'width' ? 300 : 200, 80));
    const before = mockStateUpdates;
    // Model a callback already delivered from native despite cancellation.
    cancelled(32);
    expect(mockStateUpdates).toBe(before);
    expect(mockMeasurementFrames.size).toBe(1);
    flushMeasurementFrame();
    render();
    expect(registration().layout.entries[0].size).toBe(80);
  },
);

it('cancels queued measurement rendering on unmount and ignores an already delivered frame', () => {
  viewport();
  mockCells.get('a')!.onLayout!(event(200, 60));
  const [id, cancelled] = [...mockMeasurementFrames][0];
  unmount();
  expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(id);
  const before = mockStateUpdates;
  cancelled(32);
  flushMeasurementFrame();
  expect(mockStateUpdates).toBe(before);
  expect(mockMeasurementFrames.size).toBe(0);
  expect(registrations.size).toBe(0);
});

it('uses heights as the horizontal cross axis and reports horizontal scroll offsets', () => {
  const onScrollOffsetChange = jest.fn();
  props = { ...props, zoneId: 'target', onScrollOffsetChange };
  render();
  viewport(400, 75);
  measure('d', 130, 75);
  expect(output.props.horizontal).toBe(true);
  const content = output.props.children as ReactElement<HostProps>;
  expect(flattenStyle(content.props.style).flexDirection).toBe('row');
  expect(registration().layout.entries[0].rect).toEqual({
    x: 0,
    y: 0,
    width: 130,
    height: 75,
  });
  output.props.onScroll?.({ contentOffset: { x: 55, y: 0 } });
  expect(registration().offset.get()).toBe(55);
  expect(onScrollOffsetChange).toHaveBeenCalledWith({ x: 55, y: 0 });
});

it('updates vertical scroll offsets without re-registering geometry or cancelling drag', () => {
  viewport();
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    phase: 'dragging',
    itemId: 'b',
  };
  render();
  const before = registerZone.mock.calls.length;
  output.props.onScroll?.({ contentOffset: { x: 0, y: 70 } });
  expect(registration().offset.get()).toBe(70);
  expect(registerZone).toHaveBeenCalledTimes(before);
  expect(mockRuntime.snapshot.phase).toBe('dragging');
  expect(output.props.scrollEnabled).toBe(false);
});

it.each([false, true])(
  'does not rerender cards or invalidate list metrics for pointer-only session updates (virtualization: %s)',
  virtualization => {
    props = { ...props, virtualization };
    render();
    viewport();
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'b',
    };
    (props.renderItem as jest.Mock).mockClear();
    render();
    expect(props.renderItem).toHaveBeenCalledTimes(1);
    expect(props.renderItem).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: 'b' }),
        isDragging: true,
      }),
    );
    (props.renderItem as jest.Mock).mockClear();
    const baseline = registration().layout;
    const nativeProps = output.props;
    const registrationsBefore = registerZone.mock.calls.length;
    for (let seq = 1; seq <= 120; seq += 1) {
      mockRuntime.snapshot = { ...mockRuntime.snapshot, seq };
      render();
    }
    expect(props.renderItem).not.toHaveBeenCalled();
    expect(registration().layout).toBe(baseline);
    expect(registerZone).toHaveBeenCalledTimes(registrationsBefore);
    if (virtualization) {
      expect(output.props.renderItem).toBe(nativeProps.renderItem);
      expect(output.props.getItemLayout).toBe(nativeProps.getItemLayout);
      expect(output.props.keyExtractor).toBe(nativeProps.keyExtractor);
      expect(output.props.contentContainerStyle).toBe(
        nativeProps.contentContainerStyle,
      );
    }
  },
);

it('isolates card styles from per-frame pointer and viewport motion updates', () => {
  viewport();
  expect(mockStyleSubscriptions).toHaveLength(3);
  for (const subscriptions of mockStyleSubscriptions) {
    // The two inputs are animated position and the derived hidden item ID.
    // Subscribing to full motion would rerun every card's native style mapper
    // whenever only the drag preview's pointer or viewport measurements change.
    expect(subscriptions.size).toBe(2);
    expect(subscriptions.has(mockRuntime.motion)).toBe(false);
  }
});

it('moves existing cells from validated UI geometry before a React snapshot commit', () => {
  viewport();
  const before = registerZone.mock.calls.length;
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'a',
    to: { kind: 'list', zoneId: 'source', index: 2 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  (props.renderItem as jest.Mock).mockClear();
  publishDisplay(result.value);
  flushUi();
  expect(translation('b')).toBe(0);
  expect(translation('c')).toBe(48);
  expect(translation('a')).toBe(96);
  expect(props.renderItem).not.toHaveBeenCalled();
  expect(registerZone).toHaveBeenCalledTimes(before);
  expect(mockRuntime.snapshot.displayValue!.zones[0]).toMatchObject({
    itemIds: ['a', 'b', 'c'],
  });
});

it('positions the hidden active source immediately while animating its neighbors', () => {
  viewport();
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'a',
    to: { kind: 'list', zoneId: 'source', index: 2 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  mockRuntime.motion.set({
    ...EMPTY_DND_MOTION,
    visible: true,
    itemId: 'a',
    phase: 'dragging',
  });
  publishDisplay(result.value);
  mockTimingTargets.length = 0;
  flushUi();
  expect(translation('a')).toBe(96);
  // Neighbor mappers run in UI registration order, which is not a contract.
  expect([...mockTimingTargets].sort((x, y) => x - y)).toEqual([0, 48]);
});

it('prepares candidate geometry with current measured sizes and index-dependent caller sizes', () => {
  viewport();
  measure('b', 200, 80);
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'source', index: 0 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  publishDisplay(result.value);
  expect(
    presentationRect(mockRuntime.presentation!.get(), 'source', 'a')!.y,
  ).toBe(88);
  props = {
    ...props,
    itemSize: (_itemId, index) => 20 + index * 10,
    paddingStart: 5,
  };
  render();
  publishDisplay(result.value);
  expect(
    zonePresentationRects(mockRuntime.presentation!.get().zones['#source']),
  ).toEqual({
    '#b': { x: 0, y: 5, width: 200, height: 20 },
    '#a': { x: 0, y: 33, width: 200, height: 30 },
    '#c': { x: 0, y: 71, width: 200, height: 40 },
  });
  flushUi();
  expect(flattenStyle(mockCells.get('a')!.style).height).toBe(30);
  expect(flattenStyle(mockCells.get('b')!.style).height).toBe(20);
});

it('reuses prepared candidate layouts for React rendering and repeat publication', () => {
  const itemSize = jest.fn((_itemId: string, index: number) => 20 + index * 10);
  props = { ...props, itemSize };
  render();
  viewport();
  itemSize.mockClear();
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'source', index: 0 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  const candidate = result.value.zones[0] as ListLayoutZone;
  const prepared = registration().prepareDisplay!(
    candidate,
    result.value.revision,
  );
  expect(itemSize.mock.calls).toEqual([
    ['b', 0],
    ['a', 1],
    ['c', 2],
  ]);
  expect(registration().prepareDisplay!(candidate, result.value.revision)).toBe(
    prepared,
  );
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: result.value,
  };
  render();
  expect(registration().prepareDisplay!(candidate, result.value.revision)).toBe(
    prepared,
  );
  expect(itemSize).toHaveBeenCalledTimes(3);
  expect(
    registration().prepareDisplay!(candidate, result.value.revision + 1),
  ).not.toBe(prepared);
  expect(itemSize).toHaveBeenCalledTimes(6);
});

it('invalidates prepared geometry immediately when a native measurement arrives before React rendering', () => {
  viewport();
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'source', index: 0 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  const candidate = result.value.zones[0] as ListLayoutZone;
  const prepared = registration().prepareDisplay!(
    candidate,
    result.value.revision,
  )!;
  expect(zonePresentationRects(prepared)['#a'].y).toBe(48);
  mockCells.get('b')!.onLayout!(event(200, 80));
  const changed = registration().prepareDisplay!(
    candidate,
    result.value.revision,
  )!;
  expect(changed).not.toBe(prepared);
  expect(zonePresentationRects(changed)['#a'].y).toBe(88);
});

it.each([false, true])(
  'gates UI coordinates and sizes through shared committed revision without a React render (virtualization: %s)',
  virtualization => {
    const committedRevision = mockShared(3);
    mockRuntime = {
      ...mockRuntime,
      committedRevision: committedRevision as never,
    };
    props = { ...props, itemSize: 40, virtualization };
    render();
    viewport();
    const presentation = mockRuntime.presentation!;
    const candidate = {
      token: 1,
      revision: 3,
      zones: {
        '#source': zonePresentationFromRects({
          '#a': { x: 0, y: 80, width: 200, height: 90 },
        }),
      },
    };
    presentation.set(candidate);
    (props.renderItem as jest.Mock).mockClear();
    flushUi();
    expect(translation('a')).toBe(80);
    expect(flattenStyle(mockCells.get('a')!.style).height).toBe(90);
    committedRevision.set(4);
    flushUi();
    expect(translation('a')).toBe(0);
    expect(flattenStyle(mockCells.get('a')!.style).height).toBe(40);
    presentation.set({ ...candidate, revision: 4 });
    flushUi();
    expect(translation('a')).toBe(80);
    expect(flattenStyle(mockCells.get('a')!.style).height).toBe(90);
    presentation.set(candidate);
    flushUi();
    expect(translation('a')).toBe(0);
    expect(flattenStyle(mockCells.get('a')!.style).height).toBe(40);
    expect(mockRuntime.snapshot.value!.revision).toBe(3);
    expect(props.renderItem).not.toHaveBeenCalled();
  },
);

it('ignores prior-revision UI coordinates and sizes after an external idle update', () => {
  props = { ...props, itemSize: 40 };
  render();
  viewport();
  publishDisplay(mockRuntime.snapshot.value!);
  flushUi();
  expect(translation('a')).toBe(0);
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'a',
    to: { kind: 'list', zoneId: 'source', index: 2 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  props = { ...props, itemSize: 55 };
  setValue(result.value as LayoutState<{ label: string }>);
  render();
  flushUi();
  expect(mockRuntime.presentation!.get().revision).toBe(3);
  expect(mockRuntime.snapshot.value!.revision).toBe(4);
  expect(translation('a')).toBe(126);
  expect(translation('b')).toBe(0);
  expect(flattenStyle(mockCells.get('a')!.style).height).toBe(55);
});

it.each([false, true])(
  'reuses measured card content and rerenders changed public arguments (virtualization: %s)',
  virtualization => {
    props = { ...props, virtualization };
    render();
    viewport();
    (props.renderItem as jest.Mock).mockClear();
    measure('c', 200, 75);
    expect(props.renderItem).not.toHaveBeenCalled();
    expect(registration().layout.entries[2].size).toBe(75);
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'a',
      to: { kind: 'list', zoneId: 'source', index: 1 },
    });
    if (result.status !== 'ok') throw new Error('Expected reorder');
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'a',
      displayValue: result.value,
      candidate: result.value,
    };
    (props.renderItem as jest.Mock).mockClear();
    render();
    expect(
      (props.renderItem as jest.Mock).mock.calls.map(([args]) => args.item.id),
    ).toEqual(['a', 'b']);
    publishDisplay(result.value);
    flushUi();
    // Both adapters keep their committed slots through the preview and draw
    // content at its animated start; the virtual slot offset still cancels the
    // committed slot position.
    expect(translation('b')).toBe(0);
    if (virtualization)
      expect(flattenStyle(mockCells.get('b')!.style).top).toBe(-48);
  },
);

it.each([false, true])(
  'reuses the card subtree on revision changes while updating native measurement callbacks (virtualization: %s)',
  virtualization => {
    const renderer = jest.fn(
      ({ item, index }: { item: { id: string }; index: number }) => (
        <>{`${item.id}:${index}`}</>
      ),
    );
    props = { ...props, virtualization, renderItem: renderer };
    render();
    viewport();
    const children = new Map(
      [...mockCells].map(([id, cell]) => [id, cell.children]),
    );
    const nativeSlots = new Map(mockSlots);
    const oldLayout = mockCells.get('a')!.onLayout!;
    renderer.mockClear();
    const value = mockRuntime.snapshot.value! as LayoutState<{ label: string }>;
    setValue({ ...value, revision: value.revision + 1 });
    render();
    expect(registration().revision).toBe(value.revision + 1);
    expect(renderer).not.toHaveBeenCalled();
    for (const [id, content] of children)
      expect(mockCells.get(id)!.children).toBe(content);
    // Measurement context reaches the inner cell even though its memoized
    // native slot and static wrapper element remain unchanged.
    for (const [id, slot] of nativeSlots) expect(mockSlots.get(id)).toBe(slot);
    expect(mockCells.get('a')!.onLayout).not.toBe(oldLayout);
    oldLayout(event(200, 999));
    flushMeasurementFrame();
    render();
    expect(registration().layout.entries[0].size).toBe(40);
    measure('a', 200, 80);
    expect(registration().layout.entries[0].size).toBe(80);
    expect(registration().layout.entries[1].start).toBe(88);
    expect(renderer).not.toHaveBeenCalled();
    expect(mockCells.get('a')!.children).toBe(children.get('a'));
  },
);

it('retains coordinate objects across revision changes while updating layout metadata', () => {
  viewport();
  const value = mockRuntime.snapshot.value!;
  const previous = registration().layout;
  for (const entry of previous.entries) {
    Object.freeze(entry.rect);
    Object.freeze(entry);
  }
  setValue({ ...value, revision: value.revision + 1 } as LayoutState<{
    label: string;
  }>);
  render();
  const current = registration().layout;
  const zone = mockRuntime.snapshot.value!.zones[0] as ListLayoutZone;
  const presentation = registration().prepareDisplay!(zone, current.revision)!;
  for (const [index, entry] of current.entries.entries()) {
    expect(entry).not.toBe(previous.entries[index]);
    expect(entry.revision).toBe(value.revision + 1);
    expect(entry.rect).toBe(previous.entries[index].rect);
    expect(zonePresentationRects(presentation)[`#${entry.itemId}`]).toEqual(
      entry.rect,
    );
    expect(previous.entries[index].revision).toBe(value.revision);
  }
});

it('replaces only changed coordinates after measurement and reordering', () => {
  viewport();
  const before = registration().layout.entries;
  const frozenRects = before.map(entry => Object.freeze(entry.rect));
  measure('b', 200, 80);
  const measured = registration().layout.entries;
  expect(measured[0].rect).toBe(frozenRects[0]);
  expect(measured[1].rect).not.toBe(frozenRects[1]);
  expect(measured[2].rect).not.toBe(frozenRects[2]);
  expect(frozenRects[1]).toMatchObject({ y: 48, height: 40 });
  expect(frozenRects[2]).toMatchObject({ y: 96, height: 40 });
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'source', index: 0 },
  });
  if (result.status !== 'ok') throw new Error('Expected reorder');
  setValue(result.value as LayoutState<{ label: string }>);
  render();
  const moved = registration().layout.entries;
  expect(moved[0]).toMatchObject({ itemId: 'b', index: 0, start: 0, size: 80 });
  expect(moved[1]).toMatchObject({
    itemId: 'a',
    index: 1,
    start: 88,
    size: 40,
  });
  expect(moved[0].rect).not.toBe(measured[1].rect);
  expect(moved[1].rect).not.toBe(measured[0].rect);
  expect(moved[2]).not.toBe(measured[2]);
  expect(moved[2].revision).toBe(result.value.revision);
  expect(moved[2].rect).toBe(measured[2].rect);
});

it('does not request or cache native sizes while caller sizes are authoritative', () => {
  props = { ...props, itemSize: 55 };
  render();
  viewport();
  expect(mockMeasurements).toHaveLength(0);
  const baseline = registration().layout;
  measure('a', 200, 55);
  expect(registration().layout).toBe(baseline);
  props = { ...props, itemSize: undefined };
  render();
  expect(mockMeasurements).toHaveLength(3);
  const measurement = mockMeasurements.find(entry => entry.itemId === 'a')!;
  measurement.callback(0, 0, 200, 95);
  flushMeasurementFrame();
  render();
  expect(registration().layout.entries[0].size).toBe(95);
});

it('keeps the original source cell mounted while displaying a cross-list candidate', () => {
  viewport();
  const originalRef = mockCells.get('b')!.ref;
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'target', index: 1 },
  });
  if (result.status !== 'ok') throw new Error('Expected transfer');
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    phase: 'dragging',
    itemId: 'b',
    sourceZoneId: 'source',
    targetZoneId: 'target',
    displayValue: result.value,
    candidate: result.value,
  };
  render();
  expect([...mockCells.keys()]).toEqual(['a', 'b', 'c']);
  expect(mockCells.get('b')!.ref).toBe(originalRef);
  expect(registration().layout.entries.map(entry => entry.itemId)).toEqual([
    'a',
    'b',
    'c',
  ]);
  expect(registration().contentSize).toBe(88);
  expect(props.renderItem).toHaveBeenCalledWith(
    expect.objectContaining({
      item: expect.objectContaining({ id: 'b' }),
      isDragging: true,
    }),
  );
});

it('renders an incoming cross-list item while preserving the committed target geometry', () => {
  props = { ...props, zoneId: 'target' };
  render();
  viewport(400, 75);
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'target', index: 1 },
  });
  if (result.status !== 'ok') throw new Error('Expected transfer');
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    phase: 'dragging',
    itemId: 'b',
    displayValue: result.value,
  };
  render();
  expect([...mockCells.keys()]).toEqual(['d', 'b']);
  expect(registration().layout.entries.map(entry => entry.itemId)).toEqual([
    'd',
  ]);
  expect(registration().contentSize).toBe(88);
});

function rejectJsPresentationReads() {
  const original = mockRuntime.presentation!.get;
  return jest.spyOn(mockRuntime.presentation!, 'get').mockImplementation(() => {
    if (!mockExecutingUi)
      throw new Error('Shared presentation read on the JS runtime');
    return original();
  });
}

it('mounts cells from JS geometry without reading the shared presentation on the JS runtime', () => {
  const reads = rejectJsPresentationReads();
  viewport();
  expect(translation('a')).toBe(0);
  expect(translation('b')).toBe(48);
  expect(translation('c')).toBe(96);
  // The UI mapper evaluated once per cell after mount and adopted its slot.
  expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3);
  mockTimingTargets.length = 0;
  flushUi();
  expect(translation('b')).toBe(48);
  expect(mockTimingTargets).toEqual([]);
});

function previewIncomingItem() {
  props = { ...props, zoneId: 'target' };
  render();
  viewport(400, 75);
  const result = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'b',
    to: { kind: 'list', zoneId: 'target', index: 1 },
  });
  if (result.status !== 'ok') throw new Error('Expected transfer');
  const zone = result.value.zones.find(entry => entry.id === 'target');
  if (zone?.kind !== 'list') throw new Error('Expected list');
  const display = registration().prepareDisplay?.(zone, result.value.revision);
  if (!display) throw new Error('Expected prepared presentation');
  const scheduled = {
    token: 1,
    revision: mockRuntime.snapshot.value!.revision,
    zones: { '#target': display },
  };
  mockRuntime.presentationSnapshot = () => scheduled;
  return { result, scheduled };
}

it('positions a cell mounted during a preview from the scheduled presentation without a JS shared read', () => {
  const { result, scheduled } = previewIncomingItem();
  mockRuntime.presentation!.set(scheduled);
  const reads = rejectJsPresentationReads();
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    phase: 'dragging',
    itemId: 'b',
    displayValue: result.value,
  };
  mockTimingTargets.length = 0;
  render();
  expect([...mockCells.keys()]).toEqual(['d', 'b']);
  // Initial style already uses the candidate slot; no estimate-to-target motion.
  expect(translation('b', 'X')).toBe(48);
  expect(reads).toHaveBeenCalled();
  flushUi();
  expect(translation('b', 'X')).toBe(48);
  expect(mockTimingTargets).toEqual([]);
});

it('snaps to the actual UI geometry on the first UI evaluation instead of animating from the JS estimate', () => {
  const { result, scheduled } = previewIncomingItem();
  // The UI runtime rejected or has not yet applied the scheduled table.
  mockRuntime.presentation!.set({
    ...scheduled,
    zones: {
      '#target': zonePresentationFromRects({
        ...zonePresentationRects(scheduled.zones['#target']),
        '#b': { x: 60, y: 0, width: 40, height: 75 },
      }),
    },
  });
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    phase: 'dragging',
    itemId: 'b',
    displayValue: result.value,
  };
  mockTimingTargets.length = 0;
  render();
  // The initial style still carries the JS estimate for at most one frame.
  expect(translation('b', 'X')).toBe(48);
  flushUi();
  // The first UI evaluation adopted the UI table without a timing animation.
  expect(translation('b', 'X')).toBe(60);
  expect(mockTimingTargets).toEqual([]);
  // Later validated changes still animate.
  mockRuntime.presentation!.set(scheduled);
  flushUi();
  expect(translation('b', 'X')).toBe(48);
  expect(mockTimingTargets).toEqual([48]);
});

it('applies fixed dimensions and forwards viewport layout callbacks', () => {
  const onLayout = jest.fn();
  props = { ...props, itemSize: 55, onLayout };
  render();
  viewport();
  expect(onLayout).toHaveBeenCalledWith(event(200, 300));
  expect(mockCells.get('a')!.style).toEqual(
    expect.arrayContaining([{ width: 200, height: 55 }]),
  );
  measure('a', 200, 999);
  expect(registration().layout.entries[0].size).toBe(55);
});

it('removes unavailable geometry instead of keeping a stale registered viewport', () => {
  viewport();
  expect(registrations.has('source')).toBe(true);
  viewport(0, 300);
  expect(registrations.has('source')).toBe(false);
  viewport();
  expect(registrations.has('source')).toBe(true);
});

it.each([{ gap: -1 }, { autoScroll: { maxSpeed: -1 } }])(
  'reports invalid adapter configuration and unregisters stale geometry: %p',
  overrides => {
    viewport();
    props = { ...props, ...overrides };
    render();
    expect(registrations.has('source')).toBe(false);
    expect(reportIssues).toHaveBeenLastCalledWith(
      'list:source',
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-configuration' }),
      ]),
    );
  },
);

it('reports a missing list zone and disables configured automatic scrolling', () => {
  props = { ...props, scrollEnabled: false };
  render();
  viewport();
  expect(registration().autoScroll?.enabled).toBe(false);
  props = { ...props, zoneId: 'missing' };
  render();
  expect(registrations.size).toBe(0);
  expect(reportIssues).toHaveBeenCalledWith(
    'list:missing',
    expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-configuration' }),
    ]),
  );
});

it('does not write measurements or update state after unmount', () => {
  viewport();
  viewport(300, 300);
  const oldLayout = mockCells.get('a')!.onLayout!;
  const delayed = mockMeasurements.find(entry => entry.itemId === 'a')!;
  unmount();
  mockDirty = false;
  oldLayout(event(200, 999));
  delayed.callback(0, 0, 200, 999);
  expect(mockDirty).toBe(false);
  expect(registrations.size).toBe(0);
});

it('invalidates vertical measurements when a zone changes orientation', () => {
  viewport();
  measure('a', 200, 90);
  const value = mockRuntime.snapshot.value!;
  setValue({
    ...value,
    revision: 4,
    zones: value.zones.map(zone =>
      zone.id === 'source'
        ? ({ ...zone, orientation: 'horizontal' } as ListLayoutZone)
        : zone,
    ),
  } as LayoutState<{ label: string }>);
  render();
  expect(output.props.horizontal).toBe(true);
  expect(registration().layout.entries[0].rect).toEqual({
    x: 0,
    y: 0,
    width: 40,
    height: 300,
  });
});

function longState(count = 200): LayoutState<{ label: string }> {
  const itemIds = Array.from({ length: count }, (_, index) => `item:${index}`);
  return {
    revision: 8,
    items: itemIds.map(id => ({ id, data: { label: id } })),
    zones: [
      { id: 'source', kind: 'list', orientation: 'vertical', itemIds },
      { id: 'target', kind: 'list', orientation: 'horizontal', itemIds: [] },
    ],
  };
}

function virtualize(value = longState()) {
  setValue(value);
  props = {
    ...props,
    virtualization: {
      initialNumToRender: 2,
      maxToRenderPerBatch: 4,
      windowSize: 3,
      updateCellsBatchingPeriod: 12,
    },
  };
  render();
  viewport();
}

function itemLayout(index: number) {
  const result = output.props.getItemLayout?.(output.props.data, index);
  if (!result) throw new Error('Expected virtual item layout');
  return result;
}

describe('FlatList adapter', () => {
  it('positions virtual content with a React-committed slot offset plus its animated content start', () => {
    virtualize();
    flushUi();
    expect(mockCells.size).toBeGreaterThan(0);
    for (const [itemId, cell] of mockCells) {
      const layout = itemLayout(output.props.data!.indexOf(itemId));
      const style = flattenStyle(cell.style);
      expect((style.top as number) + layout.offset).toBe(0);
      expect(translation(itemId)).toBe(layout.offset);
      expect(mockSlots.get(itemId)!.ref).toBeUndefined();
    }
  });

  it('keeps content in place through a slot reorder commit and moves it only by its content start', () => {
    props = { ...props, virtualization: true };
    render();
    viewport();
    flushUi();
    expect(translation('b')).toBe(48);
    expect(flattenStyle(mockCells.get('b')!.style).top).toBe(-48);
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'a',
      to: { kind: 'list', zoneId: 'source', index: 2 },
    });
    if (result.status !== 'ok') throw new Error('Expected reorder');
    // Candidate geometry reaches the UI runtime first: content moves by its
    // animated start while the native slots are still in committed order.
    publishDisplay(result.value);
    flushUi();
    expect(translation('b')).toBe(0);
    expect(translation('c')).toBe(48);
    expect(flattenStyle(mockCells.get('b')!.style).top).toBe(-48);
    expect(flattenStyle(mockCells.get('c')!.style).top).toBe(-96);
    // The preview itself commits nothing: a same-list candidate keeps the
    // FlatList data and its native slots in committed order.
    const data = output.props.data;
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'a',
      displayValue: result.value,
      candidate: result.value,
    };
    render();
    expect(output.props.data).toBe(data);
    expect(flattenStyle(mockCells.get('b')!.style).top).toBe(-48);
    // The drop commits the reordered slots. The slot offset changes in the
    // same commit as the slot position, so the content start alone decides
    // where a card is drawn; no measured slot correction can lag behind it.
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'idle',
      itemId: null,
    };
    setValue(result.value as LayoutState<{ label: string }>);
    render();
    expect(output.props.data).toEqual(['b', 'c', 'a']);
    expect(flattenStyle(mockCells.get('b')!.style).top).toBe(0);
    expect(flattenStyle(mockCells.get('c')!.style).top).toBe(-48);
    expect(flattenStyle(mockCells.get('a')!.style).top).toBe(-96);
    expect([0, 1, 2].map(index => itemLayout(index).offset)).toEqual([
      0, 48, 96,
    ]);
    flushUi();
    expect(translation('b')).toBe(0);
    expect(translation('c')).toBe(48);
    expect(translation('a')).toBe(96);
  });

  it('keeps content coordinates independent of the native scroll offset', () => {
    props = { ...props, virtualization: true };
    render();
    viewport();
    flushUi();
    output.props.onScroll?.({ contentOffset: { x: 0, y: 20 } });
    flushUi();
    expect(registration().offset.get()).toBe(20);
    expect(translation('b')).toBe(48);
    expect(flattenStyle(mockCells.get('b')!.style).top).toBe(-48);
  });

  it('mounts new cells at their flow starts without shared-value writes or UI tasks', () => {
    virtualize();
    flushMicrotasks();
    mockScheduledUiCount = 0;
    mockSharedWrites.length = 0;
    mockVisibleRange = { first: 28, last: 32 };
    render();
    flushMicrotasks();
    expect(mockScheduledUiCount).toBe(0);
    expect(mockCells.has('item:30')).toBe(true);
    for (const [itemId, shared] of mockExpectedStarts) {
      if (!mockCells.has(itemId)) continue;
      expect(mockSharedWrites.filter(write => write.shared === shared)).toEqual(
        [],
      );
      expect(shared.get()).toBe(
        itemLayout(output.props.data!.indexOf(itemId)).offset,
      );
    }
  });

  it('batches changed flow starts into one UI task and writes each once on the UI runtime', () => {
    virtualize();
    mockVisibleRange = { first: 28, last: 32 };
    render();
    flushMicrotasks();
    const before = mockExpectedStarts.get('item:1')!;
    mockScheduledUiCount = 0;
    mockSharedWrites.length = 0;
    measure('item:0', 200, 65);
    measure('item:1', 200, 85);
    measure('item:0', 200, 80);
    expect(before.get()).toBe(48);
    expect(mockScheduledUiCount).toBe(0);
    expect(mockMicrotasks).toHaveLength(1);
    flushMicrotasks();
    expect(mockScheduledUiCount).toBe(1);
    expect(before.get()).toBe(88);
    for (const [itemId, shared] of mockExpectedStarts) {
      if (!mockCells.has(itemId)) continue;
      expect(shared.get()).toBe(
        itemLayout(output.props.data!.indexOf(itemId)).offset,
      );
      const writes = mockSharedWrites.filter(write => write.shared === shared);
      expect(writes.every(write => write.onUi)).toBe(true);
      expect(writes.length).toBeLessThanOrEqual(1);
    }
  });

  it('drops a pending flow start for a cell evicted before its UI task is sent', () => {
    virtualize();
    mockVisibleRange = { first: 28, last: 32 };
    render();
    flushMicrotasks();
    const evicted = mockExpectedStarts.get('item:31')!;
    measure('item:30', 200, 90);
    expect(mockMicrotasks).toHaveLength(1);
    mockVisibleRange = { first: 100, last: 105 };
    render();
    flushMicrotasks();
    expect(mockCells.has('item:31')).toBe(false);
    expect(evicted.get()).toBe(31 * 48);
    expect(registration().layout.entries[30].size).toBe(90);
  });

  it.each([
    ['replaced', 'replace'],
    ['unmounted', 'unmount'],
  ] as const)(
    'drops flow starts still pending when the native viewport is %s',
    (_, action) => {
      virtualize();
      flushMicrotasks();
      const old = mockExpectedStarts.get('item:1')!;
      measure('item:0', 200, 90);
      expect(mockMicrotasks).toHaveLength(1);
      mockScheduledUiCount = 0;
      if (action === 'replace') {
        props = { ...props, zoneId: 'target' };
        render();
      } else unmount();
      flushMicrotasks();
      expect(mockScheduledUiCount).toBe(0);
      expect(old.get()).toBe(48);
    },
  );

  it('keeps flow starts current across re-renders of retained cells', () => {
    virtualize();
    measure('item:0', 200, 80);
    flushMicrotasks();
    const shared = mockExpectedStarts.get('item:1')!;
    expect(shared.get()).toBe(88);
    mockRuntime.animation = { ...mockRuntime.animation, durationMs: 250 };
    measure('item:0', 200, 40);
    flushMicrotasks();
    expect(shared.get()).toBe(48);
    expect(itemLayout(1).offset).toBe(48);
  });

  it('reads a new expected flow start without replacing its geometry worklet', () => {
    virtualize();
    flushUi();
    const shared = mockExpectedStarts.get('item:1')!;
    const mappers = mockNextMapperId;
    expect(translation('item:1')).toBe(48);
    // This is the UI write performed by the flow-start batch. Existing cell
    // mappers must observe it even before another React render.
    shared.set(88);
    flushUi();
    expect(translation('item:1')).toBe(88);
    shared.set(48);
    flushUi();
    expect(translation('item:1')).toBe(48);
    expect(mockNextMapperId).toBe(mappers);
  });

  it('uses native layout events as new distant cells enter the render window', () => {
    virtualize();
    mockVisibleRange = { first: 28, last: 32 };
    render();
    mockVisibleRange = { first: 148, last: 152 };
    render();
    expect(mockMeasurements).toHaveLength(0);
    measure('item:150', 200, 90);
    expect(registration().layout.entries[150]).toMatchObject({
      size: 90,
      source: 'measured',
    });
    expect(mockMeasurements).toHaveLength(0);
  });

  it('uses a bounded native render window while retaining logical geometry for all items', () => {
    virtualize();
    expect(output.type).toBe('Animated.FlatList');
    expect(output.props.data).toHaveLength(200);
    expect(mockCells.size).toBe(2);
    expect(registration().layout.entries).toHaveLength(200);
    expect(registration().layout.entries[150]).toMatchObject({
      itemId: 'item:150',
      start: 7200,
      size: 40,
      source: 'estimated',
    });
    expect(output.props.initialNumToRender).toBe(2);
    expect(output.props.maxToRenderPerBatch).toBe(4);
    expect(output.props.windowSize).toBe(3);
    expect(output.props.updateCellsBatchingPeriod).toBe(12);
    expect(output.props.keyExtractor?.(output.props.data![150], 150)).toBe(
      'item:150',
    );
  });

  it('keeps spacer metrics consistent with one padding path and a single gap per nonfinal slot', () => {
    props = { ...props, paddingStart: 12, paddingEnd: 17 };
    virtualize();
    expect(itemLayout(0)).toEqual({ index: 0, offset: 12, length: 48 });
    expect(itemLayout(150)).toEqual({ index: 150, offset: 7212, length: 48 });
    expect(itemLayout(199)).toEqual({ index: 199, offset: 9564, length: 40 });
    expect(itemLayout(199).offset + itemLayout(199).length + 17).toBe(
      registration().contentSize,
    );
    expect(registration().contentSize).toBe(9621);
    expect(mockSlots.get('item:0')!.style).toEqual(
      expect.objectContaining({ height: 48 }),
    );
    expect(mockCells.get('item:0')!.style).toEqual(
      expect.arrayContaining([{ width: 200, top: -12 }]),
    );
    expect(mockCells.get('item:0')!.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transform: [{ translateX: 0 }, { translateY: 12 }],
        }),
      ]),
    );
  });

  it('replaces estimates with ID measurements as distant cells enter the viewport and retains their sizes after eviction', () => {
    virtualize();
    measure('item:0', 200, 65);
    expect(itemLayout(150).offset).toBe(7225);
    mockVisibleRange = { first: 148, last: 152 };
    render();
    expect(mockCells.size).toBe(7);
    measure('item:150', 200, 90);
    expect(registration().layout.entries[150]).toMatchObject({
      size: 90,
      source: 'measured',
    });
    expect(itemLayout(151).offset).toBe(7323);
    mockVisibleRange = { first: 175, last: 179 };
    render();
    expect(mockCells.has('item:150')).toBe(false);
    expect(registration().layout.entries[150]).toMatchObject({
      size: 90,
      source: 'measured',
    });
    expect(itemLayout(151).offset).toBe(7323);
  });

  it('allows a non-pinned active source cell to unmount without losing the registered list or drag snapshot', () => {
    virtualize();
    mockVisibleRange = { first: 28, last: 32 };
    render();
    viewport(201, 300);
    measure('item:30', 200, 85);
    const pendingLayout = mockCells.get('item:30')!.onLayout!;
    const pending = mockMeasurements
      .filter(entry => entry.itemId === 'item:30')
      .at(-1)!;
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'item:30',
      sourceZoneId: 'source',
    };
    mockRuntime.motion.set({
      ...EMPTY_DND_MOTION,
      phase: 'dragging',
      itemId: 'item:30',
      visible: true,
    });
    render();
    const unregisters = unregisterZone.mock.calls.length;
    mockVisibleRange = { first: 100, last: 105 };
    render();
    expect(mockCells.has('item:30')).toBe(false);
    expect(mockRuntime.snapshot.phase).toBe('dragging');
    expect(mockRuntime.motion.get()).toMatchObject({
      phase: 'dragging',
      itemId: 'item:30',
      visible: true,
    });
    expect(unregisterZone).toHaveBeenCalledTimes(unregisters);
    pendingLayout(event(200, 999));
    pending.callback(0, 0, 200, 999);
    render();
    expect(registration().layout.entries[30].size).toBe(85);
    output.props.onScroll?.({ contentOffset: { x: 0, y: 4800 } });
    expect(registration().offset.get()).toBe(4800);
  });

  it('keeps FlatList slots in committed order through a covered same-list preview and moves cells through presentation', () => {
    virtualize();
    mockVisibleRange = { first: 0, last: 3 };
    render();
    measure('item:1', 200, 75);
    const data = output.props.data;
    const getItemLayout = output.props.getItemLayout;
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'item:1',
      to: { kind: 'list', zoneId: 'source', index: 150 },
    });
    if (result.status !== 'ok') throw new Error('Expected reorder');
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'item:1',
      displayValue: result.value,
      candidate: result.value,
    };
    mockFlatCellRenders = 0;
    render();
    publishDisplay(result.value);
    flushUi();
    // The dragged slot (75 + 8) fits inside the 300 pt overscan of windowSize 3
    // at a 300 pt viewport, so nothing about the FlatList changes.
    expect(output.props.data).toBe(data);
    expect(output.props.getItemLayout).toBe(getItemLayout);
    expect(mockFlatCellRenders).toBe(0);
    expect(output.props.data![1]).toBe('item:1');
    expect(output.props.data![150]).toBe('item:150');
    expect(itemLayout(150)).toEqual({ index: 150, offset: 7235, length: 48 });
    expect(registration().layout.entries[1]).toMatchObject({
      itemId: 'item:1',
      size: 75,
    });
    // Candidate geometry reaches the UI runtime; cells between the source and
    // the target move up by the dragged slot while their slots stay put.
    expect(
      presentationRect(mockRuntime.presentation!.get(), 'source', 'item:1'),
    ).toMatchObject({ y: 7200, height: 75 });
    expect(translation('item:1')).toBe(7200);
    expect(translation('item:2')).toBe(48);
    expect(flattenStyle(mockCells.get('item:2')!.style).top).toBe(-131);
    expect(translation('item:3')).toBe(96);
    expect(mockCells.has('item:1')).toBe(true);
  });

  it('falls back to candidate-order slots for a preview the render window cannot cover', () => {
    virtualize();
    // A 400 pt item plus its gap exceeds the 300 pt overscan of windowSize 3.
    measure('item:1', 200, 400);
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'item:1',
      to: { kind: 'list', zoneId: 'source', index: 150 },
    });
    if (result.status !== 'ok') throw new Error('Expected reorder');
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'item:1',
      displayValue: result.value,
      candidate: result.value,
    };
    mockVisibleRange = { first: 148, last: 152 };
    render();
    publishDisplay(result.value);
    flushUi();
    expect(output.props.data![1]).toBe('item:2');
    expect(output.props.data![150]).toBe('item:1');
    expect(itemLayout(150)).toEqual({ index: 150, offset: 7200, length: 408 });
    expect(registration().layout.entries[1]).toMatchObject({
      itemId: 'item:1',
      size: 400,
    });
    expect(registration().layout.entries[150].itemId).toBe('item:150');
    expect(
      presentationRect(mockRuntime.presentation!.get(), 'source', 'item:1'),
    ).toMatchObject({ y: 7200, height: 400 });
    expect(mockCells.has('item:1')).toBe(true);
  });

  it('rerenders only the cells whose public arguments change when a same-list candidate changes', () => {
    props = { ...props, virtualization: true };
    render();
    viewport();
    const data = output.props.data;
    const getItemLayout = output.props.getItemLayout;
    const renderItem = props.renderItem as jest.Mock;
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'a',
      to: { kind: 'list', zoneId: 'source', index: 1 },
    });
    if (result.status !== 'ok') throw new Error('Expected reorder');
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'a',
      displayValue: result.value,
      candidate: result.value,
    };
    renderItem.mockClear();
    mockFlatCellRenders = 0;
    render();
    expect(output.props.data).toBe(data);
    expect(output.props.getItemLayout).toBe(getItemLayout);
    expect(mockFlatCellRenders).toBe(0);
    expect(
      renderItem.mock.calls.map(([args]) => `${args.item.id}:${args.index}`),
    ).toEqual(['a:1', 'b:0']);
    publishDisplay(result.value);
    flushUi();
    expect(translation('a')).toBe(48);
    expect(translation('b')).toBe(0);
    expect(translation('c')).toBe(96);
    expect(flattenStyle(mockCells.get('a')!.style).top).toBe(0);
    expect(flattenStyle(mockCells.get('b')!.style).top).toBe(-48);
  });

  it('lets the source slot leave the window during a same-list preview and mounts the item at its committed slot on drop', () => {
    virtualize();
    mockVisibleRange = { first: 28, last: 32 };
    render();
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'item:30',
      to: { kind: 'list', zoneId: 'source', index: 102 },
    });
    if (result.status !== 'ok') throw new Error('Expected reorder');
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'item:30',
      sourceZoneId: 'source',
      displayValue: result.value,
      candidate: result.value,
    };
    render();
    expect(output.props.data![30]).toBe('item:30');
    expect(mockCells.has('item:30')).toBe(true);
    // Auto-scroll carries the window away from the committed slot.
    mockVisibleRange = { first: 100, last: 105 };
    render();
    expect(mockCells.has('item:30')).toBe(false);
    expect(mockRuntime.snapshot.phase).toBe('dragging');
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'idle',
      itemId: null,
    };
    setValue(result.value as LayoutState<{ label: string }>);
    render();
    expect(output.props.data![102]).toBe('item:30');
    expect(mockCells.has('item:30')).toBe(true);
    expect(flattenStyle(mockCells.get('item:30')!.style).top).toBe(-4896);
  });

  it('keeps FlatList ID data stable while measurements update current metrics and native slots', () => {
    props = { ...props, virtualization: true };
    render();
    viewport();
    const before = output.props.data!;
    const beforeRender = output.props.renderItem;
    const beforeLayout = output.props.getItemLayout;
    mockFlatCellRenders = 0;
    (props.renderItem as jest.Mock).mockClear();
    measure('b', 200, 80);
    const after = output.props.data!;
    expect(after).toBe(before);
    expect(after).toEqual(['a', 'b', 'c']);
    expect(output.props.renderItem).toBe(beforeRender);
    expect(output.props.getItemLayout).not.toBe(beforeLayout);
    expect(mockFlatCellRenders).toBe(0);
    expect(itemLayout(1)).toEqual({ index: 1, offset: 48, length: 88 });
    expect(itemLayout(2)).toEqual({ index: 2, offset: 136, length: 40 });
    expect(flattenStyle(mockSlots.get('b')!.style).height).toBe(88);
    expect(flattenStyle(mockSlots.get('c')!.style).height).toBe(40);
    expect(registration().layout.entries[1].size).toBe(80);
    expect(registration().layout.entries[2].start).toBe(136);
    flushUi();
    expect(translation('c')).toBe(136);
    expect(flattenStyle(mockCells.get('c')!.style).top).toBe(-136);
    expect(props.renderItem).not.toHaveBeenCalled();
  });

  it('keeps the installed RN renderer stable when current item metrics change', () => {
    const NativeFlatList = jest.requireActual<{
      default: new (flatProps: HostProps) => {
        props: HostProps;
        render(): ReactElement<HostProps>;
      };
    }>('react-native/Libraries/Lists/FlatList').default;
    props = { ...props, virtualization: true };
    render();
    viewport();
    const nativeList = new NativeFlatList(output.props);
    const before = nativeList.render().props;
    expect(output.props.strictMode).toBe(true);
    measure('b', 200, 80);
    nativeList.props = output.props;
    const after = nativeList.render().props;
    expect(after.getItemLayout).not.toBe(before.getItemLayout);
    expect(after.renderItem).toBe(before.renderItem);
    expect(after.getItemLayout?.(after.data, 2)).toEqual({
      index: 2,
      offset: 136,
      length: 40,
    });
  });

  it('updates public dragging and renderer arguments through the context of retained native cells', () => {
    props = { ...props, virtualization: true };
    render();
    viewport();
    const beforeRender = output.props.renderItem;
    const renderItem = props.renderItem as jest.Mock;
    renderItem.mockClear();
    mockFlatCellRenders = 0;
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'b',
      sourceZoneId: 'source',
    };
    render();
    expect(output.props.renderItem).toBe(beforeRender);
    expect(mockFlatCellRenders).toBe(0);
    expect(renderItem).toHaveBeenCalledTimes(1);
    expect(renderItem).toHaveBeenLastCalledWith({
      item: { id: 'b', data: { label: 'b' } },
      index: 1,
      zoneId: 'source',
      isDragging: true,
    });
    const nextRenderer = jest.fn(() => null);
    props = { ...props, renderItem: nextRenderer };
    render();
    expect(output.props.renderItem).toBe(beforeRender);
    expect(mockFlatCellRenders).toBe(0);
    expect(nextRenderer).toHaveBeenCalledTimes(3);
    expect(nextRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, isDragging: true }),
    );
  });

  it('removes a transferred source from virtual data while its session remains owned by the provider', () => {
    virtualize();
    mockVisibleRange = { first: 28, last: 32 };
    render();
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'item:30',
      to: { kind: 'list', zoneId: 'target', index: 0 },
    });
    if (result.status !== 'ok') throw new Error('Expected transfer');
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      phase: 'dragging',
      itemId: 'item:30',
      sourceZoneId: 'source',
      targetZoneId: 'target',
      displayValue: result.value,
      candidate: result.value,
    };
    render();
    expect(output.props.data).toHaveLength(199);
    expect(output.props.data).not.toContain('item:30');
    expect(mockCells.has('item:30')).toBe(false);
    expect(registration().layout.entries).toHaveLength(200);
    expect(mockRuntime.snapshot.phase).toBe('dragging');
  });

  it('keeps measured sizes by ID when an accepted reorder changes virtual indices', () => {
    virtualize();
    measure('item:1', 200, 75);
    const result = computeLayoutMove({
      value: mockRuntime.snapshot.value!,
      itemId: 'item:1',
      to: { kind: 'list', zoneId: 'source', index: 150 },
    });
    if (result.status !== 'ok') throw new Error('Expected reorder');
    setValue(result.value as LayoutState<{ label: string }>);
    render();
    expect(output.props.data![150]).toBe('item:1');
    expect(registration().layout.entries[150]).toMatchObject({
      itemId: 'item:1',
      size: 75,
      source: 'measured',
    });
    expect(itemLayout(150).length).toBe(83);
    expect(registration().revision).toBe(9);
  });

  it('invalidates unseen measured sizes on cross-size or data changes and rejects old callbacks', () => {
    virtualize();
    mockVisibleRange = { first: 28, last: 32 };
    render();
    viewport(201, 300);
    measure('item:30', 200, 90);
    const old = mockMeasurements
      .filter(entry => entry.itemId === 'item:30')
      .at(-1)!;
    mockVisibleRange = { first: 60, last: 65 };
    render();
    viewport(300, 300);
    old.callback(0, 0, 200, 999);
    render();
    expect(registration().layout.entries[30]).toMatchObject({
      size: 40,
      source: 'estimated',
    });
    measure('item:60', 300, 90);
    const value = mockRuntime.snapshot.value!;
    setValue({
      ...value,
      revision: 9,
      items: value.items.map(item => ({ ...item, data: { label: 'new' } })),
    });
    render();
    expect(registration().layout.entries[60]).toMatchObject({
      size: 40,
      source: 'estimated',
    });
  });

  it('supports horizontal virtual slots, natural width measurement and scroll offsets', () => {
    const value = longState();
    value.zones[0] = {
      ...value.zones[0],
      orientation: 'horizontal',
    } as ListLayoutZone;
    virtualize(value);
    viewport(400, 75);
    measure('item:0', 90, 75);
    expect(output.props.horizontal).toBe(true);
    expect(registration().layout.entries[0].rect).toEqual({
      x: 0,
      y: 0,
      width: 90,
      height: 75,
    });
    expect(flattenStyle(mockSlots.get('item:0')!.style)).toMatchObject({
      width: 98,
      flexDirection: 'row',
    });
    expect(itemLayout(1).offset).toBe(98);
    output.props.onScroll?.({ contentOffset: { x: 130, y: 0 } });
    expect(registration().offset.get()).toBe(130);
  });

  it('represents an empty virtual target with padding and no invalid metrics requests', () => {
    const value = longState();
    props = { ...props, zoneId: 'target', paddingStart: 12, paddingEnd: 7 };
    virtualize(value);
    expect(output.props.data).toEqual([]);
    expect(mockCells.size).toBe(0);
    expect(registration().contentSize).toBe(19);
  });

  it('applies authoritative virtual item sizes to both native slots and measured children', () => {
    props = { ...props, itemSize: 65 };
    virtualize();
    expect(itemLayout(0)).toEqual({ index: 0, length: 73, offset: 0 });
    expect(mockSlots.get('item:0')!.style).toEqual({ width: 200, height: 73 });
    expect(mockCells.get('item:0')!.style).toEqual(
      expect.arrayContaining([{ width: 200, top: 0, height: 65 }]),
    );
    measure('item:0', 200, 120);
    expect(itemLayout(0).length).toBe(73);
    expect(itemLayout(1).offset).toBe(73);
  });

  it('resets the native axis offset and measurements when the virtual orientation changes', () => {
    virtualize();
    measure('item:0', 200, 80);
    output.props.onScroll?.({ contentOffset: { x: 0, y: 450 } });
    expect(registration().offset.get()).toBe(450);
    const value = mockRuntime.snapshot.value!;
    setValue({
      ...value,
      revision: 9,
      zones: value.zones.map(zone =>
        zone.id === 'source'
          ? ({ ...zone, orientation: 'horizontal' } as ListLayoutZone)
          : zone,
      ),
    } as LayoutState<{ label: string }>);
    render();
    expect(output.props.horizontal).toBe(true);
    expect(registration().offset.get()).toBe(0);
    expect(registration().layout.entries[0]).toMatchObject({
      size: 40,
      source: 'estimated',
      rect: { x: 0, y: 0, width: 40, height: 300 },
    });
  });

  it('resets the viewport offset when switching between the two native adapters', () => {
    viewport();
    output.props.onScroll?.({ contentOffset: { x: 0, y: 70 } });
    expect(registration().offset.get()).toBe(70);
    props = { ...props, virtualization: true };
    render();
    expect(output.type).toBe('Animated.FlatList');
    expect(registration().offset.get()).toBe(0);
    output.props.onScroll?.({ contentOffset: { x: 0, y: 55 } });
    props = { ...props, virtualization: false };
    render();
    expect(output.type).toBe('Animated.ScrollView');
    expect(registration().offset.get()).toBe(0);
  });
});
