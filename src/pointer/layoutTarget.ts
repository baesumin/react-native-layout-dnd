import { validateRectMeasurement } from '../adapters/coordinates';
import type { LayoutLocation } from '../contracts';
import {
  orderedSlots,
  slotIndex,
  slotPosition,
} from '../engine/gridPlacements';
import type { GridItemLayout } from '../engine/layoutMove';
import type { GridMovementPolicy } from '../engine/movementPolicy';
import { isCellSpan } from '../engine/validation';
import type { GridZone, ItemLocation, PositionedItem } from '../types';
import type {
  DndMotion,
  GridRegistration,
  ListViewport,
  ZoneRegistration,
} from '../runtime/dndRuntime';
import {
  getCellGeometry,
  isPlacementVisible,
  isUsableRect,
  itemRect,
  readPointerTarget,
  rectContains,
} from './geometry';
import { listTarget } from './listTarget';
import type { MeasuredZone, UiMotion } from '../runtime/gridRuntime';

type RegisteredZone = ZoneRegistration & { layoutVersion: number };
type Registrations = ReadonlyMap<string, RegisteredZone>;

/** Geometry-only immutable input for UI pointer targeting; no refs or renderers. */
export type PreparedGridTarget = Omit<MeasuredZone, 'rect' | 'zone'> & {
  /** Ordered grids keep their `itemSpan` so slot targeting applies. */
  zone: GridZone<undefined>;
  zoneId: string;
  revision: number;
  layoutVersion: number;
};

const preparedGrids = new WeakMap<
  GridRegistration['layout'],
  PreparedGridTarget
>();

function sameGridInput(
  prepared: PreparedGridTarget,
  registration: GridRegistration & { layoutVersion: number },
): boolean {
  const { layout, geometry, cells } = registration;
  const previous = prepared.geometry;
  if (
    prepared.zoneId !== registration.zoneId ||
    prepared.revision !== registration.revision ||
    prepared.layoutVersion !== registration.layoutVersion ||
    prepared.pixelRatio !== registration.pixelRatio ||
    prepared.cells.cellWidth !== cells.cellWidth ||
    prepared.cells.cellHeight !== cells.cellHeight ||
    prepared.zone.id !== layout.id ||
    prepared.zone.rows !== layout.rows ||
    prepared.zone.columns !== layout.columns ||
    previous.mode !== geometry.mode ||
    previous.rowGap !== geometry.rowGap ||
    previous.columnGap !== geometry.columnGap ||
    previous.padding.top !== geometry.padding.top ||
    previous.padding.right !== geometry.padding.right ||
    previous.padding.bottom !== geometry.padding.bottom ||
    previous.padding.left !== geometry.padding.left ||
    (previous.mode === 'fixed' &&
      (geometry.mode !== 'fixed' ||
        previous.cellWidth !== geometry.cellWidth ||
        previous.cellHeight !== geometry.cellHeight)) ||
    prepared.zone.items.length !== layout.placements.length ||
    (prepared.zone.strategy === 'ordered') !==
      (layout.itemSpan !== undefined) ||
    (prepared.zone.strategy === 'ordered' &&
      (prepared.zone.itemSpan.rows !== layout.itemSpan?.rows ||
        prepared.zone.itemSpan.cols !== layout.itemSpan?.cols))
  )
    return false;
  // Direct JS callers can mutate their typed registration. Compare known
  // primitives against our detached snapshot instead of caching by identity
  // alone. Providers prepare once when registering, outside the pointer path.
  const ordered = prepared.zone.strategy === 'ordered';
  return layout.placements.every((placement, index) => {
    const item = prepared.zone.items[index] as PositionedOrOrdered;
    return (
      item.id === placement.itemId &&
      (ordered ||
        (item.position?.row === placement.position.row &&
          item.position?.col === placement.position.col)) &&
      item.span.rows === placement.span.rows &&
      item.span.cols === placement.span.cols &&
      item.placement === placement.placement
    );
  });
}

type PositionedOrOrdered = GridZone<undefined>['items'][number] & {
  position?: { row: number; col: number };
};

