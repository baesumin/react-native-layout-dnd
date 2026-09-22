import { computeMove } from '../../src/engine/move';
import { validateValue } from '../../src/engine/validation';
import type { GridValue, PositionedItem, SpatialZone } from '../../src/types';

const app = (id: string, row: number, col: number): PositionedItem<null> => ({
  id,
  data: null,
  placement: 'insert',
  span: { rows: 1, cols: 1 },
  position: { row, col },
});
function shift(
  items: PositionedItem<null>[],
  id: string,
  row: number,
  col: number,
  rows = 1,
  columns = 4,
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
  });
  expect(JSON.stringify(input)).toBe(before);
  if (result.status !== 'ok')
    throw new Error(`Expected insertion, got ${result.status}`);
  expect(validateValue(result.value)).toEqual({ valid: true });
  const placed = (result.value.zones[0] as SpatialZone<null>).items;
  return {
    positions: Object.fromEntries(placed.map(item => [item.id, item.position])),
    placed,
  };
}

describe('insertion into a vacant target', () => {
  it.each([1, 3, 4])(
    'keeps free movement of an unaligned larger insert item to column %i',
    col => {
      const wide = { ...app('wide', 0, 1), span: { rows: 1, cols: 2 } };
      expect(shift([wide], 'wide', 0, col, 1, 6).positions).toEqual({
        wide: { row: 0, col },
      });
    },
  );

  it('keeps incompatible insertion slots fixed when moving into an empty target', () => {
    const wide = { ...app('wide', 0, 1), span: { rows: 1, cols: 2 } };
    const result = shift([app('A', 0, 0), wide], 'A', 0, 3);
    expect(result.positions).toEqual({
      A: { row: 0, col: 3 },
      wide: { row: 0, col: 1 },
    });
    expect(result.placed.find(item => item.id === 'wide')).toBe(wide);
  });

  it('turns A B C empty into A C empty B at the exact requested last slot', () => {
    expect(
      shift([app('A', 0, 0), app('B', 0, 1), app('C', 0, 2)], 'B', 0, 3)
        .positions,
    ).toEqual({
      A: { row: 0, col: 0 },
      C: { row: 0, col: 1 },
      B: { row: 0, col: 3 },
    });
  });

  it('shifts intervening app slots in reverse when the requested vacancy is before the source', () => {
    expect(
      shift([app('A', 0, 1), app('B', 0, 2), app('C', 0, 3)], 'B', 0, 0)
        .positions,
    ).toEqual({
      A: { row: 0, col: 2 },
      B: { row: 0, col: 0 },
      C: { row: 0, col: 3 },
    });
  });

  it('preserves intermediate holes and apps outside the traversed interval', () => {
    expect(
      shift(
        [app('A', 0, 0), app('B', 0, 1), app('C', 0, 3), app('D', 0, 5)],
        'B',
        0,
        4,
        1,
        6,
      ).positions,
    ).toEqual({
      A: { row: 0, col: 0 },
      B: { row: 0, col: 4 },
      C: { row: 0, col: 1 },
      D: { row: 0, col: 5 },
    });
  });

  it('crosses row boundaries while keeping a fixed widget and unrelated holes unchanged', () => {
    const widget: PositionedItem<null> = {
      id: 'W',
      data: null,
      placement: 'exchange',
      span: { rows: 1, cols: 2 },
      position: { row: 0, col: 2 },
    };
    const result = shift(
      [app('A', 0, 0), app('B', 0, 1), widget, app('C', 1, 0), app('D', 1, 2)],
      'B',
      1,
      3,
      2,
      4,
    );
    expect(result.positions).toEqual({
      A: { row: 0, col: 0 },
      B: { row: 1, col: 3 },
      W: { row: 0, col: 2 },
      C: { row: 0, col: 1 },
      D: { row: 1, col: 0 },
    });
    expect(result.placed.find(item => item.id === 'W')).toBe(widget);
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
