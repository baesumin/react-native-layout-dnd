import { StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { DndProvider } from '../../src/components/DndProvider';
import { DragHandle } from '../../src/components/DragHandle';
import {
  DndItemContext,
  type DndHandleRegistration,
} from '../../src/runtime/dndRuntime';
import type { DndGestureRegistry } from '../../src/gesture/DndGestureHost';
import type { LayoutState } from '../../src/contracts';
import { createFabricTestRoot } from '../helpers/fabricTestRoot';

let mockRegistry: DndGestureRegistry;
const mockChildren = ({ children }: { children: ReactNode }) => children;

// Actual React effects and Provider registration; only native boundaries are
// replaced. The detector itself has separate actual-React GestureHost tests.
jest.mock('react-native', () => ({
  PixelRatio: { get: () => 1 },
  StyleSheet: { create: (styles: unknown) => styles },
  View: (props: { children: ReactNode }) => mockChildren(props),
}));
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: { View: (props: { children: ReactNode }) => mockChildren(props) },
    useSharedValue: (initial: unknown) =>
      React.useState(() => {
        let value = initial;
        return {
          get: () => value,
          set: (next: unknown) => {
            value = typeof next === 'function' ? next(value) : next;
          },
        };
      })[0],
    // Reanimated returns one stable derived value per hook slot; Provider
    // callbacks that depend on it must not change identity on every render.
    useDerivedValue: (read: () => unknown) => {
      const derived = React.useRef({ get: read }).current;
      derived.get = read;
      return derived;
    },
    useAnimatedRef: () => React.useRef(null),
    useAnimatedStyle: () => ({}),
    useFrameCallback: () => {},
    cancelAnimation: () => {},
    measure: () => null,
    scrollTo: () => {},
    withTiming: (value: unknown) => value,
  };
});
jest.mock('react-native-worklets', () => ({
  runOnUISync: (task: (...args: unknown[]) => unknown, ...args: unknown[]) =>
    task(...args),
  scheduleOnUI: (task: (...args: unknown[]) => void, ...args: unknown[]) =>
    task(...args),
  scheduleOnRN: (task: (...args: unknown[]) => void, ...args: unknown[]) =>
    task(...args),
}));
jest.mock('react-native-gesture-handler', () => ({}));
jest.mock('../../src/gesture/DndGestureHost', () => {
  const actual = jest.requireActual<
    typeof import('../../src/gesture/DndGestureHost')
  >('../../src/gesture/DndGestureHost');
  return {
    ...actual,
    createDndGestureRegistry: () => {
      const registry = actual.createDndGestureRegistry();
      jest.spyOn(registry, 'setOwners');
      return registry;
    },
    DndGestureHost: ({
      registry,
      children,
    }: {
      registry: DndGestureRegistry;
      children: ReactNode;
    }) => {
      mockRegistry = registry;
      return children;
    },
  };
});

it('publishes current handles through actual StrictMode cleanup and setup', async () => {
  const root = createFabricTestRoot();
  const effectSetup = jest.fn();
  const effectCleanup = jest.fn();
  function ReplayProbe() {
    useLayoutEffect(() => {
      effectSetup();
      return effectCleanup;
    }, []);
    return null;
  }
  const scopes = Array.from({ length: 40 }, (_, index) => ({
    itemId: `item-${index}`,
    zoneId: 'source',
    ref: {} as DndHandleRegistration['sourceRef'],
  }));
  const value: LayoutState<string> = {
    revision: 0,
    items: scopes.map(scope => ({ id: scope.itemId, data: scope.itemId })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: scopes.map(scope => scope.itemId),
      },
    ],
  };
  const onChange = jest.fn();
  const tree = (visible: boolean) => (
    <StrictMode>
      <DndProvider value={value} onChange={onChange}>
        <ReplayProbe />
        {visible &&
          scopes.map(scope => (
            <DndItemContext key={scope.itemId} value={scope}>
              <DragHandle>{null}</DragHandle>
            </DndItemContext>
          ))}
      </DndProvider>
    </StrictMode>
  );
  try {
    await root.render(tree(true));

    expect(effectSetup).toHaveBeenCalledTimes(2);
    expect(effectCleanup).toHaveBeenCalledTimes(1);
    expect(mockRegistry.setOwners).toHaveBeenCalledTimes(1);
    expect(
      mockRegistry.getSnapshot().map(owner => owner.registration.itemId),
    ).toEqual(scopes.map(scope => scope.itemId));
    expect(
      new Set(mockRegistry.getSnapshot().map(owner => owner.id)).size,
    ).toBe(40);
    jest.mocked(mockRegistry.setOwners).mockClear();

    await root.render(tree(false));

    expect(mockRegistry.setOwners).toHaveBeenCalledTimes(1);
    expect(mockRegistry.getSnapshot()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await root.unmount();
    jest.restoreAllMocks();
  }
});
