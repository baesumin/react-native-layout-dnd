import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { SortableGrid } from '../../src/components/SortableGrid';
import {
  type DndPresentation,
  zonePresentationFromRects,
} from '../../src/runtime/dndPresentation';
import { DndRenderStore } from '../../src/runtime/dndRenderStore';
import {
  DndItemContext,
  EMPTY_DND_MOTION,
  type DndRuntime,
  type GridRegistration,
  type ZoneRegistration,
} from '../../src/runtime/dndRuntime';
import type {
  GridItemRenderArgs,
  SortableGridProps,
} from '../../src/components/dndTypes';
import type { ZoneGeometry } from '../../src/components/gridTypes';
import type { LayoutState } from '../../src/contracts';
import { computeLayoutMove } from '../../src/engine/layoutMove';

type Hook = {
  value?: unknown;
  dependencies?: readonly unknown[];
  cleanup?: () => void;
  set?: (value: unknown) => void;
};
type Effect = () => void | (() => void);
type Frame = {
  hooks: Hook[];
  runtime?: DndRuntime;
  dirty?: boolean;
  effects: Array<{
    hook: Hook;
    effect: Effect;
    dependencies?: readonly unknown[];
  }>;
};
type HostProps = {
  children?: ReactNode;
  style?: unknown;
  pointerEvents?: string;
  onLayout?(event: LayoutChangeEvent): void;
  testID?: string;
  value?: { itemId: string };
};

// Invoke real adapter components with per-cell hooks. Layout cleanup runs before
// creates, matching React commits. This does not emulate Yoga or native motion.
const mockFrames = new Map<string, Frame>();
const mockMemoCells = new Map<
  string,
  { props: Record<string, unknown>; output: ReactNode }
>();
const mockCells = new Map<string, HostProps>();
const mockIndicators: HostProps[] = [];
let mockFrame: Frame;
let mockCursor = 0;
let mockDirty = false;
let mockRuntime: DndRuntime;
let mockPixelRatio = 2;
let mockReadingStyle: Set<unknown> | null = null;
const mockStyleSubscriptions: Array<{ frame: Frame; reads: Set<unknown> }> = [];
const mockCellTiming = jest.fn((value: number) => value);

function mockShared<T>(initial: T) {
  let value = initial;
  const result = {
    get: () => {
      mockReadingStyle?.add(result);
      return value;
    },
    set: (next: T) => {
      value = next;
    },
  };
  return result;
}

function mockState<T>(initial: T | (() => T)) {
  const frame = mockFrame;
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
        frame.dirty = true;
      }
    };
    mockFrame.hooks[index] = hook;
  }
  const hook = mockFrame.hooks[index];
  return [
    hook.value as T,
    hook.set as (next: T | ((previous: T) => T)) => void,
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

function mockEffect(effect: Effect, dependencies?: readonly unknown[]) {
  const index = mockCursor++;
  const hook = mockFrame.hooks[index] ?? (mockFrame.hooks[index] = {});
  if (
    !dependencies ||
    !hook.dependencies ||
    dependencies.some((value, i) => !Object.is(value, hook.dependencies?.[i]))
  ) {
    mockFrame.effects.push({ hook, effect, dependencies });
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
  useMemo: mockMemo,
  useSyncExternalStore: (
    subscribe: (callback: () => void) => () => void,
    getSnapshot: () => unknown,
  ) => {
    const frame = mockFrame;
    const selected = mockState(() => ({
      value: getSnapshot(),
      getSnapshot,
    }))[0];
    selected.getSnapshot = getSnapshot;
    selected.value = getSnapshot();
    mockEffect(() => {
      const check = () => {
        const next = selected.getSnapshot();
        if (Object.is(selected.value, next)) return;
        selected.value = next;
        frame.dirty = true;
        mockDirty = true;
      };
      const unsubscribe = subscribe(check);
      check();
      return unsubscribe;
    }, [subscribe]);
    return selected.value;
  },
  useLayoutEffect: mockEffect,
}));
jest.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  PixelRatio: { get: () => mockPixelRatio },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'Animated.View' },
  useAnimatedRef: () => mockState({ current: null })[0],
  useAnimatedStyle: (get: () => unknown) => {
    const reads = new Set<unknown>();
    mockReadingStyle = reads;
    const result = get();
    mockReadingStyle = null;
    mockStyleSubscriptions.push({ frame: mockFrame, reads });
    return new Proxy(result as Record<string, unknown>, {
      get: (_target, key) => (get() as Record<string | symbol, unknown>)[key],
    });
  },
  useDerivedValue: (get: () => unknown) => {
    const selector = mockState({ read: get })[0];
    selector.read = get;
    const value = mockState(() => ({
      get: () => {
        mockReadingStyle?.add(value);
        const reads = mockReadingStyle;
        mockReadingStyle = null;
        try {
          return selector.read();
        } finally {
          mockReadingStyle = reads;
        }
      },
    }))[0];
    return value;
  },
  withTiming: (value: number) => mockCellTiming(value),
}));
jest.mock('../../src/runtime/dndRuntime', () => ({
  ...jest.requireActual('../../src/runtime/dndRuntime'),
  useDndRuntime: () => {
    mockFrame.runtime = mockRuntime;
    return mockRuntime;
  },
}));

