import type { PanGestureConfig } from 'react-native-gesture-handler';
import type { AnimatedRef, SharedValue } from 'react-native-reanimated';
import type { HostInstance } from 'react-native';

import {
  createTargetChannel,
  DndGestureGroup,
  type DndGestureRuntime,
  type DndHandleTarget,
} from '../../src/gesture/DndGestureGroup';
import {
  EMPTY_DND_MOTION,
  type UiZoneRegistration,
} from '../../src/runtime/dndRuntime';

let mockConfig: PanGestureConfig;
const mockMeasure = jest.fn();
const mockFail = jest.fn();
const mockScheduleOnRN = jest.fn();
const mockSharedSets = jest.fn();
const mockHooks: Array<{ value: unknown; dependencies: readonly unknown[] }> =
  [];
let mockCursor = 0;
function mockMemo<T>(factory: () => T, dependencies: readonly unknown[]): T {
  const index = mockCursor++;
  const previous = mockHooks[index];
  if (
    !previous ||
    previous.dependencies.length !== dependencies.length ||
    dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))
  )
    mockHooks[index] = { value: factory(), dependencies };
  return mockHooks[index]!.value as T;
}
const mockShared = <T>(initial: T): SharedValue<T> => {
  let current = initial;
  return {
    get: () => current,
    set: (next: T) => {
      mockSharedSets(next);
      current = next;
    },
  } as SharedValue<T>;
};

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useMemo: mockMemo,
  useRef: (initial: unknown) => mockMemo(() => ({ current: initial }), []),
  // Layout effects run synchronously after each render in this unit test and
  // clean up the previous run of the same hook slot first.
  useLayoutEffect: (effect: () => void | (() => void)) => {
    const index = mockCursor++;
    const previous = mockHooks[index];
    if (previous && typeof previous.value === 'function')
      (previous.value as () => void)();
    mockHooks[index] = { value: effect() ?? null, dependencies: [] };
  },
}));
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: unknown) => mockMemo(() => mockShared(initial), []),
  measure: (ref: unknown) => mockMeasure(ref),
}));
jest.mock('react-native-gesture-handler', () => ({
  usePanGesture: (config: PanGestureConfig) => {
    mockConfig = config;
    return { handlerTag: 1, config };
  },
  GestureStateManager: { fail: (...args: unknown[]) => mockFail(...args) },
}));
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (...args: unknown[]) => mockScheduleOnRN(...args),
}));

const ref = () => ({}) as AnimatedRef<HostInstance>;
let targets: DndHandleTarget[];
let channel: ReturnType<typeof createTargetChannel>;
let runtime: DndGestureRuntime;
const measurement = { pageX: 0, pageY: 0, width: 100, height: 100 };
const target = (
  id: number,
  itemId: string,
  overrides: Partial<DndHandleTarget> = {},
): DndHandleTarget => ({
  id,
  itemId,
  zoneId: 'source',
  ref: ref(),
  sourceRef: ref(),
  disabled: false,
  ...overrides,
});

beforeEach(() => {
  mockMeasure.mockReset().mockReturnValue(measurement);
  mockFail.mockReset();
  mockScheduleOnRN.mockReset();
  mockSharedSets.mockReset();
  mockHooks.length = 0;
  mockCursor = 0;
  targets = [target(1, 'item')];
  channel = createTargetChannel(targets);
  runtime = {
    motion: mockShared(EMPTY_DND_MOTION),
    token: mockShared(0),
    disabled: mockShared(false),
    enabled: mockShared(true),
    rootRef: ref(),
    zones: mockShared<UiZoneRegistration[]>([
      {
        kind: 'list',
        zoneId: 'unrelated',
        ref: ref(),
        revision: 0,
        layoutVersion: 1,
        orientation: 'vertical',
        offset: mockShared(0),
        contentSize: 100,
      },
      {
        kind: 'list',
        zoneId: 'source',
        ref: ref(),
        revision: 0,
        layoutVersion: 1,
        orientation: 'vertical',
        offset: mockShared(0),
        contentSize: 100,
      },
    ]),
    begin: jest.fn(),
    move: jest.fn(),
    release: jest.fn(),
    dragAxis: 'both',
    activationDelayMs: 250,
    gestureConfigRevision: 0,
    revision: 0,
  };
});

