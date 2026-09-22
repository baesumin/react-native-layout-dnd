import type { GridPlacement } from '../contracts';
import type { CellPosition, CellSpan } from '../types';

export function samePlacement(
  first: GridPlacement,
  second: GridPlacement,
): boolean {
  return (
    first.itemId === second.itemId &&
    first.position.row === second.position.row &&
    first.position.col === second.position.col &&
    first.span.rows === second.span.rows &&
    first.span.cols === second.span.cols &&
    first.placement === second.placement
  );
}

/** Slot grid of an ordered zone: reading-order cells of one item span. */
export type OrderedSlots = { perRow: number; rows: number };

export function orderedSlots(
  zone: { rows: number; columns: number },
  itemSpan: CellSpan,
): OrderedSlots {
  return {
    perRow: Math.floor(zone.columns / itemSpan.cols),
    rows: Math.floor(zone.rows / itemSpan.rows),
  };
}

/** The cell an ordered slot starts at; the caller guarantees `perRow > 0`. */
export function slotPosition(
  index: number,
  itemSpan: CellSpan,
  perRow: number,
): CellPosition {
  return {
    row: Math.floor(index / perRow) * itemSpan.rows,
    col: (index % perRow) * itemSpan.cols,
  };
}

/** The reading-order slot a position starts, or null when it is not a slot origin. */
export function slotIndex(
  position: CellPosition,
  itemSpan: CellSpan,
  perRow: number,
): number | null {
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

/**
 * Give ordered placements their reading-order positions, reusing an existing
 * placement object whenever the item keeps the same slot.
 */
export function packOrderedPlacements(
  placements: readonly GridPlacement[],
  itemSpan: CellSpan,
  perRow: number,
  previous: readonly GridPlacement[] = [],
): GridPlacement[] {
  const existing = new Map(previous.map(item => [item.itemId, item]));
  return placements.map((placement, index) => {
    const packed: GridPlacement = {
      itemId: placement.itemId,
      position: slotPosition(index, itemSpan, perRow),
      span: { rows: itemSpan.rows, cols: itemSpan.cols },
      ...(placement.placement === undefined
        ? {}
        : { placement: placement.placement }),
    };
    const before = existing.get(placement.itemId);
    return before && samePlacement(before, packed) ? before : packed;
  });
}