const registrations = new Map<string, GridRegistration>();
const registerZone = jest.fn((entry: ZoneRegistration, _identity: object) => {
  if (entry.kind !== 'grid') throw new Error('Expected grid registration');
  registrations.set(entry.zoneId, entry);
});
const unregisterZone = jest.fn((zoneId: string, _identity: object) =>
  registrations.delete(zoneId),
);
const reportIssues = jest.fn();
const renderItem = jest.fn(
  (_args: GridItemRenderArgs<{ label: string }>) => null,
);
let props: SortableGridProps<{ label: string }>;
let output: ReactElement<HostProps>;

function initialValue(): LayoutState<{ label: string }> {
  return {
    revision: 4,
    items: ['small', 'large', 'list-item'].map(id => ({
      id,
      data: { label: id },
    })),
    zones: [
      {
        id: 'grid',
        kind: 'grid',
        rows: 3,
        columns: 4,
        placements: [
          {
            itemId: 'small',
            position: { row: 0, col: 0 },
            span: { rows: 1, cols: 1 },
            placement: 'insert',
          },
          {
            itemId: 'large',
            position: { row: 1, col: 1 },
            span: { rows: 2, cols: 2 },
            placement: 'exchange',
          },
        ],
      },
      {
        id: 'list',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['list-item'],
      },
    ],
  };
}

function geometry(): ZoneGeometry {
  return {
    mode: 'fixed',
    cellWidth: 40,
    cellHeight: 30,
    columnGap: 4,
    rowGap: 5,
    padding: { left: 10, right: 14, top: 6, bottom: 8 },
  };
}

function render() {
  let commits = 0;
  do {
    if (++commits > 15) throw new Error('Unexpected repeated state updates');
    mockDirty = false;
    mockCells.clear();
    mockIndicators.length = 0;
    const visited = new Set<string>();
    const order: Frame[] = [];
    const enter = (key: string) => {
      let frame = mockFrames.get(key);
      if (!frame) {
        frame = { hooks: [], effects: [] };
        mockFrames.set(key, frame);
      }
      visited.add(key);
      order.push(frame);
      mockFrame = frame;
      mockCursor = 0;
    };
    const children = (node: ReactNode, itemId?: string) => {
      Children.forEach(node, child => {
        if (!isValidElement<HostProps>(child)) return;
        const component = child.type as unknown as {
          $$typeof?: symbol;
          type?: (props: HostProps) => ReactNode;
        };
        if (component.$$typeof === Symbol.for('react.memo') && component.type) {
          const key = String(child.key ?? component.type.name);
          enter(key);
          const previous = mockMemoCells.get(key);
          const next = child.props as Record<string, unknown>;
          const same =
            previous &&
            !mockFrame.dirty &&
            (!mockFrame.runtime || mockFrame.runtime === mockRuntime) &&
            Object.keys(previous.props).length === Object.keys(next).length &&
            Object.keys(next).every(name =>
              Object.is(previous.props[name], next[name]),
            );
          mockFrame.dirty = false;
          const rendered = same ? previous.output : component.type(child.props);
          mockMemoCells.set(key, { props: next, output: rendered });
          children(rendered, itemId);
          return;
        }
        if (typeof child.type === 'function') {
          enter(String(child.key ?? child.type.name));
          mockFrame.dirty = false;
          children(
            (child.type as (value: HostProps) => ReactNode)(child.props),
            itemId,
          );
          return;
        }
        const scope =
          (child.type as unknown) === DndItemContext
            ? child.props.value?.itemId
            : itemId;
        if (scope && child.type === ('Animated.View' as unknown))
          mockCells.set(scope, child.props);
        if (child.props.pointerEvents === 'none')
          mockIndicators.push(child.props);
        children(child.props.children, scope);
      });
    };
    enter('root');
    mockFrame.dirty = false;
    output = SortableGrid(props);
    children(output);
    for (const [key, frame] of mockFrames) {
      if (!visited.has(key)) {
        frame.hooks.forEach(hook => hook.cleanup?.());
        mockFrames.delete(key);
        mockMemoCells.delete(key);
      }
    }
    const effects = [...order]
      .reverse()
      .flatMap(frame => frame.effects.splice(0));
    effects.forEach(({ hook }) => hook.cleanup?.());
    effects.forEach(({ hook, effect, dependencies }) => {
      hook.dependencies = dependencies;
      hook.cleanup = effect() || undefined;
    });
  } while (mockDirty);
}

