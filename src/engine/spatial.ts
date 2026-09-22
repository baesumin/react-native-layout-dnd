import type { PositionedItem } from '../types';

import type { GridMovementPolicy } from './movementPolicy';
import type { PlacementSearchResult } from './search';
import { exchangeSpatialRegions } from './spatialExchange';
import { insertSpatialItem } from './spatialInsertion';
import { rotateSpatialRows } from './spatialRotation';
import { selectSpatialMove } from './spatialPolicy';

export type SpatialMoveInput<T> = {
  items: readonly PositionedItem<T>[];
  active: PositionedItem<T>;
  /** Original active item, only when the source and target are the same zone. */
  origin?: PositionedItem<T>;
  rows: number;
  columns: number;
  searchBudget: number;
  movementPolicy?: GridMovementPolicy;
};

/** Internal: target input is valid, and items excludes the active item. */
export function resolveSpatialMove<T>(
  input: SpatialMoveInput<T>,
): PlacementSearchResult<T> {
  const { move, kind, colliders } = selectSpatialMove(input);
  if (kind === 'row-rotation') return rotateSpatialRows(move)!;
  if (kind === 'insert') return insertSpatialItem(move, colliders);
  if (kind === 'exchange') return exchangeSpatialRegions(move);
  if (kind === 'vacancy')
    return {
      status: 'ok',
      placements: [...move.items, move.active],
      attempts: 0,
    };
  return { status: 'impossible', attempts: 0 };
}
