import { computeMove } from '../../src/engine/move';
import type { GridMovementPolicy } from '../../src/engine/movementPolicy';
import { validateValue } from '../../src/engine/validation';
import type { GridValue, PositionedItem, SpatialZone } from '../../src/types';

const app = (id: string, row: number, col: number): PositionedItem<null> => ({
  id,
  data: null,
  placement: 'insert',
  span: { rows: 1, cols: 1 },
  position: { row, col },
});
function moveTo(
  items: PositionedItem<null>[],
  id: string,
  row: number,
  col: number,
  rows = 1,
  columns = 4,
  movementPolicy?: GridMovementPolicy,
) {
  const input: GridValue<null> = {
    zones: [{ id: 'home', strategy: 'spatial', rows, columns, items }],
  };
  const before = JSON.stringify(input);
  const result = computeMove({
    value: input,
    itemId: id,
    to: { zoneId: 'home', strategy: 'spatial', position: { row, col } },
    searchBudget: 100,
    movementPolicy,
  });
  expect(JSON.stringify(input)).toBe(before);
  if (result.status !== 'ok')
    throw new Error(`Expected a placement, got ${result.status}`);
  expect(validateValue(result.value)).toEqual({ valid: true });
  return (result.value.zones[0] as SpatialZone<null>).items;
}

const positions = (placed: readonly PositionedItem<null>[]) =>
  Object.fromEntries(placed.map(item => [item.id, item.position]));

/** A move to an empty target: every other item keeps its object, not only its cell. */
function place(...args: Parameters<typeof moveTo>) {
  const [items, id] = args;
  const placed = moveTo(...args);
  for (const item of items)
    if (item.id !== id)
      expect(placed.find(other => other.id === item.id)).toBe(item);
  return positions(placed);
}

describe('insertion into a vacant target', () => {
  it.each([1, 3, 4])(
    'keeps free movement of an unaligned larger insert item to column %i',
    col => {
      const wide = { ...app('wide', 0, 1), span: { rows: 1, cols: 2 } };
      expect(place([wide], 'wide', 0, col, 1, 6)).toEqual({
        wide: { row: 0, col },
      });
    },
  );

  it('keeps incompatible insertion slots fixed when moving into an empty target', () => {
    const wide = { ...app('wide', 0, 1), span: { rows: 1, cols: 2 } };
    expect(place([app('A', 0, 0), wide], 'A', 0, 3)).toEqual({
      A: { row: 0, col: 3 },
      wide: { row: 0, col: 1 },
    });
  });

  it('turns A B C empty into A empty C B and leaves the hole at the source', () => {
    expect(
      place([app('A', 0, 0), app('B', 0, 1), app('C', 0, 2)], 'B', 0, 3),
    ).toEqual({
      A: { row: 0, col: 0 },
      C: { row: 0, col: 2 },
      B: { row: 0, col: 3 },
    });
  });

  it('keeps the apps between the source and an earlier empty target in place', () => {
    expect(
      place([app('A', 0, 1), app('B', 0, 2), app('C', 0, 3)], 'C', 0, 0),
    ).toEqual({
      A: { row: 0, col: 1 },
      B: { row: 0, col: 2 },
      C: { row: 0, col: 0 },
    });
  });

  it('keeps apps and holes inside and outside the traversed interval', () => {
    expect(
      place(
        [app('A', 0, 0), app('B', 0, 1), app('C', 0, 3), app('D', 0, 5)],
        'B',
        0,
        4,
        1,
        6,
      ),
    ).toEqual({
      A: { row: 0, col: 0 },
      B: { row: 0, col: 4 },
      C: { row: 0, col: 3 },
      D: { row: 0, col: 5 },
    });
  });

  it('crosses row boundaries without moving a widget or the apps on the way', () => {
    const widget: PositionedItem<null> = {
      id: 'W',
      data: null,
      placement: 'exchange',
      span: { rows: 1, cols: 2 },
      position: { row: 0, col: 2 },
    };
    expect(
      place(
        [
          app('A', 0, 0),
          app('B', 0, 1),
          widget,
          app('C', 1, 0),
          app('D', 1, 2),
        ],
        'B',
        1,
        3,
        2,
        4,
      ),
    ).toEqual({
      A: { row: 0, col: 0 },
      B: { row: 1, col: 3 },
      W: { row: 0, col: 2 },
      C: { row: 1, col: 0 },
      D: { row: 1, col: 2 },
    });
  });

  // A sparse row below a full-width widget: an app in a distant column used to
  // be pulled into the slot the dragged app left.
  describe.each<[string, GridMovementPolicy | undefined]>([
    ['the default policy', undefined],
    [
      'both launcher rules disabled',
      { rowRotation: 'disabled', adjacentInsertExchange: 'disabled' },
    ],
  ])('in a sparse grid with %s', (_name, movementPolicy) => {
    const widget: PositionedItem<null> = {
      id: 'widget',
      data: null,
      placement: 'exchange',
      span: { rows: 2, cols: 4 },
      position: { row: 0, col: 0 },
    };
    it.each([
      [3, 0],
      [4, 3],
      [2, 1],
      [2, 3],
    ])('moves only the dragged app to the empty cell (%i, %i)', (row, col) => {
      expect(
        place(
          [widget, app('web', 2, 0), app('mail', 2, 2)],
          'web',
          row,
          col,
          5,
          4,
          movementPolicy,
        ),
      ).toEqual({
        widget: { row: 0, col: 0 },
        web: { row, col },
        mail: { row: 2, col: 2 },
      });
    });

    // Reading order runs web, other, mail: the app between them must not move.
    it('trades places with the occupant only when the app is dropped on it', () => {
      const other = app('other', 3, 3);
      const placed = moveTo(
        [widget, app('web', 2, 0), other, app('mail', 4, 0)],
        'web',
        4,
        0,
        5,
        4,
        movementPolicy,
      );
      expect(positions(placed)).toEqual({
        widget: { row: 0, col: 0 },
        web: { row: 4, col: 0 },
        other: { row: 3, col: 3 },
        mail: { row: 2, col: 0 },
      });
      expect(placed.find(item => item.id === 'other')).toBe(other);
    });
  });

  it('places an incoming Dock app into a vacancy without shifting the existing home apps', () => {
    const items = [app('A', 0, 0), app('C', 0, 1)];
    const result = computeMove({
      value: {
        zones: [
          { id: 'home', strategy: 'spatial', rows: 1, columns: 4, items },
          {
            id: 'dock',
            strategy: 'ordered',
            rows: 1,
            columns: 4,
            itemSpan: { rows: 1, cols: 1 },
            items: [app('B', 0, 0)],
          },
        ],
      },
      itemId: 'B',
      to: { zoneId: 'home', strategy: 'spatial', position: { row: 0, col: 3 } },
      searchBudget: 100,
    });
    if (result.status !== 'ok') throw new Error(result.status);
    const placed = (result.value.zones[0] as SpatialZone<null>).items;
    expect(placed.find(item => item.id === 'A')).toBe(items[0]);
    expect(placed.find(item => item.id === 'C')).toBe(items[1]);
    expect(placed.find(item => item.id === 'B')?.position).toEqual({
      row: 0,
      col: 3,
    });
  });
});