function event(width: number, height: number): LayoutChangeEvent {
  return {
    nativeEvent: { layout: { width, height, x: 0, y: 0 } },
  } as LayoutChangeEvent;
}

function viewport(width = 200, height = 120) {
  output.props.onLayout?.(event(width, height));
  render();
}

function registration() {
  const registered = registrations.get(props.zoneId);
  if (!registered) throw new Error('Expected registered grid');
  return registered;
}

function flattenStyle(value: unknown): Record<string, unknown> {
  if (Array.isArray(value))
    return Object.assign({}, ...value.map(flattenStyle));
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function unmount() {
  for (const frame of mockFrames.values())
    frame.hooks.forEach(hook => hook.cleanup?.());
  mockFrames.clear();
  mockMemoCells.clear();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFrames.clear();
  mockMemoCells.clear();
  registrations.clear();
  mockPixelRatio = 2;
  mockStyleSubscriptions.length = 0;
  mockReadingStyle = null;
  const value = initialValue();
  mockRuntime = {
    snapshot: {
      value,
      displayValue: value,
      phase: 'idle',
      itemId: null,
      targetZoneId: null,
      validity: 'pending',
    },
    motion: mockShared(EMPTY_DND_MOTION),
    animation: { durationMs: 180, reduceMotion: 'system' },
    registerZone,
    unregisterZone,
    reportIssues,
  } as unknown as DndRuntime;
  props = { zoneId: 'grid', geometry: geometry(), renderItem };
  render();
});
afterEach(unmount);

it('registers only after measurement and cleans up its own registration identity', () => {
  expect(registrations.size).toBe(0);
  expect(renderItem).not.toHaveBeenCalled();
  expect(reportIssues).toHaveBeenLastCalledWith('grid:grid', []);
  viewport();
  expect(registration()).toMatchObject({
    kind: 'grid',
    zoneId: 'grid',
    revision: 4,
    cells: { cellWidth: 40, cellHeight: 30 },
    pixelRatio: 2,
  });
  const identity = registerZone.mock.calls.at(-1)![1];
  unmount();
  expect(unregisterZone).toHaveBeenLastCalledWith('grid', identity);
  expect(reportIssues).toHaveBeenLastCalledWith('grid:grid', []);
});

it('renders mixed spans with gaps, padding, caller data and public geometry arguments', () => {
  viewport();
  const args = renderItem.mock.calls.find(
    ([entry]) => entry.item.id === 'large',
  )![0];
  expect(args).toEqual({
    item: mockRuntime.snapshot.value!.items[1],
    index: 1,
    zoneId: 'grid',
    position: { row: 1, col: 1 },
    span: { rows: 2, cols: 2 },
    placement: 'exchange',
    width: 84,
    height: 65,
    isDragging: false,
  });
  expect(args.item).toBe(mockRuntime.snapshot.value!.items[1]);
  expect(flattenStyle(mockCells.get('large')!.style)).toMatchObject({
    position: 'absolute',
    width: 84,
    height: 65,
    transform: [{ translateX: 54 }, { translateY: 41 }],
  });
});

