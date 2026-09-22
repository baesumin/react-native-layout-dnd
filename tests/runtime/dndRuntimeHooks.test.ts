import {
  act,
  createElement,
  Fragment,
  StrictMode,
  useLayoutEffect,
} from 'react';

import { DndRenderStore } from '../../src/runtime/dndRenderStore';
import {
  useDndHandleActive,
  type DndRuntime,
} from '../../src/runtime/dndRuntime';
import type { DndSessionSnapshot } from '../../src/controller/dndSession';
import { createFabricTestRoot } from '../helpers/fabricTestRoot';

jest.mock('react-native-reanimated', () => ({ measure: jest.fn() }));

function createStore() {
  let snapshot = { itemId: null } as DndSessionSnapshot<unknown>;
  const listeners = new Set<() => void>();
  const source = {
    getSnapshot: jest.fn(() => snapshot),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const runtime = {
    renderStore: new DndRenderStore(source),
  } as DndRuntime;
  return {
    runtime,
    source,
    listeners,
    publish(itemId: string | null) {
      snapshot = { ...snapshot, itemId };
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

describe('handle activation subscription with the actual React reconciler', () => {
  let root: ReturnType<typeof createFabricTestRoot>;
  let store: ReturnType<typeof createStore>;
  const observed = jest.fn();
  const cancelDisabled = jest.fn();
  function Probe({
    disabled,
    itemId = 'a',
    runtime = store.runtime,
  }: {
    disabled: boolean;
    itemId?: string;
    runtime?: DndRuntime;
  }) {
    const active = useDndHandleActive(runtime, itemId, disabled);
    observed(active);
    useLayoutEffect(() => {
      if (active) cancelDisabled(itemId);
    }, [active, itemId]);
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    root = createFabricTestRoot();
    store = createStore();
  });
  afterEach(async () => {
    await root.unmount();
    expect(store.listeners.size).toBe(0);
  });

  it('does not subscribe or read coordinator state for enabled handles', async () => {
    await root.render(
      createElement(
        Fragment,
        null,
        ...Array.from({ length: 40 }, (_, index) =>
          createElement(Probe, { key: index, disabled: false }),
        ),
      ),
    );
    observed.mockClear();

    await act(() => store.publish('a'));

    expect(store.source.subscribe).not.toHaveBeenCalled();
    expect(store.source.getSnapshot).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
    expect(cancelDisabled).not.toHaveBeenCalled();
  });

  it('reads current activation immediately when an enabled handle becomes disabled', async () => {
    await root.render(createElement(Probe, { disabled: false }));
    await act(() => store.publish('a'));

    await root.render(createElement(Probe, { disabled: true }));

    expect(observed).toHaveBeenLastCalledWith(true);
    expect(cancelDisabled).toHaveBeenCalledWith('a');
    expect(store.listeners.size).toBe(1);
    await act(() => store.publish(null));
    expect(observed).toHaveBeenLastCalledWith(false);
  });

  it('unsubscribes on re-enable and observes the latest state on another disable', async () => {
    await root.render(createElement(Probe, { disabled: true }));
    expect(store.listeners.size).toBe(1);
    await root.render(createElement(Probe, { disabled: false }));
    expect(store.listeners.size).toBe(0);
    observed.mockClear();
    await act(() => store.publish('a'));
    expect(observed).not.toHaveBeenCalled();

    await root.render(createElement(Probe, { disabled: true }));

    expect(observed).toHaveBeenLastCalledWith(true);
    expect(cancelDisabled).toHaveBeenCalledTimes(1);
    expect(store.listeners.size).toBe(1);
  });

  it('switches item identity and ignores unrelated coordinator publications', async () => {
    await act(() => store.publish('a'));
    await root.render(createElement(Probe, { disabled: true }));
    await root.render(createElement(Probe, { disabled: true, itemId: 'b' }));
    expect(observed).toHaveBeenLastCalledWith(false);
    observed.mockClear();
    await act(() => store.publish('c'));
    expect(observed).not.toHaveBeenCalled();

    await act(() => store.publish('b'));

    expect(observed).toHaveBeenLastCalledWith(true);
    expect(cancelDisabled).toHaveBeenLastCalledWith('b');
    expect(store.listeners.size).toBe(1);
  });

  it('rebinds to a replaced runtime and releases the old source', async () => {
    const replacement = createStore();
    await root.render(createElement(Probe, { disabled: true }));
    await act(() => replacement.publish('a'));

    await root.render(
      createElement(Probe, { disabled: true, runtime: replacement.runtime }),
    );

    expect(store.listeners.size).toBe(0);
    expect(replacement.listeners.size).toBe(1);
    expect(observed).toHaveBeenLastCalledWith(true);
    observed.mockClear();
    await act(() => store.publish('a'));
    expect(observed).not.toHaveBeenCalled();
    await root.unmount();
    expect(replacement.listeners.size).toBe(0);
  });

  it('retains one live subscription through StrictMode cleanup and setup', async () => {
    await root.render(
      createElement(StrictMode, null, createElement(Probe, { disabled: true })),
    );

    expect(store.listeners.size).toBe(1);
    await act(() => store.publish('a'));
    expect(observed).toHaveBeenLastCalledWith(true);
    expect(cancelDisabled).toHaveBeenCalledTimes(1);
  });
});
