import type { LayoutLocation, LayoutState } from '../../src/contracts';
import {
  DndSessionCoordinator,
  type DndSessionOptions,
} from '../../src/controller/dndSession';
import type { DndProposal, DndValue } from '../../src/controller/dndState';
import { PreviewPath } from '../../src/controller/previewPath';
import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';
import type { GridValue, PositionedItem } from '../../src/types';

// Two 2 × 2 widgets share the top rows with a third below; apps fill the
// remaining block. Widgets exchange, apps insert (the home preset).
function item(
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
  placement: 'insert' | 'exchange' = 'exchange',
  data: unknown = null,
): PositionedItem<unknown> {
  return { id, data, placement, position: { row, col }, span: { rows, cols } };
}

function widgets(data: unknown = null, revision?: number): GridValue<unknown> {
  return {
    ...(revision === undefined ? {} : { revision }),
    zones: [
      {
        id: 'home',
        strategy: 'spatial',
        rows: 5,
        columns: 4,
        items: [
          item('w1', 0, 0, 2, 2, 'exchange', data),
          item('w2', 0, 2, 2, 2, 'exchange', data),
          item('w3', 2, 0, 2, 2, 'exchange', data),
          item('a1', 2, 2, 1, 1, 'insert', data),
          item('a2', 2, 3, 1, 1, 'insert', data),
          item('a3', 3, 2, 1, 1, 'insert', data),
          item('a4', 3, 3, 1, 1, 'insert', data),
        ],
      },
      { id: 'other', strategy: 'spatial', rows: 5, columns: 4, items: [] },
    ],
  };
}

function positions(value: GridValue<unknown> | LayoutState<unknown> | null) {
  return Object.fromEntries(
    value?.zones.flatMap(zone =>
      'strategy' in zone
        ? zone.strategy === 'spatial'
          ? zone.items.map(entry => [entry.id, entry.position])
          : []
        : zone.kind === 'grid'
          ? zone.placements.map(entry => [entry.itemId, entry.position])
          : [],
    ) ?? [],
  );
}

const apps = {
  a1: { row: 2, col: 2 },
  a2: { row: 2, col: 3 },
  a3: { row: 3, col: 2 },
  a4: { row: 3, col: 3 },
};
const initialPositions = {
  w1: { row: 0, col: 0 },
  w2: { row: 0, col: 2 },
  w3: { row: 2, col: 0 },
  ...apps,
};
// w1 over w2: the two top widgets swap.
const swappedTop = {
  w1: { row: 0, col: 2 },
  w2: { row: 0, col: 0 },
  w3: { row: 2, col: 0 },
  ...apps,
};
// w1 then over w3, computed from the swapped layout: w2 keeps its new place.
const cumulative = {
  w1: { row: 2, col: 0 },
  w2: { row: 0, col: 0 },
  w3: { row: 0, col: 2 },
  ...apps,
};
// The same target computed from the committed layout instead.
const fromCommitted = {
  w1: { row: 2, col: 0 },
  w2: { row: 0, col: 2 },
  w3: { row: 0, col: 0 },
  ...apps,
};

describe('PreviewPath', () => {
  const same = (first: string, second: string) => first === second;
  const rebase = jest.fn(
    (value: string, committed: string) => `${value}@${committed}`,
  );
  const step = (target: string, value: string) => ({
    target,
    from: 'A',
    to: target,
    value,
  });

  beforeEach(() => rebase.mockClear());

  it('builds on the newest step, restores visited targets and resets at the origin', () => {
    const path = new PreviewPath<string, string>(same, rebase);
    expect(path.resolve('committed', 'A', 'B')).toEqual({
      kind: 'compute',
      base: 'committed',
      cumulative: false,
    });
    path.push('committed', step('B', 'layoutB'));
    expect(path.resolve('committed', 'A', 'C')).toEqual({
      kind: 'compute',
      base: 'layoutB',
      cumulative: true,
    });
    path.push('committed', step('C', 'layoutC'));
    path.push('committed', step('D', 'layoutD'));
    expect(path.length).toBe(3);
    expect(path.resolve('committed', 'A', 'B')).toEqual({
      kind: 'restored',
      step: step('B', 'layoutB'),
    });
    // Steps after the restored one are forgotten.
    expect(path.length).toBe(1);
    expect(path.resolve('committed', 'A', 'D')).toEqual({
      kind: 'compute',
      base: 'layoutB',
      cumulative: true,
    });
    expect(path.resolve('committed', 'A', 'A')).toEqual({
      kind: 'compute',
      base: 'committed',
      cumulative: false,
    });
    expect(path.length).toBe(0);
    expect(rebase).not.toHaveBeenCalled();
  });

  it('rebases every stored step once per new committed value', () => {
    const path = new PreviewPath<string, string>(same, rebase);
    path.push('v1', step('B', 'layoutB'));
    path.push('v1', step('C', 'layoutC'));
    expect(path.resolve('v1', 'A', 'D').kind).toBe('compute');
    expect(rebase).not.toHaveBeenCalled();
    expect(path.resolve('v2', 'A', 'B')).toEqual({
      kind: 'restored',
      step: step('B', 'layoutB@v2'),
    });
    expect(rebase).toHaveBeenCalledTimes(2);
    path.push('v2', step('C', 'layoutC2'));
    expect(path.resolve('v2', 'A', 'E')).toEqual({
      kind: 'compute',
      base: 'layoutC2',
      cumulative: true,
    });
    expect(rebase).toHaveBeenCalledTimes(2);
  });
});

