import type { MoveProposal, ProposalResponse } from '../contracts';
import { isRecord } from '../engine/validation';

/**
 * Shared revisioned approval for both value shapes (`GridValue` and
 * `LayoutState`). The adapter supplies the shape-specific checks; the order of
 * checks, the stale rules and the response protocol are the same for both.
 */
export type ApprovalResult<Value, Issue> =
  | { status: 'accepted' | 'rejected' | 'stale'; value: Value }
  | { status: 'invalid'; value: Value; issues: Issue[] };

/** Legacy grid values may carry a response without a base revision. */
type Revisioned = {
  revision: number;
  proposalResponse?: {
    sessionId: string;
    baseRevision?: number;
    accepted: boolean;
  };
};

export type ApprovalAdapter<Value extends Revisioned, Location, Issue> = {
  /** Issues of the current value, or null when it is usable as a baseline. */
  validateCurrent(current: Value): Issue[] | null;
  /** Issues of the complete candidate, or null when it is valid. */
  validateCandidate(candidate: Value): Issue[] | null;
  issue(message: string): Issue;
  isLocation(value: unknown): value is Location;
  location(value: Value, itemId: string): Location | null;
  sameLocation(first: Location, second: Location | null): boolean;
  hasDestinationZone(value: Value, to: Location): boolean;
  zonesPreserved(current: Value, candidate: Value): boolean;
  itemsPreserved(current: Value, candidate: Value): boolean;
  messages: { zones: string; items: string; destination: string };
  /** Attach the response (and any retained caller objects) to the candidate. */
  accept(current: Value, candidate: Value, response: ProposalResponse): Value;
};

/** A response only changes the exact revision on which the complete proposal was based. */
export function respondToProposal<Value extends Revisioned, Location, Issue>(
  adapter: ApprovalAdapter<Value, Location, Issue>,
  current: Value,
  proposal: MoveProposal<Value, Location>,
  accepted: boolean,
  checkCurrent: boolean,
): ApprovalResult<Value, Issue> {
  const invalid = (message: string): ApprovalResult<Value, Issue> => ({
    status: 'invalid',
    value: current,
    issues: [adapter.issue(message)],
  });
  if (checkCurrent) {
    const issues = adapter.validateCurrent(current);
    if (issues) return { status: 'invalid', value: current, issues };
  }
  if (
    !isRecord(proposal) ||
    typeof proposal.sessionId !== 'string' ||
    typeof proposal.itemId !== 'string' ||
    !Number.isSafeInteger(proposal.baseRevision) ||
    proposal.baseRevision < 0 ||
    typeof accepted !== 'boolean'
  )
    return invalid(
      'A proposal requires a session ID, item ID, base revision and boolean response.',
    );
  if (
    proposal.baseRevision !== current.revision ||
    (current.proposalResponse?.sessionId === proposal.sessionId &&
      current.proposalResponse.baseRevision === proposal.baseRevision)
  )
    return { status: 'stale', value: current };
  if (
    !adapter.isLocation(proposal.from) ||
    !adapter.isLocation(proposal.to) ||
    !adapter.sameLocation(
      proposal.from,
      adapter.location(current, proposal.itemId),
    ) ||
    !adapter.hasDestinationZone(current, proposal.to)
  )
    return invalid(
      'Proposal locations must identify the current item and an existing destination zone.',
    );
  const response: ProposalResponse = {
    sessionId: proposal.sessionId,
    baseRevision: proposal.baseRevision,
    accepted,
  };
  if (!accepted)
    return {
      status: 'rejected',
      value: { ...current, proposalResponse: response },
    };
  const issues = adapter.validateCandidate(proposal.value);
  if (issues) return { status: 'invalid', value: current, issues };
  if (
    !Number.isSafeInteger(proposal.value.revision) ||
    proposal.value.revision !== current.revision + 1
  )
    return invalid(
      'An accepted proposal must advance its base revision by one.',
    );
  if (!adapter.zonesPreserved(current, proposal.value))
    return invalid(adapter.messages.zones);
  if (!adapter.itemsPreserved(current, proposal.value))
    return invalid(adapter.messages.items);
  if (
    !adapter.sameLocation(
      proposal.to,
      adapter.location(proposal.value, proposal.itemId),
    )
  )
    return invalid(adapter.messages.destination);
  return {
    status: 'accepted',
    value: adapter.accept(current, proposal.value, response),
  };
}

export type ApprovalStore<Value, Proposal, Issue> = {
  getSnapshot(): Value;
  subscribe(listener: () => void): () => void;
  respond(proposal: Proposal, accepted: boolean): ApprovalResult<Value, Issue>;
  /** Publish a value produced outside the reducer, such as an external edit. */
  publish(next: Value): void;
};

/**
 * Listeners, closed-session memory and publication shared by the grid and
 * layout stores. Rejections leave the revision unchanged; every closed session
 * is remembered until the next revision so a delayed response cannot reopen an
 * earlier rejection.
 */
export function createApprovalStore<
  Value extends { revision: number },
  Proposal extends { sessionId: string; baseRevision: number },
  Issue,
>(
  initial: Value,
  respond: (
    current: Value,
    proposal: Proposal,
    accepted: boolean,
  ) => ApprovalResult<Value, Issue>,
): ApprovalStore<Value, Proposal, Issue> {
  let value = initial;
  const listeners = new Set<() => void>();
  const closedSessions = new Set<string>();
  const publish = (next: Value) => {
    if (next === value) return;
    if (next.revision !== value.revision) closedSessions.clear();
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    respond: (proposal, accepted) => {
      if (
        isRecord(proposal) &&
        proposal.baseRevision === value.revision &&
        closedSessions.has(proposal.sessionId)
      )
        return { status: 'stale', value };
      const result = respond(value, proposal, accepted);
      if (result.status === 'rejected') closedSessions.add(proposal.sessionId);
      publish(result.value);
      return result;
    },
    publish,
  };
}