function renderGroup() {
  mockCursor = 0;
  if (channel.targets !== targets) channel = createTargetChannel(targets);
  DndGestureGroup({
    groupId: 1,
    relations: undefined,
    channel,
    runtime,
    publish: jest.fn(),
  });
}

function touch(x: number, y: number) {
  renderGroup();
  mockConfig.onTouchesDown!({
    handlerTag: 1,
    numberOfTouches: 1,
    changedTouches: [{ absoluteX: x, absoluteY: y }],
  } as Parameters<NonNullable<PanGestureConfig['onTouchesDown']>>[0]);
}

function activate(x = 20, y = 20) {
  mockConfig.onActivate!({
    handlerTag: 1,
    absoluteX: x,
    absoluteY: y,
    numberOfPointers: 1,
  } as Parameters<NonNullable<PanGestureConfig['onActivate']>>[0]);
}

it('rejects a touch outside every handle before measuring root or any zone viewport', () => {
  touch(150, 20);

  expect(mockFail).toHaveBeenCalledWith(1);
  expect(mockMeasure.mock.calls).toEqual([[targets[0]!.ref]]);
});

it('measures only the hit handle, root and its source viewport', () => {
  touch(20, 20);

  expect(mockFail).not.toHaveBeenCalled();
  expect(mockMeasure.mock.calls).toEqual([
    [targets[0]!.ref],
    [runtime.rootRef],
    [runtime.zones.get()[1]!.ref],
  ]);
});

it('rejects a clipped handle before measuring any zone viewport', () => {
  mockMeasure.mockImplementation(nativeRef =>
    nativeRef === runtime.rootRef ? { ...measurement, pageX: 50 } : measurement,
  );
  touch(20, 20);

  expect(mockFail).toHaveBeenCalledWith(1);
  expect(mockMeasure.mock.calls).toEqual([
    [targets[0]!.ref],
    [runtime.rootRef],
  ]);
});

it('activates the handle under the pointer among several targets and records its identity', () => {
  const second = target(2, 'other', { zoneId: 'source' });
  targets = [target(1, 'item'), second];
  mockMeasure.mockImplementation(nativeRef =>
    nativeRef === targets[0]!.ref
      ? { ...measurement, width: 100 }
      : nativeRef === second.ref || nativeRef === second.sourceRef
        ? { ...measurement, pageX: 100, width: 100 }
        : { ...measurement, width: 300 },
  );
  touch(150, 20);
  expect(mockFail).not.toHaveBeenCalled();
  expect(mockMeasure.mock.calls.slice(0, 2)).toEqual([
    [targets[0]!.ref],
    [second.ref],
  ]);

  activate(150, 20);

  expect(mockFail).not.toHaveBeenCalled();
  expect(runtime.motion.get()).toMatchObject({
    phase: 'dragging',
    handleId: 2,
    itemId: 'other',
    sourceZoneId: 'source',
    grip: { x: 50, y: 20 },
  });
  expect(mockScheduleOnRN).toHaveBeenCalledWith(
    runtime.begin,
    expect.objectContaining({ handleId: 2, itemId: 'other' }),
  );
});

it('uses provider availability without rebuilding the native configuration', () => {
  touch(20, 20);
  const config = mockConfig;
  expect(config.enabled).toBe(runtime.enabled);

  runtime.disabled.set(true);
  runtime.enabled.set(false);
  renderGroup();
  expect(mockConfig).toBe(config);
  activate();
  expect(mockFail).toHaveBeenCalledWith(1);
  expect(runtime.motion.get().phase).toBe('idle');

  mockFail.mockClear();
  runtime.disabled.set(false);
  runtime.enabled.set(true);
  renderGroup();
  expect(mockConfig).toBe(config);
  activate();
  expect(mockFail).not.toHaveBeenCalled();
  expect(runtime.motion.get().phase).toBe('dragging');
});

it('skips a disabled handle without measuring it while the shared recognizer stays enabled', () => {
  targets = [target(1, 'item', { disabled: true })];

  touch(20, 20);

  expect(runtime.enabled.get()).toBe(true);
  expect(mockConfig.enabled).toBe(runtime.enabled);
  expect(mockFail).toHaveBeenCalledWith(1);
  expect(mockMeasure).not.toHaveBeenCalled();
});

