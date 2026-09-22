import type { ValidationResult } from '../types';

export type GridMoveCandidate = 'row-rotation' | 'insert' | 'exchange';

/** Declarative configuration shared by the JS engine and UI worklets. */
export type GridMovementPolicy = {
  /** Full-width exchange items may rotate every item in their vertical corridor. */
  rowRotation?: 'disabled' | 'full-width';
  /** Home compatibility: a one-cell insert item can pull an adjacent exchange item. */
  adjacentInsertExchange?: 'disabled' | 'single-cell';
  /** First applicable rule wins. Rejection never falls through to another rule. */
  candidateOrder?: readonly GridMoveCandidate[];
  pointer?: {
    /** Extra distance beyond half a cell pitch, in [0, 0.5]. Default 0.12. */
    cellHysteresis?: number;
    /** Cell-pitch fraction required when displacing exchange items, in [0.5, 1]. */
    exchangeThreshold?: number;
    /** Zone entry and ordered-slot margin in React Native logical pixels. */
    boundaryHysteresis?: number;
  };
};

export type ResolvedGridMovementPolicy = {
  rowRotation: NonNullable<GridMovementPolicy['rowRotation']>;
  adjacentInsertExchange: NonNullable<
    GridMovementPolicy['adjacentInsertExchange']
  >;
  candidateOrder: readonly GridMoveCandidate[];
  pointer: Required<NonNullable<GridMovementPolicy['pointer']>>;
};

const DEFAULT_CANDIDATES: readonly GridMoveCandidate[] = Object.freeze([
  'row-rotation',
  'insert',
  'exchange',
]);

/** Neutral placement rules; caller data and item size never imply home behavior. */
export const DEFAULT_GRID_MOVEMENT_POLICY: ResolvedGridMovementPolicy =
  Object.freeze({
    rowRotation: 'disabled',
    adjacentInsertExchange: 'disabled',
    candidateOrder: DEFAULT_CANDIDATES,
    pointer: Object.freeze({
      cellHysteresis: 0.12,
      exchangeThreshold: 0.8,
      boundaryHysteresis: 4,
    }),
  });

/** Explicit compatibility with the extracted home grid's reversible movements. */
export const HOME_GRID_MOVEMENT_POLICY: ResolvedGridMovementPolicy =
  Object.freeze({
    ...DEFAULT_GRID_MOVEMENT_POLICY,
    rowRotation: 'full-width',
    adjacentInsertExchange: 'single-cell',
  });

/** Copy configuration when starting a session so later caller edits cannot change it. */
export function resolveGridMovementPolicy(
  policy?: GridMovementPolicy,
): ResolvedGridMovementPolicy {
  'worklet';
  return {
    rowRotation:
      policy?.rowRotation ?? DEFAULT_GRID_MOVEMENT_POLICY.rowRotation,
    adjacentInsertExchange:
      policy?.adjacentInsertExchange ??
      DEFAULT_GRID_MOVEMENT_POLICY.adjacentInsertExchange,
    candidateOrder: [
      ...(policy?.candidateOrder ??
        DEFAULT_GRID_MOVEMENT_POLICY.candidateOrder),
    ],
    pointer: {
      cellHysteresis:
        policy?.pointer?.cellHysteresis ??
        DEFAULT_GRID_MOVEMENT_POLICY.pointer.cellHysteresis,
      exchangeThreshold:
        policy?.pointer?.exchangeThreshold ??
        DEFAULT_GRID_MOVEMENT_POLICY.pointer.exchangeThreshold,
      boundaryHysteresis:
        policy?.pointer?.boundaryHysteresis ??
        DEFAULT_GRID_MOVEMENT_POLICY.pointer.boundaryHysteresis,
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Invalid policies reject the complete move before any candidate is computed. */
export function validateGridMovementPolicy(policy: unknown): ValidationResult {
  if (policy === undefined) return { valid: true };
  const invalid = (message: string): ValidationResult => ({
    valid: false,
    issues: [{ code: 'invalid-configuration', message }],
  });
  if (!record(policy)) return invalid('movementPolicy must be an object.');
  if (
    policy.rowRotation !== undefined &&
    policy.rowRotation !== 'disabled' &&
    policy.rowRotation !== 'full-width'
  )
    return invalid(
      'movementPolicy.rowRotation must be disabled or full-width.',
    );
  if (
    policy.adjacentInsertExchange !== undefined &&
    policy.adjacentInsertExchange !== 'disabled' &&
    policy.adjacentInsertExchange !== 'single-cell'
  )
    return invalid(
      'movementPolicy.adjacentInsertExchange must be disabled or single-cell.',
    );
  if (
    policy.candidateOrder !== undefined &&
    (!Array.isArray(policy.candidateOrder) ||
      policy.candidateOrder.length === 0 ||
      Array.from(policy.candidateOrder).some(
        candidate => !DEFAULT_CANDIDATES.includes(candidate),
      ) ||
      new Set(policy.candidateOrder).size !== policy.candidateOrder.length)
  )
    return invalid(
      'movementPolicy.candidateOrder must contain distinct supported candidates.',
    );
  if (policy.pointer !== undefined) {
    if (!record(policy.pointer))
      return invalid('movementPolicy.pointer must be an object.');
    const limits = {
      cellHysteresis: [0, 0.5],
      exchangeThreshold: [0.5, 1],
      boundaryHysteresis: [0, Infinity],
    };
    for (const [key, [min, max]] of Object.entries(limits)) {
      const value = policy.pointer[key];
      if (
        value !== undefined &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < min ||
          value > max)
      )
        return invalid(
          `movementPolicy.pointer.${key} must be finite and between ${min} and ${max}.`,
        );
    }
  }
  return { valid: true };
}
