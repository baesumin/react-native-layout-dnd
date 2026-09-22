import {
  diagnosticNow,
  type DiagnosticObserver,
  emitDiagnostic,
  type TimingDiagnostic,
} from '../diagnostics';
import { DEFAULT_SEARCH_BUDGET } from '../defaults';
import type {
  GridItem,
  GridValue,
  GridZone,
  ItemLocation,
  MoveInput,
  MoveResult,
  PositionedItem,
  ValidationIssue,
} from '../types';

import { hasSameLayout } from './sameLayout';
import { validateGridMovementPolicy } from './movementPolicy';
import { resolveSpatialMove } from './spatial';
import {
  isCellPosition,
  isPositiveInteger,
  isRecord,
  validateValue,
} from './validation';

function invalid<T>(
  code: ValidationIssue['code'],
  message: string,
  ids: Pick<ValidationIssue, 'itemId' | 'zoneId'> = {},
): MoveResult<T> {
  return { status: 'invalid', issues: [{ code, message, ...ids }] };
}

/**
 * Compute one atomic candidate from the input snapshot. The engine remembers no
 * earlier preview; the session decides whether that snapshot is the committed
 * value or the latest same-zone preview. Drop permission, pointer geometry,
 * sessions and animation belong to the controller.
 */
export function computeMove<T>(
  input: MoveInput<T>,
  onDiagnostic?: DiagnosticObserver,
): MoveResult<T> {
  if (typeof onDiagnostic !== 'function') return calculateMove(input);
  const timings: TimingDiagnostic[] = [];
  const startedAt = diagnosticNow();
  let result: MoveResult<T> | undefined;
  try {
    result = calculateMove(input, timings);
    return result;
  } finally {
    timings.push({
      type: 'timing',
      name: 'compute-move',
      durationMs: diagnosticNow() - startedAt,
      status: result?.status ?? 'error',
      ...(result && 'attempts' in result ? { attempts: result.attempts } : {}),
    });
    // Deliver after the calculation so observer cost is not part of its timing.
    for (const event of timings) emitDiagnostic(onDiagnostic, event);
  }
}

function timedValidation<T>(
  value: GridValue<T>,
  name: 'input-validation' | 'candidate-validation',
  timings: TimingDiagnostic[],
) {
  const startedAt = diagnosticNow();
  const result = validateValue(value);
  timings.push({
    type: 'timing',
    name,
    durationMs: diagnosticNow() - startedAt,
    status: result.valid ? 'valid' : 'invalid',
  });
  return result;
}

