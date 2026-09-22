import type {
  CellPosition,
  CellSpan,
  GridValue,
  GridZone,
  PackInput,
  ValidationIssue,
  ValidationResult,
} from '../types';

import { rectanglesOverlap } from './rectangles';

type IssueContext = Pick<ValidationIssue, 'zoneId' | 'itemId'>;
type Rectangle = { position: CellPosition; span: CellSpan; itemId?: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isCellSpan(value: unknown): value is CellSpan {
  return (
    isRecord(value) &&
    isPositiveInteger(value.rows) &&
    isPositiveInteger(value.cols)
  );
}

export function isCellPosition(value: unknown): value is CellPosition {
  return (
    isRecord(value) &&
    typeof value.row === 'number' &&
    Number.isSafeInteger(value.row) &&
    typeof value.col === 'number' &&
    Number.isSafeInteger(value.col)
  );
}

function result(issues: ValidationIssue[]): ValidationResult {
  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

function addIssue(
  issues: ValidationIssue[],
  code: ValidationIssue['code'],
  message: string,
  context: IssueContext = {},
) {
  issues.push({ code, ...context, message });
}

function validateDimensions(
  rows: unknown,
  columns: unknown,
  issues: ValidationIssue[],
  context: IssueContext = {},
): boolean {
  if (isPositiveInteger(rows) && isPositiveInteger(columns)) {
    return true;
  }
  addIssue(
    issues,
    'invalid-dimension',
    'Rows and columns must be positive safe integers.',
    context,
  );
  return false;
}

function validateItem(
  item: unknown,
  itemIds: Set<string>,
  issues: ValidationIssue[],
  zoneContext: IssueContext,
): item is Record<string, unknown> {
  if (!isRecord(item)) {
    addIssue(
      issues,
      'invalid-structure',
      'Each item must be an object.',
      zoneContext,
    );
    return false;
  }
  const context = {
    ...zoneContext,
    ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
  };
  if (typeof item.id !== 'string') {
    addIssue(issues, 'invalid-structure', 'Item ID must be a string.', context);
  } else if (itemIds.has(item.id)) {
    addIssue(issues, 'duplicate-id', 'Item ID must be unique.', context);
  } else {
    itemIds.add(item.id);
  }
  if (!isCellSpan(item.span)) {
    addIssue(
      issues,
      'invalid-span',
      'Item span must contain positive safe integer rows and cols.',
      context,
    );
  }
  if (
    item.placement !== undefined &&
    item.placement !== 'insert' &&
    item.placement !== 'exchange'
  ) {
    addIssue(
      issues,
      'invalid-placement',
      'Item placement must be insert or exchange when provided.',
      context,
    );
  }
  // data is deliberately not read: it is opaque to the layout engine.
  return true;
}

function collectZoneIssues(
  zone: unknown,
  zoneIds: Set<string>,
  itemIds: Set<string>,
  issues: ValidationIssue[],
) {
  if (!isRecord(zone)) {
    addIssue(issues, 'invalid-structure', 'Each zone must be an object.');
    return;
  }
  const context = typeof zone.id === 'string' ? { zoneId: zone.id } : {};
  if (typeof zone.id !== 'string') {
    addIssue(issues, 'invalid-structure', 'Zone ID must be a string.');
  } else if (zoneIds.has(zone.id)) {
    addIssue(issues, 'duplicate-id', 'Zone ID must be unique.', context);
  } else {
    zoneIds.add(zone.id);
  }
  const dimensionsValid = validateDimensions(
    zone.rows,
    zone.columns,
    issues,
    context,
  );
  if (zone.strategy !== 'spatial' && zone.strategy !== 'ordered') {
    addIssue(
      issues,
      'invalid-structure',
      'Zone strategy must be spatial or ordered.',
      context,
    );
  }
  if (zone.strategy === 'ordered') {
    if (zone.itemSpan === undefined) {
      addIssue(
        issues,
        'missing-item-span',
        'Ordered zones require itemSpan.',
        context,
      );
    } else if (!isCellSpan(zone.itemSpan)) {
      addIssue(
        issues,
        'invalid-span',
        'Ordered itemSpan must contain positive safe integer rows and cols.',
        context,
      );
    }
  }
  if (!Array.isArray(zone.items)) {
    addIssue(
      issues,
      'invalid-structure',
      'Zone items must be an array.',
      context,
    );
    return;
  }

  const rectangles: Rectangle[] = [];
  for (const item of zone.items) {
    if (!validateItem(item, itemIds, issues, context)) {
      continue;
    }
    const itemContext = {
      ...context,
      ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
    };
    if (zone.strategy === 'ordered') {
      if (
        isCellSpan(zone.itemSpan) &&
        isCellSpan(item.span) &&
        (item.span.rows !== zone.itemSpan.rows ||
          item.span.cols !== zone.itemSpan.cols)
      ) {
        addIssue(
          issues,
          'span-mismatch',
          'Every ordered item span must equal the zone itemSpan.',
          itemContext,
        );
      }
    } else if (zone.strategy === 'spatial') {
      if (!isCellPosition(item.position)) {
        addIssue(
          issues,
          'invalid-position',
          'Spatial item position must contain safe integer row and col.',
          itemContext,
        );
        continue;
      }
      if (!isCellSpan(item.span) || !dimensionsValid) {
        continue;
      }
      if (
        item.position.row < 0 ||
        item.position.col < 0 ||
        item.position.row > (zone.rows as number) - item.span.rows ||
        item.position.col > (zone.columns as number) - item.span.cols
      ) {
        addIssue(
          issues,
          'out-of-bounds',
          'Spatial item rectangle must fit inside the zone.',
          itemContext,
        );
        continue;
      }
      const rectangle = {
        position: item.position,
        span: item.span,
        ...('itemId' in itemContext ? { itemId: itemContext.itemId } : {}),
      };
      for (const previous of rectangles) {
        if (rectanglesOverlap(previous, rectangle)) {
          addIssue(
            issues,
            'overlap',
            `Spatial item overlaps an earlier item${
              previous.itemId === undefined ? '.' : ` (${previous.itemId}).`
            }`,
            itemContext,
          );
        }
      }
      rectangles.push(rectangle);
    }
  }

  if (
    zone.strategy === 'ordered' &&
    dimensionsValid &&
    isCellSpan(zone.itemSpan)
  ) {
    const slotsPerRow = Math.floor(
      (zone.columns as number) / zone.itemSpan.cols,
    );
    const slotRows = Math.floor((zone.rows as number) / zone.itemSpan.rows);
    // Avoid multiplying dimensions: their product can overflow despite valid inputs.
    const exceedsCapacity =
      zone.items.length > 0 &&
      (slotsPerRow === 0 ||
        Math.ceil(zone.items.length / slotsPerRow) > slotRows);
    if (exceedsCapacity) {
      addIssue(
        issues,
        'capacity-exceeded',
        'Ordered item count exceeds the available slots.',
        context,
      );
    }
  }
}

export function validateZone<T>(zone: GridZone<T>): ValidationResult {
  const issues: ValidationIssue[] = [];
  collectZoneIssues(zone, new Set(), new Set(), issues);
  return result(issues);
}

export function validateValue<T>(value: GridValue<T>): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [
        { code: 'invalid-structure', message: 'Grid value must be an object.' },
      ],
    };
  }
  if (!Array.isArray(value.zones)) {
    addIssue(issues, 'invalid-structure', 'Grid zones must be an array.');
  } else {
    const zoneIds = new Set<string>();
    const itemIds = new Set<string>();
    for (const zone of value.zones) {
      collectZoneIssues(zone, zoneIds, itemIds, issues);
    }
  }
  if (
    value.revision !== undefined &&
    (!Number.isSafeInteger(value.revision) || value.revision < 0)
  ) {
    addIssue(
      issues,
      'invalid-structure',
      'Revision must be a non-negative safe integer.',
    );
  }
  if (
    value.proposalResponse !== undefined &&
    (!isRecord(value.proposalResponse) ||
      typeof value.proposalResponse.sessionId !== 'string' ||
      typeof value.proposalResponse.accepted !== 'boolean' ||
      (value.proposalResponse.baseRevision !== undefined &&
        (!Number.isSafeInteger(value.proposalResponse.baseRevision) ||
          value.proposalResponse.baseRevision < 0)))
  ) {
    addIssue(
      issues,
      'invalid-structure',
      'Proposal response must contain a string sessionId and boolean accepted.',
    );
  }
  return result(issues);
}

export function validatePackInput<T>(input: PackInput<T>): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      issues: [
        { code: 'invalid-structure', message: 'Pack input must be an object.' },
      ],
    };
  }
  validateDimensions(input.rows, input.columns, issues);
  if (!isPositiveInteger(input.searchBudget)) {
    addIssue(
      issues,
      'invalid-budget',
      'Search budget must be a positive safe integer.',
    );
  }
  if (!Array.isArray(input.items)) {
    addIssue(issues, 'invalid-structure', 'Pack items must be an array.');
  } else {
    const itemIds = new Set<string>();
    for (const item of input.items) {
      validateItem(item, itemIds, issues, {});
    }
  }
  return result(issues);
}
