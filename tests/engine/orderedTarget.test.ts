import { computeZoneLayout } from '../../src/engine/layout';
import { computeMove } from '../../src/engine/move';
import {
  computeOrderedIndex,
  type OrderedIndexInput,
} from '../../src/engine/orderedTarget';
import type { GridValue, OrderedZone } from '../../src/types';

const geometry: OrderedIndexInput = {
  rows: 3,
  columns: 5,
  itemSpan: { rows: 1, cols: 2 },
  itemCount: 4,
  center: { x: 45, y: 5 },
  cellWidth: 10,
  cellHeight: 10,
  rowGap: 0,
  columnGap: 0,
};

describe('ordered insertion boundaries', () => {
  it.each([
    [0, 5, 0],
    [10, 5, 1],
    [30, 5, 2],
    [45, 5, 2],
    [0, 15, 2],
    [30, 15, 4],
    [45, 15, 4],
    [0, 25, 4],
    [45, 25, 4],
    [-100, -100, 0],
    [100, 100, 4],
  ])('maps center (%s, %s) to index %s', (x, y, index) => {
    expect(computeOrderedIndex({ ...geometry, center: { x, y } })).toEqual({
      status: 'ok',
      index,
    });
  });

  it('uses row-end insertion for right remainder in the documented 3x5 example', () => {
    const span = { rows: 1, cols: 2 };
    const target: OrderedZone<string> = {
      id: 'target',
      rows: 3,
      columns: 5,
      strategy: 'ordered',
      itemSpan: span,
      items: ['A', 'B', 'C', 'D'].map(id => ({ id, data: id, span })),
    };
    const value: GridValue<string> = {
      zones: [
        target,
        {
          id: 'source',
          strategy: 'spatial',
          rows: 1,
          columns: 2,
          items: [{ id: 'X', data: 'X', span, position: { row: 0, col: 0 } }],
        },
      ],
    };
    const boundary = computeOrderedIndex(geometry);
    if (boundary.status !== 'ok') throw new Error('Expected boundary');
    const result = computeMove({
      value,
      itemId: 'X',
      to: { zoneId: 'target', strategy: 'ordered', index: boundary.index },
      searchBudget: 1,
    });
    if (result.status !== 'ok') throw new Error('Expected insertion');
    expect(result.value.zones[0].items.map(item => item.id)).toEqual([
      'A',
      'B',
      'X',
      'C',
      'D',
    ]);
    const layout = computeZoneLayout(result.value.zones[0]);
    if (!layout.valid) throw new Error('Expected valid layout');
    expect(layout.items.map(item => item.position)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 2 },
      { row: 1, col: 0 },
      { row: 1, col: 2 },
      { row: 2, col: 0 },
    ]);
  });

  it('resolves a row-gap tie toward the later row', () => {
    const input = { ...geometry, rowGap: 10, center: { x: 0, y: 15 } };
    expect(computeOrderedIndex(input)).toEqual({ status: 'ok', index: 2 });
    expect(
      computeOrderedIndex({ ...input, center: { x: 0, y: 14.9 } }),
    ).toEqual({ status: 'ok', index: 0 });
  });

  it('uses the vertical midpoint when there is one slot per row', () => {
    const input = { ...geometry, columns: 2, rows: 4, itemCount: 3 };
    expect(
      computeOrderedIndex({ ...input, center: { x: 10, y: 4.9 } }),
    ).toEqual({ status: 'ok', index: 0 });
    expect(computeOrderedIndex({ ...input, center: { x: 10, y: 5 } })).toEqual({
      status: 'ok',
      index: 1,
    });
    expect(computeOrderedIndex({ ...input, center: { x: 10, y: 15 } })).toEqual(
      { status: 'ok', index: 2 },
    );
  });

  it('does not invent remainder cells when a center is clamped to an exact outer edge', () => {
    const input = { ...geometry, itemSpan: { rows: 1, cols: 1 } };
    for (const x of [10, 100]) {
      expect(
        computeOrderedIndex({
          ...input,
          rows: 3,
          columns: 1,
          itemCount: 3,
          center: { x, y: 1 },
        }),
      ).toEqual({ status: 'ok', index: 0 });
    }
    for (const y of [10, 100]) {
      expect(
        computeOrderedIndex({
          ...input,
          rows: 1,
          columns: 4,
          itemCount: 4,
          center: { x: 1, y },
        }),
      ).toEqual({ status: 'ok', index: 0 });
    }
  });

  it('appends in unused bottom rows and vacant slots after the last item', () => {
    expect(
      computeOrderedIndex({
        ...geometry,
        rows: 5,
        itemSpan: { rows: 2, cols: 2 },
        center: { x: 0, y: 45 },
      }),
    ).toEqual({ status: 'ok', index: 4 });
    expect(
      computeOrderedIndex({
        ...geometry,
        itemCount: 1,
        center: { x: 21, y: 5 },
      }),
    ).toEqual({ status: 'ok', index: 1 });
    expect(computeOrderedIndex({ ...geometry, itemCount: 0 })).toEqual({
      status: 'ok',
      index: 0,
    });
    expect(
      computeOrderedIndex({ ...geometry, columns: 1, itemCount: 0 }),
    ).toEqual({ status: 'impossible' });
  });

  it('rejects invalid geometry and impossible item counts', () => {
    const result = computeOrderedIndex({ ...geometry, columnGap: -1 });
    expect(result).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-geometry' }],
    });
    expect(
      computeOrderedIndex({ ...geometry, cellWidth: Infinity }).status,
    ).toBe('invalid');
    expect(computeOrderedIndex({ ...geometry, itemCount: 7 })).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'capacity-exceeded' }],
    });
  });
});