function calculateMove<T>(
  input: MoveInput<T>,
  timings?: TimingDiagnostic[],
): MoveResult<T> {
  if (!isRecord(input))
    return invalid('invalid-structure', 'Expected a move input object.');
  const validation = timings
    ? timedValidation(input.value, 'input-validation', timings)
    : validateValue(input.value);
  if (!validation.valid)
    return { status: 'invalid', issues: validation.issues };
  const policyValidation = validateGridMovementPolicy(input.movementPolicy);
  if (!policyValidation.valid)
    return { status: 'invalid', issues: policyValidation.issues };
  const searchBudget =
    input.searchBudget === undefined
      ? DEFAULT_SEARCH_BUDGET
      : input.searchBudget;
  if (!isPositiveInteger(searchBudget))
    return invalid(
      'invalid-budget',
      'searchBudget must be a positive safe integer.',
    );
  if (typeof input.itemId !== 'string')
    return invalid('invalid-structure', 'itemId must be a string.');
  const { value, itemId, to } = input;
  if (!isRecord(to) || typeof to.zoneId !== 'string')
    return invalid('invalid-structure', 'A target zone is required.', {
      itemId,
    });

  const source = value.zones.find(zone =>
    zone.items.some(item => item.id === itemId),
  );
  const target = value.zones.find(zone => zone.id === to.zoneId);
  if (!source || !target)
    return invalid(
      'invalid-structure',
      'The item and target zone must exist.',
      {
        itemId,
        zoneId: to.zoneId,
      },
    );
  if (to.strategy !== target.strategy)
    return invalid(
      'invalid-structure',
      'Target strategy must match its zone.',
      {
        itemId,
        zoneId: target.id,
      },
    );

  const sourceIndex = source.items.findIndex(item => item.id === itemId);
  const active = source.items[sourceIndex];
  const from: ItemLocation =
    source.strategy === 'ordered'
      ? { zoneId: source.id, strategy: 'ordered', index: sourceIndex }
      : {
          zoneId: source.id,
          strategy: 'spatial',
          position: source.items[sourceIndex].position,
        };
  const sameZone = source.id === target.id;
  let nextTarget: GridZone<T>;
  let resolvedTo = to as ItemLocation;
  let attempts = 0;

  if (target.strategy === 'ordered' && to.strategy === 'ordered') {
    const remaining = target.items.filter(item => item.id !== itemId);
    if (
      !Number.isSafeInteger(to.index) ||
      to.index < 0 ||
      to.index > remaining.length
    )
      return invalid(
        'invalid-position',
        'Insertion index must address the array after removal.',
        {
          itemId,
          zoneId: target.id,
        },
      );
    const slotsPerRow = Math.floor(target.columns / target.itemSpan.cols);
    const slotRows = Math.floor(target.rows / target.itemSpan.rows);
    if (
      active.span.rows !== target.itemSpan.rows ||
      active.span.cols !== target.itemSpan.cols ||
      slotsPerRow === 0 ||
      slotRows === 0 ||
      Math.ceil((remaining.length + 1) / slotsPerRow) > slotRows
    )
      return { status: 'impossible', attempts };
    // Spatial position has no meaning in an ordered zone. Preserve opaque data by reference.
    const inserted: GridItem<T> = {
      id: active.id,
      span: active.span,
      ...(active.placement === undefined
        ? {}
        : { placement: active.placement }),
      data: active.data,
    };
    remaining.splice(to.index, 0, inserted);
    nextTarget = { ...target, items: remaining };
  } else if (target.strategy === 'spatial' && to.strategy === 'spatial') {
    if (!isCellPosition(to.position))
      return invalid(
        'invalid-position',
        'A spatial target requires safe integer coordinates.',
        {
          itemId,
          zoneId: target.id,
        },
      );
    if (
      to.position.row < 0 ||
      to.position.col < 0 ||
      to.position.row > target.rows - active.span.rows ||
      to.position.col > target.columns - active.span.cols
    )
      return { status: 'impossible', attempts };
    const moved: PositionedItem<T> = {
      id: active.id,
      span: active.span,
      ...(active.placement === undefined
        ? {}
        : { placement: active.placement }),
      data: active.data,
      position: { ...to.position },
    };
    const result = resolveSpatialMove({
      items: target.items.filter(item => item.id !== itemId),
      active: moved,
      origin:
        sameZone && source.strategy === 'spatial'
          ? source.items[sourceIndex]
          : undefined,
      rows: target.rows,
      columns: target.columns,
      searchBudget,
      movementPolicy: input.movementPolicy,
    });
    if (result.status !== 'ok') return result;
    attempts = result.attempts;
    const placements = new Map(result.placements.map(item => [item.id, item]));
    resolvedTo = {
      zoneId: target.id,
      strategy: 'spatial',
      position: placements.get(itemId)!.position,
    };
    const items = target.items.map(item => placements.get(item.id)!);
    if (!sameZone) items.push(placements.get(itemId)!);
    nextTarget = { ...target, items };
  } else {
    return invalid('invalid-structure', 'Unsupported target strategy.', {
      itemId,
    });
  }

  const zones = value.zones.map(zone => {
    if (zone.id === target.id) return nextTarget;
    if (zone.id !== source.id) return zone;
    const remaining = { ...zone };
    remaining.items = zone.items.filter(item => item.id !== itemId);
    return remaining;
  });
  // Deliberately omit the previous proposalResponse from every candidate.
  const nextValue: GridValue<T> = { zones };
  const candidateValidation = timings
    ? timedValidation(nextValue, 'candidate-validation', timings)
    : validateValue(nextValue);
  if (!candidateValidation.valid)
    return { status: 'invalid', issues: candidateValidation.issues };
  const changed = !hasSameLayout(value, nextValue);
  if (value.revision !== undefined) {
    if (changed && value.revision === Number.MAX_SAFE_INTEGER)
      return invalid(
        'invalid-configuration',
        'The layout revision cannot exceed a safe integer.',
      );
    nextValue.revision = value.revision + Number(changed);
  }
  return {
    status: 'ok',
    value: changed ? nextValue : { ...nextValue, zones: value.zones },
    from,
    to: resolvedTo,
    changed,
    attempts,
  };
}