/** Prepare on registration, then reuse the result on the UI runtime. */
export function prepareGridTarget(
  registration: GridRegistration & { layoutVersion: number },
): PreparedGridTarget {
  const cached = preparedGrids.get(registration.layout);
  if (cached && sameGridInput(cached, registration)) return cached;
  const { layout, geometry } = registration;
  const zone: GridZone<undefined> = layout.itemSpan
    ? Object.freeze({
        id: layout.id,
        strategy: 'ordered' as const,
        rows: layout.rows,
        columns: layout.columns,
        itemSpan: Object.freeze({
          rows: layout.itemSpan.rows,
          cols: layout.itemSpan.cols,
        }),
        // Ordered items carry no position; their slot follows from the order.
        items: Object.freeze(
          layout.placements.map(placement =>
            Object.freeze({
              id: placement.itemId,
              data: undefined,
              span: Object.freeze({
                rows: placement.span.rows,
                cols: placement.span.cols,
              }),
              placement: placement.placement,
            }),
          ),
        ) as GridZone<undefined>['items'],
      })
    : Object.freeze({
        id: layout.id,
        strategy: 'spatial' as const,
        rows: layout.rows,
        columns: layout.columns,
        items: Object.freeze(
          layout.placements.map(placement =>
            Object.freeze({
              id: placement.itemId,
              data: undefined,
              position: Object.freeze({
                row: placement.position.row,
                col: placement.position.col,
              }),
              span: Object.freeze({
                rows: placement.span.rows,
                cols: placement.span.cols,
              }),
              placement: placement.placement,
            }),
          ),
        ) as PositionedItem<undefined>[],
      });
  const prepared: PreparedGridTarget = Object.freeze({
    zoneId: registration.zoneId,
    revision: registration.revision,
    layoutVersion: registration.layoutVersion,
    zone,
    geometry: Object.freeze({
      ...(geometry.mode === 'fixed'
        ? {
            mode: 'fixed' as const,
            cellWidth: geometry.cellWidth,
            cellHeight: geometry.cellHeight,
          }
        : { mode: 'fit' as const }),
      rowGap: geometry.rowGap,
      columnGap: geometry.columnGap,
      padding: Object.freeze({
        top: geometry.padding.top,
        right: geometry.padding.right,
        bottom: geometry.padding.bottom,
        left: geometry.padding.left,
      }),
    }),
    cells: Object.freeze({
      cellWidth: registration.cells.cellWidth,
      cellHeight: registration.cells.cellHeight,
    }),
    pixelRatio: registration.pixelRatio,
  });
  preparedGrids.set(layout, prepared);
  return prepared;
}

/** Attach current viewport coordinates without rebuilding baseline placements. */
export function measurePreparedGrid(
  prepared: PreparedGridTarget,
  measured: ListViewport,
): MeasuredZone | null {
  'worklet';
  if (
    measured.zoneId !== prepared.zoneId ||
    measured.layoutVersion !== prepared.layoutVersion ||
    measured.viewport.revision !== prepared.revision ||
    measured.viewport.source !== 'measured' ||
    measured.viewport.space !== 'screen' ||
    !Number.isSafeInteger(prepared.revision) ||
    prepared.revision < 0 ||
    !Number.isFinite(measured.viewport.timestampMs) ||
    measured.viewport.timestampMs < 0 ||
    measured.offset !== 0 ||
    !isUsableRect(measured.viewport.rect)
  )
    return null;
  const { zone, geometry, cells, pixelRatio } = prepared;
  const currentCells = getCellGeometry(
    zone,
    geometry,
    measured.viewport.rect.width,
    measured.viewport.rect.height,
    pixelRatio,
  );
  if (
    zone.id !== prepared.zoneId ||
    !currentCells ||
    currentCells.cellWidth !== cells.cellWidth ||
    currentCells.cellHeight !== cells.cellHeight
  )
    return null;
  return { zone, geometry, cells, pixelRatio, rect: measured.viewport.rect };
}

function isCurrent(
  state: DndMotion,
  registration: RegisteredZone,
  measured: ListViewport,
  ignoreLayoutVersion = false,
): boolean {
  const checked = validateRectMeasurement(measured.viewport, {
    revision: state.revision,
  });
  return (
    checked.valid &&
    checked.value.source === 'measured' &&
    checked.value.space === 'screen' &&
    registration.revision === state.revision &&
    (ignoreLayoutVersion ||
      registration.layoutVersion === measured.layoutVersion) &&
    (registration.kind === 'grid'
      ? measured.offset === 0
      : registration.layout.revision === state.revision &&
        Number.isFinite(measured.offset))
  );
}