it('subscribes cell styles to derived visibility and geometry instead of pointer motion', () => {
  viewport();
  const cells = mockStyleSubscriptions.filter(
    entry => entry.frame !== mockFrames.get('root'),
  );
  expect(cells).toHaveLength(2);
  const hiddenItemIds = new Set<unknown>();
  for (const { reads: subscriptions } of cells) {
    expect(subscriptions.size).toBe(2);
    expect(subscriptions.has(mockRuntime.motion)).toBe(false);
    subscriptions.forEach(value => hiddenItemIds.add(value));
  }
  // One zone-wide visibility selector and one position selector per cell.
  expect(hiddenItemIds.size).toBe(3);
});

it('does not rerender unchanged grid content for pointer or unrelated session updates', () => {
  viewport();
  renderItem.mockClear();
  for (let seq = 1; seq <= 120; seq++) {
    mockRuntime.snapshot = {
      ...mockRuntime.snapshot,
      seq,
      targetZoneId: 'list',
    };
    render();
  }
  expect(renderItem).not.toHaveBeenCalled();
});

it('updates public cell position and index through item subscriptions while native slots stay stable', () => {
  const listeners = new Set<() => void>();
  const store = new DndRenderStore({
    getSnapshot: () => mockRuntime.snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  mockRuntime.renderStore = store;
  mockRuntime.presentation = mockShared<DndPresentation>({
    token: 1,
    revision: 4,
    zones: {},
  }) as never;
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    phase: 'dragging',
    itemId: 'small',
    targetZoneId: 'grid',
    validity: 'valid',
  };
  viewport();
  const nativeSlots = store.getZoneSnapshot('grid');
  const registered = registration();
  const moved = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'small',
    to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 3 } },
  });
  if (moved.status !== 'ok') throw new Error('Expected grid move');
  renderItem.mockClear();
  registerZone.mockClear();

  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: moved.value,
    candidate: moved.value,
  };
  listeners.forEach(listener => listener());
  expect(store.getZoneSnapshot('grid')).toBe(nativeSlots);
  expect(mockFrames.get('root')!.dirty).toBe(false);
  render();

  expect(renderItem).toHaveBeenCalledTimes(1);
  expect(renderItem).toHaveBeenLastCalledWith(
    expect.objectContaining({
      item: mockRuntime.snapshot.value!.items[0],
      position: { row: 0, col: 3 },
      isDragging: true,
    }),
  );
  expect(registration()).toBe(registered);
  expect(registerZone).not.toHaveBeenCalled();
  expect(flattenStyle(mockCells.get('small')!.style).transform).toEqual([
    { translateX: 10 },
    { translateY: 6 },
  ]);

  renderItem.mockClear();
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: {
      ...moved.value,
      zones: moved.value.zones.map(zone =>
        zone.kind === 'grid'
          ? {
              ...zone,
              placements: ['large', 'small'].map(id =>
                zone.placements.find(item => item.itemId === id)!,
              ),
            }
          : zone,
      ),
    },
  };
  listeners.forEach(listener => listener());
  expect(store.getZoneSnapshot('grid')).toBe(nativeSlots);
  expect(mockFrames.get('root')!.dirty).toBe(false);
  render();

  expect(renderItem).toHaveBeenCalledTimes(2);
  expect(
    renderItem.mock.calls.map(([item]) => [item.item.id, item.index]),
  ).toEqual([
    ['small', 1],
    ['large', 0],
  ]);
  expect(registerZone).not.toHaveBeenCalled();
});

it('rerenders only cells whose public arguments change when candidate objects are rebuilt', () => {
  viewport();
  const value = mockRuntime.snapshot.value!;
  const moved = computeLayoutMove({
    value,
    itemId: 'small',
    to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 3 } },
  });
  if (moved.status !== 'ok') throw new Error('Expected grid move');
  renderItem.mockClear();
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: moved.value,
    itemId: 'small',
  };
  render();
  expect(renderItem).toHaveBeenCalledTimes(1);
  expect(renderItem).toHaveBeenLastCalledWith(
    expect.objectContaining({
      item: value.items[0],
      position: { row: 0, col: 3 },
      isDragging: true,
    }),
  );
  renderItem.mockClear();
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: {
      ...moved.value,
      zones: moved.value.zones.map(zone =>
        zone.kind !== 'grid'
          ? zone
          : {
              ...zone,
              placements: zone.placements.map(placement => ({
                ...placement,
                position: { ...placement.position },
                span: { ...placement.span },
              })),
            },
      ),
    },
  };
  render();
  expect(renderItem).not.toHaveBeenCalled();
  // The consumer still sees a changed index/data/renderer on a real update.
  const nextValue = {
    ...value,
    items: value.items.map(item =>
      item.id === 'large' ? { ...item, data: { label: 'updated' } } : item,
    ),
  };
  mockRuntime.snapshot = { ...mockRuntime.snapshot, value: nextValue };
  render();
  expect(renderItem).toHaveBeenCalledTimes(1);
  expect(renderItem).toHaveBeenLastCalledWith(
    expect.objectContaining({ item: nextValue.items[1], index: 1 }),
  );
  const nextRenderer = jest.fn(() => null);
  props = { ...props, renderItem: nextRenderer };
  render();
  expect(nextRenderer).toHaveBeenCalledTimes(2);
});

