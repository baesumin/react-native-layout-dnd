import { computeListLayout, ListSizeCache } from '../../src/engine/list';
import type {
  ListLayout,
  ListLayoutEntry,
  ListLayoutInput,
} from '../../src/engine/list';

type Range = { first: number; last: number };
type CellMetrics = {
  index: number;
  offset: number;
  length: number;
  isMounted: boolean;
};
type NativeMetricProps = {
  data: ListLayoutEntry[];
  getItem(data: ListLayoutEntry[], index: number): ListLayoutEntry;
  getItemCount(data: ListLayoutEntry[]): number;
  keyExtractor(item: ListLayoutEntry): string;
  getItemLayout(
    data: ListLayoutEntry[],
    index: number,
  ): Omit<CellMetrics, 'isMounted'>;
};
type NativeMetrics = {
  getCellMetricsApprox(index: number, props: NativeMetricProps): CellMetrics;
  notifyCellLayout(args: {
    cellIndex: number;
    cellKey: string;
    orientation: { horizontal: boolean; rtl: boolean };
    layout: { x: number; y: number; width: number; height: number };
  }): boolean;
};

// Deliberately test the pinned RN implementation instead of duplicating its
// render-window algorithm. These private imports are confined to tests and are
// not dependencies of the published engine or adapter. The real native mount,
// layout, initial-batch retention and gestures still require device testing.
const { default: NativeListMetrics } =
  require('@react-native/virtualized-lists/Lists/ListMetricsAggregator') as {
    default: new () => NativeMetrics;
  };
const { computeWindowedRenderLimits } =
  require('@react-native/virtualized-lists/Lists/VirtualizeUtils') as {
    computeWindowedRenderLimits(
      props: NativeMetricProps,
      maxToRenderPerBatch: number,
      windowSize: number,
      previous: Range,
      metrics: NativeMetrics,
      scroll: {
        dt: number;
        offset: number;
        velocity: number;
        visibleLength: number;
        zoomScale: number;
      },
    ): Range;
  };

const itemIds = Array.from({ length: 5000 }, (_, index) => `item:${index}`);

function layout(overrides: Partial<ListLayoutInput> = {}): ListLayout {
  const result = computeListLayout({
    itemIds,
    orientation: 'vertical',
    crossSize: 240,
    revision: 7,
    estimatedItemSize: 40,
    gap: 8,
    paddingStart: 12,
    paddingEnd: 17,
    ...overrides,
  });
  if (!result.valid) throw new Error('Invalid layout fixture');
  return result;
}

function nativeProps(value: ListLayout): NativeMetricProps {
  return {
    data: value.entries,
    getItem: (data, index) => data[index],
    getItemCount: data => data.length,
    keyExtractor: entry => entry.itemId,
    // Match the adapter's exact flow slots: natural measured/estimated content
    // plus the inter-item gap. Content padding is included in each start.
    getItemLayout: (data, index) => ({
      index,
      offset: data[index].start,
      length: data[index].size + (index < data.length - 1 ? 8 : 0),
    }),
  };
}

function windowAt(
  value: ListLayout,
  offset: number,
  metrics = new NativeListMetrics(),
  previous: Range = { first: 0, last: 9 },
  velocity = 2,
) {
  return computeWindowedRenderLimits(
    nativeProps(value),
    12,
    5,
    previous,
    metrics,
    {
      dt: 16,
      offset,
      velocity,
      visibleLength: 280,
      zoomScale: 1,
    },
  );
}

function expectVisibleItems(value: ListLayout, offset: number, window: Range) {
  const visible = value.entries.filter(
    entry => entry.start < offset + 280 && entry.start + entry.size > offset,
  );
  expect(visible.length).toBeGreaterThan(0);
  expect(window.first).toBeLessThanOrEqual(visible[0].index);
  expect(window.last).toBeGreaterThanOrEqual(visible[visible.length - 1].index);
  // For these 40+ pixel items, even the full 5-screen overscan cannot require
  // 100 cells. A range covering the entire 5,000-item dataset is a regression.
  expect(window.last - window.first + 1).toBeLessThan(100);
}