it('publishes a changed target list to the UI runtime once without a re-render and keeps the native configuration', () => {
  renderGroup();
  const config = mockConfig;
  mockSharedSets.mockClear();
  renderGroup();
  expect(mockSharedSets).not.toHaveBeenCalled();

  const next = [targets[0]!, target(2, 'other')];
  channel.set(next);
  channel.set(next);

  expect(mockSharedSets).toHaveBeenCalledTimes(1);
  expect(mockSharedSets).toHaveBeenCalledWith(next);
  // A later render sees the already published list and publishes nothing.
  targets = next;
  const published = channel;
  renderGroup();
  expect(channel).toBe(published);
  expect(mockSharedSets).toHaveBeenCalledTimes(1);
  expect(mockConfig).toBe(config);
  mockMeasure.mockImplementation(nativeRef =>
    nativeRef === next[1]!.ref
      ? { ...measurement, pageX: 100, width: 100 }
      : nativeRef === next[0]!.ref
        ? measurement
        : { ...measurement, width: 300 },
  );
  touch(150, 20);
  expect(mockFail).not.toHaveBeenCalled();
  expect(mockMeasure.mock.calls[0]).toEqual([next[0]!.ref]);
  expect(mockMeasure.mock.calls[1]).toEqual([next[1]!.ref]);
});

it('keeps native configuration stable and reads an updated shared revision at activation', () => {
  const revision = mockShared(0);
  runtime.revision = revision;
  touch(20, 20);
  const config = mockConfig;
  revision.set(1);
  runtime.zones.set(
    runtime.zones
      .get()
      .map(zone =>
        zone.zoneId === 'source' ? { ...zone, revision: 1 } : zone,
      ),
  );
  renderGroup();

  expect(mockConfig).toBe(config);
  activate();

  expect(mockFail).not.toHaveBeenCalled();
  expect(runtime.motion.get()).toMatchObject({
    phase: 'dragging',
    revision: 1,
    itemId: 'item',
    sourceZoneId: 'source',
    handleId: 1,
  });
  expect(mockScheduleOnRN).toHaveBeenCalledWith(
    runtime.begin,
    expect.objectContaining({ revision: 1 }),
  );
});

it.each(['touch', 'activation'] as const)(
  'rejects a stale registered zone after the shared revision changes before %s',
  stage => {
    const revision = mockShared(0);
    runtime.revision = revision;
    renderGroup();
    const config = mockConfig;
    revision.set(1);

    if (stage === 'touch') touch(20, 20);
    else activate();

    expect(mockConfig).toBe(config);
    expect(mockFail).toHaveBeenCalledWith(1);
    expect(runtime.motion.get().phase).toBe('idle');
    expect(mockScheduleOnRN).not.toHaveBeenCalled();
  },
);

it('ignores update and release events that belong to another activation', () => {
  touch(20, 20);
  activate();
  const owned = runtime.motion.get();
  expect(owned.phase).toBe('dragging');
  // Another recognizer took over the shared motion with a newer token.
  runtime.motion.set({ ...owned, token: owned.token + 1, handleId: 9 });
  mockScheduleOnRN.mockClear();

  (mockConfig.onUpdate as (event: unknown) => void)({
    handlerTag: 1,
    absoluteX: 30,
    absoluteY: 40,
    numberOfPointers: 1,
  });
  mockConfig.onDeactivate!({
    handlerTag: 1,
    absoluteX: 30,
    absoluteY: 40,
    canceled: false,
  } as Parameters<NonNullable<PanGestureConfig['onDeactivate']>>[0]);
  mockConfig.onFinalize!(
    {} as Parameters<NonNullable<PanGestureConfig['onFinalize']>>[0],
  );

  expect(mockScheduleOnRN).not.toHaveBeenCalled();
  expect(runtime.motion.get()).toMatchObject({
    phase: 'dragging',
    token: owned.token + 1,
    handleId: 9,
  });
});

it('keeps numeric revision runtimes working', () => {
  touch(20, 20);
  activate();

  expect(mockFail).not.toHaveBeenCalled();
  expect(runtime.motion.get()).toMatchObject({
    phase: 'dragging',
    revision: 0,
  });
});
