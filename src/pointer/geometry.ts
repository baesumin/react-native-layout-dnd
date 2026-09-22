import type {
  CellPosition,
  CellSpan,
  GridZone,
  ItemLocation,
  SpatialZone,
} from '../types';
import { DEFAULT_GRID_MOVEMENT_POLICY } from '../engine/movementPolicy';
import { selectSpatialMove } from '../engine/spatialPolicy';

import type {
  CellGeometry,
  MeasuredZone,
  UiMotion,
  WindowRect,
} from '../runtime/gridRuntime';
import type { ZoneGeometry } from '../components/gridTypes';

function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.max(min, Math.min(max, value));
}

/**
 * The cell an ordered slot starts at. The engine owns the same arithmetic in
 * `slotPosition`; that module stays free of worklet directives, so the pointer
 * keeps a worklet copy and `tests/pointer/orderedSlots.test.ts` pins them
 * together.
 */
export function orderedSlotPosition(
  index: number,
  itemSpan: CellSpan,
  columns: number,
): CellPosition {
  'worklet';
  const perRow = Math.floor(columns / itemSpan.cols);
  return {
    row: Math.floor(index / perRow) * itemSpan.rows,
    col: (index % perRow) * itemSpan.cols,
  };
}

/** The ordered slot a cell starts, or null when it is not a slot origin. */
export function orderedSlotIndex(
  position: CellPosition,
  itemSpan: CellSpan,
  columns: number,
): number | null {
  'worklet';
  const perRow = Math.floor(columns / itemSpan.cols);
  if (
    perRow <= 0 ||
    position.row < 0 ||
    position.col < 0 ||
    position.row % itemSpan.rows !== 0 ||
    position.col % itemSpan.cols !== 0
  )
    return null;
  const col = position.col / itemSpan.cols;
  if (col >= perRow) return null;
  return (position.row / itemSpan.rows) * perRow + col;
}

