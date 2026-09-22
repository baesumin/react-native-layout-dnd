import {
  createGridStateStore,
  respondToGridProposal,
} from '../../src/controller/gridState';
import { computeMove } from '../../src/engine/move';
import type { GridProposal, RevisionedGridValue } from '../../src/types';

function initial(data: unknown = 'caller data'): RevisionedGridValue<unknown> {
  return {
    revision: 0,
    zones: [
      {
        id: 'source',
        strategy: 'spatial',
        rows: 2,
        columns: 4,
        items: [
          {
            id: 'card',
            span: { rows: 1, cols: 1 },
            position: { row: 0, col: 0 },
            data,
          },
        ],
      },
      {
        id: 'destination',
        strategy: 'spatial',
        rows: 2,
        columns: 4,
        items: [],
      },
      {
        id: 'queue',
        strategy: 'ordered',
        rows: 2,
        columns: 4,
        itemSpan: { rows: 1, cols: 1 },
        items: [],
      },
    ],
  };
}

function proposal(
  current: RevisionedGridValue<unknown>,
  sessionId = 'session',
): GridProposal<unknown> {
  const result = computeMove({
    value: current,
    itemId: 'card',
    to: {
      zoneId: 'destination',
      strategy: 'spatial',
      position: { row: 1, col: 2 },
    },
  });
  if (result.status !== 'ok' || result.value.revision === undefined)
    throw new Error('Expected a complete movement candidate');
  return {
    sessionId,
    baseRevision: current.revision,
    itemId: 'card',
    from: result.from,
    to: result.to,
    value: { ...result.value, revision: result.value.revision },
  };
}

