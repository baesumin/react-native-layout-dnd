import type {
  DndItem,
  LayoutLocation,
  LayoutState,
  LayoutValidationIssue,
} from '../contracts';
import {
  orderedSlots,
  slotIndex,
  slotPosition,
} from '../engine/gridPlacements';
import { fromGridValue } from '../engine/layoutState';
import { hasSameLayout } from '../engine/sameLayout';
import { validateValue } from '../engine/validation';
import type {
  DragEndEvent,
  GridChange,
  GridItem,
  GridValue,
  ItemLocation,
  ValidationCode,
  ValidationIssue,
} from '../types';

import type { DndDragEndEvent } from './dndSession';
import type { DndProposal, DndValue } from './dndState';

/**
 * Maps the `GridValue` API of `GridController` onto the layout-state API of
 * the shared provider: values, locations, changes, end events and validation
 * issues. Every function is pure; the component keeps only React state.
 */

/** The grid API's location for a layout location; ordered grids use slot indices. */
export function toItemLocation<T>(
  state: LayoutState<T>,
  location: LayoutLocation,
): ItemLocation {
  if (location.kind === 'list')
    return {
      zoneId: location.zoneId,
      strategy: 'ordered',
      index: location.index,
    };
  const zone = state.zones.find(entry => entry.id === location.zoneId);
  if (zone?.kind === 'grid' && zone.itemSpan) {
    const slots = orderedSlots(zone, zone.itemSpan);
    const index = slotIndex(location.position, zone.itemSpan, slots.perRow);
    if (index !== null)
      return { zoneId: location.zoneId, strategy: 'ordered', index };
  }
  return {
    zoneId: location.zoneId,
    strategy: 'spatial',
    position: { row: location.position.row, col: location.position.col },
  };
}

/** The layout location for a grid API location, or null when it names no slot. */
export function toLayoutLocation<T>(
  state: LayoutState<T>,
  location: ItemLocation,
): LayoutLocation | null {
  const zone = state.zones.find(entry => entry.id === location.zoneId);
  if (!zone) return null;
  if (zone.kind === 'list')
    return location.strategy === 'ordered'
      ? { kind: 'list', zoneId: zone.id, index: location.index }
      : null;
  if (location.strategy === 'spatial')
    return zone.itemSpan
      ? null
      : {
          kind: 'grid',
          zoneId: zone.id,
          position: { row: location.position.row, col: location.position.col },
        };
  if (
    !zone.itemSpan ||
    !Number.isSafeInteger(location.index) ||
    location.index < 0
  )
    return null;
  const slots = orderedSlots(zone, zone.itemSpan);
  if (slots.perRow === 0 || location.index >= slots.perRow * slots.rows)
    return null;
  return {
    kind: 'grid',
    zoneId: zone.id,
    position: slotPosition(location.index, zone.itemSpan, slots.perRow),
  };
}

/** The legacy change record of a proposal; the base revision is optional API. */
export function gridChangeOf<T>(
  proposal: DndProposal<T>,
  includeBaseRevision: boolean,
): GridChange {
  return {
    sessionId: proposal.sessionId,
    ...(includeBaseRevision ? { baseRevision: proposal.baseRevision } : {}),
    itemId: proposal.itemId,
    from: toItemLocation(proposal.value, proposal.from),
    to: toItemLocation(proposal.value, proposal.to),
  };
}

export function gridEndEvent<T>(
  event: DndDragEndEvent<T>,
  includeBaseRevision: boolean,
): DragEndEvent {
  const base = {
    sessionId: event.sessionId,
    itemId: event.itemId,
    sourceZoneId: event.sourceZoneId,
    ...(event.error === undefined ? {} : { error: event.error }),
  };
  if (event.outcome === 'unchanged') return { ...base, outcome: 'unchanged' };
  if (event.outcome === 'cancelled')
    return {
      ...base,
      outcome: 'cancelled',
      reason: event.reason,
      ...(event.targetZoneId === undefined
        ? {}
        : { targetZoneId: event.targetZoneId }),
      ...(event.policyReason === undefined
        ? {}
        : { policyReason: event.policyReason }),
    };
  const change = gridChangeOf(event.proposal, includeBaseRevision);
  return event.response === 'interrupted'
    ? {
        ...base,
        outcome: 'proposed',
        change,
        targetZoneId: event.targetZoneId,
        response: 'interrupted',
        reason: event.reason,
      }
    : {
        ...base,
        outcome: 'proposed',
        change,
        targetZoneId: event.targetZoneId,
        response: event.response,
      };
}

