import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';
import { computeMove } from '../../src/engine/move';
import { hasSameLayout } from '../../src/engine/sameLayout';
import { validateValue } from '../../src/engine/validation';
import type { GridValue, PositionedItem, SpatialZone } from '../../src/types';

function item(
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
  placement: 'insert' | 'exchange' = 'exchange',
): PositionedItem<unknown> {
  return {
    id,
    data: null,
    placement,
    position: { row, col },
    span: { rows, cols },
  };
}

const app = (id: string, row: number, col: number) =>
  item(id, row, col, 1, 1, 'insert');

function home(
  items: PositionedItem<unknown>[],
  rows = 5,
  columns = 4,
): GridValue<unknown> {
  return { zones: [{ id: 'home', strategy: 'spatial', rows, columns, items }] };
}

function move(value: GridValue<unknown>, row: number, col = 0) {
  return computeMove({
    movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    value,
    itemId: 'A',
    to: { zoneId: 'home', strategy: 'spatial', position: { row, col } },
    searchBudget: 1,
  });
}

function positions(value: GridValue<unknown>) {
  return Object.fromEntries(
    (value.zones[0] as SpatialZone<unknown>).items.map(current => [
      current.id,
      current.position,
    ]),
  );
}

function videoLayout() {
  return home([
    item('A', 0, 0, 2, 4),
    item('B', 2, 0, 2, 2),
    app('Mail', 3, 2),
    app('Calendar', 4, 1),
  ]);
}