export function isUsableRect(rect: WindowRect | null): rect is WindowRect {
  'worklet';
  return (
    !!rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function rectContains(rect: WindowRect, x: number, y: number): boolean {
  'worklet';
  return (
    x >= rect.x &&
    y >= rect.y &&
    x <= rect.x + rect.width &&
    y <= rect.y + rect.height
  );
}

function containsRectangle(
  outer: WindowRect,
  inner: WindowRect,
  pixelRatio: number,
): boolean {
  'worklet';
  // Compare actual rendered edges. Native layout uses Float32 and snaps edges
  // relative to the root; widening a hit box would also accept clipped pixels.
  return (
    Math.round(inner.x * pixelRatio) >= Math.round(outer.x * pixelRatio) &&
    Math.round(inner.y * pixelRatio) >= Math.round(outer.y * pixelRatio) &&
    Math.round((inner.x + inner.width) * pixelRatio) <=
      Math.round((outer.x + outer.width) * pixelRatio) &&
    Math.round((inner.y + inner.height) * pixelRatio) <=
      Math.round((outer.y + outer.height) * pixelRatio)
  );
}

export function getCellGeometry(
  zone: Pick<GridZone<unknown>, 'rows' | 'columns'>,
  geometry: ZoneGeometry,
  width: number,
  height: number,
  pixelRatio = 1,
): CellGeometry | null {
  'worklet';
  if (
    !zone ||
    typeof zone !== 'object' ||
    Array.isArray(zone) ||
    !geometry ||
    typeof geometry !== 'object' ||
    Array.isArray(geometry) ||
    (geometry.mode !== 'fixed' && geometry.mode !== 'fit') ||
    !geometry.padding ||
    typeof geometry.padding !== 'object' ||
    Array.isArray(geometry.padding) ||
    !Number.isSafeInteger(zone.rows) ||
    zone.rows <= 0 ||
    !Number.isSafeInteger(zone.columns) ||
    zone.columns <= 0 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(pixelRatio) ||
    pixelRatio <= 0
  )
    return null;
  const { padding, rowGap, columnGap } = geometry;
  if (
    ![
      padding.top,
      padding.right,
      padding.bottom,
      padding.left,
      rowGap,
      columnGap,
    ].every(value => Number.isFinite(value) && value >= 0)
  )
    return null;
  const cellWidth =
    geometry.mode === 'fixed'
      ? geometry.cellWidth
      : (width -
          padding.left -
          padding.right -
          (zone.columns - 1) * columnGap) /
        zone.columns;
  const cellHeight =
    geometry.mode === 'fixed'
      ? geometry.cellHeight
      : (height - padding.top - padding.bottom - (zone.rows - 1) * rowGap) /
        zone.rows;
  const contentWidth =
    zone.columns * cellWidth + (zone.columns - 1) * columnGap;
  const contentHeight = zone.rows * cellHeight + (zone.rows - 1) * rowGap;
  const requiredWidth = contentWidth + padding.left + padding.right;
  const requiredHeight = contentHeight + padding.top + padding.bottom;
  // A native extent is the difference between two rounded root-relative edges.
  // That can be slightly smaller than the requested size (less than one pixel).
  // Preserve explicit cell sizes; final targeting still checks rendered edges.
  const pixelSize = 1 / pixelRatio;
  return Number.isFinite(requiredWidth) &&
    Number.isFinite(requiredHeight) &&
    (geometry.mode !== 'fixed' ||
      (requiredWidth - width < pixelSize &&
        requiredHeight - height < pixelSize)) &&
    Number.isFinite(cellWidth) &&
    cellWidth > 0 &&
    Number.isFinite(cellHeight) &&
    cellHeight > 0
    ? { cellWidth, cellHeight }
    : null;
}

/** Item rectangle relative to its zone, including the zone's content padding. */
export function itemRect(
  position: CellPosition,
  span: CellSpan,
  geometry: ZoneGeometry,
  cells: CellGeometry,
): WindowRect {
  'worklet';
  return {
    x:
      geometry.padding.left +
      position.col * (cells.cellWidth + geometry.columnGap),
    y:
      geometry.padding.top +
      position.row * (cells.cellHeight + geometry.rowGap),
    width: span.cols * cells.cellWidth + (span.cols - 1) * geometry.columnGap,
    height: span.rows * cells.cellHeight + (span.rows - 1) * geometry.rowGap,
  };
}

/** Check the resolved placement, which a region exchange may shift from the pointer target. */
export function isPlacementVisible(
  zones: readonly MeasuredZone[],
  outlet: WindowRect,
  target: ItemLocation,
  span: CellSpan,
): boolean {
  'worklet';
  const measured = zones.find(entry => entry.zone.id === target.zoneId);
  if (
    !measured ||
    measured.zone.strategy !== target.strategy ||
    !isUsableRect(measured.rect) ||
    !isUsableRect(outlet) ||
    !Number.isFinite(measured.pixelRatio) ||
    measured.pixelRatio <= 0 ||
    !Number.isSafeInteger(span.rows) ||
    !Number.isSafeInteger(span.cols) ||
    span.rows <= 0 ||
    span.cols <= 0
  )
    return false;
  const { zone, rect, geometry, cells } = measured;
  let position: CellPosition;
  if (zone.strategy === 'ordered' && target.strategy === 'ordered') {
    if (
      span.rows !== zone.itemSpan.rows ||
      span.cols !== zone.itemSpan.cols ||
      !Number.isSafeInteger(target.index) ||
      target.index < 0 ||
      target.index > zone.items.length
    )
      return false;
    const slotsPerRow = Math.floor(zone.columns / span.cols);
    if (slotsPerRow <= 0) return false;
    position = {
      row: Math.floor(target.index / slotsPerRow) * span.rows,
      col: (target.index % slotsPerRow) * span.cols,
    };
  } else if (target.strategy === 'spatial') {
    position = target.position;
  } else {
    return false;
  }
  if (
    !Number.isSafeInteger(position.row) ||
    !Number.isSafeInteger(position.col) ||
    position.row < 0 ||
    position.col < 0 ||
    position.row > zone.rows - span.rows ||
    position.col > zone.columns - span.cols
  )
    return false;
  const anchored = itemRect(position, span, geometry, cells);
  const windowTarget = {
    ...anchored,
    x: rect.x + anchored.x,
    y: rect.y + anchored.y,
  };
  return (
    isUsableRect(windowTarget) &&
    containsRectangle(rect, windowTarget, measured.pixelRatio) &&
    containsRectangle(outlet, windowTarget, measured.pixelRatio)
  );
}

export function sameTarget(
  left: ItemLocation | null,
  right: ItemLocation | null,
): boolean {
  'worklet';
  if (!left || !right) return left === right;
  if (left.zoneId !== right.zoneId || left.strategy !== right.strategy)
    return false;
  return left.strategy === 'ordered' && right.strategy === 'ordered'
    ? left.index === right.index
    : left.strategy === 'spatial' &&
        right.strategy === 'spatial' &&
        left.position.row === right.position.row &&
        left.position.col === right.position.col;
}

export function sourceItemTarget(
  measured: MeasuredZone,
  itemId: string,
): ItemLocation | null {
  'worklet';
  const { zone } = measured;
  if (zone.strategy === 'ordered') {
    const index = zone.items.findIndex(item => item.id === itemId);
    return index < 0 ? null : { zoneId: zone.id, strategy: 'ordered', index };
  }
  const item = zone.items.find(candidate => candidate.id === itemId);
  return item
    ? { zoneId: zone.id, strategy: 'spatial', position: { ...item.position } }
    : null;
}

/** Worklet equivalent of computeOrderedIndex for already validated measured zones. */
export function orderedIndexForCenter(
  measured: MeasuredZone,
  itemId: string | null,
  centerX: number,
  centerY: number,
): number | null {
  'worklet';
  const { zone, geometry, cells } = measured;
  if (zone.strategy !== 'ordered') return null;
  const span = zone.itemSpan;
  const slotsPerRow = Math.floor(zone.columns / span.cols);
  const slotRows = Math.floor(zone.rows / span.rows);
  if (slotsPerRow === 0 || slotRows === 0) return null;
  const itemCount = zone.items.reduce(
    (count, item) => count + Number(item.id !== itemId),
    0,
  );
  const slotWidth =
    span.cols * cells.cellWidth + (span.cols - 1) * geometry.columnGap;
  const slotHeight =
    span.rows * cells.cellHeight + (span.rows - 1) * geometry.rowGap;
  const strideX = slotWidth + geometry.columnGap;
  const strideY = slotHeight + geometry.rowGap;
  const width =
    zone.columns * cells.cellWidth + (zone.columns - 1) * geometry.columnGap;
  const height =
    zone.rows * cells.cellHeight + (zone.rows - 1) * geometry.rowGap;
  const x = clamp(centerX, 0, width);
  const y = clamp(centerY, 0, height);
  if (zone.rows % span.rows !== 0 && y >= slotRows * strideY - geometry.rowGap)
    return itemCount;
  const row = clamp(
    Math.floor((y - slotHeight / 2) / strideY + 0.5),
    0,
    slotRows - 1,
  );
  if (
    zone.columns % span.cols !== 0 &&
    x >= slotsPerRow * strideX - geometry.columnGap
  )
    return Math.min(itemCount, (row + 1) * slotsPerRow);
  const col = clamp(
    Math.floor((x - slotWidth / 2) / strideX + 0.5),
    0,
    slotsPerRow - 1,
  );
  const slot = row * slotsPerRow + col;
  if (slot >= itemCount) return itemCount;
  const after =
    slotsPerRow === 1
      ? y >= row * strideY + slotHeight / 2
      : x >= col * strideX + slotWidth / 2;
  return Math.min(itemCount, slot + Number(after));
}

function stableAnchor(
  value: number,
  previous: number | undefined,
  maximum: number,
  hysteresis: number,
): number {
  'worklet';
  if (
    previous !== undefined &&
    previous >= 0 &&
    previous <= maximum &&
    Math.abs(value - previous) <= 0.5 + hysteresis
  )
    return previous;
  return clamp(Math.round(value), 0, maximum);
}

function stableExchangeAnchor(
  value: number,
  previous: number,
  maximum: number,
  threshold: number,
): number {
  'worklet';
  if (Math.abs(value - previous) <= threshold) return previous;
  // Quantize each crossed boundary so a fast jump cannot bypass the threshold.
  return clamp(
    value > previous
      ? Math.floor(value + (1 - threshold))
      : Math.ceil(value - (1 - threshold)),
    0,
    maximum,
  );
}

/** Use the same explicit placement policy as the engine, without application data. */
function exchangeOrigin(
  current: UiMotion,
  zone: SpatialZone<undefined>,
  position: CellPosition,
): CellPosition | null {
  'worklet';
  if (zone.id !== current.sourceZoneId) return null;
  const active = zone.items.find(item => item.id === current.itemId);
  if (!active) return null;
  const { move, kind, colliders } = selectSpatialMove({
    items: zone.items.filter(item => item.id !== active.id),
    active: { ...active, position },
    origin: active,
    rows: zone.rows,
    columns: zone.columns,
    searchBudget: 1,
    movementPolicy: current.movementPolicy,
  });
  if (kind === 'exchange') return colliders.length > 0 ? active.position : null;
  if (kind !== 'row-rotation' || !move.origin) return null;
  const corridorTop = Math.min(
    move.origin.position.row,
    move.active.position.row,
  );
  const corridorBottom =
    Math.max(move.origin.position.row, move.active.position.row) +
    move.active.span.rows;
  const exchanges = move.items.some(
    item =>
      corridorTop < item.position.row + item.span.rows &&
      corridorBottom > item.position.row,
  );
  return exchanges ? active.position : null;
}

function selectZone(
  current: UiMotion,
  x: number,
  y: number,
): MeasuredZone | null {
  'worklet';
  if (!rectContains(current.outlet, x, y)) return null;
  const previousId =
    current.target?.zoneId ?? (current.seq === 0 ? current.sourceZoneId : null);
  for (const zone of current.zones) {
    if (zone.zone.id === previousId && rectContains(zone.rect, x, y))
      return zone;
  }
  for (const zone of current.zones) {
    const boundary =
      current.movementPolicy?.pointer?.boundaryHysteresis ??
      DEFAULT_GRID_MOVEMENT_POLICY.pointer.boundaryHysteresis;
    const marginX = Math.min(boundary, zone.rect.width / 4);
    const marginY = Math.min(boundary, zone.rect.height / 4);
    if (
      x >= zone.rect.x + marginX &&
      x <= zone.rect.x + zone.rect.width - marginX &&
      y >= zone.rect.y + marginY &&
      y <= zone.rect.y + zone.rect.height - marginY
    )
      return zone;
  }
  return null;
}

type PointerTarget = Pick<UiMotion, 'target' | 'x' | 'y' | 'width' | 'height'>;

/** Preview movement and release use this same hysteresis-adjusted logical target. */
export function readPointerTarget(
  current: UiMotion,
  absoluteX: number,
  absoluteY: number,
): PointerTarget {
  'worklet';
  const outside: PointerTarget = {
    target: null,
    x: absoluteX - current.gripX * current.width,
    y: absoluteY - current.gripY * current.height,
    width: current.width,
    height: current.height,
  };
  if (!Number.isFinite(absoluteX) || !Number.isFinite(absoluteY))
    return { ...outside, x: current.x, y: current.y };
  const measured = selectZone(current, absoluteX, absoluteY);
  if (!measured) return outside;
  const { zone, rect, geometry, cells } = measured;
  const { span } = current;
  const sensitivity = current.movementPolicy?.pointer;
  const cellHysteresis =
    sensitivity?.cellHysteresis ??
    DEFAULT_GRID_MOVEMENT_POLICY.pointer.cellHysteresis;
  const exchangeThreshold =
    sensitivity?.exchangeThreshold ??
    DEFAULT_GRID_MOVEMENT_POLICY.pointer.exchangeThreshold;
  const boundaryHysteresis =
    sensitivity?.boundaryHysteresis ??
    DEFAULT_GRID_MOVEMENT_POLICY.pointer.boundaryHysteresis;
  if (span.rows > zone.rows || span.cols > zone.columns) return outside;
  const size = itemRect({ row: 0, col: 0 }, span, geometry, cells);
  if (!isUsableRect(size)) return outside;
  const x = absoluteX - current.gripX * size.width;
  const y = absoluteY - current.gripY * size.height;
  const contentX = x - rect.x - geometry.padding.left;
  const contentY = y - rect.y - geometry.padding.top;
  const previous = current.target?.zoneId === zone.id ? current.target : null;
  let target: ItemLocation;
  let position: CellPosition;
  if (zone.strategy === 'spatial') {
    const old =
      previous?.strategy === 'spatial' ? previous.position : undefined;
    const row = contentY / (cells.cellHeight + geometry.rowGap);
    const col = contentX / (cells.cellWidth + geometry.columnGap);
    position = {
      row: stableAnchor(row, old?.row, zone.rows - span.rows, cellHysteresis),
      col: stableAnchor(
        col,
        old?.col,
        zone.columns - span.cols,
        cellHysteresis,
      ),
    };
    // Classify the nearest cell before hysteresis so a configured exchange
    // threshold below the ordinary cell threshold can still take effect.
    const origin = exchangeOrigin(current, zone, {
      row: clamp(Math.round(row), 0, zone.rows - span.rows),
      col: clamp(Math.round(col), 0, zone.columns - span.cols),
    });
    if (origin) {
      // Re-entering the source zone must not bypass the exchange threshold.
      // A full-width widget can move intervening items even at an empty target.
      // Empty corridors and insertion retain their existing immediate targeting.
      const reference = old ?? origin;
      position = {
        row: stableExchangeAnchor(
          row,
          reference.row,
          zone.rows - span.rows,
          exchangeThreshold,
        ),
        col: stableExchangeAnchor(
          col,
          reference.col,
          zone.columns - span.cols,
          exchangeThreshold,
        ),
      };
    }
    target = { zoneId: zone.id, strategy: 'spatial', position };
  } else {
    const centerX = contentX + size.width / 2;
    const centerY = contentY + size.height / 2;
    let index = orderedIndexForCenter(
      measured,
      current.itemId,
      centerX,
      centerY,
    );
    if (index === null) return outside;
    if (previous?.strategy === 'ordered' && previous.index !== index) {
      const slot = itemRect({ row: 0, col: 0 }, zone.itemSpan, geometry, cells);
      const marginX = Math.min(boundaryHysteresis, slot.width / 4);
      const marginY = Math.min(boundaryHysteresis, slot.height / 4);
      for (const dx of [-marginX, marginX]) {
        for (const dy of [-marginY, marginY]) {
          if (
            orderedIndexForCenter(
              measured,
              current.itemId,
              centerX + dx,
              centerY + dy,
            ) === previous.index
          )
            index = previous.index;
        }
      }
    }
    position = orderedSlotPosition(index, zone.itemSpan, zone.columns);
    target = { zoneId: zone.id, strategy: 'ordered', index };
  }
  const anchored = itemRect(position, span, geometry, cells);
  const windowTarget = {
    ...anchored,
    x: rect.x + anchored.x,
    y: rect.y + anchored.y,
  };
  if (
    !containsRectangle(rect, windowTarget, measured.pixelRatio) ||
    !containsRectangle(current.outlet, windowTarget, measured.pixelRatio)
  )
    return outside;
  return { target, x, y, width: size.width, height: size.height };
}
