import {
  getCellGeometry,
  isPlacementVisible,
  itemRect,
  orderedIndexForCenter,
  readPointerTarget,
  sameTarget,
  sourceItemTarget,
} from '../../src/pointer/geometry';
import {
  EMPTY_MOTION,
  type MeasuredZone,
  type UiMotion,
  type WindowRect,
} from '../../src/runtime/gridRuntime';
import type { ZoneGeometry } from '../../src/components/gridTypes';
import { computeOrderedIndex } from '../../src/engine/orderedTarget';
import type { CellSpan, ItemLocation, OrderedZone } from '../../src/types';

const noPadding = { top: 0, right: 0, bottom: 0, left: 0 };
const fixed = {
  mode: 'fixed',
  cellWidth: 50,
  cellHeight: 50,
  rowGap: 0,
  columnGap: 0,
  padding: noPadding,
} satisfies ZoneGeometry;

function spatial(
  id = 'home',
  rect: WindowRect = { x: 0, y: 0, width: 200, height: 100 },
): MeasuredZone {
  return {
    zone: { id, strategy: 'spatial', rows: 2, columns: 4, items: [] },
    rect,
    geometry: fixed,
    pixelRatio: 1,
    cells: { cellWidth: 50, cellHeight: 50 },
  };
}

function dragging(zones: MeasuredZone[] = [spatial()]): UiMotion {
  return {
    ...EMPTY_MOTION,
    phase: 'dragging',
    token: 1,
    seq: 1,
    itemId: 'active',
    sourceZoneId: 'home',
    zones,
    outlet: { x: 0, y: 0, width: 700, height: 300 },
    target: {
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 0 },
    },
    span: { rows: 1, cols: 1 },
    width: 50,
    height: 50,
    gripX: 0.5,
    gripY: 0.5,
  };
}

function ordered(
  rows: number,
  columns: number,
  span: CellSpan,
  itemCount: number,
): MeasuredZone & { zone: OrderedZone<undefined> } {
  const geometry: ZoneGeometry = {
    ...fixed,
    cellWidth: 17,
    cellHeight: 23,
    rowGap: 3,
    columnGap: 5,
  };
  return {
    zone: {
      id: 'dock',
      strategy: 'ordered',
      rows,
      columns,
      itemSpan: span,
      items: Array.from({ length: itemCount }, (_, index) => ({
        id: `item-${index}`,
        span,
        data: undefined,
      })),
    },
    geometry,
    pixelRatio: 1,
    cells: { cellWidth: 17, cellHeight: 23 },
    rect: {
      x: 0,
      y: 0,
      width: columns * 17 + (columns - 1) * 5,
      height: rows * 23 + (rows - 1) * 3,
    },
  };
}