describe('RN 0.87 FlatList window calculation with adapter flow slots', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'renders a distant %s viewport with a bounded window that excludes the original non-pinned source',
    orientation => {
      const value = layout({ orientation });
      const offset = value.entries[3200].start + 1;
      const metrics = new NativeListMetrics();
      const window = windowAt(value, offset, metrics);
      expectVisibleItems(value, offset, window);
      expect(window.first).toBeGreaterThan(3000);
      expect(window.first).toBeGreaterThan(30);
      expect(
        metrics.getCellMetricsApprox(3200, nativeProps(value)),
      ).toMatchObject({
        index: 3200,
        offset: value.entries[3200].start,
        length: 48,
      });
    },
  );

  it('expands repeated batches around the viewport without bringing a distant source back into the window', () => {
    const value = layout();
    const offset = value.entries[2000].start + 1;
    const metrics = new NativeListMetrics();
    let window: Range = { first: 25, last: 40 };
    for (let batch = 0; batch < 8; batch += 1) {
      window = windowAt(value, offset, metrics, window, 0);
      expectVisibleItems(value, offset, window);
      expect(window.first).toBeGreaterThan(1900);
    }
    expect(window.first).toBeLessThan(2000);
    expect(window.last).toBeGreaterThan(2006);
  });

  it('uses corrected ID sizes when estimates before the viewport become actual measurements', () => {
    const cache = new ListSizeCache();
    const before = layout({ cache });
    const offset = before.entries[2500].start + 1;
    const metrics = new NativeListMetrics();
    const first = windowAt(before, offset, metrics);
    expectVisibleItems(before, offset, first);
    for (let index = 2000; index < 2100; index += 1) {
      cache.set(
        `item:${index}`,
        100,
        { orientation: 'vertical', crossSize: 240 },
        7,
      );
    }
    const after = layout({ cache });
    const corrected = windowAt(after, offset, metrics, first);
    expectVisibleItems(after, offset, corrected);
    // The newly measured 6,000 pixels before this point change which IDs are
    // visible. RN must consume the new logical metrics instead of old offsets.
    expect(corrected.last).toBeLessThan(first.first);
    expect(after.entries[corrected.first].itemId).not.toBe(
      before.entries[first.first].itemId,
    );
    expect(metrics.getCellMetricsApprox(2500, nativeProps(after)).offset).toBe(
      before.entries[2500].start + 6000,
    );
  });

  it('places an active item at its distant candidate index and keeps surrounding visible candidates mounted', () => {
    const cache = new ListSizeCache();
    cache.set('item:30', 130, { orientation: 'vertical', crossSize: 240 }, 7);
    const baseline = layout({ cache });
    const candidateIds = itemIds.filter(id => id !== 'item:30');
    candidateIds.splice(3000, 0, 'item:30');
    const candidate = layout({ itemIds: candidateIds, cache, revision: 8 });
    const offset = candidate.entries[3000].start + 1;
    const metrics = new NativeListMetrics();
    const baselineWindow = windowAt(baseline, offset, metrics);
    const candidateWindow = windowAt(
      candidate,
      offset,
      metrics,
      baselineWindow,
    );
    expectVisibleItems(candidate, offset, candidateWindow);
    expect(candidateWindow.first).toBeLessThanOrEqual(3000);
    expect(candidateWindow.last).toBeGreaterThanOrEqual(3000);
    expect(candidate.entries[3000]).toMatchObject({
      itemId: 'item:30',
      size: 130,
      source: 'measured',
    });
    expect(
      metrics.getCellMetricsApprox(3000, nativeProps(candidate)),
    ).toMatchObject({
      index: 3000,
      offset: candidate.entries[3000].start,
      length: 138,
    });
    expect(candidateWindow.first).toBeGreaterThan(30);
  });

  it('bounds the final viewport correctly without a phantom trailing gap', () => {
    const value = layout();
    const offset = value.totalSize - 280;
    const window = windowAt(value, offset);
    expectVisibleItems(value, offset, window);
    expect(window.last).toBe(value.entries.length - 1);
    const last = new NativeListMetrics().getCellMetricsApprox(
      4999,
      nativeProps(value),
    );
    expect(last.length).toBe(40);
    expect(last.offset + last.length + 17).toBe(value.totalSize);
  });

  it('returns an empty render window for an empty padded list', () => {
    const value = layout({ itemIds: [] });
    expect(value.totalSize).toBe(29);
    expect(windowAt(value, 0)).toEqual({ first: 0, last: -1 });
  });
});
