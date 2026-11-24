import { DEFAULT_GRID_MOVEMENT_POLICY } from './movementPolicy';
import type { GridMoveCandidate } from './movementPolicy';
import { rectanglesOverlap } from './rectangles';
import type { SpatialMoveInput } from './spatial';
import { normalizeAppWidgetMove } from './spatialAppRotation';

/** Shared rule selection only: no packing, search, or caller callbacks on the UI thread. */
export function selectSpatialMove<T>(input: SpatialMoveInput<T>) {
  'worklet';
  // Callers may pass a partial policy: every omitted rule takes its default.
  const policy = input.movementPolicy ?? DEFAULT_GRID_MOVEMENT_POLICY;
  const rowRotation =
    policy.rowRotation ?? DEFAULT_GRID_MOVEMENT_POLICY.rowRotation;
  const move =
    (policy.adjacentInsertExchange ??
      DEFAULT_GRID_MOVEMENT_POLICY.adjacentInsertExchange) === 'single-cell'
      ? (normalizeAppWidgetMove(input) ?? input)
      : input;
  const { active, origin, items, columns } = move;
  const colliders = items.filter(item => rectanglesOverlap(active, item));
  let kind: GridMoveCandidate | 'vacancy' | 'blocked' =
    colliders.length === 0 ? 'vacancy' : 'blocked';
  for (const candidate of policy.candidateOrder ??
    DEFAULT_GRID_MOVEMENT_POLICY.candidateOrder) {
    if (
      candidate === 'row-rotation' &&
      rowRotation === 'full-width' &&
      origin &&
      active.placement !== 'insert' &&
      active.span.cols === columns &&
      active.position.col === origin.position.col &&
      active.position.row !== origin.position.row
    ) {
      kind = candidate;
      break;
    }
    if (
      candidate === 'insert' &&
      active.placement === 'insert' &&
      // An empty target is a vacancy for every placement: nothing else moves.
      colliders.length > 0 &&
      colliders.every(item => item.placement === 'insert')
    ) {
      kind = candidate;
      break;
    }
    if (candidate === 'exchange' && colliders.length > 0) {
      kind = candidate;
      break;
    }
  }
  return { move, kind, colliders };
}
