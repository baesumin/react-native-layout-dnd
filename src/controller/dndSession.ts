import type {
  DndItem,
  GridLayoutZone,
  LayoutLocation,
  LayoutState,
  LayoutValidationIssue,
} from '../contracts';
import { samePlacement } from '../engine/gridPlacements';
import {
  computeValidatedLayoutMove,
  type GridItemLayout,
  type LayoutMoveResult,
} from '../engine/layoutMove';
import { validateLayoutState } from '../engine/layoutState';
import { isCellSpan, isPositiveInteger, isRecord } from '../engine/validation';
import { DEFAULT_SEARCH_BUDGET } from '../defaults';
import {
  resolveGridMovementPolicy,
  validateGridMovementPolicy,
  type GridMovementPolicy,
  type ResolvedGridMovementPolicy,
} from '../engine/movementPolicy';
import type {
  CancelReason,
  DragStartEvent,
  DropDecision,
  GridDiagnosticEvent,
} from '../types';

import {
  respondToValidatedDndProposal,
  type DndProposal,
  type DndValue,
} from './dndState';
import { now, reportCallbackError as reportFailure } from './coordinatorBase';
import { layoutLocation, sameLayoutLocation } from './locations';
import { PreviewPath } from './previewPath';
import {
  type CandidateResult,
  SessionCore,
  validatedDecision,
} from './sessionCore';

export type DndCancelReason = CancelReason;
export type DndDropFailureReason =
  | 'outside-zones'
  | 'invalid-target'
  | 'missing-grid-item-layout'
  | 'invalid-grid-item-layout'
  | 'unresolvable'
  | 'search-budget'
  | 'policy-rejected';
export type GridItemLayoutResolverArgs<T> = {
  item: DndItem<T>;
  from: LayoutLocation;
  target: GridLayoutZone;
  value: LayoutState<T>;
};
export type DndDragEndEvent<T> = DragStartEvent & { error?: unknown } & (
    | { outcome: 'unchanged' }
    | {
        outcome: 'cancelled';
        reason: DndCancelReason;
        targetZoneId?: string;
        policyReason?: string;
      }
    | {
        outcome: 'proposed';
        proposal: DndProposal<T>;
        targetZoneId: string;
        response: 'accepted' | 'rejected' | 'expired' | 'mismatch';
      }
    | {
        outcome: 'proposed';
        proposal: DndProposal<T>;
        targetZoneId: string;
        response: 'interrupted';
        reason: DndCancelReason | 'response-missing' | 'change-handler-error';
      }
  );

export type DndSessionSnapshot<T> = {
  value: DndValue<T> | null;
  displayValue: DndValue<T> | null;
  candidate: LayoutState<T> | null;
  phase: 'idle' | 'dragging' | 'awaiting-response';
  sessionId: string | null;
  itemId: string | null;
  sourceZoneId: string | null;
  targetZoneId: string | null;
  target: LayoutLocation | null;
  seq: number;
  validity: 'pending' | 'valid' | 'invalid';
  disabled: boolean;
  /** Span and placement captured once for each grid target at activation. */
  gridItemLayouts: ReadonlyMap<string, GridItemLayout>;
  movementPolicy: ResolvedGridMovementPolicy;
  failureReason: DndDropFailureReason | null;
};

export type DndSessionOptions<T> = {
  value: DndValue<T>;
  onChange(next: DndValue<T>, proposal: DndProposal<T>): void;
  canDrop?(proposal: DndProposal<T>): DropDecision;
  onDragStart?(event: DragStartEvent): void;
  onDragEnd?(event: DndDragEndEvent<T>): void;
  onValidationError?(issues: LayoutValidationIssue[]): void;
  /** Optional JS-only observation. Exceptions are ignored; omit to disable timing. */
  onDiagnostic?(event: GridDiagnosticEvent): void;
  responseTimeoutMs?: number;
  disabled?: boolean;
  movementPolicy?: GridMovementPolicy;
  searchBudget?: number;
  /** Required for list-to-grid; returning null disables that target for this session. */
  getGridItemLayout?(
    args: GridItemLayoutResolverArgs<T>,
  ): GridItemLayout | null;
};

