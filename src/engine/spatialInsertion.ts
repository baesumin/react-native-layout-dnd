import type { CellPosition, CellSpan, PositionedItem } from '../types';

import { rectanglesOverlap } from './rectangles';
import type { PlacementSearchResult } from './search';
import type { SpatialMoveInput } from './spatial';

function comparePositions(left: CellPosition, right: CellPosition): number {
  return left.row - right.row || left.col - right.col;
}

function isSlotAligned(item: PositionedItem<unknown>, span: CellSpan): boolean {
  return (
    item.span.rows === span.rows &&
    item.span.cols === span.cols &&
    item.position.row % span.rows === 0 &&
    item.position.col % span.cols === 0
  );
}

function withPosition<T>(
  item: PositionedItem<T>,
  position: CellPosition,
): PositionedItem<T> {
  return { ...item, position: { ...position } };
}

function applyInsertion<T>(
  items: readonly PositionedItem<T>[],
  active: PositionedItem<T>,
  moved: ReadonlyMap<string, PositionedItem<T>>,
  attempts: number,
): PlacementSearchResult<T> {
  return {
    status: 'ok',
    placements: [...items.map(item => moved.get(item.id) ?? item), active],
    attempts,
  };
}

/** Shift intervening occupied slots; keep the requested target even when it was empty. */
function insertWithinZone<T>(
  {
    items,
    active,
    origin,
  }: SpatialMoveInput<T> & {
    origin: PositionedItem<T>;
  },
  vacantTarget = false,
): PlacementSearchResult<T> {
  const forward = comparePositions(origin.position, active.position) < 0;
  const start = forward ? origin.position : active.position;
  const end = forward ? active.position : origin.position;
  const displaced = items
    .filter(
      item =>
        item.placement === 'insert' &&
        comparePositions(item.position, start) >= 0 &&
        comparePositions(item.position, end) <= 0,
    )
    .sort((left, right) =>
      forward
        ? comparePositions(left.position, right.position)
        : comparePositions(right.position, left.position),
    );
  if (
    !isSlotAligned(active, active.span) ||
    !isSlotAligned(origin, active.span) ||
    displaced.some(item => !isSlotAligned(item, active.span))
  ) {
    // An empty target remains usable even when larger insertion items do not
    // share aligned slots. Only compatible slots participate in insertion.
    if (vacantTarget)
      return { status: 'ok', placements: [...items, active], attempts: 0 };
    return { status: 'impossible', attempts: 1 };
  }
  let vacant = origin.position;
  const moved = new Map<string, PositionedItem<T>>();
  for (const item of displaced) {
    moved.set(item.id, withPosition(item, vacant));
    vacant = item.position;
  }
  return applyInsertion(items, active, moved, 1);
}

/** An incoming item shifts insertion slots forward until a free slot is reached. */
function insertFromAnotherZone<T>({
  items,
  active,
  rows,
  columns,
  searchBudget,
}: SpatialMoveInput<T>): PlacementSearchResult<T> {
  const displaced: PositionedItem<T>[] = [];
  const maxRow = rows - active.span.rows;
  const maxCol = columns - active.span.cols;
  let { row, col } = active.position;
  let attempts = 0;
  while (row <= maxRow) {
    if (attempts === searchBudget) return { status: 'unresolved', attempts };
    attempts++;
    const slot = { span: active.span, position: { row, col } };
    const occupants = items.filter(item => rectanglesOverlap(item, slot));
    if (occupants.length === 0) {
      const moved = new Map<string, PositionedItem<T>>();
      for (let index = 0; index < displaced.length; index++) {
        moved.set(
          displaced[index].id,
          withPosition(
            displaced[index],
            displaced[index + 1]?.position ?? slot.position,
          ),
        );
      }
      return applyInsertion(items, active, moved, attempts);
    }
    if (
      occupants.some(
        item =>
          item.placement === 'insert' && !isSlotAligned(item, active.span),
      )
    )
      return { status: 'impossible', attempts };
    if (occupants.length === 1 && occupants[0].placement === 'insert') {
      displaced.push(occupants[0]);
    }
    // Do not multiply the number of rows and columns or increment past safe ends.
    if (col <= maxCol - active.span.cols) {
      col += active.span.cols;
    } else if (row <= maxRow - active.span.rows) {
      row += active.span.rows;
      col = 0;
    } else {
      break;
    }
  }
  return { status: 'impossible', attempts };
}

export function insertSpatialItem<T>(
  input: SpatialMoveInput<T>,
  colliders: readonly PositionedItem<T>[],
): PlacementSearchResult<T> {
  const { active, origin } = input;
  if (origin && colliders.length === 0)
    return insertWithinZone({ ...input, origin }, true);
  if (
    colliders.length !== 1 ||
    !isSlotAligned(active, active.span) ||
    !isSlotAligned(colliders[0], active.span) ||
    comparePositions(colliders[0].position, active.position) !== 0
  )
    return { status: 'impossible', attempts: 0 };
  return origin
    ? insertWithinZone({ ...input, origin })
    : insertFromAnotherZone(input);
}
