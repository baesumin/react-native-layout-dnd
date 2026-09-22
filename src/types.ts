import type { MoveProposal, ProposalResponse } from './contracts';

import type { GridMovementPolicy } from './engine/movementPolicy';

export type CellPosition = { row: number; col: number };
export type CellSpan = { rows: number; cols: number };
/** Optional JS diagnostics; durations are not native rendering or GPU timings. */
export type GridDiagnosticEvent =
  | {
      type: 'timing';
      name:
        'compute-move' | 'input-validation' | 'candidate-validation' | 'policy';
      durationMs: number;
      sessionId?: string;
      attempts?: number;
      status?: string;
    }
  | {
      type: 'lifecycle';
      name:
        | 'request'
        | 'request-coalesced'
        | 'release'
        | 'proposal'
        | 'response'
        | 'settling'
        | 'end';
      timestampMs: number;
      sessionId: string;
    };
export type ItemPlacement = 'insert' | 'exchange';
export type GridItem<T> = {
  id: string;
  span: CellSpan;
  /** Caller-selected spatial behavior. Omitted means exchange, regardless of size. */
  placement?: ItemPlacement;
  data: T;
};
export type PositionedItem<T> = GridItem<T> & { position: CellPosition };

export type SpatialZone<T> = {
  id: string;
  rows: number;
  columns: number;
  strategy: 'spatial';
  items: PositionedItem<T>[];
};
export type OrderedZone<T> = {
  id: string;
  rows: number;
  columns: number;
  strategy: 'ordered';
  itemSpan: CellSpan;
  items: GridItem<T>[];
};
export type GridZone<T> = SpatialZone<T> | OrderedZone<T>;
export type GridValue<T> = {
  zones: GridZone<T>[];
  /** Increment on every external data/layout edit. Omit only for legacy control. */
  revision?: number;
  proposalResponse?: Omit<ProposalResponse, 'baseRevision'> & {
    baseRevision?: number;
  };
};

export type RevisionedGridValue<T> = GridValue<T> & { revision: number };
export type GridProposal<T> = MoveProposal<
  RevisionedGridValue<T>,
  ItemLocation
>;

export type ValidationCode =
  | 'invalid-structure'
  | 'duplicate-id'
  | 'invalid-dimension'
  | 'invalid-span'
  | 'invalid-placement'
  | 'missing-item-span'
  | 'span-mismatch'
  | 'invalid-position'
  | 'out-of-bounds'
  | 'overlap'
  | 'capacity-exceeded'
  | 'invalid-budget'
  | 'invalid-geometry'
  | 'invalid-configuration';
export type ValidationIssue = {
  code: ValidationCode;
  zoneId?: string;
  itemId?: string;
  message: string;
};
export type ValidationResult =
  { valid: true } | { valid: false; issues: ValidationIssue[] };
export type ZoneLayoutResult<T> =
  | { valid: true; items: PositionedItem<T>[] }
  | { valid: false; issues: ValidationIssue[] };
export type PackInput<T> = {
  items: readonly GridItem<T>[];
  rows: number;
  columns: number;
  searchBudget: number;
};
export type PackResult<T> =
  | { status: 'ok'; placements: PositionedItem<T>[] }
  | { status: 'impossible' }
  | { status: 'unresolved' }
  | { status: 'invalid'; issues: ValidationIssue[] };

export type ItemLocation =
  | { zoneId: string; strategy: 'spatial'; position: CellPosition }
  | { zoneId: string; strategy: 'ordered'; index: number };

/** A logical target, after pointer conversion and hysteresis in the controller. */
export type MoveInput<T> = {
  movementPolicy?: GridMovementPolicy;
  value: GridValue<T>;
  itemId: string;
  to: ItemLocation;
  searchBudget?: number;
};
export type MoveResult<T> =
  | {
      status: 'ok';
      value: GridValue<T>;
      from: ItemLocation;
      to: ItemLocation;
      changed: boolean;
      attempts: number;
    }
  | { status: 'impossible' | 'unresolved'; attempts: number }
  | { status: 'invalid'; issues: ValidationIssue[] };

export type GridChange = {
  sessionId: string;
  /** Present when the input GridValue supplies a revision (including useGridState). */
  baseRevision?: number;
  itemId: string;
  from: ItemLocation;
  to: ItemLocation;
};
export type DragStartEvent = {
  sessionId: string;
  itemId: string;
  sourceZoneId: string;
};
export type CanDropArgs<T> = {
  item: GridItem<T>;
  change: GridChange;
  proposedValue: GridValue<T>;
};
export type DropDecision =
  { allowed: true } | { allowed: false; reason?: string };
export type CleanupReason =
  | 'input-changed'
  | 'geometry-changed'
  | 'zone-removed'
  | 'disabled'
  | 'unmounted';
/** Interruptions include every cancel reason a proposal can meet while it awaits a response. */
export type ProposalInterruptReason =
  CancelReason | 'response-missing' | 'change-handler-error';
export type CancelReason =
  | CleanupReason
  | 'outside-zones'
  | 'invalid-target'
  | 'measure-failed'
  | 'policy-rejected'
  | 'search-budget'
  | 'unresolvable'
  | 'gesture-interrupted'
  | 'policy-error'
  | 'start-handler-error';
export type DragEndEvent = DragStartEvent & {
  cleanupReason?: CleanupReason;
  error?: unknown;
} & (
    | { outcome: 'unchanged' }
    | {
        outcome: 'cancelled';
        targetZoneId?: string;
        reason: CancelReason;
        policyReason?: string;
      }
    | ({ outcome: 'proposed'; change: GridChange; targetZoneId: string } & (
        | { response: 'accepted' | 'rejected' | 'expired' | 'mismatch' }
        | { response: 'interrupted'; reason: ProposalInterruptReason }
      ))
  );
