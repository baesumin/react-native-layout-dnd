import { act, createElement } from 'react';

import { GridController } from '../../src/components/GridController';
import { GridDragHandle } from '../../src/components/GridDragHandle';
import { GridZoneView } from '../../src/components/GridZoneView';
import type {
  GridControllerHandle,
  GridControllerProps,
  ItemRenderArgs,
} from '../../src/components/gridTypes';
import type { GridValue } from '../../src/types';
import { createFabricTestRoot } from '../helpers/fabricTestRoot';

// Real React reconciler, real GridController → DndProvider → SortableGrid
// adapter chain. Host views, Reanimated, Worklets and Gesture Handler are
// stubbed; native measurement is not exercised here.
type SharedMock<T> = { get(): T; set(next: T): void };

jest.mock('react-native', () => {
  const Passthrough = ({
    children,
  }: {
    children?: import('react').ReactNode;
  }) => children ?? null;
  return {
    View: Passthrough,
    Text: () => null,
    StyleSheet: { create: (styles: unknown) => styles },
    PixelRatio: { get: () => 1 },
  };
});
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const useSharedMock = <T,>(initial: T) => {
    const ref = React.useRef<SharedMock<T> | null>(null);
    if (!ref.current) {
      let value = initial;
      ref.current = {
        get: () => value,
        set: next => {
          value = next;
        },
      };
    }
    return ref.current;
  };
  // Every animated view reports one 200 × 200 layout after mounting; the
  // passive effect runs after the adapters' own mount effects, like native.
  function AnimatedView(props: {
    children?: import('react').ReactNode;
    onLayout?: (event: unknown) => void;
  }) {
    const onLayout = props.onLayout;
    React.useEffect(() => {
      onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 200 } },
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return props.children ?? null;
  }
  return {
    __esModule: true,
    default: { View: AnimatedView, FlatList: AnimatedView },
    useSharedValue: useSharedMock,
    useDerivedValue: (get: () => unknown) => {
      const ref = React.useRef<SharedMock<unknown> | null>(null);
      if (!ref.current) ref.current = { get, set() {} };
      else ref.current.get = get;
      return ref.current;
    },
    useAnimatedRef: () => React.useRef(null),
    useAnimatedStyle: () => ({}),
    useFrameCallback: () => ({ setActive() {} }),
    cancelAnimation: () => {},
    measure: () => null,
    scrollTo: () => {},
    withTiming: (value: number) => value,
  };
});
jest.mock('react-native-worklets', () => ({
  runOnUISync: (task: () => unknown) => task(),
  scheduleOnUI: (task: (...args: unknown[]) => void, ...args: unknown[]) =>
    task(...args),
  scheduleOnRN: (task: (...args: unknown[]) => void, ...args: unknown[]) =>
    task(...args),
}));
jest.mock('react-native-gesture-handler', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  let nextTag = 10;
  return {
    GestureDetector: ({ children }: { children?: import('react').ReactNode }) =>
      children ?? null,
    GestureStateManager: { fail: jest.fn() },
    useManualGesture: () => ({ handlerTag: 0 }),
    useCompetingGestures: (...gestures: Array<{ handlerTag: number }>) =>
      gestures,
    usePanGesture: (
      config: import('react-native-gesture-handler').PanGestureConfig,
    ) => {
      const tag = React.useRef(0);
      if (!tag.current) tag.current = ++nextTag;
      return React.useMemo(
        () => ({ handlerTag: tag.current, config }),
        [config],
      );
    },
  };
});

const span = { rows: 1, cols: 1 };
const geometry = {
  mode: 'fixed' as const,
  cellWidth: 50,
  cellHeight: 50,
  rowGap: 0,
  columnGap: 0,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
};

function home(): GridValue<string> {
  return {
    revision: 2,
    zones: [
      {
        id: 'page',
        strategy: 'spatial',
        rows: 2,
        columns: 4,
        items: [
          {
            id: 'p1',
            data: 'p1',
            span,
            placement: 'insert',
            position: { row: 0, col: 0 },
          },
          {
            id: 'w1',
            data: 'w1',
            span: { rows: 2, cols: 2 },
            placement: 'exchange',
            position: { row: 0, col: 2 },
          },
        ],
      },
      {
        id: 'dock',
        strategy: 'ordered',
        rows: 1,
        columns: 4,
        itemSpan: span,
        items: [
          { id: 'd1', data: 'd1', span, placement: 'insert' },
          { id: 'd2', data: 'd2', span, placement: 'insert' },
        ],
      },
    ],
  };
}

const renderItem = jest.fn((args: ItemRenderArgs<string>) =>
  createElement(GridDragHandle, { itemId: args.item.id, children: null }),
);
const onValidationError = jest.fn();

function tree(overrides: Partial<GridControllerProps<string>> = {}) {
  return createElement(GridController<string>, {
    value: home(),
    onChange: () => {},
    renderItem,
    onValidationError,
    children: [
      createElement(GridZoneView, { key: 'page', zoneId: 'page', geometry }),
      createElement(GridZoneView, { key: 'dock', zoneId: 'dock', geometry }),
    ],
    ...overrides,
  });
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

let root: ReturnType<typeof createFabricTestRoot>;

beforeEach(() => {
  jest.clearAllMocks();
  root = createFabricTestRoot();
});
afterEach(async () => {
  await root.unmount();
});

it('renders every zone item through the grid API arguments with the caller’s own item objects', async () => {
  const value = home();
  await root.render(tree({ value }));
  await flush();
  const rendered = new Map(
    renderItem.mock.calls.map(([args]) => [args.item.id, args]),
  );
  expect([...rendered.keys()].sort()).toEqual(['d1', 'd2', 'p1', 'w1']);
  expect(rendered.get('p1')).toMatchObject({
    zoneId: 'page',
    width: 50,
    height: 50,
    isDragging: false,
  });
  expect(rendered.get('w1')).toMatchObject({ width: 100, height: 100 });
  expect(rendered.get('d2')).toMatchObject({ zoneId: 'dock', width: 50 });
  expect(rendered.get('p1')!.item).toBe(value.zones[0].items[0]);
  expect(rendered.get('d2')!.item).toBe(value.zones[1].items[1]);
  expect(onValidationError).not.toHaveBeenCalled();
});

it('reports an invalid grid value once with the grid API codes and keeps rendering', async () => {
  const broken = home();
  broken.zones[0].items.push({
    id: 'p1',
    data: 'dup',
    span,
    position: { row: 1, col: 0 },
  });
  await root.render(tree({ value: broken }));
  await flush();
  expect(onValidationError).toHaveBeenCalledTimes(1);
  expect(onValidationError).toHaveBeenCalledWith([
    expect.objectContaining({ code: 'duplicate-id', itemId: 'p1' }),
  ]);
  await root.render(tree({ value: broken, style: { flex: 1 } }));
  await flush();
  expect(onValidationError).toHaveBeenCalledTimes(1);
  await root.render(tree({ value: home() }));
  await flush();
  expect(onValidationError).toHaveBeenCalledTimes(1);
  expect(renderItem).toHaveBeenCalled();
});

it('exposes the geometry handle of the shared provider', async () => {
  const ref: { current: GridControllerHandle | null } = { current: null };
  await root.render(tree({ ref }));
  await flush();
  expect(typeof ref.current?.invalidateGeometry).toBe('function');
  expect(() => ref.current!.invalidateGeometry()).not.toThrow();
});
