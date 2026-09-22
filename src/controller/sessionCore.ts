import {
  diagnosticNow,
  type DiagnosticObserver,
  emitDiagnostic,
} from '../diagnostics';
import type {
  CancelReason,
  DragStartEvent,
  DropDecision,
  GridDiagnosticEvent,
} from '../types';

import { CoordinatorBase } from './coordinatorBase';
import { type PreviewBaseline, PreviewPath } from './previewPath';

/** Engine outcome normalized for both value shapes. */
export type CandidateResult<Value, Location> =
  | {
      status: 'ok';
      value: Value;
      from: Location;
      to: Location;
      changed: boolean;
    }
  | { status: 'impossible' | 'unresolved' | 'invalid' };

type OkCandidate<Value, Location> = Extract<
  CandidateResult<Value, Location>,
  { status: 'ok' }
>;

export type CandidateFailure =
  'unresolvable' | 'search-budget' | 'invalid-target';

export function candidateFailure(
  status: 'impossible' | 'unresolved' | 'invalid',
): CandidateFailure {
  return status === 'impossible'
    ? 'unresolvable'
    : status === 'unresolved'
      ? 'search-budget'
      : 'invalid-target';
}

/** Snapshot fields every coordinator publishes; subclasses add their own. */
export type CoreSnapshot<Value> = {
  value: Value | null;
  displayValue: Value | null;
  phase: string;
  sessionId: string | null;
  itemId: string | null;
  sourceZoneId: string | null;
  targetZoneId: string | null;
  seq: number;
  validity: 'pending' | 'valid' | 'invalid';
  disabled: boolean;
};

/** Session fields the shared candidate flow reads and writes. */
export type CoreSession<Value, Location> = DragStartEvent & {
  seq: number;
  target: Location | null;
  path: PreviewPath<Location, Value>;
  deadline?: number;
};

/**
 * The drag session logic both coordinators share: request guards, the
 * cumulative preview baseline, engine dispatch, the permission callback with
 * its reentrancy guard, candidate publication and the final proposal. The
 * value shape, engine call, snapshot fields and terminal transitions
 * (cancel, unchanged, handoff) come from the subclass.
 */
export abstract class SessionCore<
  Value,
  Location extends { zoneId: string },
  Snapshot extends CoreSnapshot<Value>,
  Session extends CoreSession<Value, Location>,
  Proposal,
