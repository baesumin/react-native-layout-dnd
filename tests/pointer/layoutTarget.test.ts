import {
  isLayoutTargetVisible,
  layoutTarget,
  measurePreparedGrid,
  prepareGridTarget,
  resolveLayoutTarget,
} from '../../src/pointer/layoutTarget';
import type {
  DndMotion,
  GridRegistration,
  ListRegistration,
  ListViewport,
  ZoneRegistration,
} from '../../src/runtime/dndRuntime';
import type { MeasuredZone, UiMotion } from '../../src/runtime/gridRuntime';
import { readPointerTarget } from '../../src/pointer/geometry';
import type { GridLocation, GridPlacement } from '../../src/contracts';
import type { GridItemLayout } from '../../src/engine/layoutMove';
import { computeListLayout } from '../../src/engine/list';
import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';

function gridTarget(row: number, col: number, zoneId = 'grid'): GridLocation {
  return { kind: 'grid', zoneId, position: { row, col } };
}

function fixture() {
  const registration: GridRegistration & { layoutVersion: number } = {
    kind: 'grid',
    zoneId: 'grid',
    revision: 4,
    layoutVersion: 2,
    ref: null as unknown as GridRegistration['ref'],
    layout: {
      id: 'grid',
      kind: 'grid',
      rows: 4,
      columns: 4,
      placements: [],
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
  const state: DndMotion = {
    token: 1,
    handleId: 1,
    seq: 2,
    phase: 'dragging',
    itemId: 'active',
    sourceZoneId: 'list',
    revision: 4,
    pointer: { x: 335, y: 150 },
    origin: { x: 100, y: 150 },
    axis: 'both',
    activationDelayMs: 250,
    configRevision: 0,
    grip: { x: 100, y: 50 },
    width: 200,
    height: 100,
    root: { x: 0, y: 0, width: 1000, height: 1000 },
    zones: [measured],
    visible: true,
  };
  const registrations = new Map<
    string,
    ZoneRegistration & { layoutVersion: number }
  >([['grid', registration]]);
  const recipes = new Map<string, GridItemLayout>([
    ['grid', { span: { rows: 1, cols: 1 }, placement: 'insert' }],
  ]);
  return { state, registration, measured, registrations, recipes };
}

function addList(f: ReturnType<typeof fixture>) {
  const layout = computeListLayout({
    itemIds: ['active', 'b', 'c'],
    orientation: 'vertical',
    crossSize: 200,
    estimatedItemSize: 50,
    itemSize: id => ({ active: 40, b: 80, c: 50 })[id]!,
    revision: 4,
  });
  if (!layout.valid) throw new Error('Invalid list fixture');
  const registration: ListRegistration & { layoutVersion: number } = {
    kind: 'list',
    zoneId: 'list',
    orientation: 'vertical',
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
      rect: { x: 0, y: 100, width: 200, height: 200 },
    },
  };
  f.registrations.set('list', registration);
  f.state.zones.unshift(measured);
  return { registration, measured };
}

function homeFixture() {
  const f = fixture();
  const placement = (
    itemId: string,
    row: number,
    col: number,
    rows = 1,
    cols = 1,
  ): GridPlacement => ({
    itemId,
    position: { row, col },
    span: { rows, cols },
    placement: itemId === 'active' ? 'exchange' : 'insert',
  });
  f.registration.layout = {
    id: 'grid',
    kind: 'grid',
    rows: 5,
    columns: 4,
    placements: [
      placement('a', 0, 0),
      placement('b', 0, 1),
      placement('c', 0, 2),
      placement('active', 1, 0, 4, 4),
    ],
  };
  f.registration.geometry = {
    mode: 'fixed',
    cellWidth: 50,
    cellHeight: 60,
    rowGap: 0,
    columnGap: 0,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  f.measured.viewport.rect = { x: 30, y: 40, width: 200, height: 300 };
  f.state.sourceZoneId = 'grid';
  f.state.width = 200;
  f.state.height = 240;
  f.state.grip = { x: 100, y: 120 };
  f.state.pointer = { x: 130, y: 220 };
  f.recipes.set('grid', { span: { rows: 4, cols: 4 }, placement: 'exchange' });
  return f;
}

describe('prepared grid pointer geometry', () => {
  it('reuses baseline conversion while viewport coordinates change', () => {
    const f = homeFixture();
    const prepared = prepareGridTarget(f.registration);
    expect(prepareGridTarget(f.registration)).toBe(prepared);
    const first = measurePreparedGrid(prepared, f.measured)!;
    f.measured.viewport.rect = { ...f.measured.viewport.rect, x: 90, y: 120 };
    const next = measurePreparedGrid(prepared, f.measured)!;
    expect(next.rect).toEqual(f.measured.viewport.rect);
    expect(next.zone).toBe(first.zone);
    expect(next.zone.items).toBe(first.zone.items);
    expect(next.geometry).toBe(first.geometry);
    expect(prepared).not.toHaveProperty('ref');
    expect(prepared).not.toHaveProperty('renderItem');
  });

  it.each(['position', 'span', 'placement', 'geometry', 'cells', 'version'])(
    'refreshes an in-place %s change without mutating the previous snapshot',
    key => {
      const f = homeFixture();
      const prepared = prepareGridTarget(f.registration);
      const original = JSON.stringify(prepared);
      const placement = f.registration.layout.placements[0];
      if (key === 'position') placement.position.col = 3;
      if (key === 'span') placement.span.cols = 2;
      if (key === 'placement') placement.placement = 'exchange';
      if (key === 'geometry') f.registration.geometry.padding.left = 2;
      if (key === 'cells') f.registration.cells.cellWidth = 45;
      if (key === 'version') f.registration.layoutVersion++;
      const changed = prepareGridTarget(f.registration);
      expect(changed).not.toBe(prepared);
      expect(JSON.stringify(prepared)).toBe(original);
      expect(prepareGridTarget(f.registration)).toBe(changed);
      expect(Object.isFrozen(changed)).toBe(true);
      expect(
        Object.isFrozen(
          (changed.zone.items[0] as { position?: object }).position,
        ),
      ).toBe(true);
    },
  );

  it('copies only geometry fields without serializing caller extras', () => {
    const f = homeFixture();
    const position = f.registration.layout.placements[0].position;
    Object.defineProperty(position, 'opaque', {
      enumerable: true,
      get: () => {
        throw new Error('Do not inspect unrelated caller properties');
      },
    });
    const prepared = prepareGridTarget(f.registration);
    expect((prepared.zone.items[0] as { position?: object }).position).toEqual({
      row: 0,
      col: 0,
    });
    expect(prepareGridTarget(f.registration)).toBe(prepared);
  });

  it('rejects resized or stale measurements on the UI preparation path', () => {
    const f = fixture();
    f.registration.geometry = {
      mode: 'fit',
      rowGap: 10,
      columnGap: 10,
      padding: { top: 20, left: 10, right: 10, bottom: 20 },
    };
    const prepared = prepareGridTarget(f.registration);
    expect(measurePreparedGrid(prepared, f.measured)).not.toBeNull();
    f.measured.viewport.rect.width += 40;
    expect(measurePreparedGrid(prepared, f.measured)).toBeNull();
    f.measured.viewport.rect.width -= 40;
    f.measured.layoutVersion++;
    expect(measurePreparedGrid(prepared, f.measured)).toBeNull();
    f.measured.layoutVersion--;
    f.measured.viewport.timestampMs = NaN;
    expect(measurePreparedGrid(prepared, f.measured)).toBeNull();
  });
});

describe('stale zone measurements', () => {
  it('distinguishes a zone measured before its registered layout version from an outside pointer', () => {
    const f = fixture();
    const current = resolveLayoutTarget(f.state, f.registrations, f.recipes);
    expect(current).toEqual({ target: gridTarget(0, 0), stale: false });
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(0, 0),
    );

    f.registration.layoutVersion++;
    expect(resolveLayoutTarget(f.state, f.registrations, f.recipes)).toEqual({
      target: null,
      stale: true,
    });
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
    f.registration.layoutVersion--;

    // A revision mismatch is an external change, not a lagging publication.
    f.registration.revision++;
    expect(resolveLayoutTarget(f.state, f.registrations, f.recipes)).toEqual({
      target: null,
      stale: false,
    });
    f.registration.revision--;

    f.state.pointer = { x: 900, y: 900 };
    expect(resolveLayoutTarget(f.state, f.registrations, f.recipes)).toEqual({
      target: null,
      stale: false,
    });
  });

  it('reports staleness for a list zone whose measurement lags its registration', () => {
    const f = fixture();
    addList(f);
    const list = f.registrations.get('list')!;
    const measured = f.state.zones.find(zone => zone.zoneId === 'list')!;
    f.state.pointer = {
      x: measured.viewport.rect.x + 20,
      y: measured.viewport.rect.y + 20,
    };
    const resolved = resolveLayoutTarget(f.state, f.registrations, f.recipes);
    expect(resolved.stale).toBe(false);
    expect(resolved.target).toMatchObject({ kind: 'list', zoneId: 'list' });

    list.layoutVersion++;
    expect(resolveLayoutTarget(f.state, f.registrations, f.recipes)).toEqual({
      target: null,
      stale: true,
    });
  });
});

describe('mixed layout pointer targets', () => {
  it('converts list activation pixels to the destination grid footprint by grip ratio', () => {
    const f = fixture();
    f.state.grip = { x: 150, y: 75 };
    f.state.pointer = { x: 467.5, y: 305 };
    // 75% grip becomes 37.5×45px in a 50×60px destination cell.
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(2, 2),
    );
  });

  it('includes gaps in a multi-cell incoming footprint', () => {
    const f = fixture();
    f.recipes.set('grid', {
      span: { rows: 2, cols: 2 },
      placement: 'exchange',
    });
    f.state.grip = { x: 50, y: 25 };
    f.state.pointer = { x: 397.5, y: 222.5 };
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(1, 1),
    );
  });

  it('uses the recipe of the target zone rather than the active item ID', () => {
    const f = fixture();
    f.recipes.delete('grid');
    f.recipes.set('active', { span: { rows: 1, cols: 1 } });
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
    f.recipes.set('grid', { span: { rows: 1, cols: 1 } });
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(0, 0),
    );
  });

  it('switches between list offsets and grid coordinates without changing source dimensions', () => {
    const f = fixture();
    const list = addList(f);
    f.state.pointer = { x: 100, y: 240 };
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual({
      kind: 'list',
      zoneId: 'list',
      index: 1,
    });
    list.measured.offset = 20;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual({
      kind: 'list',
      zoneId: 'list',
      index: 2,
    });
    f.state.pointer = { x: 335, y: 150 };
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(0, 0),
    );
    expect([f.state.width, f.state.height]).toEqual([200, 100]);
  });

  it.each([
    { x: 305, y: 150 },
    { x: 335, y: 110 },
    { x: 545, y: 150 },
    { x: 335, y: 400 },
  ])('does not accept a drop in grid padding at %p', pointer => {
    const f = fixture();
    f.state.pointer = pointer;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
  });

  it('rejects the entire candidate when its anchored footprint crosses the root', () => {
    const f = fixture();
    f.state.pointer = { x: 515, y: 220 };
    f.state.root.width = 530;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
    f.state.root.width = 550;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(1, 3),
    );
  });

  it('matches native pixel rounding at a clipped edge', () => {
    const f = fixture();
    f.registration.pixelRatio = 2;
    f.state.pointer = { x: 515, y: 220 };
    f.state.root.width = 539.8;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(1, 3),
    );
    f.state.root.width = 539.7;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
  });

  it('applies grid entry hysteresis while retaining an already selected edge', () => {
    const f = fixture();
    f.registration.geometry.padding = { top: 0, right: 0, bottom: 0, left: 0 };
    f.measured.viewport.rect.width = 230;
    f.measured.viewport.rect.height = 270;
    f.state.pointer = { x: 301, y: 130 };
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
    expect(
      layoutTarget(
        f.state,
        f.registrations,
        f.recipes,
        undefined,
        gridTarget(0, 0),
      ),
    ).toEqual(gridTarget(0, 0));
    f.state.pointer.x = 305;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(0, 0),
    );
  });

  it('uses the previous grid anchor until the configured cell hysteresis is crossed', () => {
    const f = fixture();
    f.state.pointer.x = 335 + 0.6 * 60;
    expect(
      layoutTarget(
        f.state,
        f.registrations,
        f.recipes,
        undefined,
        gridTarget(0, 0),
      ),
    ).toEqual(gridTarget(0, 0));
    f.state.pointer.x = 335 + 0.621 * 60;
    expect(
      layoutTarget(
        f.state,
        f.registrations,
        f.recipes,
        undefined,
        gridTarget(0, 0),
      ),
    ).toEqual(gridTarget(0, 1));
  });

  it.each([0.7, 0.79, 0.801])(
    'preserves HOME full-width exchange thresholds at %p pitches',
    distance => {
      const f = homeFixture();
      f.state.pointer.y -= distance * 60;
      expect(
        layoutTarget(
          f.state,
          f.registrations,
          f.recipes,
          HOME_GRID_MOVEMENT_POLICY,
          gridTarget(1, 0),
        ),
      ).toEqual(gridTarget(distance > 0.8 ? 0 : 1, 0));
    },
  );

  it('matches the legacy HOME pointer trace through exchange and reverse movement', () => {
    const f = homeFixture();
    const grid: MeasuredZone = {
      zone: {
        id: 'grid',
        strategy: 'spatial',
        rows: 5,
        columns: 4,
        items: f.registration.layout.placements.map(item => ({
          id: item.itemId,
          data: undefined,
          position: item.position,
          span: item.span,
          placement: item.placement,
        })),
      },
      geometry: f.registration.geometry,
      cells: f.registration.cells,
      pixelRatio: 1,
      rect: f.measured.viewport.rect,
    };
    const legacy: UiMotion = {
      token: 1,
      phase: 'dragging',
      itemId: 'active',
      sourceZoneId: 'grid',
      seq: 1,
      target: {
        strategy: 'spatial',
        zoneId: 'grid',
        position: { row: 1, col: 0 },
      },
      span: { rows: 4, cols: 4 },
      x: 30,
      y: 100,
      width: 200,
      height: 240,
      gripX: 0.5,
      gripY: 0.5,
      zones: [grid],
      outlet: f.state.root,
      validity: 'valid',
      visible: true,
      destination: null,
      movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    };
    let previous: GridLocation | null = gridTarget(1, 0);
    for (const distance of [0.2, 0.79, 0.801, 1.2, 0.81, 0.5, 0.19]) {
      f.state.pointer.y = 220 - distance * 60;
      const result = readPointerTarget(
        legacy,
        f.state.pointer.x,
        f.state.pointer.y,
      );
      const actual = layoutTarget(
        f.state,
        f.registrations,
        f.recipes,
        HOME_GRID_MOVEMENT_POLICY,
        previous,
      );
      expect(actual).toEqual(
        result.target?.strategy === 'spatial'
          ? {
              kind: 'grid',
              zoneId: result.target.zoneId,
              position: result.target.position,
            }
          : null,
      );
      previous = actual as GridLocation | null;
      legacy.target = result.target;
      f.state.seq += 1;
    }
  });

  it.each(['revision', 'measurement', 'layout-version', 'grid-scroll'])(
    'rejects stale or inconsistent grid %s',
    key => {
      const f = fixture();
      if (key === 'revision') f.registration.revision = 3;
      if (key === 'measurement') f.measured.viewport.revision = 3;
      if (key === 'layout-version') f.measured.layoutVersion = 1;
      if (key === 'grid-scroll') f.measured.offset = 10;
      expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
      expect(
        isLayoutTargetVisible(
          f.state,
          f.registrations,
          gridTarget(0, 0),
          f.recipes,
        ),
      ).toBe(false);
    },
  );

  it('rejects stale list layouts through the mixed adapter', () => {
    const f = fixture();
    const list = addList(f);
    f.state.pointer = { x: 100, y: 240 };
    list.registration.layout.revision = 3;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
  });

  it.each([
    { rows: 0, cols: 1 },
    { rows: 1, cols: NaN },
    { rows: 5, cols: 1 },
  ])('rejects invalid or oversized grid recipes %p', span => {
    const f = fixture();
    f.recipes.set('grid', { span });
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
  });

  it('rejects unavailable source geometry and malformed registered cells', () => {
    const f = fixture();
    f.state.width = 0;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
    f.state.width = 200;
    f.registration.cells.cellWidth = NaN;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
  });

  it('rejects a resized fit viewport before its registered cell geometry catches up', () => {
    const f = fixture();
    f.registration.geometry = {
      mode: 'fit',
      rowGap: 10,
      columnGap: 10,
      padding: { top: 20, left: 10, right: 10, bottom: 20 },
    };
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(0, 0),
    );
    f.measured.viewport.rect.width += 40;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toBeNull();
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        gridTarget(0, 0),
        f.recipes,
      ),
    ).toBe(false);
    f.registration.cells.cellWidth = 60;
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(0, 0),
    );
  });
});

