import {
  createGridStateStore,
  respondToGridProposal,
} from '../../src/controller/gridState';
import {
  DndSessionCoordinator,
  type DndSessionOptions,
} from '../../src/controller/dndSession';
import {
  convertGridValue,
  gridChangeOf,
  type PreviousConversion,
  toLayoutLocation,
} from '../../src/controller/gridAdapter';
import { layoutToGridValue } from '../../src/engine/layoutState';
import { computeMove } from '../../src/engine/move';
import type {
  GridProposal,
  GridValue,
  ItemLocation,
  RevisionedGridValue,
} from '../../src/types';

const target: ItemLocation = {
  zoneId: 'destination',
  strategy: 'spatial',
  position: { row: 1, col: 2 },
};
const initial = (): GridValue<{ title: string }> => ({
  zones: [
    {
      id: 'source',
      strategy: 'spatial',
      rows: 2,
      columns: 5,
      items: [
        {
          id: 'card',
          data: { title: 'original' },
          span: { rows: 1, cols: 2 },
          position: { row: 0, col: 0 },
        },
      ],
    },
    { id: 'destination', strategy: 'spatial', rows: 3, columns: 7, items: [] },
  ],
});

function proposal(
  value: RevisionedGridValue<{ title: string }>,
  sessionId = 'session',
): GridProposal<{ title: string }> {
  const result = computeMove({ value, itemId: 'card', to: target });
  if (result.status !== 'ok' || result.value.revision === undefined)
    throw new Error('Expected candidate');
  return {
    sessionId,
    itemId: 'card',
    baseRevision: value.revision,
    from: result.from,
    to: result.to,
    value: { ...result.value, revision: result.value.revision },
  };
}