function layout(revision = 0): LayoutState<string> {
  const ids = ['w1', 'w2', 'w3', 'a1', 'a2', 'a3', 'a4'];
  const home = widgets().zones[0];
  if (home.strategy !== 'spatial') throw new Error('Expected a spatial zone');
  return {
    revision,
    items: ids.map(id => ({ id, data: id })),
    zones: [
      {
        id: 'home',
        kind: 'grid',
        rows: 5,
        columns: 4,
        placements: home.items.map(entry => ({
          itemId: entry.id,
          position: entry.position,
          span: entry.span,
          placement: entry.placement!,
        })),
      },
      { id: 'other', kind: 'grid', rows: 5, columns: 4, placements: [] },
    ],
  };
}

const grid = (row: number, col: number, zoneId = 'home'): LayoutLocation => ({
  kind: 'grid',
  zoneId,
  position: { row, col },
});

function dndHarness(overrides: Partial<DndSessionOptions<string>> = {}) {
  const onChange = jest.fn<void, [DndValue<string>, DndProposal<string>]>();
  const onDragEnd = jest.fn();
  let options: DndSessionOptions<string> = {
    value: layout(),
    movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    ...overrides,
    onChange,
    onDragEnd,
  };
  const session = new DndSessionCoordinator(options);
  return {
    session,
    onChange,
    onDragEnd,
    get value() {
      return options.value;
    },
    commit(patch: Partial<DndSessionOptions<string>>) {
      options = { ...options, ...patch };
      session.commit(options);
    },
    start() {
      const id = session.start('w1');
      if (!id) throw new Error('Expected a started session');
      return id;
    },
    preview(id: string, seq: number, to: LayoutLocation | null) {
      session.requestTarget(id, seq, to);
      return session.getSnapshot();
    },
    proposal() {
      const call = onChange.mock.calls[onChange.mock.calls.length - 1];
      if (!call) throw new Error('Expected a proposal');
      return call[1];
    },
  };
}

describe('DndSessionCoordinator cumulative grid previews', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('exchanges against the displayed layout, restores visited targets and the origin', () => {
    const h = dndHarness();
    expect(positions(h.value)).toEqual(initialPositions);
    const id = h.start();
    const second = h.preview(id, 1, grid(0, 2));
    expect(positions(second.candidate)).toEqual(swappedTop);
    const third = h.preview(id, 2, grid(2, 0));
    expect(third.validity).toBe('valid');
    expect(positions(third.candidate)).toEqual(cumulative);
    expect(third.candidate).toMatchObject({ revision: 1 });
    expect(third.candidate!.items).toBe(h.value.items);
    expect(h.preview(id, 3, grid(0, 2)).candidate).toBe(second.candidate);
    const origin = h.preview(id, 4, grid(0, 0));
    expect(origin.validity).toBe('valid');
    expect(origin.candidate).toBe(h.value);
    expect(positions(h.preview(id, 5, grid(2, 0)).candidate)).toEqual(
      fromCommitted,
    );
  });

  it('proposes the displayed cumulative layout from the committed origin', () => {
    const h = dndHarness({ value: layout(7) });
    const id = h.start();
    h.preview(id, 1, grid(0, 2));
    const shown = h.preview(id, 2, grid(2, 0)).candidate;
    h.session.release(id, 3, grid(2, 0));
    const proposal = h.proposal();
    expect(proposal.value).toBe(shown);
    expect(proposal).toMatchObject({
      itemId: 'w1',
      baseRevision: 7,
      from: grid(0, 0),
      to: grid(2, 0),
    });
    expect(proposal.value.revision).toBe(8);
    expect(positions(proposal.value)).toEqual(cumulative);
    h.commit({
      value: {
        ...proposal.value,
        proposalResponse: { sessionId: id, baseRevision: 7, accepted: true },
      },
    });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'proposed', response: 'accepted' }),
    );
  });

  it.each([
    ['every zone', null],
    ['another zone', grid(0, 0, 'other')],
  ] as const)(
    'starts over from the committed layout after leaving for %s',
    (_name, away) => {
      const h = dndHarness();
      const id = h.start();
      expect(positions(h.preview(id, 1, grid(0, 2)).candidate)).toEqual(
        swappedTop,
      );
      h.preview(id, 2, away);
      expect(positions(h.preview(id, 3, grid(2, 0)).candidate)).toEqual(
        fromCommitted,
      );
    },
  );

  it('starts over from the committed layout after a rejected candidate', () => {
    const h = dndHarness({
      canDrop: proposal =>
        proposal.to.kind === 'grid' &&
        proposal.to.position.row === 2 &&
        proposal.to.position.col === 2
          ? { allowed: false, reason: 'locked' }
          : { allowed: true },
    });
    const id = h.start();
    h.preview(id, 1, grid(0, 2));
    const rejected = h.preview(id, 2, grid(2, 2));
    expect(rejected.validity).toBe('invalid');
    expect(rejected.candidate).toBeNull();
    expect(positions(h.preview(id, 3, grid(2, 0)).candidate)).toEqual(
      fromCommitted,
    );
  });

  it('gives stored previews the item objects of a same-layout recommit', () => {
    const h = dndHarness();
    const id = h.start();
    const second = h.preview(id, 1, grid(0, 2)).candidate;
    const fresh = { ...layout(), items: layout().items };
    h.commit({ value: fresh });
    expect(h.session.getSnapshot().phase).toBe('dragging');
    const third = h.preview(id, 2, grid(2, 0)).candidate!;
    expect(third.items).toBe(fresh.items);
    expect(positions(third)).toEqual(cumulative);
    const restored = h.preview(id, 3, grid(0, 2)).candidate!;
    expect(restored).not.toBe(second);
    expect(restored.items).toBe(fresh.items);
    expect(positions(restored)).toEqual(swappedTop);
  });
});
