import type { CellPosition, GridItem, PositionedItem } from '../types';

import { rectanglesOverlap } from './rectangles';

export type PlacementSearchResult<T> =
  | { status: 'ok'; placements: PositionedItem<T>[]; attempts: number }
  | { status: 'impossible' | 'unresolved'; attempts: number };
type PlacementSearchProgress<T> =
  PlacementSearchResult<T> | { status: 'pending'; attempts: number };

type SearchInput<T> = {
  items: readonly GridItem<T>[];
  fixedItems?: readonly PositionedItem<T>[];
  rows: number;
  columns: number;
  searchBudget: number;
};

function* rowMajorCandidates(
  maxRow: number,
  maxCol: number,
): Generator<CellPosition> {
  for (let row = 0; row <= maxRow; row++) {
    for (let col = 0; col <= maxCol; col++) {
      yield { row, col };
    }
  }
}

/** Distance shells, then row/column order. No grid-sized array or sort. */
export function* nearestCandidates(
  maxRow: number,
  maxCol: number,
  origin: CellPosition,
): Generator<CellPosition> {
  const colReach = Math.max(origin.col, maxCol - origin.col);
  const maxDistance = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(origin.row, maxRow - origin.row) + colReach,
  );
  for (let distance = 0; distance <= maxDistance; distance++) {
    const minRowDistance = Math.max(0, distance - colReach);
    const firstRow = distance > origin.row ? 0 : origin.row - distance;
    const lastRow = origin.row + Math.min(distance, maxRow - origin.row);
    for (let row = firstRow; row <= lastRow; row++) {
      // Skip the middle of a wide shell when the grid has very few columns.
      if (Math.abs(row - origin.row) < minRowDistance) {
        if (minRowDistance > maxRow - origin.row) {
          break;
        }
        row = origin.row + minRowDistance;
      }
      if (row > lastRow) {
        break;
      }
      const colDistance = distance - Math.abs(row - origin.row);
      if (colDistance <= origin.col) {
        yield { row, col: origin.col - colDistance };
      }
      if (colDistance > 0 && colDistance <= maxCol - origin.col) {
        yield { row, col: origin.col + colDistance };
      }
    }
  }
}

function exceedsArea<T>(
  items: readonly GridItem<T>[],
  fixedItems: readonly PositionedItem<T>[],
  rows: number,
  columns: number,
): boolean {
  let remaining = rows * columns;
  // Area is only a shortcut. Avoid a rounded product becoming a proof.
  if (!Number.isSafeInteger(remaining)) {
    return false;
  }
  for (const group of [fixedItems, items]) {
    for (const item of group) {
      const area = item.span.rows * item.span.cols;
      if (area > remaining) {
        return true;
      }
      remaining -= area;
    }
  }
  return false;
}

/** Internal: inputs are validated by the caller; fixed rectangles never move. */
export function createPlacementSearch<T>({
  items,
  fixedItems = [],
  rows,
  columns,
  searchBudget,
}: SearchInput<T>): {
  advance: (maxAttempts: number) => PlacementSearchProgress<T>;
} {
  let attempts = 0;
  let depth = 0;
  let terminal: PlacementSearchResult<T> | undefined;
  const placements: PositionedItem<T>[] = [];
  const cursors: Generator<CellPosition>[] = [];
  let nextPosition: CellPosition | undefined;

  if (
    items.some(item => item.span.rows > rows || item.span.cols > columns) ||
    exceedsArea(items, fixedItems, rows, columns)
  ) {
    terminal = { status: 'impossible', attempts };
  }

  function createCursor(index: number): Generator<CellPosition> {
    const item = items[index];
    const maxRow = rows - item.span.rows;
    const maxCol = columns - item.span.cols;
    return rowMajorCandidates(maxRow, maxCol);
  }

  return {
    advance(maxAttempts) {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
        throw new RangeError(
          'Search chunk size must be a nonnegative safe integer.',
        );
      }
      let chunkAttempts = 0;
      while (!terminal) {
        if (depth === items.length) {
          terminal = { status: 'ok', placements, attempts };
          break;
        }
        cursors[depth] ??= createCursor(depth);
        if (!nextPosition) {
          const candidate = cursors[depth].next();
          if (candidate.done) {
            // Exhaustion is free to inspect: at an exact budget boundary this
            // distinguishes a proof of impossibility from unfinished search.
            cursors.pop();
            if (depth === 0) {
              terminal = { status: 'impossible', attempts };
              break;
            }
            depth--;
            placements.pop();
            continue;
          }
          nextPosition = candidate.value;
        }
        if (attempts === searchBudget) {
          terminal = { status: 'unresolved', attempts };
          break;
        }
        if (chunkAttempts === maxAttempts) {
          return { status: 'pending', attempts };
        }
        attempts++;
        chunkAttempts++;
        const candidate = { ...items[depth], position: nextPosition };
        nextPosition = undefined;
        if (
          fixedItems.some(item => rectanglesOverlap(candidate, item)) ||
          placements.some(item => rectanglesOverlap(candidate, item))
        ) {
          continue;
        }
        placements.push(candidate);
        depth++;
      }
      return terminal;
    },
  };
}