function measuredGrid(
  registration: GridRegistration & { layoutVersion: number },
  measured: ListViewport,
): MeasuredZone | null {
  const { layout, geometry, cells, pixelRatio } = registration;
  const currentCells = getCellGeometry(
    layout,
    geometry,
    measured.viewport.rect.width,
    measured.viewport.rect.height,
    pixelRatio,
  );
  if (
    layout.id !== registration.zoneId ||
    !currentCells ||
    currentCells.cellWidth !== cells.cellWidth ||
    currentCells.cellHeight !== cells.cellHeight
  )
    return null;
  const prepared = prepareGridTarget(registration);
  return {
    zone: prepared.zone,
    geometry: prepared.geometry,
    cells: prepared.cells,
    pixelRatio: prepared.pixelRatio,
    rect: measured.viewport.rect,
  };
}

/**
 * Use committed list geometry and the existing grid pointer policy in one
 * measured coordinate space. Grid recipes are captured by destination zone ID.
 */
type LayoutTargetResolution = {
  target: LayoutLocation | null;
  /**
   * The pointer is over a zone whose UI measurement predates the layout
   * version registered on JS. The packet carries no new position; callers
   * keep their current target until the UI publishes the new version.
   */
  stale: boolean;
};

export function layoutTarget(
  state: DndMotion,
  registrations: Registrations,
  gridItemLayouts: ReadonlyMap<string, GridItemLayout>,
  movementPolicy?: GridMovementPolicy,
  previousTarget?: LayoutLocation | null,
): LayoutLocation | null {
  return resolveLayoutTarget(
    state,
    registrations,
    gridItemLayouts,
    movementPolicy,
    previousTarget,
  ).target;
}

export function resolveLayoutTarget(
  state: DndMotion,
  registrations: Registrations,
  gridItemLayouts: ReadonlyMap<string, GridItemLayout>,
  movementPolicy?: GridMovementPolicy,
  previousTarget?: LayoutLocation | null,
): LayoutTargetResolution {
  const outside: LayoutTargetResolution = { target: null, stale: false };
  if (
    state.itemId === null ||
    !isUsableRect(state.root) ||
    !rectContains(state.root, state.pointer.x, state.pointer.y) ||
    !Number.isFinite(state.width) ||
    !Number.isFinite(state.height) ||
    state.width <= 0 ||
    state.height <= 0 ||
    !Number.isFinite(state.grip.x) ||
    !Number.isFinite(state.grip.y)
  )
    return outside;

  // Keep an overlapping previous zone until the pointer actually leaves it,
  // matching the old grid controller's zone selection policy.
  const previous = state.zones.find(
    measured => measured.zoneId === previousTarget?.zoneId,
  );
  const zones = previous
    ? [previous, ...state.zones.filter(measured => measured !== previous)]
    : state.zones;
  let stale = false;
  for (const measured of zones) {
    const registration = registrations.get(measured.zoneId);
    if (!registration) continue;
    const inside = rectContains(
      measured.viewport.rect,
      state.pointer.x,
      state.pointer.y,
    );
    if (!isCurrent(state, registration, measured)) {
      if (inside && isCurrent(state, registration, measured, true))
        stale = true;
      continue;
    }
    if (!inside) continue;
    if (registration.kind === 'list') {
      return {
        target: listTarget(
          { ...state, zones: [measured] },
          new Map([[measured.zoneId, registration]]),
        ),
        stale: false,
      };
    }

    const recipe = gridItemLayouts.get(measured.zoneId);
    const grid = measuredGrid(registration, measured);
    if (!recipe || !isCellSpan(recipe.span) || !grid) return outside;
    const content = itemRect(
      { row: 0, col: 0 },
      { rows: grid.zone.rows, cols: grid.zone.columns },
      grid.geometry,
      grid.cells,
    );
    // Padding cannot accept a grid drop even if clamping would fit its first cell.
    if (
      !rectContains(
        { ...content, x: grid.rect.x + content.x, y: grid.rect.y + content.y },
        state.pointer.x,
        state.pointer.y,
      )
    )
      continue;

    const legacyMotion: UiMotion = {
      token: state.token,
      phase: 'dragging',
      itemId: state.itemId,
      sourceZoneId: state.sourceZoneId,
      // Provider activation starts at sequence 1; the grid policy starts at 0.
      seq: Math.max(0, state.seq - 1),
      target:
        previousTarget?.kind === 'grid'
          ? legacyGridTarget(previousTarget, grid.zone)
          : null,
      span: recipe.span,
      x: state.pointer.x - state.grip.x,
      y: state.pointer.y - state.grip.y,
      width: state.width,
      height: state.height,
      gripX: Math.max(0, Math.min(1, state.grip.x / state.width)),
      gripY: Math.max(0, Math.min(1, state.grip.y / state.height)),
      zones: [grid],
      outlet: state.root,
      validity: 'pending',
      visible: state.visible,
      destination: null,
      movementPolicy,
      baseRevision: state.revision,
    };
    const result = readPointerTarget(
      legacyMotion,
      state.pointer.x,
      state.pointer.y,
    );
    if (result.target?.strategy === 'spatial') {
      return {
        target: {
          kind: 'grid',
          zoneId: result.target.zoneId,
          position: result.target.position,
        },
        stale: false,
      };
    }
    if (
      result.target?.strategy === 'ordered' &&
      grid.zone.strategy === 'ordered'
    ) {
      const slots = orderedSlots(grid.zone, grid.zone.itemSpan);
      return {
        target: {
          kind: 'grid',
          zoneId: result.target.zoneId,
          position: slotPosition(
            result.target.index,
            grid.zone.itemSpan,
            slots.perRow,
          ),
        },
        stale: false,
      };
    }
  }
  return { target: null, stale };
}

