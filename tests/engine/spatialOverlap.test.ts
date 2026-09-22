import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';
import { computeMove } from '../../src/engine/move';
import { validateValue } from '../../src/engine/validation';
import type {
  CellPosition,
  GridValue,
  PositionedItem,
  SpatialZone,
} from '../../src/types';

function item(
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
): PositionedItem<null> {
  return {
    id,
    data: null,
    placement: rows === 1 && cols === 1 ? 'insert' : 'exchange',
    position: { row, col },
    span: { rows, cols },
  };
}

function home(
  items: PositionedItem<null>[],
  rows = 5,
  columns = 4,
): GridValue<null> {
  return { zones: [{ id: 'home', strategy: 'spatial', rows, columns, items }] };
}

function move(value: GridValue<null>, position: CellPosition) {
  return computeMove({
    movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    value,
    itemId: 'widget',
    to: { zoneId: 'home', strategy: 'spatial', position },
    searchBudget: 1,
  });
}

function positions(value: GridValue<null>) {
  return Object.fromEntries(
    (value.zones[0] as SpatialZone<null>).items.map(current => [
      current.id,
      current.position,
    ]),
  );
}

it('moves the 4×4 home widget upward, carrying top apps and their hole into the last row', () => {
  const value = home([
    item('A', 0, 0),
    item('B', 0, 1),
    item('C', 0, 2),
    item('widget', 1, 0, 4, 4),
  ]);
  const before = JSON.stringify(value);
  const result = move(value, { row: 0, col: 0 });
  expect(result).toMatchObject({
    status: 'ok',
    attempts: 1,
    to: { position: { row: 0, col: 0 } },
  });
  if (result.status !== 'ok') throw new Error(result.status);
  expect(validateValue(result.value)).toEqual({ valid: true });
  expect(positions(result.value)).toEqual({
    A: { row: 4, col: 0 },
    B: { row: 4, col: 1 },
    C: { row: 4, col: 2 },
    widget: { row: 0, col: 0 },
  });
  const reversed = move(result.value, { row: 1, col: 0 });
  expect(reversed.status).toBe('ok');
  if (reversed.status !== 'ok') throw new Error(reversed.status);
  expect(positions(reversed.value)).toEqual(positions(value));
  expect(JSON.stringify(value)).toBe(before);
});

it('moves horizontally while preserving rows, holes, and items outside the exchanged area', () => {
  const fixed = item('fixed', 0, 5);
  const value = home(
    [item('A', 0, 0), item('B', 2, 0), item('widget', 0, 1, 4, 4), fixed],
    4,
    6,
  );
  const result = move(value, { row: 0, col: 0 });
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(result.status);
  expect(positions(result.value)).toEqual({
    A: { row: 0, col: 4 },
    B: { row: 2, col: 4 },
    widget: { row: 0, col: 0 },
    fixed: { row: 0, col: 5 },
  });
  expect(result.value.zones[0].items.find(entry => entry.id === 'fixed')).toBe(
    fixed,
  );
  const reversed = move(result.value, { row: 0, col: 1 });
  expect(reversed.status).toBe('ok');
  if (reversed.status !== 'ok') throw new Error(reversed.status);
  expect(positions(reversed.value)).toEqual(positions(value));
});

it('supports diagonal cycles when each whole item fits the vacated source area', () => {
  const result = move(
    home(
      [
        item('corner', 0, 0),
        item('top', 0, 2),
        item('left', 2, 0),
        item('widget', 1, 1, 3, 3),
      ],
      4,
      4,
    ),
    { row: 0, col: 0 },
  );
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(result.status);
  expect(validateValue(result.value)).toEqual({ valid: true });
  expect(positions(result.value)).toEqual({
    corner: { row: 3, col: 3 },
    top: { row: 1, col: 3 },
    left: { row: 3, col: 1 },
    widget: { row: 0, col: 0 },
  });
});

it('carries a smaller widget as one whole item into the vacated row', () => {
  const result = move(
    home([item('small', 0, 1, 1, 2), item('widget', 1, 0, 4, 4)]),
    { row: 0, col: 0 },
  );
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(result.status);
  expect(positions(result.value)).toEqual({
    small: { row: 4, col: 1 },
    widget: { row: 0, col: 0 },
  });
  expect(result.value.zones[0].items[0].span).toEqual({ rows: 1, cols: 2 });
});

it('moves a full-width band when the old overlapping cycles would split a smaller widget', () => {
  const value = home(
    [item('small', 0, 0, 2, 1), item('widget', 3, 0, 4, 2)],
    7,
    2,
  );
  const result = move(value, { row: 0, col: 0 });
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(result.status);
  expect(positions(result.value)).toEqual({
    small: { row: 4, col: 0 },
    widget: { row: 0, col: 0 },
  });
  expect(validateValue(result.value)).toEqual({ valid: true });
  const reversed = move(result.value, { row: 3, col: 0 });
  expect(reversed.status).toBe('ok');
  if (reversed.status !== 'ok') throw new Error(reversed.status);
  expect(positions(reversed.value)).toEqual(positions(value));
});

it('still rejects a narrow widget exchange cutting through a wider neighbor', () => {
  const value = home(
    [item('small', 0, 0, 1, 2), item('widget', 1, 1, 2, 2)],
    3,
    3,
  );
  const before = JSON.stringify(value);
  expect(validateValue(value)).toEqual({ valid: true });
  expect(move(value, { row: 0, col: 1 })).toEqual({
    status: 'impossible',
    attempts: 1,
  });
  expect(JSON.stringify(value)).toBe(before);
});

it('rejects out-of-bounds widget targets before attempting an exchange', () => {
  const value = home([item('A', 0, 0), item('widget', 1, 0, 4, 4)]);
  expect(move(value, { row: -1, col: 0 })).toEqual({
    status: 'impossible',
    attempts: 0,
  });
});

it('handles a long translation cycle within one attempt without visiting every grid cell', () => {
  const rows = Number.MAX_SAFE_INTEGER;
  const result = move(
    home([item('A', 0, 0), item('widget', 1, 0, rows - 1, 1)], rows, 1),
    { row: 0, col: 0 },
  );
  expect(result).toMatchObject({ status: 'ok', attempts: 1 });
  if (result.status !== 'ok') throw new Error(result.status);
  expect(positions(result.value)).toEqual({
    A: { row: rows - 1, col: 0 },
    widget: { row: 0, col: 0 },
  });
});
