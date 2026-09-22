import type { GridLocation } from '../../src/contracts';
import type { GridItemLayout } from '../../src/engine/layoutMove';
import {
  isLayoutTargetVisible,
  prepareGridTarget,
  resolveLayoutTarget,
} from '../../src/pointer/layoutTarget';
import type {
  DndMotion,
  GridRegistration,
  ListViewport,
  ZoneRegistration,
} from '../../src/runtime/dndRuntime';

const span = { rows: 1, cols: 1 };

/**
 * A one-row dock of four 50 × 60 slots with 10 px gaps and 10/20 px padding,
 * measured at (300, 100). Two apps occupy the first two slots.
 */
function fixture(pointerX: number, previous?: GridLocation) {
  const registration: GridRegistration & { layoutVersion: number } = {
    kind: 'grid',
    zoneId: 'dock',
    revision: 4,
    layoutVersion: 2,
    ref: null as unknown as GridRegistration['ref'],
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
    geometry: {
      mode: 'fixed',
      cellWidth: 50,
      cellHeight: 60,
      rowGap: 10,
      columnGap: 10,
      padding: { top: 20, left: 10, right: 10, bottom: 20 },
    },
    cells: { cellWidth: 50, cellHeight: 60 },
    pixelRatio: 1,
    renderItem: () => null,
  };
  const measured: ListViewport = {
    zoneId: 'dock',
    layoutVersion: 2,
    offset: 0,
    viewport: {
      source: 'measured',
      space: 'screen',
      revision: 4,
      timestampMs: 100,
      rect: { x: 300, y: 100, width: 250, height: 100 },
    },
  };
  const state: DndMotion = {
    token: 1,
    handleId: 1,
    seq: 2,
    phase: 'dragging',
    itemId: 'active',
    sourceZoneId: 'page',
    revision: 4,
    pointer: { x: pointerX, y: 150 },
    origin: { x: 100, y: 150 },
    axis: 'both',
    activationDelayMs: 250,
    configRevision: 0,
    grip: { x: 25, y: 30 },
    width: 50,
    height: 60,
    root: { x: 0, y: 0, width: 1000, height: 1000 },
    zones: [measured],
    visible: true,
  };
  const registrations = new Map<
    string,
    ZoneRegistration & { layoutVersion: number }
  >([['dock', registration]]);
  const recipes = new Map<string, GridItemLayout>([
    ['dock', { span, placement: 'insert' }],
  ]);
  return {
    resolve: () =>
      resolveLayoutTarget(state, registrations, recipes, undefined, previous),
    visible: (target: GridLocation) =>
      isLayoutTargetVisible(state, registrations, target, recipes),
    registration,
  };
}

const slotCenterX = (index: number) => 300 + 10 + index * 60 + 25;

describe('ordered grid targeting', () => {
  it('prepares an ordered zone with its item span and no positions', () => {
    const { registration } = fixture(0);
    const prepared = prepareGridTarget(registration);
    expect(prepared.zone).toMatchObject({
      strategy: 'ordered',
      itemSpan: span,
      items: [{ id: 'd1' }, { id: 'd2' }],
    });
    expect(prepared.zone.items[0]).not.toHaveProperty('position');
    // The same registration prepares once.
    expect(prepareGridTarget(registration)).toBe(prepared);
  });

  it('resolves the pointer to the slot after the last item and reports it as a cell', () => {
    const f = fixture(slotCenterX(2));
    expect(f.resolve()).toEqual({
      target: { kind: 'grid', zoneId: 'dock', position: { row: 0, col: 2 } },
      stale: false,
    });
    expect(
      f.visible({ kind: 'grid', zoneId: 'dock', position: { row: 0, col: 2 } }),
    ).toBe(true);
  });

  it('clamps a pointer past the occupied slots to the append index', () => {
    // Slot 3 is beyond the two apps plus the entering item, so index 2 wins.
    const f = fixture(slotCenterX(3));
    expect(f.resolve().target).toEqual({
      kind: 'grid',
      zoneId: 'dock',
      position: { row: 0, col: 2 },
    });
  });

  it('keeps the previous slot inside the boundary hysteresis', () => {
    // The ordered index flips from "after d1" to "after d2" at the centre of
    // slot 1 (content x 85). Two pixels past it the nearer index wins alone,
    // but a previous target one index back is retained within 4 px.
    const x = 300 + 10 + 85 + 2;
    expect(fixture(x).resolve().target).toMatchObject({
      position: { row: 0, col: 2 },
    });
    expect(
      fixture(x, {
        kind: 'grid',
        zoneId: 'dock',
        position: { row: 0, col: 1 },
      }).resolve().target,
    ).toMatchObject({ position: { row: 0, col: 1 } });
  });
});