it('reuses card subtrees on revision-only commits and refreshes public dimensions', () => {
  const renderer = jest.fn((args: GridItemRenderArgs<{ label: string }>) => (
    <>{`${args.item.id}:${args.width}`}</>
  ));
  props = { ...props, renderItem: renderer };
  render();
  viewport();
  const children = new Map(
    [...mockCells].map(([id, cell]) => [id, cell.children]),
  );
  renderer.mockClear();
  const value = { ...mockRuntime.snapshot.value!, revision: 5 };
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    value,
    displayValue: value,
  };
  render();
  expect(registration().revision).toBe(5);
  expect(renderer).not.toHaveBeenCalled();
  for (const [id, content] of children)
    expect(mockCells.get(id)!.children).toBe(content);
  props = {
    ...props,
    geometry: { ...geometry(), mode: 'fixed', cellWidth: 36, cellHeight: 30 },
  };
  render();
  expect(renderer).toHaveBeenCalledTimes(2);
  expect(renderer).toHaveBeenCalledWith(
    expect.objectContaining({
      item: expect.objectContaining({ id: 'small' }),
      width: 36,
    }),
  );
  expect(mockCells.get('small')!.children).not.toBe(children.get('small'));
});

it('applies validated UI presentation before React commits and ignores another revision', () => {
  const presentation = mockShared<DndPresentation>({
    token: 1,
    revision: 4,
    zones: {},
  });
  mockRuntime = { ...mockRuntime, presentation: presentation as never };
  viewport();
  renderItem.mockClear();
  presentation.set({
    token: 1,
    revision: 4,
    zones: {
      '#grid': zonePresentationFromRects({
        '#small': { x: 142, y: 6, width: 84, height: 65 },
      }),
    },
  });
  // No render() call: a policy-validated result changes native style directly.
  expect(flattenStyle(mockCells.get('small')!.style)).toMatchObject({
    width: 84,
    height: 65,
    transform: [{ translateX: 142 }, { translateY: 6 }],
  });
  expect(renderItem).not.toHaveBeenCalled();
  presentation.set({ ...presentation.get(), revision: 3 });
  expect(flattenStyle(mockCells.get('small')!.style)).toMatchObject({
    width: 40,
    height: 30,
    transform: [{ translateX: 10 }, { translateY: 6 }],
  });
});

it('gates native cell presentation with shared committed revision before React props change', () => {
  const committedRevision = mockShared(4);
  const candidate: DndPresentation = {
    token: 1,
    revision: 4,
    zones: {
      '#grid': zonePresentationFromRects({
        '#small': { x: 142, y: 6, width: 84, height: 65 },
      }),
    },
  };
  const presentation = mockShared(candidate);
  mockRuntime = {
    ...mockRuntime,
    presentation: presentation as never,
    committedRevision: committedRevision as never,
  };
  viewport();
  renderItem.mockClear();
  expect(flattenStyle(mockCells.get('small')!.style)).toMatchObject({
    width: 84,
    height: 65,
    transform: [{ translateX: 142 }, { translateY: 6 }],
  });
  committedRevision.set(5);
  expect(flattenStyle(mockCells.get('small')!.style)).toMatchObject({
    width: 40,
    height: 30,
    transform: [{ translateX: 10 }, { translateY: 6 }],
  });
  presentation.set({ ...candidate, revision: 5 });
  expect(flattenStyle(mockCells.get('small')!.style)).toMatchObject({
    width: 84,
    height: 65,
    transform: [{ translateX: 142 }, { translateY: 6 }],
  });
  presentation.set(candidate);
  expect(flattenStyle(mockCells.get('small')!.style)).toMatchObject({
    width: 40,
    height: 30,
    transform: [{ translateX: 10 }, { translateY: 6 }],
  });
  expect(mockRuntime.snapshot.value!.revision).toBe(4);
  expect(renderItem).not.toHaveBeenCalled();
});

