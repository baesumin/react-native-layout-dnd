import type { PositionedItem } from '../types';

import type { PlacementSearchResult } from './search';
import type { SpatialMoveInput } from './spatial';

/**
 * Move a full-width exchange item through a vertical band, preserving its holes.
 * Null means this movement belongs to another policy; impossible is terminal.
 */
export function rotateSpatialRows<T>({
  items,
  active,
  origin,
  columns,
}: SpatialMoveInput<T>): PlacementSearchResult<T> | null {
  if (
    !origin ||
    active.placement === 'insert' ||
    active.span.cols !== columns ||
    active.position.col !== origin.position.col ||
    active.position.row === origin.position.row
  )
    return null;

  const firstRow = Math.min(origin.position.row, active.position.row);
  // Both rectangles were validated within the zone, so their ends stay safe.
  const endRow =
    Math.max(origin.position.row, active.position.row) + active.span.rows;
  const offset =
    active.position.row > origin.position.row
      ? -active.span.rows
      : active.span.rows;
  const placements: PositionedItem<T>[] = [];
  let attempts = 0;
  for (const item of items) {
    const itemEnd = item.position.row + item.span.rows;
    if (itemEnd <= firstRow || item.position.row >= endRow) {
      placements.push(item);
      continue;
    }
    attempts = 1;
    if (item.position.row < firstRow || itemEnd > endRow)
      return { status: 'impossible', attempts };
    // The full-width source contains no other item. All touched items therefore
    // occupy the remaining band and translate together by the source height.
    placements.push({
      ...item,
      position: {
        row: item.position.row + offset,
        col: item.position.col,
      },
    });
  }
  placements.push(active);
  return { status: 'ok', placements, attempts };
}