describe('resolved layout footprint visibility', () => {
  it('rejects a resolved exchange destination even when the requested anchor was visible', () => {
    const f = fixture();
    f.state.root.width = 500;
    f.state.pointer = { x: 455, y: 220 };
    expect(layoutTarget(f.state, f.registrations, f.recipes)).toEqual(
      gridTarget(1, 2),
    );
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        gridTarget(1, 2),
        f.recipes,
      ),
    ).toBe(true);
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        gridTarget(1, 3),
        f.recipes,
      ),
    ).toBe(false);
  });

  it('checks a resolved multi-cell span against grid dimensions', () => {
    const f = fixture();
    f.recipes.set('grid', { span: { rows: 2, cols: 2 } });
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        gridTarget(2, 2),
        f.recipes,
      ),
    ).toBe(true);
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        gridTarget(3, 3),
        f.recipes,
      ),
    ).toBe(false);
  });

  it('permits list insertion indices after removal without requiring a fully visible item', () => {
    const f = fixture();
    addList(f);
    f.state.height = 500;
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        { kind: 'list', zoneId: 'list', index: 2 },
        f.recipes,
      ),
    ).toBe(true);
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        { kind: 'list', zoneId: 'list', index: 3 },
        f.recipes,
      ),
    ).toBe(false);
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        { kind: 'list', zoneId: 'grid', index: 0 },
        f.recipes,
      ),
    ).toBe(false);
  });

  it('fails after a target zone or its captured recipe is removed', () => {
    const f = fixture();
    f.recipes.clear();
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        gridTarget(0, 0),
        f.recipes,
      ),
    ).toBe(false);
    f.recipes.set('grid', { span: { rows: 1, cols: 1 } });
    f.registrations.clear();
    expect(
      isLayoutTargetVisible(
        f.state,
        f.registrations,
        gridTarget(0, 0),
        f.recipes,
      ),
    ).toBe(false);
  });
});