it('fits cell dimensions to the measured viewport after subtracting padding and inter-cell gaps', () => {
  props = {
    ...props,
    geometry: {
      mode: 'fit',
      columnGap: 4,
      rowGap: 5,
      padding: { left: 10, right: 14, top: 6, bottom: 8 },
    },
  };
  render();
  viewport(224, 144);
  expect(registration().cells).toEqual({ cellWidth: 47, cellHeight: 40 });
  expect(flattenStyle(mockCells.get('large')!.style)).toMatchObject({
    width: 98,
    height: 85,
    transform: [{ translateX: 61 }, { translateY: 51 }],
  });
});

it('rejects clipped geometry and unregisters a previously usable viewport', () => {
  viewport();
  viewport(100, 120);
  expect(registrations.size).toBe(0);
  expect(mockCells.size).toBe(0);
  expect(reportIssues).toHaveBeenLastCalledWith('grid:grid', [
    expect.objectContaining({ code: 'invalid-geometry', zoneId: 'grid' }),
  ]);
  viewport();
  expect(registrations.size).toBe(1);
});

it.each([
  null,
  { ...geometry(), rowGap: -1 },
  { ...geometry(), cellWidth: NaN },
  { ...geometry(), padding: null },
])('rejects malformed geometry without registering %p', invalidGeometry => {
  props = { ...props, geometry: invalidGeometry as ZoneGeometry };
  render();
  viewport();
  expect(registrations.size).toBe(0);
  expect(reportIssues).toHaveBeenLastCalledWith('grid:grid', [
    expect.objectContaining({ code: 'invalid-geometry' }),
  ]);
});

it('rejects a missing zone or a list zone instead of interpreting it as a grid', () => {
  props = { ...props, zoneId: 'list' };
  render();
  viewport();
  expect(registrations.size).toBe(0);
  expect(reportIssues).toHaveBeenCalledWith('grid:list', [
    expect.objectContaining({ code: 'invalid-configuration' }),
  ]);
  props = { ...props, zoneId: 'missing' };
  render();
  expect(reportIssues).toHaveBeenCalledWith('grid:missing', [
    expect.objectContaining({ code: 'invalid-configuration' }),
  ]);
});

it('isolates registered geometry from in-place caller changes and refreshes it on the next render', () => {
  viewport();
  const original = registration();
  expect(original.geometry).not.toBe(props.geometry);
  expect(original.geometry.padding).not.toBe(props.geometry.padding);
  props.geometry.padding.left = 12;
  expect(original.geometry.padding.left).toBe(10);
  render();
  expect(registration().geometry.padding.left).toBe(12);
  expect(registration().geometry).not.toBe(original.geometry);
  expect(flattenStyle(mockCells.get('small')!.style).transform).toEqual([
    { translateX: 12 },
    { translateY: 6 },
  ]);
});

it('does not serialize unrelated caller geometry properties or invoke a serialization hook', () => {
  const config = geometry() as ZoneGeometry & {
    extra?: unknown;
    toJSON?(): unknown;
  };
  config.extra = config;
  config.toJSON = () => {
    throw new Error('Do not serialize caller extras');
  };
  props = { ...props, geometry: config };
  expect(() => {
    render();
    viewport();
  }).not.toThrow();
  expect(registration().geometry).not.toHaveProperty('extra');
  expect(registration().geometry).not.toHaveProperty('toJSON');
});

it('keeps committed grid targeting geometry while displaying the candidate positions', () => {
  viewport();
  const value = mockRuntime.snapshot.value!;
  const moved = computeLayoutMove({
    value,
    itemId: 'small',
    to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 3 } },
  });
  if (moved.status !== 'ok') throw new Error('Expected grid move');
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: moved.value,
    candidate: moved.value,
    phase: 'dragging',
    itemId: 'small',
    targetZoneId: 'grid',
    validity: 'valid',
  };
  render();
  expect(registration().layout.placements[0].position).toEqual({
    row: 0,
    col: 0,
  });
  expect(flattenStyle(mockCells.get('small')!.style).transform).toEqual([
    { translateX: 142 },
    { translateY: 6 },
  ]);
  expect(renderItem).toHaveBeenLastCalledWith(
    expect.objectContaining({ item: value.items[0], isDragging: true }),
  );
});

