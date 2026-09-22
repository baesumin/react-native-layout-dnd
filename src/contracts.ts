import type {
  CellPosition,
  CellSpan,
  ItemPlacement,
  ValidationCode,
} from './types';

export type ItemId = string;
export type ZoneId = string;

/** Application data has no layout meaning and remains owned by the caller. */
export type DndItem<T> = { id: ItemId; data: T };

export type GridPlacement = {
  itemId: ItemId;
  position: CellPosition;
  span: CellSpan;
  placement?: ItemPlacement;
};

export type GridLayoutZone = {
  id: ZoneId;
  kind: 'grid';
  rows: number;
  columns: number;
  placements: GridPlacement[];
  /**
   * Ordered packing (a dock, for example): every placement has this span,
   * the array order is the item order and positions are the reading-order
   * slots of that order. A move inserts at the slot the target addresses and
   * re-packs; removing an item closes the gap; capacity is rows × columns
   * in slots. Omitted for spatial grids.
   */
  itemSpan?: CellSpan;
};

/** A one-dimensional order, independent of item sizes and the drag axis. */
export type ListLayoutZone = {
  id: ZoneId;
  kind: 'list';
  orientation: 'vertical' | 'horizontal';
  itemIds: ItemId[];
};

export type LayoutZone = GridLayoutZone | ListLayoutZone;

/**
 * Every item is referenced by exactly one zone. Revisions are nonnegative safe
 * integers; the owner increments the revision for each accepted/external change.
 * Shared by the list adapter and the grid conversion helpers.
 */
export type LayoutState<T> = {
  revision: number;
  items: DndItem<T>[];
  zones: LayoutZone[];
};

export type GridLocation = {
  kind: 'grid';
  zoneId: ZoneId;
  position: CellPosition;
};
export type ListLocation = { kind: 'list'; zoneId: ZoneId; index: number };
export type LayoutLocation = GridLocation | ListLocation;

/** The completed candidate is approved atomically against baseRevision. */
export type MoveProposal<State, Location = LayoutLocation> = {
  sessionId: string;
  itemId: ItemId;
  baseRevision: number;
  from: Location;
  to: Location;
  value: State;
};

/** A response applies only to the matching session AND base revision. */
export type ProposalResponse = {
  sessionId: string;
  baseRevision: number;
  accepted: boolean;
};

export type LayoutValidationCode =
  | ValidationCode
  | 'invalid-revision'
  | 'unknown-item'
  | 'unplaced-item'
  | 'duplicate-reference'
  | 'invalid-orientation';
export type LayoutValidationIssue = {
  code: LayoutValidationCode;
  zoneId?: ZoneId;
  itemId?: ItemId;
  message: string;
};
export type LayoutValidationResult =
  { valid: true } | { valid: false; issues: LayoutValidationIssue[] };

export type LayoutConversionIssue = Omit<LayoutValidationIssue, 'code'> & {
  code: LayoutValidationCode | 'unsupported-zone';
};
export type LayoutConversionResult<Value> =
  | { valid: true; value: Value }
  | { valid: false; issues: LayoutConversionIssue[] };

/** Logical pixels in the coordinate space named by the containing contract. */
export type LayoutPoint = { x: number; y: number };
export type LayoutRect = LayoutPoint & { width: number; height: number };
export type CoordinateSpace = 'screen' | 'content';

type MeasurementBase<Space extends CoordinateSpace> = {
  space: Space;
  rect: LayoutRect;
  revision: number;
  /** Monotonic milliseconds in the same clock domain as MeasurementFreshness.nowMs. */
  timestampMs: number;
};
export type MeasuredRect<Space extends CoordinateSpace = CoordinateSpace> =
  MeasurementBase<Space> & { source: 'measured' };
export type EstimatedRect<Space extends CoordinateSpace = CoordinateSpace> =
  MeasurementBase<Space> & { source: 'estimated' };
export type RectMeasurement<Space extends CoordinateSpace = CoordinateSpace> =
  MeasuredRect<Space> | EstimatedRect<Space>;

export type MeasurementFreshness = {
  revision: number;
  /** Supply both nowMs and maxAgeMs to impose an age limit. */
  nowMs?: number;
  maxAgeMs?: number;
};

/**
 * Viewport is the measured screen origin of content at scroll offset zero.
 * Offset changes do not change layout revision. Negative offsets support bounce
 * and insets. Padding is part of content coordinates, not another offset here.
 */
export type ZoneCoordinateContext = {
  viewport: MeasuredRect<'screen'>;
  scrollOffset: LayoutPoint;
};
export type CoordinateFailureReason =
  | 'invalid-coordinate'
  | 'invalid-context'
  | 'invalid-measurement'
  | 'invalid-freshness'
  | 'stale-measurement';
export type CoordinateResult<Value> =
  | { valid: true; value: Value }
  | { valid: false; reason: CoordinateFailureReason };
