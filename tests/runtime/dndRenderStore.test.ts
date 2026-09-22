import type {
  GridLayoutZone,
  LayoutLocation,
  LayoutState,
  LayoutZone,
  ListLayoutZone,
} from '../../src/contracts';
import {
  DndRenderStore,
  type RetainSlotsRule,
} from '../../src/runtime/dndRenderStore';
import {
  DndSessionCoordinator,
  type DndSessionOptions,
  type DndSessionSnapshot,
} from '../../src/controller/dndSession';
import {
  respondToDndProposal,
  type DndProposal,
  type DndValue,
} from '../../src/controller/dndState';

function initial(): LayoutState<string> {
  return {
    revision: 4,
    items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ id, data: id })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['a', 'b', 'c'],
      },
      {
        id: 'other',
        kind: 'list',
        orientation: 'horizontal',
        itemIds: ['d', 'e'],
      },
      {
        id: 'grid',
        kind: 'grid',
        rows: 3,
        columns: 3,
        placements: ['f', 'g'].map((itemId, col) => ({
          itemId,
          position: { row: 0, col },
          span: { rows: 1, cols: 1 },
        })),
      },
    ],
  };
}

function replaceZone(value: LayoutState<string>, zone: LayoutZone) {
  return {
    ...value,
    zones: value.zones.map(current =>
      current.id === zone.id ? zone : current,
    ),
  };
}