describe('full-width widget row rotation', () => {
  it('moves the recorded widget to the bottom and reverses the complete layout including holes', () => {
    const initial = videoLayout();
    const down = move(initial, 3);
    expect(down).toMatchObject({
      status: 'ok',
      attempts: 1,
      to: { position: { row: 3, col: 0 } },
    });
    if (down.status !== 'ok') throw new Error(down.status);
    expect(positions(down.value)).toEqual({
      A: { row: 3, col: 0 },
      B: { row: 0, col: 0 },
      Mail: { row: 1, col: 2 },
      Calendar: { row: 2, col: 1 },
    });
    expect(validateValue(down.value)).toEqual({ valid: true });

    const up = move(down.value, 0);
    expect(up).toMatchObject({ status: 'ok', attempts: 1 });
    if (up.status !== 'ok') throw new Error(up.status);
    expect(hasSameLayout(up.value, initial)).toBe(true);
    expect(up.value).toEqual(initial);
  });

  it('rotates intermediate apps even when both the outward and return destinations are empty', () => {
    const initial = home([item('A', 0, 0, 2, 4), app('Mail', 5, 2)], 8);
    const down = move(initial, 6);
    expect(down).toMatchObject({ status: 'ok', attempts: 1 });
    if (down.status !== 'ok') throw new Error(down.status);
    expect(positions(down.value)).toEqual({
      A: { row: 6, col: 0 },
      Mail: { row: 3, col: 2 },
    });

    const up = move(down.value, 0);
    expect(up).toMatchObject({ status: 'ok', attempts: 1 });
    if (up.status !== 'ok') throw new Error(up.status);
    expect(up.value).toEqual(initial);
  });

  it('rejects a widget crossing the corridor boundary even when expanding the old exchange could fit', () => {
    const initial = home([item('A', 0, 0, 2, 4), item('B', 4, 0, 2, 2)], 6);
    const before = JSON.stringify(initial);
    expect(move(initial, 3)).toEqual({ status: 'impossible', attempts: 1 });
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('preserves frozen input, opaque data, and item references outside the rotated rows', () => {
    const above = app('above', 0, 3);
    const below = app('below', 8, 1);
    const mail = app('Mail', 4, 2);
    const opaque = { self: null as unknown };
    opaque.self = opaque;
    mail.data = Object.freeze(opaque);
    const initial = home(
      [above, item('A', 2, 0, 2, 4), mail, item('B', 5, 0, 2, 2), below],
      9,
    );
    for (const zone of initial.zones) {
      for (const current of (zone as SpatialZone<unknown>).items) {
        Object.freeze(current.position);
        Object.freeze(current.span);
        Object.freeze(current);
      }
      Object.freeze(zone.items);
      Object.freeze(zone);
    }
    Object.freeze(initial.zones);
    Object.freeze(initial);
    const result = move(initial, 5);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      above: { row: 0, col: 3 },
      A: { row: 5, col: 0 },
      Mail: { row: 2, col: 2 },
      B: { row: 3, col: 0 },
      below: { row: 8, col: 1 },
    });
    expect(result.value.zones[0].items[0]).toBe(above);
    expect(result.value.zones[0].items[4]).toBe(below);
    result.value.zones[0].items.forEach((current, index) => {
      expect(current.span).toBe(initial.zones[0].items[index].span);
      expect(current.data).toBe(initial.zones[0].items[index].data);
    });
  });

  it('produces the same coordinates and attempt count regardless of the spatial item array order', () => {
    const initial = videoLayout();
    const zone = initial.zones[0] as SpatialZone<unknown>;
    const reordered = home([...zone.items].reverse());
    const first = move(initial, 3);
    const second = move(reordered, 3);
    expect(first).toMatchObject({ status: 'ok', attempts: 1 });
    expect(second).toMatchObject({ status: 'ok', attempts: 1 });
    if (first.status !== 'ok' || second.status !== 'ok')
      throw new Error('Expected both orders to resolve');
    expect(first.to).toEqual(second.to);
    expect(hasSameLayout(first.value, second.value)).toBe(true);
  });

  it('treats an omitted placement as exchange for a full-width widget', () => {
    const active = item('A', 0, 0, 2, 4);
    delete active.placement;
    const initial = home([active, app('Mail', 5, 2)], 8);
    const result = move(initial, 6);
    expect(result).toMatchObject({ status: 'ok', attempts: 1 });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value).Mail).toEqual({ row: 3, col: 2 });
    expect(result.value.zones[0].items[0].placement).toBeUndefined();
  });

  it('retains a zero-attempt move when no other item occupies the traversed rows', () => {
    const fixed = app('fixed', 6, 3);
    const result = move(home([item('A', 0, 0, 2, 4), fixed], 7), 3);
    expect(result).toMatchObject({ status: 'ok', attempts: 0 });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value).A).toEqual({ row: 3, col: 0 });
    expect(result.value.zones[0].items[1]).toBe(fixed);
  });

  it('handles safe-integer grid dimensions in one attempt without allocating grid rows', () => {
    const rows = Number.MAX_SAFE_INTEGER;
    const initial = home(
      [item('A', 0, 0, 2, 4), app('Mail', rows - 3, 2)],
      rows,
    );
    const down = move(initial, rows - 2);
    expect(down).toMatchObject({ status: 'ok', attempts: 1 });
    if (down.status !== 'ok') throw new Error(down.status);
    expect(positions(down.value)).toEqual({
      A: { row: rows - 2, col: 0 },
      Mail: { row: rows - 5, col: 2 },
    });
    const up = move(down.value, 0);
    expect(up.status).toBe('ok');
    if (up.status !== 'ok') throw new Error(up.status);
    expect(hasSameLayout(up.value, initial)).toBe(true);
  });

  it('keeps narrow widget exchange local to the source and target rectangles', () => {
    const middle = app('middle', 2, 1);
    const result = move(
      home([item('A', 0, 0, 2, 2), middle, item('B', 4, 0, 2, 2)], 6),
      4,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      A: { row: 4, col: 0 },
      middle: { row: 2, col: 1 },
      B: { row: 0, col: 0 },
    });
    expect(result.value.zones[0].items[1]).toBe(middle);
  });

  it('keeps app insertion anchored to the requested empty slot', () => {
    const result = move(
      home([app('first', 0, 0), app('A', 0, 1), app('last', 0, 2)]),
      0,
      3,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      first: { row: 0, col: 0 },
      A: { row: 0, col: 3 },
      last: { row: 0, col: 1 },
    });
  });

  it('respects explicit insertion for a full-width item instead of rotating intermediate rows', () => {
    const result = move(
      home(
        [item('A', 0, 0, 1, 4, 'insert'), item('B', 2, 0, 1, 4, 'insert')],
        4,
      ),
      3,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      A: { row: 3, col: 0 },
      B: { row: 0, col: 0 },
    });
  });
});