describe('grid cell geometry', () => {
  test.each([375, 390, 393, 414, 428])(
    'accepts native-rounded demo extents at window width %i',
    windowWidth => {
      const boardWidth = windowWidth - 40;
      const cell = (boardWidth - 5 * 6) / 6;
      const geometry: ZoneGeometry = {
        ...fixed,
        cellWidth: cell,
        cellHeight: cell,
        rowGap: 6,
        columnGap: 6,
      };
      for (const rows of [1, 8]) {
        const height = rows * cell + (rows - 1) * 6;
        // Yoga layout floats and root-relative physical-pixel snapping are two
        // distinct sources of native measurement rounding.
        expect(
          getCellGeometry(
            { rows, columns: 6 },
            geometry,
            Math.fround(boardWidth),
            Math.fround(height),
            3,
          ),
        ).not.toBeNull();
        for (const scale of [1, 2, 3]) {
          for (const origin of [0, 0.2, 0.7]) {
            const measuredHeight = Math.fround(
              (Math.round((origin + height) * scale) -
                Math.round(origin * scale)) /
                scale,
            );
            expect(
              getCellGeometry(
                { rows, columns: 6 },
                geometry,
                boardWidth,
                measuredHeight,
                scale,
              ),
            ).not.toBeNull();
            expect(
              getCellGeometry(
                { rows, columns: 6 },
                geometry,
                boardWidth,
                height - 1.1 / scale,
                scale,
              ),
            ).toBeNull();
          }
        }
      }
    },
  );

  test('fit subtracts padding and gaps before dividing, while fixed keeps explicit cells', () => {
    const geometry: ZoneGeometry = {
      mode: 'fit',
      rowGap: 4,
      columnGap: 6,
      padding: { top: 3, right: 5, bottom: 7, left: 11 },
    };
    const cells = getCellGeometry({ rows: 3, columns: 4 }, geometry, 194, 198);
    expect(cells).toEqual({ cellWidth: 40, cellHeight: 60 });
    expect(getCellGeometry({ rows: 2, columns: 4 }, fixed, 600, 300)).toEqual({
      cellWidth: 50,
      cellHeight: 50,
    });
    expect(
      itemRect({ row: 1, col: 2 }, { rows: 2, cols: 2 }, geometry, cells!),
    ).toEqual({
      x: 103,
      y: 67,
      width: 86,
      height: 124,
    });
  });

  test.each([
    null,
    undefined,
    {},
    { ...fixed, mode: 'unknown' },
    { ...fixed, padding: null },
    { ...fixed, padding: {} },
    { ...fixed, columnGap: -1 },
    { ...fixed, cellWidth: 0 },
    { ...fixed, cellHeight: Number.NaN },
    { ...fixed, cellWidth: Number.MAX_VALUE },
    { ...fixed, rowGap: Number.MAX_VALUE },
    { ...fixed, padding: { ...noPadding, right: Infinity } },
  ])(
    'rejects malformed or overflowing geometry %# without throwing',
    geometry => {
      expect(
        getCellGeometry(
          { rows: 4, columns: 4 },
          geometry as ZoneGeometry,
          200,
          200,
        ),
      ).toBeNull();
    },
  );

  test('rejects zero measurements and fit geometry consumed by padding/gaps', () => {
    expect(getCellGeometry({ rows: 2, columns: 4 }, fixed, 0, 100)).toBeNull();
    expect(
      getCellGeometry({ rows: 2, columns: 4 }, fixed, 200, NaN),
    ).toBeNull();
    expect(
      getCellGeometry({ rows: 0, columns: 4 }, fixed, 200, 100),
    ).toBeNull();
    expect(
      getCellGeometry(
        { rows: 2, columns: 4 },
        { ...fixed, mode: 'fit', columnGap: 100 },
        200,
        100,
      ),
    ).toBeNull();
    expect(
      getCellGeometry({ rows: 2, columns: 4 }, fixed, 199, 100),
    ).toBeNull();
    expect(getCellGeometry({ rows: 2, columns: 4 }, fixed, 200, 99)).toBeNull();
  });
});

