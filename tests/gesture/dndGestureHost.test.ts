import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import {
  createDndGestureRegistry,
  DndGestureHost,
  groupGestureOwners,
} from '../../src/gesture/DndGestureHost';
import type {
  DndGestureGroupProps,
  DndGestureRuntime,
  DndHandleTarget,
} from '../../src/gesture/DndGestureGroup';
import type { DndHandleRegistration } from '../../src/runtime/dndRuntime';
import type { GestureRelations } from '../../src/components/gridTypes';
import { createFabricTestRoot } from '../helpers/fabricTestRoot';

const mockCompose = jest.fn((...gestures: Array<{ handlerTag: number }>) => ({
  handlerTags: gestures.map(gesture => gesture.handlerTag),
}));
const mockGroupMounts = jest.fn();
const mockGroupUnmounts = jest.fn();
const mockGroupTargets = jest.fn(
  (_groupId: number, _targets: readonly DndHandleTarget[]) => {},
);
const mockGroupRenders = jest.fn((_groupId: number) => {});
const mockGroupPublish = new Map<number, DndGestureGroupProps['publish']>();
const mockSentinel = { handlerTag: 0 };

jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  useManualGesture: () => mockSentinel,
  useCompetingGestures: (...gestures: Array<{ handlerTag: number }>) =>
    mockCompose(...gestures),
}));
jest.mock('../../src/gesture/DndGestureGroup', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  // The real module imports Reanimated; only the channel factory is needed.
  function createTargetChannel(initial: readonly DndHandleTarget[]) {
    let targets = initial;
    const listeners = new Set<(mockNext: readonly DndHandleTarget[]) => void>();
    return {
      get targets() {
        return targets;
      },
      set(mockNext: readonly DndHandleTarget[]) {
        if (mockNext === targets) return;
        targets = mockNext;
        for (const listener of Array.from(listeners)) listener(mockNext);
      },
      subscribe(listener: (mockNext: readonly DndHandleTarget[]) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }
  return {
    createTargetChannel,
    DndGestureGroup: ({
      groupId,
      relations,
      channel,
      publish,
    }: DndGestureGroupProps) => {
      mockGroupRenders(groupId);
      const gesture = React.useMemo(
        () => ({ handlerTag: groupId, relations }),
        [groupId, relations],
      );
      React.useLayoutEffect(() => {
        mockGroupPublish.set(groupId, publish);
        publish(groupId, gesture as never);
      }, [groupId, gesture, publish]);
      React.useLayoutEffect(() => {
        mockGroupTargets(groupId, channel.targets);
        return channel.subscribe(targets => mockGroupTargets(groupId, targets));
      }, [groupId, channel]);
      React.useLayoutEffect(() => {
        mockGroupMounts(groupId);
        return () => {
          mockGroupUnmounts(groupId);
          publish(groupId, null);
        };
      }, [groupId, publish]);
      return null;
    },
  };
});

const externalGesture = {
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
const registration = (
  itemId: string,
  gestureRelations?: GestureRelations,
): DndHandleRegistration => ({
  itemId,
  zoneId: 'list',
  ref: {} as DndHandleRegistration['ref'],
  sourceRef: {} as DndHandleRegistration['sourceRef'],
  disabled: false,
  ...(gestureRelations ? { gestureRelations } : {}),
});
const lastTargets = (groupId: number) =>
  mockGroupTargets.mock.calls.filter(([id]) => id === groupId).at(-1)?.[1];

it('keeps its snapshot stable while a retained owner leaves the cell window', () => {
  const registry = createDndGestureRegistry();
  const listener = jest.fn();
  registry.subscribe(listener);
  const owner = { id: 1, registration: registration('a'), mounted: true };
  registry.setOwners([owner]);
  const mountedSnapshot = registry.getSnapshot();
  listener.mockClear();

  const retained = { ...owner, mounted: false };
  registry.setOwners([retained]);

  expect(registry.getSnapshot()).toBe(mountedSnapshot);
  expect(listener).not.toHaveBeenCalled();
  registry.setOwners([]);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(registry.getSnapshot()).toEqual([]);
});

it('publishes new or changed owners and preserves unchanged registrations', () => {
  const registry = createDndGestureRegistry();
  const first = { id: 1, registration: registration('a') };
  const second = { id: 2, registration: registration('b') };
  registry.setOwners([first]);
  const listener = jest.fn(() => registry.getSnapshot());
  registry.subscribe(listener);

  registry.setOwners([first, second]);

  expect(listener).toHaveBeenCalledTimes(1);
  expect(registry.getSnapshot()[0]!.registration).toBe(first.registration);
  const revised = {
    ...second,
    registration: { ...second.registration, disabled: true },
  };
  registry.setOwners([first, revised]);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(registry.getSnapshot()[1]!.registration).toBe(revised.registration);
  expect(listener.mock.results[1]!.value).toBe(registry.getSnapshot());
});

it('copies input records so a caller cannot mutate the published snapshot', () => {
  const registry = createDndGestureRegistry();
  const owner = { id: 1, registration: registration('a') };
  const input = [owner];
  registry.setOwners(input);
  const published = registry.getSnapshot();

  input.push({ id: 2, registration: registration('b') });
  owner.registration = registration('replacement');

  expect(published).toHaveLength(1);
  expect(published[0]!.registration.itemId).toBe('a');
});

it('unsubscribes without removing other native owner consumers', () => {
  const registry = createDndGestureRegistry();
  const removed = jest.fn();
  const remaining = jest.fn();
  const unsubscribe = registry.subscribe(removed);
  registry.subscribe(remaining);
  unsubscribe();

  registry.setOwners([{ id: 1, registration: registration('a') }]);

  expect(removed).not.toHaveBeenCalled();
  expect(remaining).toHaveBeenCalledTimes(1);
});

describe('relation signature grouping', () => {
  const state = () => ({
    targets: new Map(),
    signatures: [],
    nextGroupId: 0,
    groups: [] as ReturnType<typeof groupGestureOwners>,
  });

  it('shares one group and reuses target objects while registrations are unchanged', () => {
    const grouping = state();
    const a = { id: 1, registration: registration('a') };
    const b = { id: 2, registration: registration('b') };
    const first = groupGestureOwners([a, b], grouping);
    expect(first).toHaveLength(1);
    expect(first[0]!.targets.map(target => target.id)).toEqual([1, 2]);
    expect(first[0]!.targets[0]).toMatchObject({
      id: 1,
      itemId: 'a',
      zoneId: 'list',
      ref: a.registration.ref,
      sourceRef: a.registration.sourceRef,
      disabled: false,
    });

    // The same owners produce the identical result; StrictMode may call twice.
    expect(groupGestureOwners([a, b], grouping)).toBe(first);

    const c = { id: 3, registration: registration('c') };
    const second = groupGestureOwners([a, c], grouping);
    expect(second[0]!.groupId).toBe(first[0]!.groupId);
    expect(second[0]!.channel).toBe(first[0]!.channel);
    expect(second[0]!.targets[0]).toBe(first[0]!.targets[0]);
    expect(second[0]!.targets[1]!.id).toBe(3);

    const revised = {
      ...a,
      registration: { ...a.registration, disabled: true },
    };
    const third = groupGestureOwners([revised, c], grouping);
    expect(third[0]!.targets[0]).not.toBe(first[0]!.targets[0]);
    expect(third[0]!.targets[0]).toMatchObject({ id: 1, disabled: true });
    expect(third[0]!.targets[1]).toBe(second[0]!.targets[1]);
  });

  it('separates relation signatures, keeps group ids and drops empty groups', () => {
    const grouping = state();
    const plain = { id: 1, registration: registration('a') };
    const related = {
      id: 2,
      registration: registration('b', {
        simultaneousWith: [externalGesture as never],
      }),
    };
    const alsoRelated = {
      id: 3,
      registration: registration('c', {
        simultaneousWith: [externalGesture as never],
      }),
    };
    const groups = groupGestureOwners([plain, related, alsoRelated], grouping);
    expect(groups.map(group => group.groupId)).toEqual([1, 2]);
    expect(groups[1]!.targets.map(target => target.id)).toEqual([2, 3]);
    expect(groups[1]!.relations).toBe(related.registration.gestureRelations);

    const withoutRelated = groupGestureOwners([plain], grouping);
    expect(withoutRelated.map(group => group.groupId)).toEqual([1]);
    expect(withoutRelated[0]!.targets).toBe(groups[0]!.targets);

    // The signature returns with a fresh group id and recognizer.
    const returned = groupGestureOwners([plain, alsoRelated], grouping);
    expect(returned.map(group => group.groupId)).toEqual([1, 3]);
  });
});

describe('native detector with the actual React reconciler', () => {
  let root: ReturnType<typeof createFabricTestRoot>;
  let registry: ReturnType<typeof createDndGestureRegistry>;
  const runtime = {} as DndGestureRuntime;
  const contentRendered = jest.fn();
  const contentMounted = jest.fn();
  const contentUnmounted = jest.fn();
  function Content({ value }: { value: string }) {
    contentRendered(value);
    useLayoutEffect(() => {
      contentMounted();
      return contentUnmounted;
    }, []);
    return null;
  }
  const tree = (value = 'initial') =>
    createElement(DndGestureHost, {
      registry,
      runtime,
      children: createElement(Content, { value }),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGroupPublish.clear();
    root = createFabricTestRoot();
    registry = createDndGestureRegistry();
  });
  afterEach(async () => {
    await root.unmount();
  });

  it('updates root content without recomposing gestures or remounting content', async () => {
    registry.setOwners([{ id: 1, registration: registration('a') }]);
    await root.render(tree());
    mockCompose.mockClear();

    await root.render(tree('updated'));

    expect(contentRendered).toHaveBeenLastCalledWith('updated');
    expect(contentMounted).toHaveBeenCalledTimes(1);
    expect(contentUnmounted).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('composes one native gesture for forty owners that share a relation signature', async () => {
    await root.render(tree());
    mockCompose.mockClear();
    const owners = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      registration: registration(`item-${index}`),
    }));

    await act(() => registry.setOwners(owners));

    expect(mockGroupMounts).toHaveBeenCalledTimes(1);
    expect(mockCompose).toHaveBeenCalledTimes(1);
    expect(mockCompose.mock.results[0]!.value.handlerTags).toEqual([0, 1]);
    expect(lastTargets(1)!.map(target => target.id)).toEqual(
      owners.map(owner => owner.id),
    );
  });

  it('keeps the composition and target identities while cells leave and remount', async () => {
    const active = {
      id: 1,
      registration: registration('active'),
      mounted: true,
    };
    registry.setOwners([
      active,
      { id: 2, registration: registration('other') },
    ]);
    await root.render(tree());
    const composition = mockCompose.mock.results.at(-1)!.value;
    const initialTargets = lastTargets(1)!;
    expect(initialTargets.map(target => target.id)).toEqual([1, 2]);
    mockCompose.mockClear();
    mockGroupUnmounts.mockClear();

    const retained = { ...active, mounted: false };
    const renders = mockGroupRenders.mock.calls.length;
    await act(() => registry.setOwners([retained]));

    expect(mockGroupUnmounts).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
    // Target changes reach the group through its channel, not a re-render.
    expect(mockGroupRenders).toHaveBeenCalledTimes(renders);
    expect(composition.handlerTags).toEqual([0, 1]);
    expect(lastTargets(1)!.map(target => target.id)).toEqual([1]);
    expect(lastTargets(1)![0]).toBe(initialTargets[0]);

    await act(() =>
      registry.setOwners([
        active,
        { id: 3, registration: registration('replacement') },
      ]),
    );
    expect(mockCompose).not.toHaveBeenCalled();
    expect(lastTargets(1)!.map(target => target.id)).toEqual([1, 3]);
    expect(lastTargets(1)![0]).toBe(initialTargets[0]);
    expect(mockGroupMounts).toHaveBeenCalledTimes(1);
  });

  it('gives a distinct relation signature its own native gesture and drops it when empty', async () => {
    registry.setOwners([{ id: 1, registration: registration('a') }]);
    await root.render(tree());
    mockCompose.mockClear();

    await act(() =>
      registry.setOwners([
        { id: 1, registration: registration('a') },
        {
          id: 2,
          registration: registration('b', {
            simultaneousWith: [externalGesture as never],
          }),
        },
      ]),
    );

    expect(mockCompose).toHaveBeenCalledTimes(1);
    expect(mockCompose.mock.results.at(-1)!.value.handlerTags).toEqual([
      0, 1, 2,
    ]);
    expect(mockGroupMounts.mock.calls.map(([id]) => id)).toEqual([1, 2]);

    await act(() =>
      registry.setOwners([{ id: 1, registration: registration('a') }]),
    );
    expect(mockGroupUnmounts.mock.calls).toEqual([[2]]);
    expect(mockCompose.mock.results.at(-1)!.value.handlerTags).toEqual([0, 1]);
  });

  it('ignores an old host publisher after unmount and resubscribes a new host', async () => {
    registry.setOwners([{ id: 1, registration: registration('a') }]);
    await root.render(tree());
    const previousPublish = mockGroupPublish.get(1)!;
    await root.unmount();
    root = createFabricTestRoot();
    registry.setOwners([{ id: 2, registration: registration('b') }]);
    await root.render(tree('remounted'));
    mockCompose.mockClear();

    await act(() => previousPublish(99, { handlerTag: 99 } as never));

    expect(mockCompose).not.toHaveBeenCalled();
    await act(() => registry.setOwners([]));
    expect(mockCompose.mock.results.at(-1)!.value.handlerTags).toEqual([0]);
  });

  it('keeps group publication correct across StrictMode effect cleanup and setup', async () => {
    registry.setOwners([{ id: 1, registration: registration('a') }]);
    await root.render(createElement(StrictMode, null, tree()));

    expect(mockCompose.mock.results.at(-1)!.value.handlerTags).toEqual([0, 1]);
    await act(() => registry.setOwners([]));
    expect(mockCompose.mock.results.at(-1)!.value.handlerTags).toEqual([0]);
  });
});