function source() {
  const value = initial();
  let snapshot = new DndSessionCoordinator({
    value,
    onChange: () => {},
  }).getSnapshot();
  const listeners = new Set<() => void>();
  const store = new DndRenderStore({
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const publish = (patch: Partial<DndSessionSnapshot<string>>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    value,
    store,
    publish,
    start() {
      publish({
        phase: 'dragging',
        sessionId: 'session',
        itemId: 'a',
        sourceZoneId: 'source',
        targetZoneId: 'source',
        target: { kind: 'list', zoneId: 'source', index: 0 },
      });
    },
  };
}

function observeZone(
  store: DndRenderStore<string>,
  zoneId: string,
  preserveSlots: boolean | RetainSlotsRule = true,
) {
  const get = () => store.getZoneSnapshot(zoneId, preserveSlots);
  const listener = jest.fn();
  const unsubscribe = store.subscribeSelection(get, listener);
  return { get, listener, unsubscribe };
}

describe('provider selection', () => {
  it('does not notify React for pointer sequences or changed same-zone preview targets', () => {
    const h = source();
    h.start();
    const previous = h.store.getProviderSnapshot();
    const listener = jest.fn();
    h.store.subscribeProvider(listener);
    for (let seq = 1; seq <= 240; seq += 1) {
      const candidate = replaceZone(h.value, {
        ...(h.value.zones[0] as ListLayoutZone),
        itemIds: seq % 2 ? ['b', 'a', 'c'] : ['b', 'c', 'a'],
      });
      h.publish({
        seq,
        candidate,
        displayValue: candidate,
        target: { kind: 'list', zoneId: 'source', index: seq % 2 ? 1 : 2 },
      });
    }
    expect(listener).not.toHaveBeenCalled();
    expect(h.store.getProviderSnapshot()).toBe(previous);
    expect(h.store.getSnapshot()).toMatchObject({ seq: 240 });
    expect(h.store.getSnapshot()).not.toBe(previous);
  });

  it.each([
    ['phase', { phase: 'awaiting-response' }],
    ['session', { sessionId: 'next-session' }],
    ['item', { itemId: 'b' }],
    ['source zone', { sourceZoneId: 'other' }],
    ['target zone', { targetZoneId: 'other' }],
    ['validity', { validity: 'invalid' }],
    ['disabled', { disabled: true }],
  ] as const)('notifies when %s changes', (_name, patch) => {
    const h = source();
    h.start();
    const listener = jest.fn();
    h.store.subscribeProvider(listener);
    h.publish(patch);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.store.getProviderSnapshot()).toMatchObject(patch);
  });

  it('publishes a new controlled value and removes unsubscribed listeners', () => {
    const h = source();
    const listener = jest.fn();
    const unsubscribe = h.store.subscribeProvider(listener);
    const value = { ...h.value };
    h.publish({ value, displayValue: value });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.store.getProviderSnapshot().value).toBe(value);
    unsubscribe();
    h.publish({ disabled: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('zone selection', () => {
  it('keeps list slots and unrelated zones stable across approved in-list previews', () => {
    const h = source();
    h.start();
    const sourceZone = observeZone(h.store, 'source');
    const other = observeZone(h.store, 'other');
    const grid = observeZone(h.store, 'grid');
    const previous = sourceZone.get();
    for (const itemIds of [
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
      ['a', 'b', 'c'],
    ]) {
      const candidate = replaceZone(h.value, {
        ...(h.value.zones[0] as ListLayoutZone),
        itemIds,
      });
      h.publish({ displayValue: candidate, candidate });
    }
    expect(sourceZone.get()).toBe(previous);
    expect(sourceZone.get().display).toBe(h.value.zones[0]);
    expect(sourceZone.listener).not.toHaveBeenCalled();
    expect(other.listener).not.toHaveBeenCalled();
    expect(grid.listener).not.toHaveBeenCalled();
  });

  it('keeps stable and ordered subscriptions independent for index-dependent item sizes', () => {
    const h = source();
    h.start();
    const stable = observeZone(h.store, 'source');
    const ordered = observeZone(h.store, 'source', false);
    const baseline = stable.get();
    const candidate = replaceZone(h.value, {
      ...(h.value.zones[0] as ListLayoutZone),
      itemIds: ['b', 'c', 'a'],
    });
    h.publish({ displayValue: candidate, candidate });
    const nextOrdered = ordered.get();
    for (let read = 0; read < 20; read += 1) {
      expect(stable.get()).toBe(baseline);
      expect(ordered.get()).toBe(nextOrdered);
    }
    expect(stable.listener).not.toHaveBeenCalled();
    expect(ordered.listener).toHaveBeenCalledTimes(1);
    expect(nextOrdered.display).toBe(candidate.zones[0]);
  });

  it('retains grid cells when only placement positions and ordering change', () => {
    const h = source();
    h.start();
    const grid = observeZone(h.store, 'grid');
    const original = grid.get();
    const zone = h.value.zones[2] as GridLayoutZone;
    const candidate = replaceZone(h.value, {
      ...zone,
      placements: zone.placements.toReversed().map((entry, row) => ({
        ...entry,
        position: { row: row + 1, col: 0 },
      })),
    });
    h.publish({ displayValue: candidate, candidate });
    expect(grid.get()).toBe(original);
    expect(grid.listener).not.toHaveBeenCalled();
  });

  it.each([
    ['rows', (zone: GridLayoutZone) => ({ ...zone, rows: zone.rows + 1 })],
    [
      'columns',
      (zone: GridLayoutZone) => ({ ...zone, columns: zone.columns + 1 }),
    ],
    [
      'span',
      (zone: GridLayoutZone) => ({
        ...zone,
        placements: zone.placements.map((entry, index) =>
          index === 0 ? { ...entry, span: { rows: 2, cols: 1 } } : entry,
        ),
      }),
    ],
    [
      'placement policy',
      (zone: GridLayoutZone) => ({
        ...zone,
        placements: zone.placements.map((entry, index) =>
          index === 0 ? { ...entry, placement: 'exchange' as const } : entry,
        ),
      }),
    ],
    [
      'membership',
      (zone: GridLayoutZone) => ({
        ...zone,
        placements: zone.placements.map((entry, index) =>
          index === 0 ? { ...entry, itemId: 'a' } : entry,
        ),
      }),
    ],
  ] as const)('publishes grid %s changes', (_name, change) => {
    const h = source();
    h.start();
    const grid = observeZone(h.store, 'grid');
    const changed = change(h.value.zones[2] as GridLayoutZone);
    h.publish({ displayValue: replaceZone(h.value, changed) });
    expect(grid.get().display).toBe(changed);
    expect(grid.listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['orientation', { orientation: 'horizontal' as const }],
    ['same-length membership', { itemIds: ['a', 'b', 'd'] }],
    ['added membership', { itemIds: ['a', 'b', 'c', 'd'] }],
    ['empty membership', { itemIds: [] }],
  ])('publishes list %s changes', (_name, patch) => {
    const h = source();
    h.start();
    const list = observeZone(h.store, 'source');
    const changed = { ...(h.value.zones[0] as ListLayoutZone), ...patch };
    h.publish({ displayValue: replaceZone(h.value, changed) });
    expect(list.get().display).toBe(changed);
    expect(list.listener).toHaveBeenCalledTimes(1);
  });

  it('resets retained display when owner items, base geometry, or revision change', () => {
    const h = source();
    h.start();
    const list = observeZone(h.store, 'source');
    const changedItems = h.value.items.map(item => ({
      ...item,
      data: `new:${item.id}`,
    }));
    const value = {
      ...h.value,
      revision: h.value.revision + 1,
      items: changedItems,
      zones: h.value.zones.map(zone =>
        zone.id === 'source'
          ? { ...(zone as ListLayoutZone), itemIds: ['c', 'b', 'a'] }
          : zone,
      ),
    };
    h.publish({ value, displayValue: value });
    expect(list.get()).toMatchObject({ revision: 5, items: changedItems });
    expect(list.get().zone).toBe(value.zones[0]);
    expect(list.get().display).toBe(value.zones[0]);
    expect(list.listener).toHaveBeenCalledTimes(1);
  });

  it.each(['items', 'revision', 'base zone'] as const)(
    'notifies independently when only the controlled %s changes',
    field => {
      const h = source();
      h.start();
      const list = observeZone(h.store, 'source');
      const value =
        field === 'items'
          ? {
              ...h.value,
              items: h.value.items.map(item => ({
                ...item,
                data: `${item.data}!`,
              })),
            }
          : field === 'revision'
            ? { ...h.value, revision: h.value.revision + 1 }
            : replaceZone(h.value, {
                ...(h.value.zones[0] as ListLayoutZone),
                itemIds: ['c', 'b', 'a'],
              });
      h.publish({ value, displayValue: value });
      expect(list.listener).toHaveBeenCalledTimes(1);
      expect(list.get().zone).toBe(value.zones[0]);
      expect(list.get().display).toBe(value.zones[0]);
      expect(list.get().items).toBe(value.items);
      expect(list.get().revision).toBe(value.revision);
    },
  );

  it('publishes zone removal and restoration without leaking a previous display', () => {
    const h = source();
    h.start();
    const list = observeZone(h.store, 'source');
    const removed = { ...h.value, zones: h.value.zones.slice(1) };
    h.publish({ value: removed, displayValue: removed });
    expect(list.get().zone).toBeUndefined();
    expect(list.get().display).toBeUndefined();
    h.publish({ value: h.value, displayValue: h.value });
    expect(list.get().display).toBe(h.value.zones[0]);
    expect(list.listener).toHaveBeenCalledTimes(2);
    list.unsubscribe();
    h.publish({ itemId: 'b' });
    expect(list.listener).toHaveBeenCalledTimes(2);
  });

  it('keeps awaiting-response slots stable and publishes actual order on idle', () => {
    const h = source();
    h.start();
    const list = observeZone(h.store, 'source');
    const candidate = replaceZone(h.value, {
      ...(h.value.zones[0] as ListLayoutZone),
      itemIds: ['b', 'c', 'a'],
    });
    h.publish({
      phase: 'awaiting-response',
      candidate,
      displayValue: candidate,
    });
    expect(list.listener).not.toHaveBeenCalled();
    h.publish({ phase: 'idle', itemId: null });
    expect(list.get()).toMatchObject({
      activeItemId: null,
      scrollEnabled: true,
    });
    expect(list.get().display).toBe(candidate.zones[0]);
    expect(list.listener).toHaveBeenCalledTimes(1);
  });
});

describe('retain rule', () => {
  function candidateOrder(
    h: ReturnType<typeof source>,
    itemIds: string[],
    revision = h.value.revision,
  ) {
    return {
      ...replaceZone(h.value, {
        ...(h.value.zones[0] as ListLayoutZone),
        itemIds,
      }),
      revision,
    };
  }

  it('asks the rule once per drag session and keeps committed slots when it allows', () => {
    const h = source();
    h.start();
    const rule = jest.fn<boolean, [string]>(() => true);
    const list = observeZone(h.store, 'source', rule);
    const before = list.get();
    for (const itemIds of [
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
    ]) {
      const candidate = candidateOrder(h, itemIds, h.value.revision + 1);
      h.publish({ displayValue: candidate, candidate });
    }
    expect(rule).toHaveBeenCalledTimes(1);
    expect(rule).toHaveBeenCalledWith('a');
    expect(list.get()).toBe(before);
    expect(list.get().display).toBe(h.value.zones[0]);
    expect(list.get().displayRevision).toBe(h.value.revision);
    expect(list.listener).not.toHaveBeenCalled();
  });

  it('follows candidate order under the candidate revision when the rule declines, deciding once per session', () => {
    const h = source();
    h.start();
    const rule = jest.fn<boolean, [string]>(() => false);
    const list = observeZone(h.store, 'source', rule);
    const candidate = candidateOrder(h, ['b', 'c', 'a'], h.value.revision + 1);
    h.publish({ displayValue: candidate, candidate });
    expect(list.get().display).toBe(candidate.zones[0]);
    expect(list.get().displayRevision).toBe(h.value.revision + 1);
    expect(list.listener).toHaveBeenCalledTimes(1);
    const again = candidateOrder(h, ['c', 'b', 'a'], h.value.revision + 1);
    h.publish({ displayValue: again, candidate: again });
    expect(list.get().display).toBe(again.zones[0]);
    expect(list.listener).toHaveBeenCalledTimes(2);
    expect(rule).toHaveBeenCalledTimes(1);
    // The next session asks again for its own item.
    h.publish({
      phase: 'idle',
      sessionId: null,
      itemId: null,
      displayValue: h.value,
      candidate: null,
    });
    expect(list.get().display).toBe(h.value.zones[0]);
    expect(list.get().displayRevision).toBe(h.value.revision);
    h.publish({
      phase: 'dragging',
      sessionId: 'next-session',
      itemId: 'b',
      sourceZoneId: 'source',
      targetZoneId: 'source',
    });
    list.get();
    expect(rule).toHaveBeenCalledTimes(2);
    expect(rule).toHaveBeenLastCalledWith('b');
  });

  it('reports the revision of the value a display comes from', () => {
    const h = source();
    h.start();
    const list = observeZone(h.store, 'source');
    // Changed membership shows the candidate itself under its own revision.
    const incoming = candidateOrder(
      h,
      ['a', 'b', 'c', 'd'],
      h.value.revision + 1,
    );
    h.publish({ displayValue: incoming, candidate: incoming });
    expect(list.get().display).toBe(incoming.zones[0]);
    expect(list.get().displayRevision).toBe(h.value.revision + 1);
    // A later candidate with that membership keeps the retained display.
    const reordered = candidateOrder(
      h,
      ['d', 'a', 'b', 'c'],
      h.value.revision + 2,
    );
    h.publish({ displayValue: reordered, candidate: reordered });
    expect(list.get().display).toBe(incoming.zones[0]);
    expect(list.get().displayRevision).toBe(h.value.revision + 1);
    // Committed membership again: the committed zone under its revision.
    h.publish({ displayValue: h.value, candidate: null });
    expect(list.get().display).toBe(h.value.zones[0]);
    expect(list.get().displayRevision).toBe(h.value.revision);
  });
});

describe('item render arguments', () => {
  it('publishes changed list indices independently from retained native slots', () => {
    const h = source();
    h.start();
    const native = h.store.getZoneSnapshot('source');
    const before = ['a', 'b', 'c'].map(id =>
      h.store.getItemSnapshot('source', id),
    );
    const listeners = ['a', 'b', 'c'].map(id => {
      const listener = jest.fn();
      h.store.subscribeSelection(
        () => h.store.getItemSnapshot('source', id),
        listener,
      );
      return listener;
    });
    for (let delivery = 0; delivery < 3; delivery += 1)
      h.publish({
        displayValue: replaceZone(h.value, {
          ...(h.value.zones[0] as ListLayoutZone),
          itemIds: ['b', 'a', 'c'],
        }),
      });
    expect(h.store.getZoneSnapshot('source')).toBe(native);
    expect(h.store.getItemSnapshot('source', 'a')).toEqual({ index: 1 });
    expect(h.store.getItemSnapshot('source', 'b')).toEqual({ index: 0 });
    expect(h.store.getItemSnapshot('source', 'c')).toBe(before[2]);
    expect(listeners[0]).toHaveBeenCalledTimes(1);
    expect(listeners[1]).toHaveBeenCalledTimes(1);
    expect(listeners[2]).not.toHaveBeenCalled();
  });

  it('publishes grid coordinates and placement-array indices independently', () => {
    const h = source();
    h.start();
    const native = h.store.getZoneSnapshot('grid');
    const original = h.value.zones[2] as GridLayoutZone;
    const first = { ...original.placements[0], position: { row: 1, col: 2 } };
    const f = jest.fn();
    const g = jest.fn();
    h.store.subscribeSelection(() => h.store.getItemSnapshot('grid', 'f'), f);
    h.store.subscribeSelection(() => h.store.getItemSnapshot('grid', 'g'), g);
    h.publish({
      displayValue: replaceZone(h.value, {
        ...original,
        placements: [first, original.placements[1]],
      }),
    });
    const moved = h.store.getItemSnapshot('grid', 'f');
    expect(moved).toEqual({ index: 0, row: 1, col: 2 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(g).not.toHaveBeenCalled();
    h.publish({
      displayValue: replaceZone(h.value, {
        ...original,
        placements: [original.placements[1], first],
      }),
    });
    expect(h.store.getItemSnapshot('grid', 'f')).toEqual({
      index: 1,
      row: 1,
      col: 2,
    });
    expect(h.store.getItemSnapshot('grid', 'g')).toEqual({
      index: 0,
      row: 0,
      col: 1,
    });
    expect(f).toHaveBeenCalledTimes(2);
    expect(g).toHaveBeenCalledTimes(1);
    expect(h.store.getZoneSnapshot('grid')).toBe(native);
    expect(moved).toEqual({ index: 0, row: 1, col: 2 });
  });

  it('removes the source item, exposes the target index, and restores both on rollback', () => {
    const h = source();
    h.start();
    const from = jest.fn();
    const to = jest.fn();
    h.store.subscribeSelection(
      () => h.store.getItemSnapshot('source', 'a'),
      from,
    );
    h.store.subscribeSelection(() => h.store.getItemSnapshot('other', 'a'), to);
    const candidate = replaceZone(
      replaceZone(h.value, {
        ...(h.value.zones[0] as ListLayoutZone),
        itemIds: ['b', 'c'],
      }),
      {
        ...(h.value.zones[1] as ListLayoutZone),
        itemIds: ['d', 'a', 'e'],
      },
    );
    h.publish({ displayValue: candidate });
    expect(h.store.getItemSnapshot('source', 'a')).toBeUndefined();
    expect(h.store.getItemSnapshot('other', 'a')).toEqual({ index: 1 });
    h.publish({ displayValue: h.value });
    expect(h.store.getItemSnapshot('source', 'a')).toEqual({ index: 0 });
    expect(h.store.getItemSnapshot('other', 'a')).toBeUndefined();
    expect(from).toHaveBeenCalledTimes(2);
    expect(to).toHaveBeenCalledTimes(2);
  });

  it('returns stable undefined for missing items, missing zones, and absent display values', () => {
    const h = source();
    const missing = jest.fn();
    h.store.subscribeSelection(
      () => h.store.getItemSnapshot('source', 'absent'),
      missing,
    );
    expect(h.store.getItemSnapshot('absent', 'a')).toBeUndefined();
    h.publish({ displayValue: null });
    expect(h.store.getItemSnapshot('source', 'a')).toBeUndefined();
    h.publish({ displayValue: h.value });
    expect(h.store.getItemSnapshot('source', 'a')).toEqual({ index: 0 });
    expect(missing).not.toHaveBeenCalled();
  });

  it('does not conflate separator-like or object-prototype zone and item IDs', () => {
    const h = source();
    h.publish({
      displayValue: {
        ...h.value,
        zones: [
          { id: 'a:b', kind: 'list', orientation: 'vertical', itemIds: ['c'] },
          {
            id: 'a',
            kind: 'list',
            orientation: 'vertical',
            itemIds: ['x', 'b:c'],
          },
          {
            id: '__proto__',
            kind: 'list',
            orientation: 'vertical',
            itemIds: ['constructor', '__proto__'],
          },
        ],
      },
    });
    const first = h.store.getItemSnapshot('a:b', 'c');
    const second = h.store.getItemSnapshot('a', 'b:c');
    expect(first).toEqual({ index: 0 });
    expect(second).toEqual({ index: 1 });
    expect(h.store.getItemSnapshot('a:b', 'c')).toBe(first);
    expect(h.store.getItemSnapshot('a', 'b:c')).toBe(second);
    expect(h.store.getItemSnapshot('__proto__', '__proto__')).toEqual({
      index: 1,
    });
  });

  it('indexes a display zone once across all mounted-item selections', () => {
    const h = source();
    const ids = Array.from({ length: 5000 }, (_, index) => `entry:${index}`);
    let reads = 0;
    const counted = new Proxy(ids, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    h.publish({
      displayValue: replaceZone(h.value, {
        ...(h.value.zones[0] as ListLayoutZone),
        itemIds: counted,
      }),
    });
    for (let index = 0; index < ids.length; index++)
      expect(h.store.getItemSnapshot('source', ids[index])).toEqual({ index });
    expect(reads).toBe(5000);
    const first = h.store.getItemSnapshot('source', ids[0]);
    for (let index = 0; index < 100; index++)
      expect(h.store.getItemSnapshot('source', ids[0])).toBe(first);
    expect(reads).toBe(5000);
  });
});

describe('approved mixed-zone topology', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each([
    ['same list', 'a', { kind: 'list', zoneId: 'source', index: 2 }],
    ['list to list', 'a', { kind: 'list', zoneId: 'other', index: 1 }],
    [
      'list to grid',
      'a',
      { kind: 'grid', zoneId: 'grid', position: { row: 1, col: 0 } },
    ],
    ['grid to list', 'f', { kind: 'list', zoneId: 'source', index: 1 }],
  ] as const)(
    '%s publishes membership then restores or accepts the complete proposal',
    (_name, itemId, target) => {
      for (const accepted of [true, false]) {
        const value = initial();
        const onChange = jest.fn<
          void,
          [DndValue<string>, DndProposal<string>]
        >();
        const options: DndSessionOptions<string> = {
          value,
          onChange,
          getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
        };
        const coordinator = new DndSessionCoordinator(options);
        const store = new DndRenderStore(coordinator);
        const id = coordinator.start(itemId)!;
        const sourceZoneId = coordinator.getSnapshot().sourceZoneId;
        const selected = value.zones.map(zone => observeZone(store, zone.id));
        coordinator.requestTarget(id, 1, target as LayoutLocation);
        const preview = coordinator.getSnapshot().displayValue!;
        for (const [index, selection] of selected.entries()) {
          const display = selection.get().display!;
          const expected = preview.zones[index];
          expect(display.kind).toBe(expected.kind);
          const ids =
            display.kind === 'list'
              ? display.itemIds
              : display.placements.map(entry => entry.itemId);
          const expectedIds =
            expected.kind === 'list'
              ? expected.itemIds
              : expected.placements.map(entry => entry.itemId);
          expect(new Set(ids)).toEqual(new Set(expectedIds));
          const zoneId = value.zones[index].id;
          const membershipChanged =
            sourceZoneId !== target.zoneId &&
            (zoneId === sourceZoneId || zoneId === target.zoneId);
          expect(selection.listener).toHaveBeenCalledTimes(
            membershipChanged ? 1 : 0,
          );
        }
        const flatIds = selected.flatMap(selection => {
          const display = selection.get().display!;
          return display.kind === 'list'
            ? display.itemIds
            : display.placements.map(entry => entry.itemId);
        });
        expect(flatIds).toHaveLength(value.items.length);
        expect(new Set(flatIds).size).toBe(value.items.length);
        coordinator.release(id, 2, target as LayoutLocation);
        expect(coordinator.getSnapshot().phase).toBe('awaiting-response');
        const proposal = onChange.mock.calls[0][1];
        const response = respondToDndProposal(value, proposal, accepted);
        expect(response.status).toBe(accepted ? 'accepted' : 'rejected');
        coordinator.commit({ ...options, value: response.value });
        expect(coordinator.getSnapshot().phase).toBe('idle');
        for (const [index, selection] of selected.entries()) {
          expect(selection.get().display).toBe(response.value.zones[index]);
          expect(selection.get().zone).toBe(response.value.zones[index]);
          expect(selection.get().scrollEnabled).toBe(true);
          expect(selection.get().activeItemId).toBeNull();
        }
        coordinator.dispose();
      }
    },
  );
});
