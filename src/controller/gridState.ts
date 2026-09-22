import { isCellPosition, isRecord, validateValue } from '../engine/validation';
import type {
  GridChange,
  GridProposal,
  GridValue,
  ItemLocation,
  RevisionedGridValue,
  ValidationIssue,
} from '../types';

import {
  createApprovalStore,
  respondToProposal,
  type ApprovalAdapter,
  type ApprovalResult,
} from './approval';
import { itemLocation, sameItemLocation } from './locations';

export type GridProposalResult<T> = ApprovalResult<
  RevisionedGridValue<T>,
  ValidationIssue
>;

function isLocation(value: unknown): value is ItemLocation {
  if (!isRecord(value) || typeof value.zoneId !== 'string') return false;
  return value.strategy === 'ordered'
    ? typeof value.index === 'number' &&
        Number.isSafeInteger(value.index) &&
        value.index >= 0
    : value.strategy === 'spatial' &&
        isCellPosition(value.position) &&
        value.position.row >= 0 &&
        value.position.col >= 0;
}

function issues<T>(value: GridValue<T>): ValidationIssue[] | null {
  const checked = validateValue(value);
  return checked.valid ? null : checked.issues;
}

function gridAdapter<T>(): ApprovalAdapter<
  RevisionedGridValue<T>,
  ItemLocation,
  ValidationIssue
> {
  return {
    validateCurrent: current =>
      issues(current) ??
      (!Number.isSafeInteger(current.revision) || current.revision < 0
        ? [
            {
              code: 'invalid-structure',
              message:
                'Current grid state must have a non-negative safe integer revision.',
            },
          ]
        : null),
    validateCandidate: issues,
    issue: message => ({ code: 'invalid-structure', message }),
    isLocation,
    location: itemLocation,
    sameLocation: sameItemLocation,
    hasDestinationZone: (value, to) =>
      value.zones.some(
        zone => zone.id === to.zoneId && zone.strategy === to.strategy,
      ),
    zonesPreserved: (current, candidate) => {
      const zones = new Map(current.zones.map(zone => [zone.id, zone]));
      return (
        candidate.zones.length === zones.size &&
        candidate.zones.every(zone => {
          const original = zones.get(zone.id);
          return (
            original !== undefined &&
            original.strategy === zone.strategy &&
            original.rows === zone.rows &&
            original.columns === zone.columns &&
            (original.strategy !== 'ordered' ||
              zone.strategy !== 'ordered' ||
              (original.itemSpan.rows === zone.itemSpan.rows &&
                original.itemSpan.cols === zone.itemSpan.cols))
          );
        })
      );
    },
    // A movement may change layout, never the caller's item set or opaque data.
    itemsPreserved: (current, candidate) => {
      const items = new Map(
        current.zones.flatMap(zone => zone.items).map(item => [item.id, item]),
      );
      const proposed = candidate.zones.flatMap(zone => zone.items);
      return (
        proposed.length === items.size &&
        proposed.every(item => {
          const original = items.get(item.id);
          return (
            original !== undefined &&
            Object.is(original.data, item.data) &&
            original.span.rows === item.span.rows &&
            original.span.cols === item.span.cols &&
            original.placement === item.placement
          );
        })
      );
    },
    messages: {
      zones:
        'A grid proposal must preserve zone IDs, strategies, dimensions and ordered item spans.',
      items:
        'A grid proposal must preserve all item IDs, spans, placement policies and caller data.',
      destination:
        'The proposed destination must match the item location in the complete candidate.',
    },
    accept: (_current, candidate, response) => ({
      ...candidate,
      proposalResponse: response,
    }),
  };
}

/** A response only changes the exact revision on which the complete proposal was based. */
export function respondToGridProposal<T>(
  current: RevisionedGridValue<T>,
  proposal: GridProposal<T>,
  accepted: boolean,
): GridProposalResult<T> {
  return respondToProposal(gridAdapter<T>(), current, proposal, accepted, true);
}

export type GridStateUpdate<T> =
  GridValue<T> | ((current: RevisionedGridValue<T>) => GridValue<T>);
export type GridStateStore<T> = {
  getSnapshot(): RevisionedGridValue<T>;
  subscribe(listener: () => void): () => void;
  /** Synchronously accept valid controller proposals. Use canDrop for synchronous rejection. */
  onChange(next: GridValue<T>, change: GridChange): void;
  /** External edits advance the revision and clear any previous response. */
  setValue(next: GridStateUpdate<T>): void;
  respond(proposal: GridProposal<T>, accepted: boolean): GridProposalResult<T>;
};

function assertValid<T>(value: GridValue<T>): void {
  const result = validateValue(value);
  if (!result.valid)
    throw new TypeError(result.issues.map(issue => issue.message).join(' '));
}

/** React-independent store; the state hook and external stores share the response reducer. */
export function createGridStateStore<T>(
  initialValue: GridValue<T>,
): GridStateStore<T> {
  assertValid(initialValue);
  const store = createApprovalStore<
    RevisionedGridValue<T>,
    GridProposal<T>,
    ValidationIssue
  >(
    { zones: initialValue.zones, revision: initialValue.revision ?? 0 },
    respondToGridProposal,
  );
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    onChange: (next, change) => {
      if (change.baseRevision === undefined || next.revision === undefined)
        return;
      store.respond(
        {
          ...change,
          baseRevision: change.baseRevision,
          value: { ...next, revision: next.revision },
        },
        true,
      );
    },
    setValue: update => {
      const value = store.getSnapshot();
      const next = typeof update === 'function' ? update(value) : update;
      if (next === value) return;
      assertValid(next);
      if (value.revision === Number.MAX_SAFE_INTEGER)
        throw new RangeError('Grid revision is exhausted.');
      store.publish({ zones: next.zones, revision: value.revision + 1 });
    },
    respond: store.respond,
  };
}