/** Hand the grid pointer policy the previous target in its own vocabulary. */
function legacyGridTarget(
  previous: Extract<LayoutLocation, { kind: 'grid' }>,
  zone: GridZone<undefined>,
): ItemLocation {
  if (zone.strategy === 'ordered' && previous.zoneId === zone.id) {
    const slots = orderedSlots(zone, zone.itemSpan);
    const index = slotIndex(previous.position, zone.itemSpan, slots.perRow);
    if (index !== null)
      return { zoneId: previous.zoneId, strategy: 'ordered', index };
  }
  return {
    zoneId: previous.zoneId,
    strategy: 'spatial',
    position: previous.position,
  };
}

/** Recheck a resolved grid footprint after an exchange changes its position. */
export function isLayoutTargetVisible(
  state: DndMotion,
  registrations: Registrations,
  target: LayoutLocation,
  gridItemLayouts: ReadonlyMap<string, GridItemLayout>,
): boolean {
  if (!isUsableRect(state.root)) return false;
  const registration = registrations.get(target.zoneId);
  const measured = state.zones.find(entry => entry.zoneId === target.zoneId);
  if (
    !registration ||
    !measured ||
    registration.kind !== target.kind ||
    !isCurrent(state, registration, measured)
  )
    return false;
  if (target.kind === 'list' && registration.kind === 'list') {
    const count = registration.layout.entries.filter(
      entry => entry.itemId !== state.itemId,
    ).length;
    return (
      Number.isSafeInteger(target.index) &&
      target.index >= 0 &&
      target.index <= count
    );
  }
  if (target.kind !== 'grid' || registration.kind !== 'grid') return false;
  const recipe = gridItemLayouts.get(target.zoneId);
  const grid = measuredGrid(registration, measured);
  if (!recipe || !grid || !isCellSpan(recipe.span)) return false;
  if (grid.zone.strategy === 'ordered') {
    // An ordered slot has the zone's span whatever the entering item asked for.
    const slots = orderedSlots(grid.zone, grid.zone.itemSpan);
    const index = slotIndex(target.position, grid.zone.itemSpan, slots.perRow);
    return (
      index !== null &&
      isPlacementVisible(
        [grid],
        state.root,
        { strategy: 'ordered', zoneId: target.zoneId, index },
        grid.zone.itemSpan,
      )
    );
  }
  return isPlacementVisible(
    [grid],
    state.root,
    { strategy: 'spatial', zoneId: target.zoneId, position: target.position },
    recipe.span,
  );
}
