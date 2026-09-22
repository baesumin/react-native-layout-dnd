import type {
  LayoutLocation,
  LayoutState,
  LayoutValidationIssue,
  MoveProposal,
  ProposalResponse,
} from '../contracts';
import { validateLayoutState } from '../engine/layoutState';
import { isCellPosition, isRecord } from '../engine/validation';

import {
  createApprovalStore,
  respondToProposal,
  type ApprovalAdapter,
  type ApprovalResult,
} from './approval';
import { layoutLocation, sameLayoutLocation } from './locations';

export type DndValue<T> = LayoutState<T> & {
  proposalResponse?: ProposalResponse;
};
export type DndProposal<T> = MoveProposal<LayoutState<T>, LayoutLocation>;
export type DndProposalResult<T> = ApprovalResult<
  DndValue<T>,
  LayoutValidationIssue
>;

function isLocation(value: unknown): value is LayoutLocation {
  if (!isRecord(value) || typeof value.zoneId !== 'string') return false;
  return value.kind === 'list'
    ? typeof value.index === 'number' &&
        Number.isSafeInteger(value.index) &&
        value.index >= 0
    : value.kind === 'grid' &&
        isCellPosition(value.position) &&
        value.position.row >= 0 &&
        value.position.col >= 0;
}

function issues<T>(value: LayoutState<T>): LayoutValidationIssue[] | null {
  const checked = validateLayoutState(value);
  return checked.valid ? null : checked.issues;
}

function layoutAdapter<T>(): ApprovalAdapter<
  DndValue<T>,
  LayoutLocation,
  LayoutValidationIssue
> {
  return {
    validateCurrent: issues,
    validateCandidate: issues,
    issue: message => ({ code: 'invalid-structure', message }),
    isLocation,
    location: layoutLocation,
    sameLocation: sameLayoutLocation,
    hasDestinationZone: (value, to) =>
      value.zones.some(zone => zone.id === to.zoneId && zone.kind === to.kind),
    zonesPreserved: (current, candidate) => {
      const zones = new Map(current.zones.map(zone => [zone.id, zone]));
      return (
        candidate.zones.length === zones.size &&
        candidate.zones.every(zone => {
          const original = zones.get(zone.id);
          return (
            original !== undefined &&
            original.kind === zone.kind &&
            (zone.kind !== 'list' ||
              original.kind !== 'list' ||
              zone.orientation === original.orientation) &&
            (zone.kind !== 'grid' ||
              original.kind !== 'grid' ||
              (zone.rows === original.rows &&
                zone.columns === original.columns &&
                zone.itemSpan?.rows === original.itemSpan?.rows &&
                zone.itemSpan?.cols === original.itemSpan?.cols))
          );
        })
      );
    },
    // computeLayoutMove reuses the baseline items array; only a replaced array
    // needs the per-item identity check.
    itemsPreserved: (current, candidate) => {
      if (candidate.items === current.items) return true;
      const items = new Map(current.items.map(item => [item.id, item]));
      return (
        candidate.items.length === items.size &&
        candidate.items.every(item => items.get(item.id) === item)
      );
    },
    messages: {
      zones:
        'A movement must preserve zone IDs, kinds, orientations and grid dimensions.',
      items:
        'A movement must preserve every caller-owned item object and its data.',
      destination:
        'The destination must match the item location in the complete candidate.',
    },
    accept: (current, candidate, response) => ({
      ...candidate,
      items: current.items,
      proposalResponse: response,
    }),
  };
}

/** Validate the complete atomic proposal before applying a matching revision response. */
export function respondToDndProposal<T>(
  current: DndValue<T>,
  proposal: DndProposal<T>,
  accepted: boolean,
): DndProposalResult<T> {
  return respondToProposal(
    layoutAdapter<T>(),
    current,
    proposal,
    accepted,
    true,
  );
}

/**
 * Internal entry for a caller that has already validated `current` and holds
 * it immutably since (the session keeps its committed value). The proposal and
 * its complete candidate are still checked in full.
 */
export function respondToValidatedDndProposal<T>(
  current: DndValue<T>,
  proposal: DndProposal<T>,
  accepted: boolean,
): DndProposalResult<T> {
  return respondToProposal(
    layoutAdapter<T>(),
    current,
    proposal,
    accepted,
    false,
  );
}

export type DndStateUpdate<T> =
  LayoutState<T> | ((current: DndValue<T>) => LayoutState<T>);
export type DndStateStore<T> = {
  getSnapshot(): DndValue<T>;
  subscribe(listener: () => void): () => void;
  onChange(next: DndValue<T>, proposal: DndProposal<T>): void;
  /** External edits advance the revision and clear the previous proposal response. */
  setValue(next: DndStateUpdate<T>): void;
  respond(proposal: DndProposal<T>, accepted: boolean): DndProposalResult<T>;
};

function assertValid<T>(value: LayoutState<T>): void {
  const checked = validateLayoutState(value);
  if (!checked.valid)
    throw new TypeError(checked.issues.map(issue => issue.message).join(' '));
}

/** The same synchronous approval path for React state and external stores. */
export function createDndStateStore<T>(
  initialValue: LayoutState<T>,
): DndStateStore<T> {
  assertValid(initialValue);
  const store = createApprovalStore<
    DndValue<T>,
    DndProposal<T>,
    LayoutValidationIssue
  >(
    {
      revision: initialValue.revision,
      items: initialValue.items,
      zones: initialValue.zones,
    },
    respondToDndProposal,
  );
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    onChange: (next, proposal) => {
      // The callback carries one complete proposal; two different candidates are ambiguous.
      if (next !== proposal.value) return;
      store.respond(proposal, true);
    },
    setValue: update => {
      const value = store.getSnapshot();
      const next = typeof update === 'function' ? update(value) : update;
      if (next === value) return;
      assertValid(next);
      if (value.revision === Number.MAX_SAFE_INTEGER)
        throw new RangeError('Layout revision is exhausted.');
      store.publish({
        revision: value.revision + 1,
        items: next.items,
        zones: next.zones,
      });
    },
    respond: store.respond,
  };
}
