import type {
  GridPlacement,
  LayoutConversionIssue,
  LayoutLocation,
  LayoutState,
  LayoutZone,
} from '../contracts';
import { DEFAULT_SEARCH_BUDGET } from '../defaults';
import type { CellSpan, ItemPlacement, PositionedItem } from '../types';

import {
  orderedSlots,
  packOrderedPlacements,
  samePlacement,
  slotIndex,
  slotPosition,
} from './gridPlacements';
import { validateLayoutState } from './layoutState';
import {
  validateGridMovementPolicy,
  type GridMovementPolicy,
} from './movementPolicy';
import { resolveSpatialMove } from './spatial';
import {
  isCellPosition,
  isCellSpan,
  isPositiveInteger,
  isRecord,
} from './validation';

/** Caller-owned target grid geometry; list membership never stores a grid span. */
export type GridItemLayout = { span: CellSpan; placement?: ItemPlacement };

export type LayoutMoveInput<T> = {
  value: LayoutState<T>;
  itemId: string;
  /** List indices address the target order after removing the active item. */
  to: LayoutLocation;
  /** Required on list-to-grid moves; optional conversion on cross-grid moves. */
  gridItem?: GridItemLayout;
  movementPolicy?: GridMovementPolicy;
  searchBudget?: number;
};

export type LayoutMoveResult<T> =
  | {
      status: 'ok';
      value: LayoutState<T>;
      from: LayoutLocation;
      to: LayoutLocation;
      changed: boolean;
      attempts: number;
    }
  | { status: 'impossible' | 'unresolved'; attempts: number }
  | { status: 'invalid'; issues: LayoutConversionIssue[] };

function invalid<T>(
  code: LayoutConversionIssue['code'],
  message: string,
  context: Pick<LayoutConversionIssue, 'itemId' | 'zoneId'> = {},
): LayoutMoveResult<T> {
  return { status: 'invalid', issues: [{ code, message, ...context }] };
}

function positioned(placement: GridPlacement): PositionedItem<undefined> {
  return {
    id: placement.itemId,
    span: placement.span,
    position: placement.position,
    ...(placement.placement === undefined
      ? {}
      : { placement: placement.placement }),
    data: undefined,
  };
}

/** Remove an item; an ordered grid closes the gap it leaves. */
function withoutItem(zone: LayoutZone, itemId: string): LayoutZone {
  if (zone.kind === 'list')
    return { ...zone, itemIds: zone.itemIds.filter(id => id !== itemId) };
  const remaining = zone.placements.filter(item => item.itemId !== itemId);
  if (!zone.itemSpan) return { ...zone, placements: remaining };
  const slots = orderedSlots(zone, zone.itemSpan);
  return {
    ...zone,
    placements: packOrderedPlacements(
      remaining,
      zone.itemSpan,
      slots.perRow,
      zone.placements,
    ),
  };
}

/**
 * Compute an atomic move from one complete baseline. The existing spatial
 * solver owns grid movement policy and bounded search; list membership drops
 * grid geometry. Opaque data is never read, copied, or passed to the solver.
 */
export function computeLayoutMove<T>(
  input: LayoutMoveInput<T>,
): LayoutMoveResult<T> {
  if (!isRecord(input)) {
    return invalid('invalid-structure', 'Expected a layout move input object.');
  }
  const validation = validateLayoutState(input.value);
  if (!validation.valid)
    return { status: 'invalid', issues: validation.issues };
  return computeValidatedLayoutMove(input);
}

/**
 * Internal entry for a caller that has already passed `input.value` through
 * `validateLayoutState` and holds it immutably since (the session keeps its
 * committed value). Only that baseline pass is skipped; the complete candidate
 * is still validated before it is returned.
 */