type ActiveSession<T> = DragStartEvent & {
  baseRevision: number;
  seq: number;
  target: LayoutLocation | null;
  /** Same-zone grid previews the next candidate builds on. */
  path: PreviewPath<LayoutLocation, LayoutState<T>>;
  proposal?: DndProposal<T>;
  proposalKey?: string;
  deadline?: number;
  gridItemLayouts: Map<string, GridItemLayout>;
  gridItemLayoutErrors: Map<
    string,
    'missing-grid-item-layout' | 'invalid-grid-item-layout'
  >;
  movementPolicy: ResolvedGridMovementPolicy;
  searchBudget: number;
  responseTimeoutMs: number;
  settingsKey: string;
  getGridItemLayout: DndSessionOptions<T>['getGridItemLayout'];
  resolving: boolean;
  previewSeq: number | null;
  previewInputVersion: number;
};

let instanceCounter = 0;

/** Capture structure by value so an in-place same-revision edit still invalidates a drag. */
function layoutKey<T>(value: LayoutState<T>): string {
  return JSON.stringify([
    value.revision,
    value.items.map(item => item.id).sort(),
    value.zones
      .map(zone =>
        zone.kind === 'list'
          ? [zone.id, zone.kind, zone.orientation, [...zone.itemIds]]
          : [
              zone.id,
              zone.kind,
              zone.rows,
              zone.columns,
              zone.placements
                .map(item => [
                  item.itemId,
                  item.position.row,
                  item.position.col,
                  item.span.rows,
                  item.span.cols,
                  item.placement,
                ])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            ],
      )
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

function sameTarget(
  first: LayoutLocation | null,
  second: LayoutLocation | null,
): boolean {
  if (!first || !second) return first === second;
  if (first.zoneId !== second.zoneId) return false;
  return first.kind === 'list' && second.kind === 'list'
    ? first.index === second.index
    : first.kind === 'grid' &&
        second.kind === 'grid' &&
        first.position?.row === second.position?.row &&
        first.position?.col === second.position?.col;
}

type PreviewStructure =
  | 'state'
  | 'zones'
  | 'zone'
  | 'placements'
  | 'placement'
  | 'coordinates'
  | 'itemIds'
  | 'target';

/** Compare generated layout containers without reading or copying opaque data. */
function samePreviewStructure(
  first: unknown,
  second: unknown,
  structure: PreviewStructure,
): boolean {
  if (Object.is(first, second)) return true;
  if (
    first === null ||
    second === null ||
    typeof first !== 'object' ||
    typeof second !== 'object' ||
    Object.getPrototypeOf(first) !== Object.getPrototypeOf(second)
  )
    return false;
  const keys = Reflect.ownKeys(first);
  const otherKeys = Reflect.ownKeys(second);
  return (
    keys.length === otherKeys.length &&
    keys.every((key, index) => {
      if (key !== otherKeys[index]) return false;
      const a = Object.getOwnPropertyDescriptor(first, key)!;
      const b = Object.getOwnPropertyDescriptor(second, key)!;
      if (!('value' in a) || !('value' in b) || a.enumerable !== b.enumerable)
        return false;
      let child: PreviewStructure | undefined;
      if (structure === 'state' && key === 'zones') child = 'zones';
      else if (structure === 'zone' && key === 'itemIds') child = 'itemIds';
      else if (structure === 'zone' && key === 'placements')
        child = 'placements';
      else if (
        (structure === 'placement' && (key === 'position' || key === 'span')) ||
        (structure === 'target' && key === 'position')
      )
        child = 'coordinates';
      else if (
        (structure === 'zones' || structure === 'placements') &&
        typeof key === 'string' &&
        /^(0|[1-9]\d*)$/.test(key)
      )
        child = structure === 'zones' ? 'zone' : 'placement';
      // Item arrays and extra metadata retain their exact identity. In
      // particular, equality never traverses caller-owned item.data objects.
      return child
        ? samePreviewStructure(a.value, b.value, child)
        : Object.is(a.value, b.value);
    })
  );
}

function sameVisibleSnapshot<T>(
  first: DndSessionSnapshot<T>,
  second: DndSessionSnapshot<T>,
): boolean {
  return (Object.keys(first) as Array<keyof DndSessionSnapshot<T>>).every(
    key =>
      key === 'seq' ||
      (key === 'candidate' || key === 'displayValue'
        ? samePreviewStructure(first[key], second[key], 'state')
        : key === 'target'
          ? samePreviewStructure(first[key], second[key], 'target')
          : Object.is(first[key], second[key])),
  );
}

function settingsKey<T>(options: DndSessionOptions<T>): string {
  return JSON.stringify([
    options.searchBudget ?? DEFAULT_SEARCH_BUDGET,
    options.responseTimeoutMs ?? 2000,
    resolveGridMovementPolicy(options.movementPolicy),
  ]);
}

function copyMovementPolicy(
  policy?: GridMovementPolicy,
): ResolvedGridMovementPolicy {
  const resolved = resolveGridMovementPolicy(policy);
  return Object.freeze({
    ...resolved,
    candidateOrder: Object.freeze([...resolved.candidateOrder]),
    pointer: Object.freeze({ ...resolved.pointer }),
  });
}

function copyGridItemLayout(value: unknown): GridItemLayout | null {
  if (
    !isRecord(value) ||
    !isCellSpan(value.span) ||
    (value.placement !== undefined &&
      value.placement !== 'insert' &&
      value.placement !== 'exchange')
  )
    return null;
  return Object.freeze({
    span: Object.freeze({ rows: value.span.rows, cols: value.span.cols }),
    ...(value.placement === undefined ? {} : { placement: value.placement }),
  });
}

function checkOptions<T>(options: DndSessionOptions<T>) {
  const checked = validateLayoutState(options.value);
  const issues: LayoutValidationIssue[] = checked.valid
    ? []
    : [...checked.issues];
  const policy = validateGridMovementPolicy(options.movementPolicy);
  if (!policy.valid) issues.push(...policy.issues);
  const budgetValid = isPositiveInteger(
    options.searchBudget === undefined
      ? DEFAULT_SEARCH_BUDGET
      : options.searchBudget,
  );
  const timeoutValid = isPositiveInteger(options.responseTimeoutMs ?? 2000);
  if (!budgetValid)
    issues.push({
      code: 'invalid-budget',
      message: 'searchBudget must be a positive safe integer.',
    });
  if (
    (options.responseTimeoutMs !== undefined &&
      !isPositiveInteger(options.responseTimeoutMs)) ||
    (options.disabled !== undefined && typeof options.disabled !== 'boolean') ||
    typeof options.onChange !== 'function' ||
    [
      'canDrop',
      'onDragStart',
      'onDragEnd',
      'onValidationError',
      'getGridItemLayout',
    ].some(key => {
      const callback = options[key as keyof DndSessionOptions<T>];
      return callback !== undefined && typeof callback !== 'function';
    })
  ) {
    issues.push({
      code: 'invalid-configuration',
      message: 'Session callbacks, disabled or response timeout are invalid.',
    });
  }
  return {
    layoutValid: checked.valid,
    issues,
    movementPolicy: copyMovementPolicy(
      policy.valid ? options.movementPolicy : undefined,
    ),
    settingsKey:
      policy.valid && budgetValid && timeoutValid ? settingsKey(options) : null,
  };
}

function reportCallbackError(error: unknown): void {
  reportFailure('LayoutDnD', error);
}

/** Give a stored preview the item objects of a same-layout recommit. */
function rebaseLayoutState<T>(
  value: LayoutState<T>,
  committed: LayoutState<T>,
): LayoutState<T> {
  return value.items === committed.items
    ? value
    : { ...value, items: committed.items };
}

/** Compare zone layouts by ID; revision and caller items are not layout. */
function sameLayoutZones<T>(
  first: LayoutState<T>,
  second: LayoutState<T>,
): boolean {
  if (first.zones.length !== second.zones.length) return false;
  const zones = new Map(second.zones.map(zone => [zone.id, zone]));
  return first.zones.every(zone => {
    const other = zones.get(zone.id);
    if (!other) return false;
    if (zone === other) return true;
    if (zone.kind === 'list')
      return (
        other.kind === 'list' &&
        zone.itemIds.length === other.itemIds.length &&
        zone.itemIds.every((id, index) => id === other.itemIds[index])
      );
    if (
      other.kind !== 'grid' ||
      zone.placements.length !== other.placements.length
    )
      return false;
    const placements = new Map(
      other.placements.map(item => [item.itemId, item]),
    );
    return zone.placements.every(item => {
      const match = placements.get(item.itemId);
      return match !== undefined && samePlacement(item, match);
    });
  });
}

/** Express a candidate built on an earlier preview relative to the committed value. */
function relativeToCommitted<T>(
  committed: LayoutState<T>,
  from: LayoutLocation,
  result: Extract<LayoutMoveResult<T>, { status: 'ok' }>,
): LayoutMoveResult<T> {
  if (sameLayoutZones(committed, result.value))
    return { ...result, value: committed, from, changed: false };
  if (committed.revision === Number.MAX_SAFE_INTEGER)
    return {
      status: 'invalid',
      issues: [
        {
          code: 'invalid-revision',
          message: 'The layout revision cannot exceed a safe integer.',
        },
      ],
    };
  const revision = committed.revision + 1;
  const value =
    result.value.revision === revision && result.value.items === committed.items
      ? result.value
      : { ...result.value, revision, items: committed.items };
  return { ...result, value, from, changed: true };
}

/** UI-independent normalized session; screen/scroll measurements stay in the adapter. */
export class DndSessionCoordinator<T> extends SessionCore<
  DndValue<T>,
  LayoutLocation,
  DndSessionSnapshot<T>,
  ActiveSession<T>,
  DndProposal<T>
> {
  private readonly instanceId = ++instanceCounter;
  private sessionCounter = 0;
  private options: DndSessionOptions<T>;
  private lastLayoutKey: string | null;
  private validationNotification: string | null = null;
  private previewInputVersion = 0;
  private operationVersion = 0;

  constructor(options: DndSessionOptions<T>) {
    const checked = checkOptions(options);
    const lastValidValue = checked.layoutValid ? options.value : null;
    super(
      {
        value: lastValidValue,
        displayValue: lastValidValue,
        candidate: null,
        phase: 'idle',
        sessionId: null,
        itemId: null,
        sourceZoneId: null,
        targetZoneId: null,
        target: null,
        seq: 0,
        validity: checked.issues.length ? 'invalid' : 'valid',
        disabled: checked.issues.length > 0 || options.disabled === true,
        gridItemLayouts: new Map(),
        movementPolicy: checked.movementPolicy,
        failureReason: null,
      },
      lastValidValue,
    );
    this.options = options;
    this.lastLayoutKey = checked.layoutValid ? layoutKey(options.value) : null;
  }

  /** Every batch is one operation; a refresh may only fold into its own. */
  protected override batchStarted(): void {
    this.operationVersion++;
  }

  protected diagnosticObserver() {
    return typeof this.options.onDiagnostic === 'function'
      ? this.options.onDiagnostic
      : undefined;
  }

  /** Commit owner state after render; ordinary scroll updates do not enter this contract. */
  commit(options: DndSessionOptions<T>): void {
    this.batch(() => {
      this.disposed = false;
      const previousValue = this.lastValidValue;
      const checked = checkOptions(options);
      const key = checked.layoutValid ? layoutKey(options.value) : null;
      const layoutChanged = key !== this.lastLayoutKey;
      if (
        options.value !== this.options.value ||
        options.canDrop !== this.options.canDrop
      )
        this.previewInputVersion++;
      this.options = options;
      this.lastLayoutKey = key;
      if (checked.layoutValid) this.lastValidValue = options.value;
      const disabled = checked.issues.length > 0 || options.disabled === true;
      this.update({ value: this.lastValidValue, disabled });
      const session = this.session;
      const settingsChanged =
        !!session &&
        (checked.settingsKey !== session.settingsKey ||
          options.getGridItemLayout !== session.getGridItemLayout);
      if (!session) {
        this.update({
          displayValue: this.lastValidValue,
          validity: disabled ? 'invalid' : 'valid',
          ...(JSON.stringify(this.snapshot.movementPolicy) !==
          JSON.stringify(checked.movementPolicy)
            ? { movementPolicy: checked.movementPolicy }
            : {}),
        });
      } else if (this.snapshot.phase === 'awaiting-response') {
        const response = isRecord(options.value)
          ? options.value.proposalResponse
          : undefined;
        const matches =
          isRecord(response) &&
          response.sessionId === session.sessionId &&
          response.baseRevision === session.baseRevision &&
          typeof response.accepted === 'boolean';
        if (session.deadline !== undefined && now() >= session.deadline) {
          this.settle(session, 'expired');
        } else if (settingsChanged) {
          this.interrupt(session, 'input-changed');
        } else if (matches) {
          // Acceptance is judged by layout and revision (the layout key). The
          // owner may rebuild item objects or data in the accepting commit,
          // as a store that derives a dock item from a page item does.
          this.settle(
            session,
            response.accepted === false
              ? 'rejected'
              : checked.layoutValid && key === session.proposalKey
                ? 'accepted'
                : 'mismatch',
          );
        } else if (layoutChanged) {
          this.interrupt(
            session,
            key === session.proposalKey ? 'response-missing' : 'input-changed',
          );
        } else if (disabled) {
          this.interrupt(session, 'disabled');
        }
      } else if (layoutChanged) {
        this.cancelWith('input-changed');
      } else if (disabled) {
        this.cancelWith('disabled');
      } else if (settingsChanged) {
        this.cancelWith('input-changed');
      } else if (this.snapshot.displayValue === previousValue) {
        this.update({ displayValue: this.lastValidValue });
      }
      const notification = checked.issues.length
        ? JSON.stringify(checked.issues)
        : null;
      if (notification !== this.validationNotification) {
        this.validationNotification = notification;
        if (notification && typeof options.onValidationError === 'function') {
          try {
            options.onValidationError(checked.issues);
          } catch (error) {
            reportCallbackError(error);
          }
        }
      }
    });
  }

  start(itemId: string, baseRevision?: number): string | null {
    return this.batch(() => {
      if (
        this.disposed ||
        this.session ||
        this.snapshot.disabled ||
        !this.lastValidValue ||
        (baseRevision !== undefined &&
          baseRevision !== this.lastValidValue.revision)
      )
        return null;
      const checked = checkOptions(this.options);
      if (checked.issues.length) {
        this.commit(this.options);
        return null;
      }
      const source = this.lastValidValue.zones.find(zone =>
        zone.kind === 'list'
          ? zone.itemIds.includes(itemId)
          : zone.placements.some(item => item.itemId === itemId),
      );
      if (!source) return null;
      const base = this.lastValidValue;
      const gridSource =
        source.kind === 'grid'
          ? source.placements.find(item => item.itemId === itemId)!
          : null;
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
              position: { ...gridSource!.position },
            };
      const session: ActiveSession<T> = {
        sessionId: `layout-dnd:${this.instanceId}:${++this.sessionCounter}`,
        itemId,
        sourceZoneId: source.id,
        baseRevision: this.lastValidValue.revision,
        seq: -1,
        target: null,
        path: new PreviewPath(sameLayoutLocation, rebaseLayoutState),
        gridItemLayouts: new Map(),
        gridItemLayoutErrors: new Map(),
        movementPolicy: checked.movementPolicy,
        searchBudget: this.options.searchBudget ?? DEFAULT_SEARCH_BUDGET,
        responseTimeoutMs: this.options.responseTimeoutMs ?? 2000,
        settingsKey: settingsKey(this.options),
        getGridItemLayout: this.options.getGridItemLayout,
        resolving: true,
        previewSeq: null,
        previewInputVersion: this.previewInputVersion,
      };
      this.session = session;
      this.update({
        phase: 'dragging',
        sessionId: session.sessionId,
        itemId,
        sourceZoneId: source.id,
        targetZoneId: null,
        target: null,
        candidate: null,
        seq: -1,
        displayValue: this.lastValidValue,
        validity: 'pending',
        failureReason: null,
        gridItemLayouts: new Map(),
        movementPolicy: session.movementPolicy,
      });
      try {
        const item = base.items.find(candidate => candidate.id === itemId)!;
        for (const target of base.zones) {
          if (target.kind !== 'grid') continue;
          const descriptor =
            target.id === source.id
              ? gridSource
              : session.getGridItemLayout
                ? session.getGridItemLayout({ item, from, target, value: base })
                : gridSource;
          if (this.session !== session) return null;
          const copied = copyGridItemLayout(descriptor);
          if (copied) session.gridItemLayouts.set(target.id, copied);
          else
            session.gridItemLayoutErrors.set(
              target.id,
              descriptor === null || descriptor === undefined
                ? 'missing-grid-item-layout'
                : 'invalid-grid-item-layout',
            );
        }
      } catch (error) {
        if (this.session === session) this.cancelWith('policy-error', error);
        else reportCallbackError(error);
        return null;
      }
      session.resolving = false;
      this.update({ gridItemLayouts: new Map(session.gridItemLayouts) });
      try {
        this.options.onDragStart?.(this.event(session));
      } catch (error) {
        if (this.session === session)
          this.cancelWith('start-handler-error', error);
        else reportCallbackError(error);
      }
      return this.session === session ? session.sessionId : null;
    });
  }

  requestTarget(
    sessionId: string,
    seq: number,
    to: LayoutLocation | null,
    options?: { refresh?: boolean },
  ): void {
    this.batch(() => {
      const session = this.acceptsRequest(sessionId, seq, false);
      if (!session || session.resolving) return;
      // The adapter can certify that measurements and policy inputs have not
      // changed. Pointer movement within one target then needs only the private
      // sequence guard; publishing it would rerender every sortable child.
      if (
        options?.refresh === false &&
        session.previewSeq === session.seq &&
        session.previewInputVersion === this.previewInputVersion &&
        sameTarget(session.target, to)
      ) {
        session.seq = seq;
        session.previewSeq = seq;
        // Pointer movement inside one logical cell. Reported so an observer can
        // tell a coalesced packet from one that never arrived.
        this.lifecycle('request-coalesced', session);
        return;
      }
      const inputVersion = this.previewInputVersion;
      const previous = this.snapshot;
      const previousChanged = this.changed;
      const operationVersion = this.operationVersion;
      this.lifecycle('request', session);
      this.calculate(session, seq, to, false);
      // Reentrant callbacks may already have completed a newer request. Never
      // mark that request as reusable using this older request's inputs.
      if (
        this.session === session &&
        session.seq === seq &&
        this.snapshot.phase === 'dragging'
      ) {
        session.previewSeq = seq;
        session.previewInputVersion = inputVersion;
        if (
          options?.refresh === true &&
          this.batchDepth === 1 &&
          this.operationVersion === operationVersion &&
          this.previewInputVersion === inputVersion &&
          sameTarget(previous.target, to) &&
          sameVisibleSnapshot(previous, this.snapshot)
        ) {
          // Scrolling can require a fresh visibility/canDrop check without
          // changing anything React displays. Keep sequence ownership private,
          // just as for refresh:false, after every validation has completed.
          this.restore(previous, previousChanged);
        }
      }
    });
  }

  release(sessionId: string, seq: number, to: LayoutLocation | null): void {
    this.batch(() => {
      const session = this.acceptsRequest(sessionId, seq, true);
      if (!session || session.resolving) return;
      // This is receipt on JS, not the physical touch-release timestamp.
      this.lifecycle('release', session);
      this.calculate(session, seq, to, true);
    });
  }

  private calculate(
    session: ActiveSession<T>,
    seq: number,
    target: LayoutLocation | null,
    final: boolean,
  ): void {
    // The path accumulates inside one grid zone only; any other target builds
    // on the committed value again, as the display does.
    if (
      !target ||
      target.kind !== 'grid' ||
      target.zoneId !== session.target?.zoneId
    )
      session.path.reset();
    session.seq = seq;
    session.target =
      target &&
      (target.kind === 'grid'
        ? { ...target, position: { ...target.position } }
        : { ...target });
    this.update({
      seq,
      target: session.target,
      targetZoneId: target?.zoneId ?? null,
      validity: 'pending',
      failureReason: null,
    });
    this.calculateCandidate(session, final);
  }

  protected location(value: DndValue<T>, itemId: string) {
    return layoutLocation(value, itemId);
  }

  protected isSpatial(target: LayoutLocation) {
    return target.kind === 'grid';
  }

  /** Grid destinations need the span captured at activation. */
  protected precheck(session: ActiveSession<T>, target: LayoutLocation) {
    if (target.kind !== 'grid' || session.gridItemLayouts.has(target.zoneId))
      return null;
    return session.gridItemLayoutErrors.get(target.zoneId) ?? 'invalid-target';
  }

  protected compute(
    session: ActiveSession<T>,
    target: LayoutLocation,
    baseline: { base: DndValue<T>; cumulative: boolean },
    committed: DndValue<T>,
    from: LayoutLocation | null,
  ): CandidateResult<DndValue<T>, LayoutLocation> {
    // lastValidValue passed validateLayoutState when it was committed, the
    // API requires immutable values, and an earlier preview was validated as
    // a complete candidate. Pointer updates therefore validate only the new
    // candidate instead of the whole baseline again.
    const result = this.timed(
      session,
      'compute-move',
      () =>
        computeValidatedLayoutMove({
          value: baseline.cumulative
            ? { ...baseline.base, revision: committed.revision }
            : committed,
          itemId: session.itemId,
          to: target,
          gridItem:
            target.kind === 'grid'
              ? session.gridItemLayouts.get(target.zoneId)
              : undefined,
          movementPolicy: session.movementPolicy,
          searchBudget: session.searchBudget,
        }),
      computed => computed.status,
      computed => ('attempts' in computed ? computed.attempts : undefined),
    );
    if (result.status !== 'ok') return { status: result.status };
    const relative =
      baseline.cumulative && from
        ? relativeToCommitted(committed, from, result)
        : result;
    return relative.status === 'ok' ? relative : { status: relative.status };
  }

  // A transient gap between legal positions inside the source grid must not
  // bounce neighbors back to the committed layout (the same rule as the grid
  // controller). This affects display only; release still computes its own
  // candidate and reports the failure reason.
  protected keepsPreview(
    session: ActiveSession<T>,
    target: LayoutLocation,
    status: 'impossible' | 'unresolved' | 'invalid',
  ) {
    return (
      target.kind === 'grid' &&
      target.zoneId === session.sourceZoneId &&
      (status === 'impossible' || status === 'unresolved')
    );
  }

  protected prepareProposal(
    session: ActiveSession<T>,
    result: { value: DndValue<T>; from: LayoutLocation; to: LayoutLocation },
  ): DndProposal<T> {
    return {
      sessionId: session.sessionId,
      baseRevision: session.baseRevision,
      itemId: session.itemId,
      from: result.from,
      to: result.to,
      value: result.value,
    };
  }

  protected askPolicy(
    _session: ActiveSession<T>,
    _committed: DndValue<T>,
    proposal: DndProposal<T>,
  ): DropDecision {
    return validatedDecision(
      this.options.canDrop ? this.options.canDrop(proposal) : { allowed: true },
    );
  }

  protected policyFailed(
    session: ActiveSession<T>,
    seq: number,
    error: unknown,
  ) {
    if (
      this.session === session &&
      session.seq === seq &&
      this.snapshot.phase === 'dragging'
    )
      this.cancelWith('policy-error', error);
    else reportCallbackError(error);
  }

  // Policy callbacks receive the complete candidate. Validate it again if a
  // callback was allowed to run before issuing an atomic state proposal.
  protected revalidate(
    _session: ActiveSession<T>,
    committed: DndValue<T>,
    proposal: DndProposal<T>,
  ) {
    return (
      !this.options.canDrop ||
      respondToValidatedDndProposal(
        this.lastValidValue ?? committed,
        proposal,
        true,
      ).status === 'accepted'
    );
  }

  protected showCandidate(result: { value: DndValue<T> }) {
    this.update({
      validity: 'valid',
      candidate: result.value,
      displayValue: result.value,
    });
  }

  protected showFailure(
    committed: DndValue<T> | null,
    failure: string,
    keepPreview: boolean,
  ) {
    this.update({
      validity: 'invalid',
      failureReason: failure as DndDropFailureReason,
      ...(keepPreview ? {} : { candidate: null, displayValue: committed }),
    });
  }

  protected expectedPhase() {
    return 'dragging';
  }

  protected sessionEnded() {
    return false;
  }

  protected finishUnchanged(session: ActiveSession<T>) {
    this.finish(session, { ...this.event(session), outcome: 'unchanged' });
  }

  protected registerProposal(
    session: ActiveSession<T>,
    proposal: DndProposal<T>,
    result: { value: DndValue<T> },
  ) {
    session.proposal = proposal;
    session.proposalKey = layoutKey(result.value);
    session.deadline = now() + session.responseTimeoutMs;
    this.update({ phase: 'awaiting-response' });
    this.armTimer(session);
    this.lifecycle('proposal', session);
  }

  protected emitChange(
    proposal: DndProposal<T>,
    result: { value: DndValue<T> },
  ) {
    this.options.onChange(result.value, proposal);
  }

  protected changeFailed(session: ActiveSession<T>, error: unknown) {
    if (this.session === session)
      this.interrupt(session, 'change-handler-error', error);
    else reportCallbackError(error);
  }

  private armTimer(session: ActiveSession<T>): void {
    this.armDeadline(
      session.deadline,
      () => this.session === session,
      () => this.settle(session, 'expired'),
    );
  }

  private settle(
    session: ActiveSession<T>,
    response: 'accepted' | 'rejected' | 'expired' | 'mismatch',
  ): void {
    if (!session.proposal) return;
    this.finish(session, {
      ...this.event(session),
      outcome: 'proposed',
      proposal: session.proposal,
      targetZoneId: session.proposal.to.zoneId,
      response,
    });
  }

  private interrupt(
    session: ActiveSession<T>,
    reason: DndCancelReason | 'response-missing' | 'change-handler-error',
    error?: unknown,
  ): void {
    if (!session.proposal) return;
    this.finish(session, {
      ...this.event(session),
      outcome: 'proposed',
      proposal: session.proposal,
      targetZoneId: session.proposal.to.zoneId,
      response: 'interrupted',
      reason,
      ...(error === undefined ? {} : { error }),
    });
  }

  protected cancelWith(
    reason: DndCancelReason,
    error?: unknown,
    policyReason?: string,
  ): void {
    const session = this.session;
    if (!session) return;
    if (session.proposal) {
      this.interrupt(session, reason, error);
      return;
    }
    this.finish(session, {
      ...this.event(session),
      outcome: 'cancelled',
      reason,
      ...(session.target ? { targetZoneId: session.target.zoneId } : {}),
      ...(error === undefined ? {} : { error }),
      ...(policyReason === undefined ? {} : { policyReason }),
    });
  }

  cancel(reason: DndCancelReason): void {
    this.batch(() => this.cancelWith(reason));
  }

  private finish(session: ActiveSession<T>, event: DndDragEndEvent<T>): void {
    if (this.session !== session) return;
    if (event.outcome === 'proposed') this.lifecycle('response', session);
    this.lifecycle('end', session);
    this.clearDeadline();
    // Clear before callbacks so reentrant end handlers can safely start a new drag.
    this.session = null;
    this.update({
      phase: 'idle',
      sessionId: null,
      itemId: null,
      sourceZoneId: null,
      targetZoneId: null,
      target: null,
      candidate: null,
      seq: 0,
      displayValue: this.lastValidValue,
      validity: this.snapshot.disabled ? 'invalid' : 'valid',
      gridItemLayouts: new Map(),
      failureReason: null,
    });
    try {
      this.options.onDragEnd?.(event);
    } catch (error) {
      reportCallbackError(error);
    }
  }

  dispose(): void {
    this.batch(() => {
      this.disposed = true;
      this.clearDeadline();
      this.update({ disabled: true });
      this.cancelWith('unmounted');
    });
  }
}
