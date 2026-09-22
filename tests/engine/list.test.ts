import {
  computeListIndex,
  computeListLayout,
  ListSizeCache,
} from '../../src/engine/list';
import type {
  ListLayout,
  ListLayoutInput,
  ListMeasurementContext,
} from '../../src/engine/list';

const vertical: ListMeasurementContext = {
  orientation: 'vertical',
  crossSize: 200,
};

function input(overrides: Partial<ListLayoutInput> = {}): ListLayoutInput {
  return {
    itemIds: ['a', 'b', 'c'],
    orientation: 'vertical',
    crossSize: 200,
    estimatedItemSize: 40,
    revision: 4,
    ...overrides,
  };
}

function layout(overrides: Partial<ListLayoutInput> = {}): ListLayout {
  const result = computeListLayout(input(overrides));
  if (!result.valid) throw new Error(JSON.stringify(result));
  return result;
}

describe('ListSizeCache', () => {
  it('retains measurements by ID across a reorder and recomputes rect revisions', () => {
    const cache = new ListSizeCache();
    cache.set('a', 30, vertical, 2);
    cache.set('b', 90, vertical, 3);
    const before = layout({ cache });
    const after = layout({ cache, itemIds: ['b', 'a', 'c'], revision: 5 });
    expect(before.entries.map(entry => entry.size)).toEqual([30, 90, 40]);
    expect(
      after.entries.map(entry => [entry.itemId, entry.start, entry.size]),
    ).toEqual([
      ['b', 0, 90],
      ['a', 90, 30],
      ['c', 120, 40],
    ]);
    expect(after.entries.map(entry => entry.source)).toEqual([
      'measured',
      'measured',
      'estimated',
    ]);
    expect(before.entries.every(entry => entry.revision === 4)).toBe(true);
    expect(after.entries.every(entry => entry.revision === 5)).toBe(true);
  });

  it('invalidates sizes after cross-size, orientation or content epoch changes', () => {
    const cache = new ListSizeCache();
    cache.set('a', 80, vertical, 3);
    expect(cache.get('a', { ...vertical, crossSize: 300 })).toBeUndefined();
    expect(
      cache.get('a', { ...vertical, orientation: 'horizontal' }),
    ).toBeUndefined();
    expect(cache.get('a', { ...vertical, epoch: 1 })).toBeUndefined();
    expect(layout({ cache, measurementEpoch: 1 }).entries[0]).toMatchObject({
      size: 40,
      source: 'estimated',
    });
    expect(cache.set('a', 70, { ...vertical, epoch: 1 }, 4)).toBe(true);
    expect(cache.set('a', 80, vertical, 5)).toBe(false);
    expect(cache.get('a', { ...vertical, epoch: 1 })).toBe(70);
  });

  it('ignores old asynchronous measurements but allows same-revision content remeasurement', () => {
    const cache = new ListSizeCache();
    cache.set('a', 60, vertical, 8);
    expect(cache.set('a', 200, vertical, 7)).toBe(false);
    expect(cache.set('a', 65, vertical, 8)).toBe(true);
    expect(cache.get('a', vertical)).toBe(65);
    expect(cache.set('a', 45, { ...vertical, crossSize: 300 }, 9)).toBe(true);
    expect(cache.set('a', 90, vertical, 8)).toBe(false);
    expect(cache.get('a', vertical)).toBeUndefined();
    expect(cache.get('a', { ...vertical, crossSize: 300 })).toBe(45);
  });

  it('copies the context and can prune or reset stale IDs', () => {
    const cache = new ListSizeCache();
    const context = { ...vertical };
    cache.set('a', 30, context);
    cache.set('b', 40, context);
    context.crossSize = 300;
    expect(cache.get('a', vertical)).toBe(30);
    cache.prune(['b']);
    expect(cache.get('a', vertical)).toBeUndefined();
    expect(cache.get('b', vertical)).toBe(40);
    cache.clear();
    expect(cache.get('b', vertical)).toBeUndefined();
  });

  it.each([-1, NaN, Infinity, '20', null])(
    'rejects invalid size %p without changing a stored size',
    size => {
      const cache = new ListSizeCache();
      cache.set('a', 30, vertical);
      expect(cache.set('a', size as number, vertical)).toBe(false);
      expect(cache.get('a', vertical)).toBe(30);
    },
  );

  it('rejects malformed contexts and measurement revisions', () => {
    const cache = new ListSizeCache();
    expect(cache.set('a', 30, null as unknown as ListMeasurementContext)).toBe(
      false,
    );
    expect(
      cache.get('a', null as unknown as ListMeasurementContext),
    ).toBeUndefined();
    expect(cache.set('a', 30, { ...vertical, epoch: -1 })).toBe(false);
    expect(cache.set('a', 30, { ...vertical, crossSize: NaN })).toBe(false);
    expect(cache.set('a', 30, vertical, 0.5)).toBe(false);
    expect(cache.set(1 as unknown as string, 30, vertical)).toBe(false);
    expect(cache.set('zero', 0, vertical)).toBe(true);
  });
});