export function computeValidatedLayoutMove<T>(
  input: LayoutMoveInput<T>,
): LayoutMoveResult<T> {
  const policyValidation = validateGridMovementPolicy(input.movementPolicy);
  if (!policyValidation.valid)
    return { status: 'invalid', issues: policyValidation.issues };
  const searchBudget =
    input.searchBudget === undefined
      ? DEFAULT_SEARCH_BUDGET
      : input.searchBudget;
  if (!isPositiveInteger(searchBudget)) {
    return invalid(
      'invalid-budget',
      'searchBudget must be a positive safe integer.',
    );
  }
  if (input.gridItem !== undefined) {
    if (!isRecord(input.gridItem) || !isCellSpan(input.gridItem.span)) {
      return invalid(
        'invalid-span',
        'gridItem.span must contain positive safe integer rows and cols.',
      );
    }
    if (
      input.gridItem.placement !== undefined &&
      input.gridItem.placement !== 'insert' &&
      input.gridItem.placement !== 'exchange'
    ) {
      return invalid(
        'invalid-placement',
        'gridItem.placement must be insert or exchange when supplied.',
      );
    }
  }
  if (typeof input.itemId !== 'string') {
    return invalid('invalid-structure', 'The moving item ID must be a string.');
  }
  if (!isRecord(input.to) || typeof input.to.zoneId !== 'string') {
    return invalid('invalid-structure', 'A target zone is required.');
  }
  const { value, itemId, to } = input;
  const source = value.zones.find(zone =>
    zone.kind === 'list'
      ? zone.itemIds.includes(itemId)
      : zone.placements.some(placement => placement.itemId === itemId),
  );
  const target = value.zones.find(zone => zone.id === to.zoneId);
  if (!source || !target) {
    return invalid(
      'invalid-structure',
      'The item and target zone must exist.',
      {
        itemId,
        zoneId: to.zoneId,
      },
    );
  }
  if (to.kind !== target.kind) {
    return invalid('invalid-structure', 'Target kind must match its zone.', {
      itemId,
      zoneId: target.id,
    });
  }
  const original =
    source.kind === 'grid'
      ? source.placements.find(item => item.itemId === itemId)!
      : undefined;
  const from: LayoutLocation =
    source.kind === 'list'
      ? {
          kind: 'list',
          zoneId: source.id,
          index: source.itemIds.indexOf(itemId),
        }
      : {
          kind: 'grid',
          zoneId: source.id,
          position: { ...original!.position },
        };
  const sameZone = source.id === target.id;
  let nextTarget: LayoutZone;
  let resolvedTo: LayoutLocation;
  let changed: boolean;
  let attempts = 0;
  if (target.kind === 'list' && to.kind === 'list') {
    const remaining = target.itemIds.filter(id => id !== itemId);
    if (
      !Number.isSafeInteger(to.index) ||
      to.index < 0 ||
      to.index > remaining.length
    ) {
      return invalid(
        'invalid-position',
        'Insertion index must address the array after removal.',
        { itemId, zoneId: target.id },
      );
    }
    remaining.splice(to.index, 0, itemId);
    nextTarget = { ...target, itemIds: remaining };
    resolvedTo = { kind: 'list', zoneId: target.id, index: to.index };
    changed = !sameZone || from.kind !== 'list' || from.index !== to.index;
  } else if (target.kind === 'grid' && to.kind === 'grid') {
    if (!isCellPosition(to.position)) {
      return invalid(
        'invalid-position',
        'A grid target requires safe integer row and col coordinates.',
        { itemId, zoneId: target.id },
      );
    }
    const descriptor = input.gridItem ?? original;
    if (!descriptor) {
      return invalid(
        'missing-item-span',
        'A list-to-grid move requires an explicit gridItem descriptor.',
        { itemId, zoneId: target.id },
      );
    }
    if (
      sameZone &&
      original &&
      (descriptor.span.rows !== original.span.rows ||
        descriptor.span.cols !== original.span.cols)
    ) {
      return invalid(
        'span-mismatch',
        'An in-grid move cannot change the item footprint.',
        { itemId, zoneId: target.id },
      );
    }
    if (
      to.position.row < 0 ||
      to.position.col < 0 ||
      to.position.row > target.rows - descriptor.span.rows ||
      to.position.col > target.columns - descriptor.span.cols
    ) {
      return { status: 'impossible', attempts };
    }
    if (target.itemSpan) {
      // Ordered grid: the target position names a slot after removal; the
      // zone re-packs in reading order and its capacity is the slot count.
      const { itemSpan } = target;
      if (
        descriptor.span.rows !== itemSpan.rows ||
        descriptor.span.cols !== itemSpan.cols
      )
        return { status: 'impossible', attempts };
      const slots = orderedSlots(target, itemSpan);
      const remaining = target.placements.filter(
        item => item.itemId !== itemId,
      );
      if (
        slots.perRow === 0 ||
        slots.rows === 0 ||
        Math.ceil((remaining.length + 1) / slots.perRow) > slots.rows
      )
        return { status: 'impossible', attempts };
      const index = slotIndex(to.position, itemSpan, slots.perRow);
      if (index === null || index > remaining.length)
        return invalid(
          'invalid-position',
          'An ordered target must address a slot after removal.',
          { itemId, zoneId: target.id },
        );
      remaining.splice(index, 0, {
        itemId,
        position: slotPosition(index, itemSpan, slots.perRow),
        span: { rows: itemSpan.rows, cols: itemSpan.cols },
        ...(descriptor.placement === undefined
          ? {}
          : { placement: descriptor.placement }),
      });
      const placements = packOrderedPlacements(
        remaining,
        itemSpan,
        slots.perRow,
        target.placements,
      );
      nextTarget = { ...target, placements };
      resolvedTo = {
        kind: 'grid',
        zoneId: target.id,
        position: slotPosition(index, itemSpan, slots.perRow),
      };
      changed =
        !sameZone ||
        placements.length !== target.placements.length ||
        placements.some(
          (placement, position) =>
            !samePlacement(placement, target.placements[position]),
        );
    } else {
      const active: PositionedItem<undefined> = {
        id: itemId,
        data: undefined,
        position: { ...to.position },
        span: { ...descriptor.span },
        ...(descriptor.placement === undefined
          ? {}
          : { placement: descriptor.placement }),
      };
      const result = resolveSpatialMove({
        items: target.placements
          .filter(item => item.itemId !== itemId)
          .map(positioned),
        active,
        origin: sameZone && original ? positioned(original) : undefined,
        rows: target.rows,
        columns: target.columns,
        searchBudget,
        movementPolicy: input.movementPolicy,
      });
      if (result.status !== 'ok') return result;
      attempts = result.attempts;
      const computed = new Map(result.placements.map(item => [item.id, item]));
      const targetIds = target.placements.map(item => item.itemId);
      if (!sameZone) targetIds.push(itemId);
      const existing = new Map(
        target.placements.map(item => [item.itemId, item]),
      );
      const placements = targetIds.map(id => {
        const item = computed.get(id)!;
        const placement: GridPlacement = {
          itemId: item.id,
          position: { ...item.position },
          span: { ...item.span },
          ...(item.placement === undefined
            ? {}
            : { placement: item.placement }),
        };
        const previous = existing.get(id);
        return previous && samePlacement(previous, placement)
          ? previous
          : placement;
      });
      nextTarget = { ...target, placements };
      resolvedTo = {
        kind: 'grid',
        zoneId: target.id,
        position: { ...computed.get(itemId)!.position },
      };
      changed =
        !sameZone ||
        placements.some(
          (placement, index) =>
            !samePlacement(placement, target.placements[index]),
        );
    }
  } else {
    return invalid('invalid-structure', 'Unsupported target kind.', {
      itemId,
      zoneId: target.id,
    });
  }
  if (!changed) {
    return { status: 'ok', value, from, to: resolvedTo, changed, attempts };
  }
  if (value.revision === Number.MAX_SAFE_INTEGER) {
    return invalid(
      'invalid-revision',
      'The layout revision cannot exceed a safe integer.',
    );
  }
  const candidate: LayoutState<T> = {
    revision: value.revision + 1,
    items: value.items,
    zones: value.zones.map(zone => {
      if (zone.id === target.id) return nextTarget;
      if (zone.id === source.id) return withoutItem(source, itemId);
      return zone;
    }),
  };
  const candidateValidation = validateLayoutState(candidate);
  if (!candidateValidation.valid) {
    return { status: 'invalid', issues: candidateValidation.issues };
  }
  return {
    status: 'ok',
    value: candidate,
    from,
    to: resolvedTo,
    changed,
    attempts,
  };
}