describe('revisioned grid state', () => {
  it('accepts a cross-zone proposal atomically, preserving opaque data and notifying once', () => {
    const store = createGridStateStore(initial());
    const before = store.getSnapshot();
    const listener = jest.fn();
    store.subscribe(listener);
    const next = proposal(before);
    store.onChange(next.value, next);
    const after = store.getSnapshot();
    expect(after.revision).toBe(1);
    expect(after.zones[0].items).toEqual([]);
    expect(after.zones[1].items[0].data).toBe(before.zones[0].items[0].data);
    expect(after.proposalResponse).toEqual({
      sessionId: 'session',
      baseRevision: 0,
      accepted: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(before.zones[0].items).toHaveLength(1);
    expect(store.respond(next, true).status).toBe('stale');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects without moving either zone or advancing revision', () => {
    const store = createGridStateStore(initial());
    const before = store.getSnapshot();
    expect(store.respond(proposal(before), false).status).toBe('rejected');
    expect(store.getSnapshot().zones).toBe(before.zones);
    expect(store.getSnapshot().revision).toBe(0);
    expect(store.getSnapshot().proposalResponse?.accepted).toBe(false);
  });

  it('does not let a late acceptance or rejection overwrite an external data edit', () => {
    const store = createGridStateStore(initial());
    const next = proposal(store.getSnapshot());
    store.setValue(current => ({
      zones: current.zones.map(zone =>
        zone.strategy === 'spatial'
          ? {
              ...zone,
              items: zone.items.map(item => ({
                ...item,
                data: { title: 'newer' },
              })),
            }
          : zone,
      ),
    }));
    const fresh = store.getSnapshot();
    expect(fresh.revision).toBe(1);
    expect(store.respond(next, true)).toEqual({
      status: 'stale',
      value: fresh,
    });
    expect(store.respond(next, false)).toEqual({
      status: 'stale',
      value: fresh,
    });
    expect(store.getSnapshot().zones[0].items[0].data.title).toBe('newer');
  });

  it('validates the whole candidate and does not accept removed or replaced caller data', () => {
    const current = createGridStateStore(initial()).getSnapshot();
    const next = proposal(current);
    const missing = {
      ...next,
      value: {
        ...next.value,
        zones: next.value.zones.map(zone => ({ ...zone, items: [] })),
      },
    };
    expect(respondToGridProposal(current, missing, true).status).toBe(
      'invalid',
    );
    next.value.zones[1].items[0] = {
      ...next.value.zones[1].items[0],
      data: { title: 'replacement' },
    };
    expect(respondToGridProposal(current, next, true).status).toBe('invalid');
    expect(current.zones[0].items[0].data.title).toBe('original');
  });

  it('requires a single revision increment and rejects invalid external edits', () => {
    const store = createGridStateStore(initial());
    const current = store.getSnapshot();
    const next = proposal(current);
    next.value.revision = 9;
    expect(store.respond(next, true).status).toBe('invalid');
    expect(() =>
      store.setValue({ zones: [current.zones[0], current.zones[0]] }),
    ).toThrow(TypeError);
    expect(store.getSnapshot()).toBe(current);
    store.setValue(current);
    expect(store.getSnapshot()).toBe(current);
  });

  it('handles revision exhaustion without unsafe increments', () => {
    const store = createGridStateStore({
      ...initial(),
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(
      computeMove({ value: store.getSnapshot(), itemId: 'card', to: target })
        .status,
    ).toBe('invalid');
    expect(() => store.setValue(initial())).toThrow(RangeError);
  });
});

describe('revisioned session integration', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // The grid API over the shared session: values, changes and responses are
  // converted exactly as GridController converts them.
  function setup(
    autoAccept = false,
    initialValue: GridValue<{ title: string }> = initial(),
    to: ItemLocation = target,
  ) {
    const store = createGridStateStore(initialValue);
    const onChange = jest.fn(autoAccept ? store.onChange : undefined);
    const onDragEnd = jest.fn();
    type Card = { title: string };
    let previous: PreviousConversion<Card> | null = null;
    const convert = (value: GridValue<Card>) => {
      const converted = convertGridValue(value, previous, undefined);
      if (!converted.state) throw new Error('Expected a valid grid value');
      previous = {
        value,
        revision: converted.revision,
        state: converted.state,
      };
      return converted.state;
    };
    let options: DndSessionOptions<Card> = {
      value: convert(store.getSnapshot()),
      onChange: (next, proposed) =>
        onChange(layoutToGridValue(next), gridChangeOf(proposed, true)),
      onDragEnd,
    };
    const session = new DndSessionCoordinator(options);
    const commit = (value: GridValue<Card>) => {
      options = { ...options, value: convert(value) };
      session.commit(options);
    };
    store.subscribe(() => commit(store.getSnapshot()));
    const start = () => session.start('card')!;
    const drop = (id: string) => {
      const location = toLayoutLocation(session.getSnapshot().value!, to);
      session.release(id, 1, location);
    };
    const display = () => {
      const value = session.getSnapshot().displayValue;
      return value && layoutToGridValue(value);
    };
    return {
      store,
      session,
      commit,
      start,
      drop,
      display,
      onChange,
      onDragEnd,
    };
  }

  it('uses defaults and synchronously settles the state helper acceptance', () => {
    const h = setup(true);
    const id = h.start();
    h.drop(id);
    expect(h.onChange.mock.calls[0][1].baseRevision).toBe(0);
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'proposed', response: 'accepted' }),
    );
    expect(h.store.getSnapshot().revision).toBe(1);
  });

  it('accepts a page-to-dock move whose accepting commit rebuilds the item data for its new zone', () => {
    // superapp regression: the owner derives dock items from its own model, so
    // the moved app gets a new data object. The legacy path compared placements
    // only; acceptance must not demand item identity.
    const h = setup(
      false,
      {
        zones: [
          initial().zones[0],
          {
            id: 'dock',
            strategy: 'ordered',
            rows: 1,
            columns: 4,
            // The card spans 1×2; an ordered zone accepts only its item span.
            itemSpan: { rows: 1, cols: 2 },
            items: [],
          },
        ],
      },
      { zoneId: 'dock', strategy: 'ordered', index: 0 },
    );
    const id = h.start();
    h.drop(id);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    const [next, change] = h.onChange.mock.calls[0];
    expect(next.zones[1].items.map(item => item.id)).toEqual(['card']);
    h.commit({
      ...next,
      zones: next.zones.map(zone =>
        zone.strategy === 'ordered'
          ? {
              ...zone,
              items: zone.items.map(item => ({
                ...item,
                data: { title: `dock:${item.data.title}` },
              })),
            }
          : zone,
      ),
      proposalResponse: {
        sessionId: id,
        baseRevision: change.baseRevision!,
        accepted: true,
      },
    });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'proposed', response: 'accepted' }),
    );
    expect(h.session.getSnapshot().phase).toBe('idle');
    const shown = h.display()!;
    expect(shown.revision).toBe(next.revision);
    expect(shown.zones[0].items).toHaveLength(0);
    expect(shown.zones[1].items).toEqual([
      expect.objectContaining({ id: 'card', data: { title: 'dock:original' } }),
    ]);
  });

  it('ignores responses from another base revision even if the session ID matches', () => {
    const h = setup();
    const id = h.start();
    h.drop(id);
    h.commit({
      ...h.store.getSnapshot(),
      proposalResponse: { sessionId: id, baseRevision: 99, accepted: false },
    });
    expect(h.session.getSnapshot().phase).toBe('awaiting-response');
    h.commit({
      ...h.store.getSnapshot(),
      proposalResponse: { sessionId: id, baseRevision: 0, accepted: false },
    });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'rejected' }),
    );
  });

  it('rejects acceptance that copies the proposal layout without advancing its revision', () => {
    const h = setup();
    const id = h.start();
    h.drop(id);
    const next = h.onChange.mock.calls[0][0];
    h.commit({
      ...next,
      revision: 0,
      proposalResponse: { sessionId: id, baseRevision: 0, accepted: true },
    });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'mismatch' }),
    );
  });

  it.each(['dragging', 'awaiting-response'] as const)(
    'preserves external same-layout updates during %s',
    phase => {
      const h = setup();
      const id = h.start();
      if (phase === 'awaiting-response') h.drop(id);
      h.store.setValue(initial());
      expect(h.display()).toEqual({
        ...h.store.getSnapshot(),
        zones: h.store.getSnapshot().zones,
      });
      expect(h.onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'input-changed' }),
      );
      expect(h.store.getSnapshot().revision).toBe(1);
      expect(h.store.getSnapshot().zones[0].items).toHaveLength(1);
    },
  );
});