> extends CoordinatorBase<Snapshot> {
  protected session: Session | null = null;
  protected lastValidValue: Value | null;
  protected disposed = false;
  private diagnosticEvents:
    { observer: DiagnosticObserver; event: GridDiagnosticEvent }[] | undefined;
  private flushingDiagnostics = false;

  protected constructor(initial: Snapshot, lastValidValue: Value | null) {
    super(initial);
    this.lastValidValue = lastValidValue;
  }

  /** The consumer's optional JS-only observer; exceptions never affect a drag. */
  protected abstract diagnosticObserver(): DiagnosticObserver | undefined;

  protected queueDiagnostic(
    observer: DiagnosticObserver,
    event: GridDiagnosticEvent,
  ): void {
    (this.diagnosticEvents ??= []).push({ observer, event });
  }

  /** Diagnostics queued during a batch are delivered after its subscribers. */
  protected override batchFinished(): void {
    if (this.diagnosticEvents) this.flushDiagnostics();
  }

  private flushDiagnostics(): void {
    if (this.flushingDiagnostics) return;
    this.flushingDiagnostics = true;
    try {
      while (this.diagnosticEvents) {
        const pending = this.diagnosticEvents;
        this.diagnosticEvents = undefined;
        for (const { observer, event } of pending)
          emitDiagnostic(observer, event);
      }
    } finally {
      this.flushingDiagnostics = false;
    }
  }

  protected lifecycle(
    name: Extract<GridDiagnosticEvent, { type: 'lifecycle' }>['name'],
    session: Session,
  ): void {
    const observer = this.diagnosticObserver();
    if (!observer) return;
    this.queueDiagnostic(observer, {
      type: 'lifecycle',
      name,
      timestampMs: diagnosticNow(),
      sessionId: session.sessionId,
    });
  }

  /** Time one engine or policy step for the observer, including failures. */
  protected timed<R>(
    session: Session,
    name: 'compute-move' | 'policy',
    run: () => R,
    status: (result: R) => string,
    attempts: (result: R) => number | undefined = () => undefined,
  ): R {
    const observer = this.diagnosticObserver();
    if (!observer) return run();
    const startedAt = diagnosticNow();
    let result: R | undefined;
    try {
      result = run();
      return result;
    } finally {
      const count = result === undefined ? undefined : attempts(result);
      this.queueDiagnostic(observer, {
        type: 'timing',
        name,
        durationMs: diagnosticNow() - startedAt,
        status: result === undefined ? 'error' : status(result),
        ...(count === undefined ? {} : { attempts: count }),
        sessionId: session.sessionId,
      });
    }
  }

  protected event(session: Session): DragStartEvent {
    return {
      sessionId: session.sessionId,
      itemId: session.itemId,
      sourceZoneId: session.sourceZoneId,
    };
  }

  /** The live dragging session when the request sequence is acceptable. */
  protected acceptsRequest(
    sessionId: string,
    seq: number,
    final: boolean,
  ): Session | null {
    const session = this.session;
    if (
      !session ||
      session.sessionId !== sessionId ||
      this.snapshot.phase !== 'dragging' ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      (final ? seq < session.seq : seq <= session.seq)
    )
      return null;
    return session;
  }

  protected abstract location(value: Value, itemId: string): Location | null;
  /** Spatial targets accumulate previews; ordered/list targets never do. */
  protected abstract isSpatial(target: Location): boolean;
  /** A failure detail that rejects the target before any computation. */
  protected abstract precheck(
    session: Session,
    target: Location,
  ): string | null;
  protected abstract compute(
    session: Session,
    target: Location,
    baseline: { base: Value; cumulative: boolean },
    committed: Value,
    from: Location | null,
  ): CandidateResult<Value, Location>;
  /** Whether a failed candidate leaves the earlier preview on screen. */
  protected abstract keepsPreview(
    session: Session,
    target: Location,
    status: 'impossible' | 'unresolved' | 'invalid',
  ): boolean;
  protected abstract prepareProposal(
    session: Session,
    result: OkCandidate<Value, Location>,
  ): Proposal;
  /** Runs the permission callback and validates its shape; may throw. */
  protected abstract askPolicy(
    session: Session,
    committed: Value,
    proposal: Proposal,
    result: OkCandidate<Value, Location>,
  ): DropDecision;
  protected abstract policyFailed(
    session: Session,
    seq: number,
    error: unknown,
  ): void;
  /** Re-check a changed candidate after the callback ran; true when it stands. */
  protected abstract revalidate(
    session: Session,
    committed: Value,
    proposal: Proposal,
    result: OkCandidate<Value, Location>,
  ): boolean;
  protected abstract showCandidate(result: OkCandidate<Value, Location>): void;
  protected abstract showFailure(
    committed: Value | null,
    failure: string,
    keepPreview: boolean,
  ): void;
  protected abstract expectedPhase(final: boolean): string;
  protected abstract sessionEnded(session: Session): boolean;
  protected abstract cancelWith(
    reason: CancelReason,
    error?: unknown,
    policyReason?: string,
  ): void;
  protected abstract finishUnchanged(session: Session): void;
  /** Store the proposal, arm the deadline and enter awaiting-response. */
  protected abstract registerProposal(
    session: Session,
    proposal: Proposal,
    result: OkCandidate<Value, Location>,
  ): void;
  protected abstract emitChange(
    proposal: Proposal,
    result: OkCandidate<Value, Location>,
  ): void;
  protected abstract changeFailed(session: Session, error: unknown): void;

  /**
   * Compute, permit and publish the candidate for `session.target`. The
   * subclass has already stored the target and its sequence on the session.
   */
  protected calculateCandidate(session: Session, final: boolean): void {
    const seq = session.seq;
    const committed = this.lastValidValue;
    const target = session.target;
    if (!target || !committed) {
      if (final) this.cancelWith('outside-zones');
      else this.showFailure(committed, 'outside-zones', false);
      return;
    }
    const rejected = this.precheck(session, target);
    if (rejected !== null) {
      session.path.reset();
      if (final) this.cancelWith('invalid-target', undefined, rejected);
      else this.showFailure(committed, rejected, false);
      return;
    }
    const from = this.location(committed, session.itemId);
    // Previews accumulate only inside the source zone: ordered targets are
    // path-independent, and other zones keep computing from the committed
    // value, so a cross-zone exchange stays impossible.
    const accumulates =
      from !== null &&
      this.isSpatial(target) &&
      target.zoneId === session.sourceZoneId;
    let baseline: PreviewBaseline<Location, Value>;
    if (accumulates) baseline = session.path.resolve(committed, from, target);
    else {
      session.path.reset();
      baseline = { kind: 'compute', base: committed, cumulative: false };
    }
    const result: CandidateResult<Value, Location> =
      baseline.kind === 'restored'
        ? {
            status: 'ok',
            value: baseline.step.value,
            from: baseline.step.from,
            to: baseline.step.to,
            changed: true,
          }
        : this.compute(session, target, baseline, committed, from);
    if (result.status !== 'ok') {
      const failure = candidateFailure(result.status);
      if (final) this.cancelWith(failure);
      else {
        const keepPreview = this.keepsPreview(session, target, result.status);
        if (!keepPreview) session.path.reset();
        this.showFailure(committed, failure, keepPreview);
      }
      return;
    }
    const proposal = this.prepareProposal(session, result);
    let decision: DropDecision;
    try {
      decision = this.timed(
        session,
        'policy',
        () => this.askPolicy(session, committed, proposal, result),
        chosen => (chosen.allowed ? 'allowed' : 'rejected'),
      );
    } catch (error) {
      this.policyFailed(session, seq, error);
      return;
    }
    // A consumer callback may have synchronously changed or disposed the input.
    if (
      this.session !== session ||
      this.sessionEnded(session) ||
      session.seq !== seq ||
      this.snapshot.phase !== this.expectedPhase(final)
    )
      return;
    if (!decision.allowed) {
      if (final) this.cancelWith('policy-rejected', undefined, decision.reason);
      else {
        session.path.reset();
        this.showFailure(committed, 'policy-rejected', false);
      }
      return;
    }
    if (
      result.changed &&
      !this.revalidate(session, committed, proposal, result)
    ) {
      if (final) this.cancelWith('invalid-target');
      else {
        session.path.reset();
        this.showFailure(committed, 'invalid-target', false);
      }
      return;
    }
    this.showCandidate(result);
    if (baseline.kind === 'compute') {
      if (accumulates && result.changed)
        session.path.push(committed, {
          target,
          from,
          to: result.to,
          value: result.value,
        });
      else session.path.reset();
    }
    if (!final) return;
    if (!result.changed) {
      this.finishUnchanged(session);
      return;
    }
    this.registerProposal(session, proposal, result);
    try {
      this.emitChange(proposal, result);
    } catch (error) {
      this.changeFailed(session, error);
    }
  }
}

/** Shape-check a permission callback result; the caller reports a throw. */
export function validatedDecision(decision: unknown): DropDecision {
  if (
    typeof decision !== 'object' ||
    decision === null ||
    typeof (decision as { allowed?: unknown }).allowed !== 'boolean'
  )
    throw new TypeError('canDrop must return an allowed boolean decision.');
  return decision as DropDecision;
}