it('shows a configurable indicator at the resolved target and hides it for rejected targets', () => {
  viewport();
  const moved = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'small',
    to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 3 } },
  });
  if (moved.status !== 'ok') throw new Error('Expected grid move');
  props = {
    ...props,
    dropIndicatorStyle: { borderColor: 'orange', borderWidth: 3 },
  };
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: moved.value,
    phase: 'dragging',
    itemId: 'small',
    targetZoneId: 'grid',
    validity: 'valid',
  };
  render();
  expect(mockIndicators).toHaveLength(1);
  expect(flattenStyle(mockIndicators[0].style)).toMatchObject({
    left: 142,
    top: 6,
    width: 40,
    height: 30,
    borderColor: 'orange',
    borderWidth: 3,
  });
  mockRuntime.snapshot = { ...mockRuntime.snapshot, validity: 'invalid' };
  render();
  expect(mockIndicators).toHaveLength(0);
});

function approvedIndicator() {
  const presentation = mockShared<DndPresentation>({
    token: 1,
    revision: 4,
    releaseTarget: {
      target: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 3 } },
      policyRevision: 0,
    },
    zones: {
      '#grid': zonePresentationFromRects({
        '#small': { x: 142, y: 6, width: 40, height: 30 },
      }),
    },
  });
  mockRuntime = { ...mockRuntime, presentation: presentation as never };
  mockRuntime.motion.set({
    ...EMPTY_DND_MOTION,
    token: 1,
    revision: 4,
    phase: 'dragging',
    itemId: 'small',
    visible: true,
  });
  props = {
    ...props,
    dropIndicatorStyle: { borderColor: 'orange', borderWidth: 3 },
  };
  viewport();
  expect(mockIndicators).toHaveLength(1);
  const indicator = mockIndicators[0];
  expect(flattenStyle(indicator.style)).toMatchObject({
    opacity: 1,
    left: 142,
    top: 6,
    width: 40,
    height: 30,
    borderColor: 'orange',
    borderWidth: 3,
  });
  return { presentation, indicator };
}

it('moves its approved indicator through shared presentation without a React render', () => {
  const { presentation, indicator } = approvedIndicator();
  const committedOutput = output;
  const snapshot = mockRuntime.snapshot;
  renderItem.mockClear();
  registerZone.mockClear();

  presentation.set({
    ...presentation.get(),
    releaseTarget: {
      target: { kind: 'grid', zoneId: 'grid', position: { row: 1, col: 1 } },
      policyRevision: 0,
    },
    zones: {
      '#grid': zonePresentationFromRects({
        '#small': { x: 54, y: 41, width: 84, height: 65 },
      }),
    },
  });

  // No render() call: this is the already mounted animated indicator style.
  expect(flattenStyle(indicator.style)).toMatchObject({
    opacity: 1,
    left: 54,
    top: 41,
    width: 84,
    height: 65,
  });
  expect(output).toBe(committedOutput);
  expect(mockRuntime.snapshot).toBe(snapshot);
  expect(renderItem).not.toHaveBeenCalled();
  expect(registerZone).not.toHaveBeenCalled();
  const subscriptions = mockStyleSubscriptions
    .filter(entry => entry.frame === mockFrames.get('root'))
    .at(-1)!.reads;
  expect(subscriptions.has(mockRuntime.motion)).toBe(false);
});

it.each([
  'stale-revision',
  'stale-token',
  'invalid-target',
  'other-zone',
  'hidden-overlay',
] as const)(
  'hides its shared indicator immediately for %s without a React render',
  reason => {
    const { presentation, indicator } = approvedIndicator();
    renderItem.mockClear();
    const current = presentation.get();
    if (reason === 'hidden-overlay')
      mockRuntime.motion.set({ ...mockRuntime.motion.get(), visible: false });
    else
      presentation.set(
        reason === 'stale-revision'
          ? { ...current, revision: 3 }
          : reason === 'stale-token'
            ? { ...current, token: 0 }
            : reason === 'invalid-target'
              ? { ...current, releaseTarget: undefined }
              : {
                  ...current,
                  releaseTarget: {
                    target: { kind: 'list', zoneId: 'list', index: 0 },
                    policyRevision: 0,
                  },
                },
      );

    expect(flattenStyle(indicator.style)).toMatchObject({
      opacity: 0,
      width: 0,
      height: 0,
    });
    expect(renderItem).not.toHaveBeenCalled();
  },
);

