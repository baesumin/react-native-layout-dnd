import { sameLayoutTarget, uiLayoutTarget } from '../../src/pointer/dndTarget';
import type { DndTargetSession } from '../../src/pointer/dndTarget';
import type {
  DndMotion,
  GridRegistration,
  ListRegistration,
  ListViewport,
  UiZoneRegistration,
  ZoneRegistration,
} from '../../src/runtime/dndRuntime';
import {
  layoutTarget,
  prepareGridTarget,
} from '../../src/pointer/layoutTarget';
import type { LayoutLocation } from '../../src/contracts';
import type { GridItemLayout } from '../../src/engine/layoutMove';
import { computeListLayout } from '../../src/engine/list';
import { createListTargetIndex } from '../../src/engine/listIndex';
import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';

type Registration = ZoneRegistration & { layoutVersion: number };

function fixture(
  orientation: 'vertical' | 'horizontal' = 'vertical',
  sizes = [40, 100, 0, 0, 60, 80],
) {
  const layout = computeListLayout({
    itemIds: sizes.map((_, index) => `item-${index}`),
    orientation,
    crossSize: 200,
    estimatedItemSize: 40,
    itemSize: (_id, index) => sizes[index],
    revision: 4,
  });
  if (!layout.valid) throw new Error('Invalid fixture');
  const list: ListRegistration & { layoutVersion: number } = {
    kind: 'list',
    zoneId: 'list',
    orientation,
    revision: 4,
    layoutVersion: 3,
    ref: null as unknown as ListRegistration['ref'],
    offset: { get: () => 0 } as ListRegistration['offset'],
    contentSize: layout.totalSize,
    layout,
    renderItem: () => null,
  };
  const measured: ListViewport = {
    zoneId: 'list',
    layoutVersion: 3,
    offset: 0,
    viewport: {
      source: 'measured',
      space: 'screen',
      revision: 4,
      timestampMs: 100,
      rect: { x: 40, y: 80, width: 200, height: 300 },
    },
  };
  const state: DndMotion = {
    token: 1,
    handleId: 1,
    seq: 2,
    phase: 'dragging',
    itemId: 'item-0',
    sourceZoneId: 'list',
    revision: 4,
    configRevision: 0,
    pointer: { x: 140, y: 150 },
    origin: { x: 140, y: 150 },
    axis: 'both',
    activationDelayMs: 250,
    grip: { x: 100, y: 20 },
    width: 200,
    height: 40,
    root: { x: 0, y: 0, width: 1000, height: 1000 },
    zones: [measured],
    visible: true,
  };
  const registrations = new Map<string, Registration>([['list', list]]);
  const recipes = new Map<string, GridItemLayout>();
  const session: DndTargetSession = {
    token: 1,
    policyRevision: 0,
    gridItems: {},
  };
  return { state, list, measured, registrations, recipes, session };
}

function addGrid(f: ReturnType<typeof fixture>) {
  const grid: GridRegistration & { layoutVersion: number } = {
    kind: 'grid',
    zoneId: 'grid',
    revision: 4,
    layoutVersion: 2,
    ref: null as unknown as GridRegistration['ref'],
    layout: { id: 'grid', kind: 'grid', rows: 4, columns: 4, placements: [] },
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
    zoneId: 'grid',
    layoutVersion: 2,
    offset: 0,
    viewport: {
      source: 'measured',
      space: 'screen',
      revision: 4,
      timestampMs: 100,
      rect: { x: 300, y: 100, width: 250, height: 310 },
    },
  };
  f.registrations.set('grid', grid);
  f.state.zones.push(measured);
  f.recipes.set('grid', { span: { rows: 1, cols: 1 }, placement: 'insert' });
  return { grid, measured };
}

function prepared(f: ReturnType<typeof fixture>): UiZoneRegistration[] {
  return Array.from(f.registrations.values(), registration =>
    registration.kind === 'list'
      ? {
          kind: 'list' as const,
          zoneId: registration.zoneId,
          revision: registration.revision,
          layoutVersion: registration.layoutVersion,
          orientation: registration.orientation,
          ref: registration.ref,
          offset: registration.offset,
          contentSize: registration.contentSize,
          targetIndex: createListTargetIndex(registration.layout),
        }
      : {
          kind: 'grid' as const,
          zoneId: registration.zoneId,
          revision: registration.revision,
          layoutVersion: registration.layoutVersion,
          ref: registration.ref,
          targetGrid: prepareGridTarget(registration),
        },
  );
}

function compare(
  f: ReturnType<typeof fixture>,
  previous: LayoutLocation | null = null,
) {
  f.session.gridItems = Object.fromEntries(
    Array.from(f.recipes, ([id, recipe]) => [`#${id}`, recipe]),
  );
  const expected = layoutTarget(
    f.state,
    f.registrations,
    f.recipes,
    f.session.movementPolicy,
    previous,
  );
  const actual = uiLayoutTarget(f.state, prepared(f), f.session, previous);
  expect(actual).toEqual(expected);
  return actual;
}

