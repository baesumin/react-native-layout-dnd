import { computeZoneLayout } from '../../src/engine/layout';
import type {
  GridItem,
  GridZone,
  OrderedZone,
  SpatialZone,
} from '../../src/types';

function ordered(count = 4): OrderedZone<unknown> {
  return {
    id: 'dock',
    rows: 3,
    columns: 5,
    strategy: 'ordered',
    itemSpan: { rows: 1, cols: 2 },
    items: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      span: { rows: 1, cols: 2 },
      data: null,
    })),
  };
}

describe('computeZoneLayout', () => {
  it('returns ordered row-major slots without using right or bottom remainders', () => {
    const result = computeZoneLayout(ordered(6));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.items.map(item => item.position)).toEqual([
        { row: 0, col: 0 },
        { row: 0, col: 2 },
        { row: 1, col: 0 },
        { row: 1, col: 2 },
        { row: 2, col: 0 },
        { row: 2, col: 2 },
      ]);
    }
    const twoRows = ordered(2);
    twoRows.itemSpan.rows = 2;
    twoRows.items.forEach(item => {
      item.span.rows = 2;
    });
    const taller = computeZoneLayout(twoRows);
    expect(taller.valid && taller.items.map(item => item.position)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 2 },
    ]);
  });

  it('handles an empty zero-capacity zone without dividing by zero', () => {
    expect(computeZoneLayout({ ...ordered(0), rows: 1, columns: 1 })).toEqual({
      valid: true,
      items: [],
    });
  });

  it('returns validation issues instead of partially laying out bad input', () => {
    const result = computeZoneLayout(ordered(7));
    expect(result).toEqual({
      valid: false,
      issues: [
        expect.objectContaining({ code: 'capacity-exceeded', zoneId: 'dock' }),
      ],
    });
    expect(computeZoneLayout(null as unknown as GridZone<unknown>)).toEqual({
      valid: false,
      issues: [expect.objectContaining({ code: 'invalid-structure' })],
    });
  });

  it('preserves spatial coordinates, order, gaps and opaque data references', () => {
    const data = new Map([['opaque', () => null]]);
    const zone: SpatialZone<unknown> = {
      id: 'home',
      rows: 4,
      columns: 4,
      strategy: 'spatial',
      items: [
        {
          id: 'B',
          span: { rows: 1, cols: 1 },
          position: { row: 3, col: 2 },
          data,
        },
      ],
    };
    Object.freeze(zone.items[0].position);
    Object.freeze(zone.items[0].span);
    Object.freeze(zone.items[0]);
    Object.freeze(zone.items);
    Object.freeze(zone);
    const result = computeZoneLayout(zone);
    expect(result).toEqual({ valid: true, items: zone.items });
    if (result.valid) {
      expect(result.items).not.toBe(zone.items);
      expect(result.items[0]).toBe(zone.items[0]);
      expect(result.items[0].data).toBe(data);
    }
  });

  it('adds ordered coordinates without mutating input or traversing data', () => {
    const data: { self?: unknown } = {};
    data.self = data;
    const item: GridItem<unknown> = {
      id: 'A',
      span: { rows: 1, cols: 2 },
      data,
    };
    const zone = { ...ordered(0), items: [item] };
    Object.freeze(item.span);
    Object.freeze(item);
    Object.freeze(zone.items);
    Object.freeze(zone);
    const result = computeZoneLayout(zone);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.items[0].data).toBe(data);
      expect(result.items[0].span).toBe(item.span);
      expect(result.items[0].position).toEqual({ row: 0, col: 0 });
      expect('position' in item).toBe(false);
    }
  });
});