describe('resolved placement visibility', () => {
  test('rejects a resolved group anchor outside the outlet even when the requested anchor is visible', () => {
    const home = spatial();
    const outlet = { x: 0, y: 0, width: 100, height: 100 };
    const span = { rows: 2, cols: 2 };
    const requested: ItemLocation = {
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 0 },
    };
    const resolved: ItemLocation = {
      ...requested,
      position: { row: 0, col: 2 },
    };
    expect(isPlacementVisible([home], outlet, requested, span)).toBe(true);
    expect(isPlacementVisible([home], outlet, resolved, span)).toBe(false);
    expect(isPlacementVisible([home], home.rect, resolved, span)).toBe(true);
  });

  test('uses window coordinates and requires containment in both the zone and the outlet', () => {
    const home = spatial('home', { x: 100, y: 200, width: 200, height: 100 });
    const target: ItemLocation = {
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 1, col: 3 },
    };
    const span = { rows: 1, cols: 1 };
    expect(isPlacementVisible([home], home.rect, target, span)).toBe(true);
    expect(
      isPlacementVisible([home], { ...home.rect, x: 251 }, target, span),
    ).toBe(false);
    expect(
      isPlacementVisible(
        [{ ...home, rect: { ...home.rect, width: 175 } }],
        home.rect,
        target,
        span,
      ),
    ).toBe(false);
  });

  test('keeps native physical-pixel edge rounding without admitting a clipped pixel', () => {
    const cell = (388 - 30) / 6;
    const geometry: ZoneGeometry = {
      ...fixed,
      cellWidth: cell,
      cellHeight: cell,
      rowGap: 6,
      columnGap: 6,
    };
    const home: MeasuredZone = {
      ...spatial(),
      zone: { id: 'home', strategy: 'spatial', rows: 8, columns: 6, items: [] },
      rect: { x: 0, y: 0, width: 388, height: Math.fround(8 * cell + 42) },
      geometry,
      cells: { cellWidth: cell, cellHeight: cell },
      pixelRatio: 3,
    };
    const target: ItemLocation = {
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 7, col: 5 },
    };
    const span = { rows: 1, cols: 1 };
    const clipped = { ...home.rect, height: home.rect.height - 1 / 3 };
    expect(isPlacementVisible([home], home.rect, target, span)).toBe(true);
    expect(isPlacementVisible([home], clipped, target, span)).toBe(false);
    expect(
      isPlacementVisible([{ ...home, rect: clipped }], home.rect, target, span),
    ).toBe(false);
  });

  test('maps ordered indices with the declared span, gaps and zone offset', () => {
    const span = { rows: 2, cols: 2 };
    const dock = ordered(4, 6, span, 4);
    dock.rect = { ...dock.rect, x: 10, y: 20 };
    const target: ItemLocation = {
      zoneId: 'dock',
      strategy: 'ordered',
      index: 3,
    };
    expect(isPlacementVisible([dock], dock.rect, target, span)).toBe(true);
    expect(
      isPlacementVisible([dock], { ...dock.rect, height: 90 }, target, span),
    ).toBe(false);
    expect(
      isPlacementVisible([dock], dock.rect, target, { rows: 1, cols: 1 }),
    ).toBe(false);
    for (const index of [-1, 1.5, 5, Number.NaN]) {
      expect(
        isPlacementVisible([dock], dock.rect, { ...target, index }, span),
      ).toBe(false);
    }
    const full = ordered(1, 4, { rows: 1, cols: 1 }, 4);
    expect(
      isPlacementVisible(
        [full],
        full.rect,
        { ...target, index: 4 },
        { rows: 1, cols: 1 },
      ),
    ).toBe(false);
  });

  test('rejects missing zones, strategy mismatches, invalid spans and out-of-bounds coordinates', () => {
    const home = spatial();
    const span = { rows: 1, cols: 1 };
    const target: ItemLocation = {
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 0 },
    };
    expect(isPlacementVisible([], home.rect, target, span)).toBe(false);
    expect(
      isPlacementVisible(
        [home],
        home.rect,
        { zoneId: 'home', strategy: 'ordered', index: 0 },
        span,
      ),
    ).toBe(false);
    for (const position of [
      { row: -1, col: 0 },
      { row: 2, col: 0 },
      { row: 0, col: 4 },
      { row: 0.5, col: 0 },
      { row: 0, col: Number.NaN },
    ]) {
      expect(
        isPlacementVisible([home], home.rect, { ...target, position }, span),
      ).toBe(false);
    }
    for (const invalidSpan of [
      { rows: 0, cols: 1 },
      { rows: 1, cols: -1 },
      { rows: 3, cols: 1 },
      { rows: 1, cols: Number.NaN },
    ]) {
      expect(isPlacementVisible([home], home.rect, target, invalidSpan)).toBe(
        false,
      );
    }
    expect(
      isPlacementVisible([home], { ...home.rect, width: 0 }, target, span),
    ).toBe(false);
    expect(
      isPlacementVisible([{ ...home, pixelRatio: 0 }], home.rect, target, span),
    ).toBe(false);
  });
});

describe('ordered worklet targeting parity', () => {
  test('matches the public pure function for gaps, midpoints, remainders, outside centers and active exclusion', () => {
    for (const [rows, columns, spanRows, spanCols] of [
      [1, 4, 1, 1],
      [3, 5, 1, 2],
      [3, 3, 2, 1],
      [4, 1, 1, 1],
      [2, 3, 2, 2],
    ]) {
      const span = { rows: spanRows, cols: spanCols };
      const capacity =
        Math.floor(rows / spanRows) * Math.floor(columns / spanCols);
      for (const count of [0, Math.ceil(capacity / 2), capacity]) {
        const measured = ordered(rows, columns, span, count);
        const slotWidth = spanCols * 17 + (spanCols - 1) * 5;
        const slotHeight = spanRows * 23 + (spanRows - 1) * 3;
        const xs = [
          -20,
          0,
          slotWidth / 2 - 0.01,
          slotWidth / 2,
          slotWidth / 2 + 0.01,
          slotWidth,
          slotWidth + 2.5,
          measured.rect.width - 0.01,
          measured.rect.width,
          measured.rect.width + 20,
        ];
        const ys = [
          -20,
          0,
          slotHeight / 2 - 0.01,
          slotHeight / 2,
          slotHeight / 2 + 0.01,
          slotHeight,
          slotHeight + 1.5,
          measured.rect.height - 0.01,
          measured.rect.height,
          measured.rect.height + 20,
        ];
        for (const itemId of [null, 'item-0']) {
          for (const x of xs) {
            for (const y of ys) {
              const expected = computeOrderedIndex({
                rows,
                columns,
                itemSpan: span,
                itemCount: count - Number(itemId === 'item-0' && count > 0),
                center: { x, y },
                cellWidth: 17,
                cellHeight: 23,
                rowGap: 3,
                columnGap: 5,
              });
              expect(expected.status).toBe('ok');
              expect(orderedIndexForCenter(measured, itemId, x, y)).toBe(
                expected.status === 'ok' ? expected.index : null,
              );
            }
          }
        }
      }
    }
  });
});

