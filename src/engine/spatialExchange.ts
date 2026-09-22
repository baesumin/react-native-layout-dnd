import type { CellPosition, CellSpan, PositionedItem } from '../types';

import { rectanglesOverlap } from './rectangles';
import { nearestCandidates, type PlacementSearchResult } from './search';
import type { SpatialMoveInput } from './spatial';

type Region = { position: CellPosition; span: CellSpan };

function contains(region: Region, item: Region): boolean {
  return (
    item.position.row >= region.position.row &&
    item.position.col >= region.position.col &&
    item.position.row - region.position.row <=
      region.span.rows - item.span.rows &&
    item.position.col - region.position.col <= region.span.cols - item.span.cols
  );
}

/** Include complete target items; expanding one edge may encounter another item. */
function closeTargetRegion<T>(
  active: PositionedItem<T>,
  items: readonly PositionedItem<T>[],
): Region {
  let region: Region = { position: active.position, span: active.span };
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of items) {
      if (!rectanglesOverlap(region, item) || contains(region, item)) continue;
      const row = Math.min(region.position.row, item.position.row);
      const col = Math.min(region.position.col, item.position.col);
      // Validated items and the active target fit in the zone, so ends stay safe.
      const endRow = Math.max(
        region.position.row + region.span.rows,
        item.position.row + item.span.rows,
      );
      const endCol = Math.max(
        region.position.col + region.span.cols,
        item.position.col + item.span.cols,
      );
      region = {
        position: { row, col },
        span: { rows: endRow - row, cols: endCol - col },
      };
      expanded = true;
    }
  }
  return region;
}

function translated<T>(
  item: PositionedItem<T>,
  from: Region,
  to: Region,
): PositionedItem<T> {
  return {
    ...item,
    position: {
      row: to.position.row + (item.position.row - from.position.row),
      col: to.position.col + (item.position.col - from.position.col),
    },
  };
}

/**
 * Rotate entering items through an overlapping translation into the vacated edge.
 * A whole item must follow one cycle; an item whose cells would split is rejected.
 */
function exchangeOverlappingRegions<T>(
  items: readonly PositionedItem<T>[],
  active: PositionedItem<T>,
  origin: PositionedItem<T>,
  target: Region,
): PlacementSearchResult<T> {
  const attempts = 1;
  // Expanded mixed-item regions have no unambiguous overlapping source region.
  if (
    target.position.row !== active.position.row ||
    target.position.col !== active.position.col ||
    target.span.rows !== active.span.rows ||
    target.span.cols !== active.span.cols
  )
    return { status: 'impossible', attempts };

  const rowStep = origin.position.row - active.position.row;
  const colStep = origin.position.col - active.position.col;
  const placements: PositionedItem<T>[] = [];
  for (const item of items) {
    if (!rectanglesOverlap(target, item)) {
      placements.push(item);
      continue;
    }
    // Compute the first translation wholly outside the target, without a loop
    // proportional to grid dimensions (which may be very large safe integers).
    const rowSteps =
      rowStep > 0
        ? Math.ceil(
            (target.position.row + target.span.rows - item.position.row) /
              rowStep,
          )
        : rowStep < 0
          ? Math.ceil(
              (item.position.row + item.span.rows - target.position.row) /
                -rowStep,
            )
          : Infinity;
    const colSteps =
      colStep > 0
        ? Math.ceil(
            (target.position.col + target.span.cols - item.position.col) /
              colStep,
          )
        : colStep < 0
          ? Math.ceil(
              (item.position.col + item.span.cols - target.position.col) /
                -colStep,
            )
          : Infinity;
    const steps = Math.min(rowSteps, colSteps);
    const moved = {
      ...item,
      position: {
        row: item.position.row + steps * rowStep,
        col: item.position.col + steps * colStep,
      },
    };
    if (
      !Number.isSafeInteger(moved.position.row) ||
      !Number.isSafeInteger(moved.position.col) ||
      !contains(origin, moved) ||
      rectanglesOverlap(target, moved)
    )
      return { status: 'impossible', attempts };
    // Containment in origin = target + step also means the entire previous
    // translation was inside target. Thus no part of this item exits early.
    // These cycles are disjoint and origin contains no other original items.
    placements.push(moved);
  }
  placements.push(active);
  return { status: 'ok', placements, attempts };
}

/** Exchange equal regions, preserving whole items and their empty cells. */
export function exchangeSpatialRegions<T>({
  items,
  active,
  origin,
  rows,
  columns,
  searchBudget,
}: SpatialMoveInput<T>): PlacementSearchResult<T> {
  if (!origin) return { status: 'impossible', attempts: 0 };
  const target = closeTargetRegion(active, items);
  if (rectanglesOverlap(origin, active))
    return exchangeOverlappingRegions(items, active, origin, target);
  const firstRow = Math.max(
    0,
    origin.position.row - (target.span.rows - origin.span.rows),
  );
  const firstCol = Math.max(
    0,
    origin.position.col - (target.span.cols - origin.span.cols),
  );
  const lastRow = Math.min(origin.position.row, rows - target.span.rows);
  const lastCol = Math.min(origin.position.col, columns - target.span.cols);
  // Choosing a source near this anchor puts the active item near its requested
  // target. Clamping each axis adds a constant distance to every valid candidate.
  const preferred = {
    row: origin.position.row + (target.position.row - active.position.row),
    col: origin.position.col + (target.position.col - active.position.col),
  };
  const candidates = nearestCandidates(lastRow - firstRow, lastCol - firstCol, {
    row: Math.max(firstRow, Math.min(lastRow, preferred.row)) - firstRow,
    col: Math.max(firstCol, Math.min(lastCol, preferred.col)) - firstCol,
  });
  let attempts = 0;
  for (const position of candidates) {
    if (attempts === searchBudget) return { status: 'unresolved', attempts };
    attempts++;
    const source: Region = {
      position: {
        row: firstRow + position.row,
        col: firstCol + position.col,
      },
      span: target.span,
    };
    if (rectanglesOverlap(source, target)) continue;
    if (
      items.some(
        item => rectanglesOverlap(source, item) && !contains(source, item),
      )
    )
      continue;

    // Each touched item is wholly contained in exactly one disjoint region.
    // Translation therefore cannot collide with fixed items or lose any holes.
    const placements = items.map(item => {
      if (contains(source, item)) return translated(item, source, target);
      if (contains(target, item)) return translated(item, target, source);
      return item;
    });
    const moved = translated(origin, source, target);
    placements.push(
      moved.position.row === active.position.row &&
        moved.position.col === active.position.col
        ? active
        : moved,
    );
    return { status: 'ok', placements, attempts };
  }
  return { status: 'impossible', attempts };
}
