import type { GridLocation, LayoutLocation } from '../../src/contracts';
import { slotIndex, slotPosition } from '../../src/engine/gridPlacements';
import type { GridItemLayout } from '../../src/engine/layoutMove';
import {
  orderedSlotIndex,
  orderedSlotPosition,
} from '../../src/pointer/geometry';
import {
  type DndTargetSession,
  uiLayoutTarget,
} from '../../src/pointer/dndTarget';
import {
  prepareGridTarget,
  resolveLayoutTarget,
} from '../../src/pointer/layoutTarget';
import type {
  DndMotion,
  GridRegistration,
  ListViewport,
  UiZoneRegistration,
  ZoneRegistration,
} from '../../src/runtime/dndRuntime';

const span = { rows: 1, cols: 1 };
const geometry = {
  mode: 'fixed' as const,
  cellWidth: 50,
  cellHeight: 60,
  rowGap: 10,
  columnGap: 10,
  padding: { top: 20, left: 10, right: 10, bottom: 20 },
};

/**
 * A spatial page of 2 x 4 cells at (0, 100) and an ordered dock of one row of
 * four slots at (300, 100), both holding two items.
 */
function board() {
  const page: GridRegistration & { layoutVersion: number } = {
    kind: 'grid',
    zoneId: 'page',
    revision: 4,
    layoutVersion: 2,
    ref: null as unknown as GridRegistration['ref'],
    layout: {
      id: 'page',
      kind: 'grid',
      rows: 2,
      columns: 4,
      placements: [
        { itemId: 'p1', position: { row: 0, col: 0 }, span },
        { itemId: 'p2', position: { row: 0, col: 1 }, span },
      ],
    },
    geometry,
    cells: { cellWidth: 50, cellHeight: 60 },
    pixelRatio: 1,
    renderItem: () => null,
  };
  const dock: GridRegistration & { layoutVersion: number } = {
    ...page,
    zoneId: 'dock',
    layout: {
      id: 'dock',
      kind: 'grid',
      rows: 1,
      columns: 4,
      itemSpan: span,
      placements: [
        { itemId: 'd1', position: { row: 0, col: 0 }, span },
        { itemId: 'd2', position: { row: 0, col: 1 }, span },
      ],
    },
  };
  const viewport = (zoneId: string, x: number): ListViewport => ({
    zoneId,
    layoutVersion: 2,
    offset: 0,
    viewport: {
      source: 'measured',
      space: 'screen',
      revision: 4,
      timestampMs: 100,
      rect: { x, y: 100, width: 250, height: 160 },
    },
  });
  const zones = [viewport('page', 0), viewport('dock', 300)];
  const registrations = new Map<
    string,
    ZoneRegistration & { layoutVersion: number }
  >([
    ['page', page],
    ['dock', dock],
  ]);
  const uiRegistrations: UiZoneRegistration[] = [page, dock].map(
    registration => ({
      kind: 'grid',
      zoneId: registration.zoneId,
      revision: registration.revision,
      layoutVersion: registration.layoutVersion,
      ref: registration.ref,
      targetGrid: prepareGridTarget(registration),
    }),
  );
  const recipes = new Map<string, GridItemLayout>([
    ['page', { span, placement: 'insert' }],
    ['dock', { span, placement: 'insert' }],
  ]);
  const session: DndTargetSession = {
    token: 1,
    policyRevision: 0,
    gridItems: { '#page': recipes.get('page')!, '#dock': recipes.get('dock')! },
  };
  const state = (x: number, y: number): DndMotion => ({
    token: 1,
    handleId: 1,
    seq: 2,
    phase: 'dragging',
    itemId: 'active',
    sourceZoneId: 'page',
    revision: 4,
    pointer: { x, y },
    origin: { x, y },
    axis: 'both',
    activationDelayMs: 250,
    configRevision: 0,
    grip: { x: 25, y: 30 },
    width: 50,
    height: 60,
    root: { x: 0, y: 0, width: 1000, height: 1000 },
    zones,
    visible: true,
  });
  return {
    ui: (x: number, y: number, previous: LayoutLocation | null) =>
      uiLayoutTarget(state(x, y), uiRegistrations, session, previous),
    js: (x: number, y: number, previous: LayoutLocation | null) =>
      resolveLayoutTarget(
        state(x, y),
        registrations,
        recipes,
        undefined,
        previous,
      ).target,
  };
}

const cell = (target: LayoutLocation | null) =>
  target
    ? `${target.zoneId}:${(target as GridLocation).position.row},${
        (target as GridLocation).position.col
      }`
    : 'none';

describe('ordered slot arithmetic shared with the engine', () => {
  // The engine module stays free of worklet directives, so the pointer keeps
  // its own copy. These must not drift.
  it.each([
    [{ rows: 1, cols: 1 }, 4],
    [{ rows: 1, cols: 2 }, 4],
    [{ rows: 2, cols: 2 }, 5],
  ])(
    'matches slotPosition and slotIndex for %o in %i columns',
    (itemSpan, columns) => {
      const perRow = Math.floor(columns / itemSpan.cols);
      for (let index = 0; index < 8; index++) {
        expect(orderedSlotPosition(index, itemSpan, columns)).toEqual(
          slotPosition(index, itemSpan, perRow),
        );
      }
      for (let row = 0; row < 6; row++) {
        for (let col = 0; col < columns + 1; col++) {
          expect(orderedSlotIndex({ row, col }, itemSpan, columns)).toBe(
            slotIndex({ row, col }, itemSpan, perRow),
          );
        }
      }
    },
  );
});

describe('UI and JS target resolution agree', () => {
  // The frame callback gates every candidate request on the UI result, and the
  // move handler recomputes it on JS. A zone kind the UI twin does not
  // understand reports no target, so the gate stops requesting mid-drag.
  it('resolves the same cell for every pointer position over both zone kinds', () => {
    const b = board();
    const disagreements: string[] = [];
    for (let x = 0; x <= 560; x += 3) {
      for (const y of [130, 150, 200]) {
        const ui = b.ui(x, y, null);
        const js = b.js(x, y, null);
        if (cell(ui) !== cell(js))
          disagreements.push(`(${x},${y}) ui=${cell(ui)} js=${cell(js)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('carries the previous target forward identically across a dock sweep', () => {
    const b = board();
    let uiPrevious: LayoutLocation | null = null;
    let jsPrevious: LayoutLocation | null = null;
    const uiPath: string[] = [];
    const jsPath: string[] = [];
    for (let x = 305; x <= 555; x += 1) {
      const ui = b.ui(x, 150, uiPrevious);
      const js = b.js(x, 150, jsPrevious);
      if (uiPath[uiPath.length - 1] !== cell(ui)) uiPath.push(cell(ui));
      if (jsPath[jsPath.length - 1] !== cell(js)) jsPath.push(cell(js));
      if (ui) uiPrevious = ui;
      if (js) jsPrevious = js;
    }
    // The dragged item comes from the page, so two apps plus it fill slots 0-2.
    expect(uiPath).toEqual([
      'none',
      'dock:0,0',
      'dock:0,1',
      'dock:0,2',
      'none',
    ]);
    expect(uiPath).toEqual(jsPath);
  });
});