describe('pointer movement and logical targets', () => {
  test('preserves the grabbed ratio while switching to different cell sizes', () => {
    const targetZone: MeasuredZone = {
      ...spatial('large', { x: 300, y: 0, width: 400, height: 200 }),
      geometry: { ...fixed, cellWidth: 100, cellHeight: 100 },
      cells: { cellWidth: 100, cellHeight: 100 },
    };
    const current = {
      ...dragging([spatial(), targetZone]),
      gripX: 0.25,
      gripY: 0.25,
    };
    const next = readPointerTarget(current, 350, 50);
    expect(next).toEqual({
      target: {
        zoneId: 'large',
        strategy: 'spatial',
        position: { row: 0, col: 0 },
      },
      width: 100,
      height: 100,
      x: 325,
      y: 25,
    });
    expect(readPointerTarget({ ...current, ...next }, 250, 50)).toEqual({
      target: null,
      width: 100,
      height: 100,
      x: 225,
      y: 25,
    });
  });

  test('spatial entry and return thresholds differ, and release repeats the same target', () => {
    const current = dragging();
    expect(readPointerTarget(current, 55, 25).target).toEqual(current.target);
    const moved = readPointerTarget(current, 57, 25);
    expect(moved.target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 1 },
    });
    const preview = { ...current, ...moved };
    expect(readPointerTarget(preview, 49, 25).target).toEqual(moved.target);
    expect(readPointerTarget(preview, 43, 25).target).toEqual(current.target);
    expect(readPointerTarget(preview, 57, 25)).toEqual(moved);
  });

  test('ordered insertion boundaries use hysteresis around the moving center', () => {
    const dock = ordered(1, 4, { rows: 1, cols: 1 }, 2);
    const current: UiMotion = {
      ...dragging([dock]),
      sourceZoneId: 'dock',
      width: 17,
      height: 23,
      target: { zoneId: 'dock', strategy: 'ordered', index: 0 },
    };
    expect(readPointerTarget(current, 10, 10).target).toEqual(current.target);
    const moved = readPointerTarget(current, 13, 10);
    expect(moved.target).toEqual({
      zoneId: 'dock',
      strategy: 'ordered',
      index: 1,
    });
    expect(readPointerTarget({ ...current, ...moved }, 7, 10).target).toEqual(
      moved.target,
    );
    expect(readPointerTarget({ ...current, ...moved }, 4, 10).target).toEqual(
      current.target,
    );
  });

  test('stationary ordered activation stays at the original index, including empty IDs', () => {
    const dock = ordered(1, 4, { rows: 1, cols: 1 }, 3);
    dock.zone.id = '';
    dock.zone.items[1].id = '';
    const target = sourceItemTarget(dock, '');
    expect(target).toEqual({ zoneId: '', strategy: 'ordered', index: 1 });
    const current: UiMotion = {
      ...dragging([dock]),
      itemId: '',
      sourceZoneId: '',
      target,
      seq: 0,
      width: 17,
      height: 23,
    };
    const centerX = 22 + 17 / 2;
    const next = readPointerTarget(current, centerX, 23 / 2);
    expect(next.target).toEqual(target);
    expect(
      readPointerTarget({ ...current, ...next, seq: 1 }, centerX, 23 / 2)
        .target,
    ).toEqual(target);
  });

  test('actual zone/outlet exits clear the target and reentry resets cell hysteresis', () => {
    const current = dragging();
    const outside = readPointerTarget(current, 201, 25);
    expect(outside.target).toBeNull();
    expect(outside.width).toBe(50);
    const reentered = readPointerTarget(
      { ...current, ...outside, seq: 2 },
      55,
      25,
    );
    expect(reentered.target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 1 },
    });
    expect(
      readPointerTarget(
        { ...current, outlet: { x: 0, y: 0, width: 100, height: 100 } },
        125,
        25,
      ).target,
    ).toBeNull();
  });

  test('zone entry uses a small inner margin without allowing drops beyond its real edge', () => {
    const current: UiMotion = { ...dragging(), target: null, seq: 2 };
    expect(readPointerTarget(current, 2, 25).target).toBeNull();
    const entered = readPointerTarget(current, 5, 25);
    expect(entered.target).not.toBeNull();
    expect(
      readPointerTarget({ ...current, ...entered }, 1, 25).target,
    ).not.toBeNull();
    expect(
      readPointerTarget({ ...current, ...entered }, -1, 25).target,
    ).toBeNull();
  });

  test('rejects clipped anchored cells even with a visible pointer; the floating preview may cross an edge', () => {
    const current = dragging();
    expect(
      readPointerTarget(
        { ...current, outlet: { x: 0, y: 0, width: 175, height: 100 } },
        165,
        25,
      ).target,
    ).toBeNull();
    const clamped = readPointerTarget(current, 195, 25);
    expect(clamped.target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 3 },
    });
    expect(clamped.x + clamped.width).toBeGreaterThan(200);
  });

  test('fit division rounding does not reject the last visible cell', () => {
    const geometry: ZoneGeometry = { ...fixed, mode: 'fit' };
    const measured: MeasuredZone = {
      zone: { id: 'home', strategy: 'spatial', rows: 1, columns: 3, items: [] },
      geometry,
      pixelRatio: 1,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      cells: getCellGeometry({ rows: 1, columns: 3 }, geometry, 100, 50)!,
    };
    expect(
      readPointerTarget(
        { ...dragging([measured]), width: 100 / 3, outlet: measured.rect },
        90,
        25,
      ).target,
    ).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 2 },
    });
  });

  test('native-rounded fixed edge accepts the last cell but rejects actual clipping and outside pointers', () => {
    const cell = (388 - 30) / 6;
    const geometry: ZoneGeometry = {
      ...fixed,
      cellWidth: cell,
      cellHeight: cell,
      rowGap: 6,
      columnGap: 6,
    };
    const rect = { x: 0, y: 0, width: 388, height: Math.fround(8 * cell + 42) };
    const measured: MeasuredZone = {
      zone: { id: 'home', strategy: 'spatial', rows: 8, columns: 6, items: [] },
      geometry,
      pixelRatio: 3,
      rect,
      cells: getCellGeometry(
        { rows: 8, columns: 6 },
        geometry,
        rect.width,
        rect.height,
        3,
      )!,
    };
    const current = {
      ...dragging([measured]),
      width: cell,
      height: cell,
      outlet: rect,
    };
    const x = 5 * (cell + 6) + cell / 2;
    const y = 7 * (cell + 6) + cell / 2;
    expect(readPointerTarget(current, x, y).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 7, col: 5 },
    });
    expect(
      readPointerTarget(current, x, rect.height + 0.001).target,
    ).toBeNull();
    expect(
      readPointerTarget(
        { ...current, outlet: { ...rect, height: rect.height - 1 / 3 } },
        x,
        y,
      ).target,
    ).toBeNull();
  });

  test('too-large logical spans and nonfinite pointers produce no target', () => {
    const current = dragging();
    expect(
      readPointerTarget({ ...current, span: { rows: 3, cols: 1 } }, 25, 25)
        .target,
    ).toBeNull();
    expect(readPointerTarget(current, NaN, Infinity)).toEqual({
      target: null,
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height,
    });
  });

  test('logical equality includes the zone and strategy', () => {
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(dragging().target, dragging().target)).toBe(true);
    expect(
      sameTarget(
        { zoneId: 'home', strategy: 'ordered', index: 1 },
        { zoneId: 'dock', strategy: 'ordered', index: 1 },
      ),
    ).toBe(false);
    expect(
      sameTarget(dragging().target, {
        zoneId: 'home',
        strategy: 'ordered',
        index: 0,
      }),
    ).toBe(false);
  });
});