describe('proposal validation and terminal responses', () => {
  it.each([NaN, -0, Symbol('opaque'), () => 'opaque'])(
    'preserves opaque data without interpreting it: %p',
    data => {
      const current = initial(data);
      const result = respondToGridProposal(current, proposal(current), true);
      expect(result.status).toBe('accepted');
      expect(Object.is(result.value.zones[1].items[0].data, data)).toBe(true);
    },
  );

  it('rejects replacing negative zero with positive zero as a caller data edit', () => {
    const current = initial(-0);
    const next = proposal(current);
    next.value.zones[1].items[0] = { ...next.value.zones[1].items[0], data: 0 };
    expect(respondToGridProposal(current, next, true)).toMatchObject({
      status: 'invalid',
      value: current,
    });
  });

  it('treats a rejection as terminal in the standalone reducer', () => {
    const current = initial();
    const next = proposal(current);
    const rejected = respondToGridProposal(current, next, false);
    expect(rejected.status).toBe('rejected');
    expect(respondToGridProposal(rejected.value, next, true)).toEqual({
      status: 'stale',
      value: rejected.value,
    });
    expect(respondToGridProposal(rejected.value, next, false)).toEqual({
      status: 'stale',
      value: rejected.value,
    });
  });

  it('remembers earlier rejected sessions until the revision changes', () => {
    const store = createGridStateStore(initial());
    const first = proposal(store.getSnapshot(), 'first');
    const second = proposal(store.getSnapshot(), 'second');
    const listener = jest.fn();
    store.subscribe(listener);
    expect(store.respond(first, false).status).toBe('rejected');
    expect(store.respond(second, false).status).toBe('rejected');
    const rejected = store.getSnapshot();
    expect(store.respond(first, true)).toEqual({
      status: 'stale',
      value: rejected,
    });
    expect(store.respond(first, false)).toEqual({
      status: 'stale',
      value: rejected,
    });
    expect(listener).toHaveBeenCalledTimes(2);

    store.setValue(initial());
    expect(store.respond(first, true).status).toBe('stale');
    expect(
      store.respond(proposal(store.getSnapshot(), 'first'), true).status,
    ).toBe('accepted');
    expect(store.getSnapshot().revision).toBe(2);
  });

  it('closes the rejected session before subscriber callbacks can respond again', () => {
    const store = createGridStateStore(initial());
    const first = proposal(store.getSnapshot(), 'first');
    const second = proposal(store.getSnapshot(), 'second');
    let entered = false;
    store.subscribe(() => {
      if (entered) return;
      entered = true;
      store.respond(second, false);
      expect(store.respond(first, true).status).toBe('stale');
    });
    store.respond(first, false);
    expect(store.getSnapshot().revision).toBe(0);
    expect(store.getSnapshot().zones[0].items).toHaveLength(1);
  });

  it.each([
    { sessionId: undefined },
    { baseRevision: NaN },
    { itemId: 'absent' },
    {
      from: {
        zoneId: 'source',
        strategy: 'spatial',
        position: { row: 1, col: 0 },
      },
    },
    {
      to: {
        zoneId: 'absent',
        strategy: 'spatial',
        position: { row: 1, col: 2 },
      },
    },
    { to: { zoneId: 'destination', strategy: 'ordered', index: 0 } },
    { to: { zoneId: 'queue', strategy: 'ordered', index: 0.5 } },
  ])('rejects malformed proposal metadata without publishing it: %p', patch => {
    const store = createGridStateStore(initial());
    const current = store.getSnapshot();
    const listener = jest.fn();
    store.subscribe(listener);
    const malformed = {
      ...proposal(current),
      ...patch,
    } as GridProposal<unknown>;
    expect(store.respond(malformed, true).status).toBe('invalid');
    expect(store.respond(malformed, false).status).toBe('invalid');
    expect(store.getSnapshot()).toBe(current);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each(['id', 'rows', 'columns', 'strategy', 'itemSpan'] as const)(
    'rejects candidate changes to zone %s',
    field => {
      const current = initial();
      const next = proposal(current);
      const queue = next.value.zones[2];
      if (queue.strategy !== 'ordered')
        throw new Error('Expected ordered fixture');
      next.value.zones[2] =
        field === 'strategy'
          ? {
              id: queue.id,
              strategy: 'spatial',
              rows: queue.rows,
              columns: queue.columns,
              items: [],
            }
          : {
              ...queue,
              ...(field === 'id' ? { id: 'renamed' } : {}),
              ...(field === 'rows' ? { rows: 3 } : {}),
              ...(field === 'columns' ? { columns: 5 } : {}),
              ...(field === 'itemSpan'
                ? { itemSpan: { rows: 1, cols: 2 } }
                : {}),
            };
      expect(respondToGridProposal(current, next, true)).toMatchObject({
        status: 'invalid',
        value: current,
      });
    },
  );

  it.each(['spatial', 'ordered'] as const)(
    'requires the reported %s destination to match the completed candidate',
    strategy => {
      const current = initial();
      const next = proposal(current);
      next.to =
        strategy === 'spatial'
          ? { zoneId: 'destination', strategy, position: { row: 0, col: 2 } }
          : { zoneId: 'queue', strategy, index: 0 };
      expect(respondToGridProposal(current, next, true).status).toBe('invalid');
    },
  );

  it('ignores an invalid automatic acceptance without publishing a response', () => {
    const store = createGridStateStore(initial());
    const current = store.getSnapshot();
    const next = proposal(current);
    next.value.zones[1] = { ...next.value.zones[1], columns: 5 };
    store.onChange(next.value, next);
    expect(store.getSnapshot()).toBe(current);
    expect(store.getSnapshot().proposalResponse).toBeUndefined();
  });

  it('reports malformed current states and response envelopes without throwing', () => {
    const current = initial();
    const next = proposal(current);
    expect(
      respondToGridProposal(
        {
          ...current,
          revision: undefined,
        } as unknown as RevisionedGridValue<unknown>,
        next,
        true,
      ).status,
    ).toBe('invalid');
    expect(
      respondToGridProposal(
        current,
        null as unknown as GridProposal<unknown>,
        true,
      ).status,
    ).toBe('invalid');
    expect(
      respondToGridProposal(current, next, null as unknown as boolean).status,
    ).toBe('invalid');
  });
});