describe('computeListLayout', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'computes %s variable-size content rectangles with padding and gaps',
    orientation => {
      const result = layout({
        orientation,
        itemSize: (_itemId, index) => [20, 80, 35][index],
        paddingStart: 12,
        paddingEnd: 18,
        gap: 7,
      });
      expect(result.totalSize).toBe(179);
      expect(result.entries.map(entry => [entry.start, entry.size])).toEqual([
        [12, 20],
        [39, 80],
        [126, 35],
      ]);
      expect(result.entries[1].rect).toEqual(
        orientation === 'vertical'
          ? { x: 0, y: 39, width: 200, height: 80 }
          : { x: 39, y: 0, width: 80, height: 200 },
      );
    },
  );

  it('does not add a trailing gap and includes empty-list padding only', () => {
    expect(
      layout({ itemIds: [], gap: 100, paddingStart: 12, paddingEnd: 8 })
        .totalSize,
    ).toBe(20);
    expect(layout({ itemIds: ['a'], gap: 100, itemSize: 20 }).totalSize).toBe(
      20,
    );
    expect(layout({ itemSize: 0, crossSize: 0 }).totalSize).toBe(0);
  });

  it('uses declared item sizes over cache and tracks measured and estimated geometry honestly', () => {
    const cache = new ListSizeCache();
    cache.set('a', 70, vertical);
    cache.set('b', 50, vertical);
    const result = layout({ cache, itemSize: 50 });
    expect(result.entries.map(entry => entry.size)).toEqual([50, 50, 50]);
    expect(result.entries.map(entry => entry.source)).toEqual([
      'estimated',
      'measured',
      'estimated',
    ]);
    expect(cache.get('a', vertical)).toBe(70);
  });

  it('does not mutate its input order or consult item data', () => {
    const itemIds = Object.freeze(['a', 'b']);
    const itemSize = jest.fn(
      (itemId: string, index: number) => itemId.length + index,
    );
    const result = layout({ itemIds, itemSize });
    expect(result.totalSize).toBe(3);
    expect(itemSize.mock.calls).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it.each([null, undefined, [], 'items', 4])(
    'rejects malformed input %p',
    value => {
      expect(
        computeListLayout(value as unknown as ListLayoutInput),
      ).toMatchObject({
        valid: false,
        issues: [{ code: 'invalid-structure' }],
      });
    },
  );

  it.each([
    { itemIds: ['a', 'a'] },
    { itemIds: ['a', 4] },
    { itemIds: 'items' },
    { orientation: 'diagonal' },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { crossSize: Infinity },
    { estimatedItemSize: NaN },
    { gap: -1 },
    { paddingStart: -1 },
    { paddingEnd: Infinity },
    { measurementEpoch: 0.5 },
    { itemSize: 'auto' },
    { itemSize: () => -1 },
    { itemSize: () => undefined },
    { cache: {} },
  ])('rejects invalid geometry/configuration %p', overrides => {
    expect(
      computeListLayout(input(overrides as Partial<ListLayoutInput>)),
    ).toMatchObject({ valid: false });
  });

  it('rejects overflow and failed size callbacks without partial output', () => {
    expect(
      computeListLayout(input({ itemSize: Number.MAX_VALUE })),
    ).toMatchObject({ valid: false });
    expect(
      computeListLayout(
        input({
          itemIds: [],
          paddingStart: Number.MAX_VALUE,
          paddingEnd: Number.MAX_VALUE,
        }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      computeListLayout(
        input({
          itemSize: () => {
            throw new Error('size error');
          },
        }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ code: 'invalid-configuration', itemId: 'a' }],
    });
  });
});

describe('computeListIndex', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'uses original %s centers, keeping the active footprint for variable sizes',
    orientation => {
      // Original centers: a=10, b=160, c=345. Removing tall b must NOT
      // shift c's threshold to 75 or moving one pixel would reorder b.
      const metrics = layout({
        orientation,
        itemSize: (_id, index) => [20, 260, 90][index],
        gap: 10,
      });
      expect(computeListIndex(metrics, 'b', 160)).toBe(1);
      expect(computeListIndex(metrics, 'b', 161)).toBe(1);
      expect(computeListIndex(metrics, 'b', 344)).toBe(1);
      expect(computeListIndex(metrics, 'b', 345)).toBe(1);
      expect(computeListIndex(metrics, 'b', 346)).toBe(2);
      expect(computeListIndex(metrics, 'b', 10)).toBe(1);
      expect(computeListIndex(metrics, 'b', 9)).toBe(0);
    },
  );

  it('clamps to either end outside the content and supports external IDs and empty targets', () => {
    const metrics = layout({ paddingStart: 10, gap: 8 });
    expect(computeListIndex(metrics, 'b', -500)).toBe(0);
    expect(computeListIndex(metrics, 'b', 10000)).toBe(2);
    expect(computeListIndex(metrics, 'external', 10000)).toBe(3);
    expect(computeListIndex(metrics, 'external', 30)).toBe(0);
    expect(computeListIndex(metrics, 'external', 30.1)).toBe(1);
    expect(computeListIndex(layout({ itemIds: [] }), 'external', 10)).toBe(0);
  });

  it('preserves the original insertion index at tied zero-size centers', () => {
    const metrics = layout({ itemSize: 0 });
    expect(computeListIndex(metrics, 'a', 0)).toBe(0);
    expect(computeListIndex(metrics, 'b', 0)).toBe(1);
    expect(computeListIndex(metrics, 'c', 0)).toBe(2);
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects a non-finite content center %p',
    center => {
      expect(computeListIndex(layout(), 'a', center)).toBeNull();
    },
  );
});