it('hides the original only when the provider reveals its overlay', () => {
  viewport();
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    phase: 'dragging',
    itemId: 'large',
  };
  mockRuntime.motion.set({
    ...EMPTY_DND_MOTION,
    phase: 'dragging',
    itemId: 'large',
    visible: false,
  });
  render();
  expect(flattenStyle(mockCells.get('large')!.style).opacity).toBe(1);
  mockRuntime.motion.set({ ...mockRuntime.motion.get(), visible: true });
  render();
  mockCellTiming.mockClear();
  expect(flattenStyle(mockCells.get('large')!.style).opacity).toBe(0);
  expect(mockCellTiming).not.toHaveBeenCalled();
  expect(flattenStyle(mockCells.get('small')!.style).opacity).toBe(1);
});

it('allows a transferred source cell to unmount without unregistering the grid or ending the provider session', () => {
  viewport();
  const moved = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'large',
    to: { kind: 'list', zoneId: 'list', index: 1 },
  });
  if (moved.status !== 'ok') throw new Error('Expected transfer');
  const unregisters = unregisterZone.mock.calls.length;
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: moved.value,
    phase: 'dragging',
    itemId: 'large',
    sourceZoneId: 'grid',
    targetZoneId: 'list',
  };
  render();
  expect(mockCells.has('large')).toBe(false);
  expect(registration().layout.placements).toHaveLength(2);
  expect(unregisterZone).toHaveBeenCalledTimes(unregisters);
  expect(mockRuntime.snapshot.phase).toBe('dragging');
});

it('renders an incoming list item using its target span and exposes original grid rendering to the provider preview', () => {
  viewport();
  const registered = registration();
  const original = mockRuntime.snapshot.value!.items[1];
  registered.renderItem({
    item: original,
    index: 1,
    zoneId: 'grid',
    isDragging: true,
  });
  expect(renderItem).toHaveBeenLastCalledWith(
    expect.objectContaining({
      item: original,
      span: { rows: 2, cols: 2 },
      width: 84,
      height: 65,
      isDragging: true,
    }),
  );
  const moved = computeLayoutMove({
    value: mockRuntime.snapshot.value!,
    itemId: 'list-item',
    to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 1 } },
    gridItem: { span: { rows: 1, cols: 2 }, placement: 'exchange' },
  });
  if (moved.status !== 'ok') throw new Error('Expected incoming transfer');
  mockRuntime.snapshot = {
    ...mockRuntime.snapshot,
    displayValue: moved.value,
    phase: 'dragging',
    itemId: 'list-item',
  };
  render();
  expect(mockCells.has('list-item')).toBe(true);
  expect(renderItem).toHaveBeenLastCalledWith(
    expect.objectContaining({
      item: mockRuntime.snapshot.value!.items[2],
      position: { row: 0, col: 1 },
      span: { rows: 1, cols: 2 },
      width: 84,
      height: 30,
      isDragging: true,
    }),
  );
  expect(registration().layout.placements).toHaveLength(2);
});

it('forwards presentation props and layout events without re-registering unchanged geometry', () => {
  const onLayout = jest.fn();
  props = {
    ...props,
    onLayout,
    style: { backgroundColor: 'white' },
    testID: 'board',
    children: 'background content',
  };
  render();
  viewport();
  expect(output.props.testID).toBe('board');
  expect(flattenStyle(output.props.style)).toMatchObject({
    position: 'relative',
    backgroundColor: 'white',
  });
  expect(onLayout).toHaveBeenCalledWith(event(200, 120));
  const registrationsBefore = registerZone.mock.calls.length;
  viewport();
  expect(registerZone).toHaveBeenCalledTimes(registrationsBefore);
});

it('ignores queued native layout events after the adapter unmounts', () => {
  const onLayout = jest.fn();
  props = { ...props, onLayout };
  render();
  viewport();
  const late = output.props.onLayout!;
  unmount();
  mockDirty = false;
  onLayout.mockClear();
  late(event(240, 160));
  expect(mockDirty).toBe(false);
  expect(onLayout).not.toHaveBeenCalled();
  expect(registrations.size).toBe(0);
});