const GRID_CODES = new Set<string>([
  'invalid-structure',
  'duplicate-id',
  'invalid-dimension',
  'invalid-span',
  'invalid-placement',
  'missing-item-span',
  'span-mismatch',
  'invalid-position',
  'out-of-bounds',
  'overlap',
  'capacity-exceeded',
  'invalid-budget',
  'invalid-geometry',
  'invalid-configuration',
]);

/** Layout-state issues in the grid API's vocabulary. */
export function gridIssues(
  issues: ReadonlyArray<
    Pick<LayoutValidationIssue, 'message' | 'zoneId' | 'itemId'> & {
      code: string;
    }
  >,
): ValidationIssue[] {
  return issues.map(issue => ({
    code: (GRID_CODES.has(issue.code)
      ? issue.code
      : 'invalid-structure') as ValidationCode,
    message: issue.message,
    ...(issue.zoneId === undefined ? {} : { zoneId: issue.zoneId }),
    ...(issue.itemId === undefined ? {} : { itemId: issue.itemId }),
  }));
}

export type ConvertedGridValue<T> = {
  /** Null when the grid value is invalid; `issues` then explains why. */
  state: DndValue<T> | null;
  issues: ValidationIssue[];
  revision: number;
};

export type PreviousConversion<T> = {
  value: GridValue<T>;
  revision: number;
  state: DndValue<T> | null;
};

/**
 * Convert a committed grid value for the provider. Values without a revision
 * receive a synthetic one that advances whenever the layout changes, so the
 * provider's revision protocol still detects edits; a response that omits its
 * base revision is attributed to the proposal it answers. Item objects whose
 * data is unchanged keep their identity, so cells and the approval reducer see
 * stable objects; acceptance itself compares layout and revision only, so an
 * owner may rebuild an item's data for its new zone.
 */
export function convertGridValue<T>(
  value: GridValue<T>,
  previous: PreviousConversion<T> | null,
  pendingBaseRevision: number | undefined,
): ConvertedGridValue<T> {
  const checked = validateValue(value);
  const revision =
    value.revision ??
    (previous === null
      ? 0
      : hasSameLayout(previous.value, value)
        ? previous.revision
        : previous.revision + 1);
  if (!checked.valid) return { state: null, issues: checked.issues, revision };
  const converted = fromGridValue(value, revision);
  if (!converted.valid)
    return { state: null, issues: gridIssues(converted.issues), revision };
  const state = converted.value;
  if (previous?.state)
    state.items = reuseItems(state.items, previous.state.items);
  const response = value.proposalResponse;
  return {
    revision,
    issues: [],
    state: response
      ? {
          ...state,
          proposalResponse: {
            sessionId: response.sessionId,
            accepted: response.accepted,
            baseRevision:
              response.baseRevision ?? pendingBaseRevision ?? revision,
          },
        }
      : state,
  };
}

function reuseItems<T>(
  items: DndItem<T>[],
  previous: DndItem<T>[],
): DndItem<T>[] {
  const known = new Map(previous.map(item => [item.id, item]));
  let same = items.length === previous.length;
  const reused = items.map((item, index) => {
    const before = known.get(item.id);
    const kept = before && Object.is(before.data, item.data) ? before : item;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? previous : reused;
}

/** The caller's own item objects by ID, so render callbacks see stable identities. */
export function gridItemIndex<T>(
  value: GridValue<T>,
): Map<string, GridItem<T>> {
  const items = new Map<string, GridItem<T>>();
  for (const zone of value.zones)
    for (const item of zone.items) items.set(item.id, item);
  return items;
}
