import { computeListIndex, computeListLayout } from '../../src/engine/list';
import type { ListLayout, ListLayoutInput } from '../../src/engine/list';
import {
  createListTargetIndex,
  findListTargetIndex,
} from '../../src/engine/listIndex';

function layout(overrides: Partial<ListLayoutInput> = {}): ListLayout {
  const result = computeListLayout({
    itemIds: ['a', 'b', 'c'],
    orientation: 'vertical',
    crossSize: 200,
    estimatedItemSize: 40,
    revision: 4,
    ...overrides,
  });
  if (!result.valid) throw new Error(JSON.stringify(result));
  return result;
}

describe('prepared list target index', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'preserves original %s footprints, directional ties and external insertion',
    orientation => {
      const metrics = layout({
        orientation,
        itemSize: (_id, index) => [20, 260, 90][index],
        gap: 10,
      });
      const index = createListTargetIndex(metrics);
      expect(
        [9, 10, 160, 161, 344, 345, 346].map(center =>
          findListTargetIndex(index, 'b', center),
        ),
      ).toEqual([0, 1, 1, 1, 1, 1, 2]);
      expect(findListTargetIndex(index, null, 10)).toBe(0);
      expect(findListTargetIndex(index, 'external', 10.1)).toBe(1);
      expect(findListTargetIndex(index, 'external', 10000)).toBe(3);
    },
  );

  it('retains each original slot when zero-sized items have identical centers', () => {
    const index = createListTargetIndex(layout({ itemSize: 0 }));
    expect(
      ['a', 'b', 'c', null, 'external'].map(id =>
        findListTargetIndex(index, id, 0),
      ),
    ).toEqual([0, 1, 2, 0, 0]);
    expect(findListTargetIndex(index, 'b', -0.1)).toBe(0);
    expect(findListTargetIndex(index, 'b', 0.1)).toBe(2);
  });

  it('handles empty targets and rejects nonfinite centers', () => {
    const index = createListTargetIndex(layout({ itemIds: [] }));
    expect(findListTargetIndex(index, 'external', 10)).toBe(0);
    for (const center of [NaN, Infinity, -Infinity]) {
      expect(findListTargetIndex(index, 'external', center)).toBeNull();
    }
  });

  it('survives serialization with arbitrary IDs without retaining the layout', () => {
    const metrics = layout({
      itemIds: ['__proto__', 'constructor', 'toString', '$a', '', 'null'],
      itemSize: 0,
    });
    const prepared = createListTargetIndex(metrics);
    // Detach every column the way a runtime copy would, keeping typed arrays.
    const index = {
      ...(JSON.parse(JSON.stringify(prepared)) as typeof prepared),
      thresholds: Float64Array.from(prepared.thresholds),
      entryIndices: Float64Array.from(prepared.entryIndices),
      positions: Int32Array.from(prepared.positions),
      ranks: Int32Array.from(prepared.ranks),
    };
    for (const [position, entry] of metrics.entries.entries()) {
      expect(findListTargetIndex(index, entry.itemId, 0)).toBe(position);
    }
    expect(findListTargetIndex(index, null, 1)).toBe(6);
    metrics.entries[0].start = 100;
    expect(findListTargetIndex(index, 'constructor', 0)).toBe(1);
    expect(computeListIndex(metrics, 'constructor', 0)).toBe(0);
    expect(
      findListTargetIndex(createListTargetIndex(metrics), 'constructor', 0),
    ).toBe(0);
  });

  it('matches the public scan after callers change order, index fields or duplicate IDs', () => {
    const metrics = layout({ itemSize: 0 });
    metrics.entries = [
      metrics.entries[2],
      metrics.entries[0],
      metrics.entries[1],
    ];
    metrics.entries.push({ ...metrics.entries[0], start: -10 });
    const index = createListTargetIndex(metrics);
    for (const id of ['a', 'b', 'c', null, 'external']) {
      for (const center of [-20, -10, -1, 0, 1]) {
        expect(findListTargetIndex(index, id, center)).toBe(
          computeListIndex(metrics, id, center),
        );
      }
    }
  });

  it('matches the scan across deterministic random layouts and boundary crossings', () => {
    let seed = 38291;
    const next = (limit: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % limit;
    };
    for (let trial = 0; trial < 180; trial += 1) {
      const sizes = Array.from({ length: next(120) }, () =>
        next(4) === 0 ? 0 : next(160) / 2,
      );
      const metrics = layout({
        itemIds: sizes.map((_, position) => `item-${position}`),
        itemSize: (_id, position) => sizes[position],
        orientation: next(2) === 0 ? 'vertical' : 'horizontal',
        gap: next(3),
        paddingStart: next(30),
        paddingEnd: next(30),
      });
      const index = createListTargetIndex(metrics);
      const ids = [
        null,
        'external',
        ...metrics.entries
          .filter((_, position) => position % 7 === 0)
          .map(entry => entry.itemId),
      ];
      const centers = [
        -100,
        metrics.totalSize + 100,
        ...metrics.entries.flatMap(entry => {
          const center = entry.start + entry.size / 2;
          return [center - 0.01, center, center + 0.01];
        }),
      ];
      for (const id of ids) {
        expect(
          centers.map(center => findListTargetIndex(index, id, center)),
        ).toEqual(centers.map(center => computeListIndex(metrics, id, center)));
      }
    }
  });

  it('reuses unchanged columns and the slot map when rebuilt for the same item order', () => {
    const first = createListTargetIndex(layout({ itemSize: 40 }));
    const second = createListTargetIndex(layout({ itemSize: 50 }), first);
    expect(second.slots).toBe(first.slots);
    expect(second.positions).toBe(first.positions);
    expect(second.ranks).toBe(first.ranks);
    expect(second.entryIndices).toBe(first.entryIndices);
    expect(second.thresholds).not.toBe(first.thresholds);
    expect(Array.from(second.thresholds)).toEqual([25, 75, 125]);
    expect(findListTargetIndex(second, 'a', 80)).toBe(1);
    const reordered = createListTargetIndex(
      layout({ itemIds: ['b', 'a', 'c'], itemSize: 50 }),
      second,
    );
    expect(reordered.slots).not.toBe(second.slots);
    // Equal columns are shared even when the slot map changed.
    expect(reordered.positions).toBe(second.positions);
    expect(Array.from(reordered.positions)).toEqual([0, 1, 2]);
    expect(findListTargetIndex(reordered, 'a', 80)).toBe(1);
    const nextRevision = createListTargetIndex(
      layout({ itemSize: 50, revision: 5 }),
      second,
    );
    expect(nextRevision.slots).not.toBe(second.slots);
    expect(nextRevision.revision).toBe(5);
  });

  it('reads logarithmically many boundaries for repeated queries of a large list', () => {
    const length = 32768;
    const metrics = layout({
      itemIds: Array.from({ length }, (_, position) => `item-${position}`),
      itemSize: 40,
    });
    const prepared = createListTargetIndex(metrics);
    let boundaryReads = 0;
    const index = {
      ...prepared,
      thresholds: new Proxy(prepared.thresholds, {
        get(target, property) {
          if (typeof property === 'string' && /^\d+$/.test(property))
            boundaryReads += 1;
          // Typed array accessors require the actual buffer as receiver.
          return Reflect.get(target, property);
        },
      }),
      slots: new Proxy(prepared.slots, {
        ownKeys() {
          throw new Error('A query must not scan item IDs.');
        },
      }),
    };
    const queryCount = 128;
    for (let query = 0; query < queryCount; query += 1) {
      const position = (query * 257) % length;
      const center = position * 40 + 21;
      expect(findListTargetIndex(index, 'item-100', center)).toBe(
        position + (position < 100 ? 1 : 0),
      );
    }
    expect(boundaryReads).toBeLessThanOrEqual(
      queryCount * (Math.ceil(Math.log2(length)) + 1),
    );
  });
});
