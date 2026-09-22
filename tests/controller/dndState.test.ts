import type { LayoutState } from '../../src/contracts';
import {
  createDndStateStore,
  respondToDndProposal,
  respondToValidatedDndProposal,
  type DndProposal,
} from '../../src/controller/dndState';
import { computeLayoutMove } from '../../src/engine/layoutMove';

function initial(): LayoutState<{ title: string }> {
  return {
    revision: 0,
    items: ['a', 'b', 'c'].map(id => ({ id, data: { title: id } })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['a', 'b'],
      },
      {
        id: 'destination',
        kind: 'list',
        orientation: 'horizontal',
        itemIds: ['c'],
      },
      { id: 'grid', kind: 'grid', rows: 2, columns: 3, placements: [] },
    ],
  };
}

function proposal(
  value: LayoutState<{ title: string }>,
  sessionId = 'session',
): DndProposal<{ title: string }> {
  const result = computeLayoutMove({
    value,
    itemId: 'a',
    to: { kind: 'list', zoneId: 'destination', index: 1 },
  });
  if (result.status !== 'ok') throw new Error('Expected move candidate');
  return {
    sessionId,
    itemId: 'a',
    baseRevision: value.revision,
    from: result.from,
    to: result.to,
    value: result.value,
  };
}

describe('normalized state approval', () => {
  it('accepts cross-list changes atomically and preserves caller item references', () => {
    const input = initial();
    const store = createDndStateStore(input);
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    const next = proposal(store.getSnapshot());
    store.onChange(next.value, next);
    expect(store.getSnapshot()).toEqual({
      ...next.value,
      proposalResponse: {
        sessionId: 'session',
        baseRevision: 0,
        accepted: true,
      },
    });
    expect(store.getSnapshot().items).toBe(input.items);
    expect(store.getSnapshot().zones[2]).toBe(input.zones[2]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(input.zones[0]).toHaveProperty('itemIds', ['a', 'b']);
    expect(store.respond(next, true).status).toBe('stale');
    unsubscribe();
    store.setValue(initial());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exposes a validated entry that skips only the baseline pass and keeps candidate checks', () => {
    const current = initial();
    const next = proposal(current);
    expect(respondToValidatedDndProposal(current, next, true)).toEqual(
      respondToDndProposal(current, next, true),
    );
    expect(respondToValidatedDndProposal(current, next, false)).toEqual(
      respondToDndProposal(current, next, false),
    );

    const replacedItems = {
      ...next,
      value: {
        ...next.value,
        items: next.value.items.map(item => ({ ...item })),
      },
    };
    expect(respondToValidatedDndProposal(current, replacedItems, true)).toEqual(
      respondToDndProposal(current, replacedItems, true),
    );
    expect(
      respondToValidatedDndProposal(current, replacedItems, true).status,
    ).toBe('invalid');
    const corruptCandidate = {
      ...next,
      value: { ...next.value, zones: next.value.zones.slice(0, 2) },
    };
    expect(
      respondToValidatedDndProposal(current, corruptCandidate, true).status,
    ).toBe('invalid');

    const duplicatedBase = {
      ...current,
      items: [...current.items, current.items[0]!],
    };
    expect(respondToDndProposal(duplicatedBase, next, true)).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'duplicate-id' })],
    });
  });

  it('closes every rejected session at the current revision, including non-latest rejections', () => {
    const store = createDndStateStore(initial());
    const before = store.getSnapshot();
    const first = proposal(before, 'first');
    const second = proposal(before, 'second');
    expect(store.respond(first, false).status).toBe('rejected');
    expect(store.respond(second, false).status).toBe('rejected');
    expect(store.respond(first, true).status).toBe('stale');
    expect(store.respond(second, true).status).toBe('stale');
    expect(store.getSnapshot().revision).toBe(0);
    expect(store.getSnapshot().zones).toBe(before.zones);
  });

  it('advances revision for external edits and ignores both old acceptance and rejection', () => {
    const store = createDndStateStore(initial());
    const pending = proposal(store.getSnapshot());
    store.setValue(current => ({
      ...current,
      items: current.items.map(item => ({
        ...item,
        data: { title: 'external' },
      })),
    }));
    const fresh = store.getSnapshot();
    expect(fresh.revision).toBe(1);
    expect(fresh.proposalResponse).toBeUndefined();
    expect(store.respond(pending, true)).toEqual({
      status: 'stale',
      value: fresh,
    });
    expect(store.respond(pending, false)).toEqual({
      status: 'stale',
      value: fresh,
    });
    expect(store.getSnapshot().items[0].data.title).toBe('external');
  });

  it.each([
    'orientation',
    'dimensions',
    'item',
    'missing-item',
    'location',
    'revision',
    'duplicate-reference',
  ])('rejects a complete candidate with invalid %s', mutation => {
    const store = createDndStateStore(initial());
    const current = store.getSnapshot();
    const next = proposal(current);
    if (mutation === 'orientation')
      next.value = {
        ...next.value,
        zones: next.value.zones.map(zone =>
          zone.kind === 'list' ? { ...zone, orientation: 'horizontal' } : zone,
        ),
      };
    if (mutation === 'dimensions')
      next.value = {
        ...next.value,
        zones: next.value.zones.map(zone =>
          zone.kind === 'grid' ? { ...zone, rows: 5 } : zone,
        ),
      };
    if (mutation === 'item')
      next.value = {
        ...next.value,
        items: next.value.items.map(item => ({ ...item })),
      };
    if (mutation === 'missing-item')
      next.value = { ...next.value, items: next.value.items.slice(1) };
    if (mutation === 'location')
      next.to = { kind: 'list', zoneId: 'destination', index: 0 };
    if (mutation === 'revision') next.value = { ...next.value, revision: 5 };
    if (mutation === 'duplicate-reference')
      next.value = {
        ...next.value,
        zones: next.value.zones.map(zone =>
          zone.kind === 'list' ? { ...zone, itemIds: ['a', 'b', 'c'] } : zone,
        ),
      };
    expect(store.respond(next, true).status).toBe('invalid');
    expect(store.getSnapshot()).toBe(current);
  });

  it('rejects invalid metadata and mismatched callback candidates without publishing', () => {
    const store = createDndStateStore(initial());
    const before = store.getSnapshot();
    const next = proposal(before);
    store.onChange({ ...next.value }, next);
    expect(store.getSnapshot()).toBe(before);
    expect(
      respondToDndProposal(before, { ...next, baseRevision: -1 }, true).status,
    ).toBe('invalid');
    expect(
      respondToDndProposal(
        before,
        { ...next, from: { kind: 'list', zoneId: 'source', index: 1 } },
        false,
      ).status,
    ).toBe('invalid');
  });

  it('validates external edits, keeps identical snapshots and detects revision exhaustion', () => {
    const store = createDndStateStore(initial());
    const current = store.getSnapshot();
    expect(() => store.setValue({ ...initial(), items: [] })).toThrow(
      TypeError,
    );
    store.setValue(current);
    expect(store.getSnapshot()).toBe(current);
    const exhausted = createDndStateStore({
      ...initial(),
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(() => exhausted.setValue(initial())).toThrow(RangeError);
  });

  it('never reads opaque data properties to validate and accept item references', () => {
    const value = initial();
    Object.defineProperty(value.items[0], 'data', {
      get: () => {
        throw new Error('opaque');
      },
    });
    const store = createDndStateStore(value);
    expect(store.respond(proposal(store.getSnapshot()), true).status).toBe(
      'accepted',
    );
  });

  it('atomically approves list-to-grid and grid-to-list without reading opaque data', () => {
    const input = initial();
    Object.defineProperty(input.items[0], 'data', {
      get: () => {
        throw new Error('opaque');
      },
    });
    const store = createDndStateStore(input);
    const listener = jest.fn();
    store.subscribe(listener);
    const forward = computeLayoutMove({
      value: store.getSnapshot(),
      itemId: 'a',
      to: { kind: 'grid', zoneId: 'grid', position: { row: 1, col: 0 } },
      gridItem: { span: { rows: 1, cols: 2 }, placement: 'insert' },
    });
    if (forward.status !== 'ok') throw new Error('Expected mixed candidate');
    expect(
      store.respond(
        {
          sessionId: 'to-grid',
          baseRevision: 0,
          itemId: 'a',
          from: forward.from,
          to: forward.to,
          value: forward.value,
        },
        true,
      ).status,
    ).toBe('accepted');
    expect(store.getSnapshot().zones[0]).toHaveProperty('itemIds', ['b']);
    expect(store.getSnapshot().zones[2]).toHaveProperty('placements', [
      {
        itemId: 'a',
        position: { row: 1, col: 0 },
        span: { rows: 1, cols: 2 },
        placement: 'insert',
      },
    ]);
    const back = computeLayoutMove({
      value: store.getSnapshot(),
      itemId: 'a',
      to: { kind: 'list', zoneId: 'destination', index: 1 },
    });
    if (back.status !== 'ok') throw new Error('Expected mixed candidate');
    expect(
      store.respond(
        {
          sessionId: 'to-list',
          baseRevision: 1,
          itemId: 'a',
          from: back.from,
          to: back.to,
          value: back.value,
        },
        true,
      ).status,
    ).toBe('accepted');
    expect(store.getSnapshot().zones[2]).toHaveProperty('placements', []);
    expect(store.getSnapshot().zones[1]).toHaveProperty('itemIds', ['c', 'a']);
    expect(store.getSnapshot().items).toBe(input.items);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects a mixed proposal atomically and refuses a candidate that retained the source reference', () => {
    const store = createDndStateStore(initial());
    const current = store.getSnapshot();
    const result = computeLayoutMove({
      value: current,
      itemId: 'a',
      to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
      gridItem: { span: { rows: 1, cols: 1 } },
    });
    if (result.status !== 'ok') throw new Error('Expected mixed candidate');
    const candidate = {
      sessionId: 'mixed',
      baseRevision: 0,
      itemId: 'a',
      from: result.from,
      to: result.to,
      value: result.value,
    };
    const duplicate = {
      ...candidate,
      value: {
        ...candidate.value,
        zones: candidate.value.zones.map(zone =>
          zone.id === 'source' ? current.zones[0] : zone,
        ),
      },
    };
    expect(store.respond(duplicate, true).status).toBe('invalid');
    expect(store.getSnapshot()).toBe(current);
    expect(store.respond(candidate, false).status).toBe('rejected');
    expect(store.getSnapshot().zones).toBe(current.zones);
    expect(store.respond(candidate, true).status).toBe('stale');
  });
});