describe('UI prepared pointer targeting matches JS targeting', () => {
  it.each(['vertical', 'horizontal'] as const)(
    'preserves variable-size %s boundaries across scrolling and zero-size ties',
    orientation => {
      const f = fixture(orientation);
      const vertical = orientation === 'vertical';
      const coordinate = vertical ? 'y' : 'x';
      for (const offset of [-25, 0, 50, 170]) {
        f.measured.offset = offset;
        for (const active of [null, 'item-0', 'item-2', 'item-3', 'external']) {
          f.state.itemId = active;
          for (const entry of f.list.layout.entries) {
            for (const delta of [-0.01, 0, 0.01]) {
              const center = entry.start + entry.size / 2 + delta;
              f.state.pointer[coordinate] =
                f.measured.viewport.rect[coordinate] +
                center -
                offset +
                f.state.grip[coordinate] -
                (vertical ? f.state.height : f.state.width) / 2;
              compare(f);
            }
          }
        }
      }
    },
  );

  it('retains zero-size tie slots and accepts the empty string as an item ID', () => {
    const f = fixture('vertical', [0, 0, 0]);
    f.state.pointer.y = f.measured.viewport.rect.y;
    f.state.itemId = 'item-2';
    expect(compare(f)).toEqual({ kind: 'list', zoneId: 'list', index: 2 });
    f.state.itemId = '';
    f.list.layout.entries[1].itemId = '';
    expect(compare(f)).toEqual({ kind: 'list', zoneId: 'list', index: 1 });
  });

  it('uses committed prepared thresholds while observed scrolling changes the target', () => {
    const f = fixture();
    const registrations = prepared(f);
    expect(uiLayoutTarget(f.state, registrations, f.session, null)).toEqual({
      kind: 'list',
      zoneId: 'list',
      index: 0,
    });
    f.measured.offset = 100;
    expect(uiLayoutTarget(f.state, registrations, f.session, null)).toEqual({
      kind: 'list',
      zoneId: 'list',
      index: 3,
    });
    expect(compare(f)).toEqual({ kind: 'list', zoneId: 'list', index: 3 });
  });

  it.each([
    'layout-revision',
    'registration-revision',
    'measurement-revision',
    'layout-version',
    'estimated',
    'content-space',
    'negative-timestamp',
    'nonfinite-timestamp',
    'nonfinite-offset',
    'fractional-revision',
    'negative-revision',
    'invalid-rect',
  ])('rejects invalid or stale list input: %s', invalid => {
    const f = fixture();
    if (invalid === 'layout-revision') f.list.layout.revision = 3;
    if (invalid === 'registration-revision') f.list.revision = 3;
    if (invalid === 'measurement-revision') f.measured.viewport.revision = 3;
    if (invalid === 'layout-version') f.measured.layoutVersion = 2;
    if (invalid === 'estimated')
      Object.assign(f.measured.viewport, { source: 'estimated' });
    if (invalid === 'content-space')
      Object.assign(f.measured.viewport, { space: 'content' });
    if (invalid === 'negative-timestamp') f.measured.viewport.timestampMs = -1;
    if (invalid === 'nonfinite-timestamp')
      f.measured.viewport.timestampMs = NaN;
    if (invalid === 'nonfinite-offset') f.measured.offset = Infinity;
    if (invalid === 'invalid-rect') f.measured.viewport.rect.width = NaN;
    if (invalid === 'fractional-revision' || invalid === 'negative-revision') {
      const revision = invalid === 'fractional-revision' ? 4.5 : -1;
      f.state.revision =
        f.list.revision =
        f.list.layout.revision =
        f.measured.viewport.revision =
          revision;
    }
    expect(compare(f)).toBeNull();
  });

  it.each([
    { x: 335, y: 150 },
    { x: 467.5, y: 305 },
    { x: 305, y: 150 },
    { x: 335, y: 110 },
    { x: 545, y: 150 },
    { x: 335, y: 400 },
  ])('preserves grid grip conversion and padding rejection at %p', pointer => {
    const f = fixture();
    addGrid(f);
    f.state.pointer = pointer;
    f.state.grip = { x: 150, y: 75 };
    f.state.height = 100;
    compare(f);
  });

  it('keeps the previous overlapping zone until it is no longer eligible', () => {
    const f = fixture();
    const { measured } = addGrid(f);
    measured.viewport.rect.x = 40;
    measured.viewport.rect.y = 80;
    f.state.pointer = { x: 75, y: 130 };
    expect(compare(f)?.zoneId).toBe('list');
    const previous: LayoutLocation = {
      kind: 'grid',
      zoneId: 'grid',
      position: { row: 0, col: 0 },
    };
    expect(compare(f, previous)?.zoneId).toBe('grid');
    f.state.pointer.x = 45;
    expect(compare(f, previous)?.zoneId).toBe('list');
    f.measured.viewport.revision = 3;
    expect(compare(f, previous)).toBeNull();
  });

  it.each(['fixed', 'fit'] as const)(
    'rejects stale %s grid geometry then accepts its updated registration',
    mode => {
      const f = fixture();
      const { grid, measured } = addGrid(f);
      f.state.pointer = { x: 335, y: 150 };
      grid.geometry =
        mode === 'fit'
          ? { mode, rowGap: 10, columnGap: 10, padding: grid.geometry.padding }
          : grid.geometry;
      expect(compare(f)?.kind).toBe('grid');
      grid.cells.cellWidth = 60;
      expect(compare(f)).toBeNull();
      measured.viewport.rect.width += 40;
      if (grid.geometry.mode === 'fixed') grid.geometry.cellWidth = 60;
      expect(compare(f)?.kind).toBe('grid');
    },
  );

  it('skips a stale grid scroll measurement before selecting an overlapping list', () => {
    const f = fixture();
    const { measured } = addGrid(f);
    measured.viewport.rect.x = 40;
    measured.viewport.rect.y = 80;
    measured.offset = 10;
    f.state.zones = [measured, f.measured];
    f.state.pointer = { x: 75, y: 130 };
    expect(compare(f)).toEqual({ kind: 'list', zoneId: 'list', index: 0 });
  });

  it.each([
    { rows: 0, cols: 1 },
    { rows: 1, cols: NaN },
    { rows: 5, cols: 1 },
    { rows: 1.5, cols: 1 },
  ])('rejects invalid or oversized destination spans %p', span => {
    const f = fixture();
    addGrid(f);
    f.state.pointer = { x: 335, y: 150 };
    f.recipes.set('grid', { span });
    expect(compare(f)).toBeNull();
  });

  it('preserves HOME full-width exchange hysteresis across a pointer trace', () => {
    const f = fixture();
    const { grid, measured } = addGrid(f);
    grid.layout.rows = 5;
    grid.layout.placements = [
      {
        itemId: 'a',
        position: { row: 0, col: 0 },
        span: { rows: 1, cols: 1 },
        placement: 'insert',
      },
      {
        itemId: 'item-0',
        position: { row: 1, col: 0 },
        span: { rows: 4, cols: 4 },
        placement: 'exchange',
      },
    ];
    grid.geometry = {
      mode: 'fixed',
      cellWidth: 50,
      cellHeight: 60,
      rowGap: 0,
      columnGap: 0,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    measured.viewport.rect = { x: 300, y: 100, width: 200, height: 300 };
    f.state.sourceZoneId = 'grid';
    f.state.width = 200;
    f.state.height = 240;
    f.state.grip = { x: 100, y: 120 };
    f.state.pointer = { x: 400, y: 280 };
    f.recipes.set('grid', {
      span: { rows: 4, cols: 4 },
      placement: 'exchange',
    });
    f.session.movementPolicy = HOME_GRID_MOVEMENT_POLICY;
    let previous: LayoutLocation | null = {
      kind: 'grid',
      zoneId: 'grid',
      position: { row: 1, col: 0 },
    };
    for (const distance of [0.2, 0.79, 0.801, 1.2, 0.81, 0.5, 0.19]) {
      f.state.pointer.y = 280 - distance * 60;
      previous = compare(f, previous);
      f.state.seq += 1;
    }
  });

  it('rejects a grid destination whose footprint is clipped by the root', () => {
    const f = fixture();
    const { grid } = addGrid(f);
    grid.pixelRatio = 2;
    f.state.pointer = { x: 515, y: 220 };
    f.state.root.width = 539.8;
    expect(compare(f)?.kind).toBe('grid');
    f.state.root.width = 539.7;
    expect(compare(f)).toBeNull();
  });
});

describe('semantic target equality', () => {
  it('compares only zone, kind and insertion coordinates', () => {
    const list: LayoutLocation = { kind: 'list', zoneId: 'list', index: 2 };
    const grid: LayoutLocation = {
      kind: 'grid',
      zoneId: 'grid',
      position: { row: 1, col: 2 },
    };
    expect(sameLayoutTarget(null, null)).toBe(true);
    expect(sameLayoutTarget(list, { ...list })).toBe(true);
    expect(
      sameLayoutTarget(grid, { ...grid, position: { ...grid.position } }),
    ).toBe(true);
    expect(sameLayoutTarget(list, null)).toBe(false);
    expect(sameLayoutTarget(list, { ...list, index: 3 })).toBe(false);
    expect(sameLayoutTarget(list, { ...list, zoneId: 'other' })).toBe(false);
    expect(sameLayoutTarget(list, grid)).toBe(false);
    expect(
      sameLayoutTarget(grid, { ...grid, position: { row: 2, col: 2 } }),
    ).toBe(false);
  });
});
