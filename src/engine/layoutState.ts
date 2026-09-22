import type {
  DndItem,
  GridLayoutZone,
  GridPlacement,
  LayoutConversionResult,
  LayoutState,
  LayoutValidationIssue,
  LayoutValidationResult,
} from '../contracts';
import type { GridValue } from '../types';

import { orderedSlots, slotPosition } from './gridPlacements';
import { computeZoneLayout } from './layout';
import { rectanglesOverlap } from './rectangles';
import {
  isCellPosition,
  isCellSpan,
  isPositiveInteger,
  isRecord,
  validateValue,
} from './validation';

type IssueContext = Pick<LayoutValidationIssue, 'zoneId' | 'itemId'>;

function addIssue(
  issues: LayoutValidationIssue[],
  code: LayoutValidationIssue['code'],
  message: string,
  context: IssueContext = {},
) {
  issues.push({ code, ...context, message });
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function collectReference(
  itemId: unknown,
  itemIds: Set<string>,
  references: Set<string>,
  issues: LayoutValidationIssue[],
  context: IssueContext,
) {
  if (typeof itemId !== 'string') {
    addIssue(
      issues,
      'invalid-structure',
      'Item reference must be a string.',
      context,
    );
    return;
  }
  const itemContext = { ...context, itemId };
  if (!itemIds.has(itemId)) {
    addIssue(
      issues,
      'unknown-item',
      'Item reference must resolve to a declared item.',
      itemContext,
    );
  }
  if (references.has(itemId)) {
    addIssue(
      issues,
      'duplicate-reference',
      'An item must appear in exactly one placement or list position.',
      itemContext,
    );
  }
  references.add(itemId);
}

function collectGridIssues(
  zone: Record<string, unknown>,
  itemIds: Set<string>,
  references: Set<string>,
  issues: LayoutValidationIssue[],
  context: IssueContext,
) {
  const dimensionsValid =
    isPositiveInteger(zone.rows) && isPositiveInteger(zone.columns);
  if (!dimensionsValid) {
    addIssue(
      issues,
      'invalid-dimension',
      'Rows and columns must be positive safe integers.',
      context,
    );
  }
  if (!Array.isArray(zone.placements)) {
    addIssue(
      issues,
      'invalid-structure',
      'Grid placements must be an array.',
      context,
    );
    return;
  }
  const rectangles: GridPlacement[] = [];
  for (const placement of zone.placements) {
    if (!isRecord(placement)) {
      addIssue(
        issues,
        'invalid-structure',
        'Each grid placement must be an object.',
        context,
      );
      continue;
    }
    collectReference(placement.itemId, itemIds, references, issues, context);
    const itemContext = {
      ...context,
      ...(typeof placement.itemId === 'string'
        ? { itemId: placement.itemId }
        : {}),
    };
    if (
      placement.placement !== undefined &&
      placement.placement !== 'insert' &&
      placement.placement !== 'exchange'
    ) {
      addIssue(
        issues,
        'invalid-placement',
        'Placement must be insert or exchange when provided.',
        itemContext,
      );
    }
    const spanValid = isCellSpan(placement.span);
    const positionValid = isCellPosition(placement.position);
    if (!spanValid) {
      addIssue(
        issues,
        'invalid-span',
        'Span must contain positive safe integer rows and cols.',
        itemContext,
      );
    }
    if (!positionValid) {
      addIssue(
        issues,
        'invalid-position',
        'Position must contain safe integer row and col.',
        itemContext,
      );
    }
    if (!spanValid || !positionValid || !dimensionsValid) continue;
    const rectangle = placement as GridPlacement;
    if (
      rectangle.position.row < 0 ||
      rectangle.position.col < 0 ||
      rectangle.position.row > (zone.rows as number) - rectangle.span.rows ||
      rectangle.position.col > (zone.columns as number) - rectangle.span.cols
    ) {
      addIssue(
        issues,
        'out-of-bounds',
        'Grid placement must fit inside its zone.',
        itemContext,
      );
      continue;
    }
    for (const previous of rectangles) {
      if (rectanglesOverlap(previous, rectangle)) {
        addIssue(
          issues,
          'overlap',
          `Grid placement overlaps an earlier item (${previous.itemId}).`,
          itemContext,
        );
      }
    }
    rectangles.push(rectangle);
  }
  if (zone.itemSpan !== undefined)
    collectOrderedIssues(zone, dimensionsValid, issues, context);
}

/** An ordered grid keeps one span per item, reading-order slots and its capacity. */
function collectOrderedIssues(
  zone: Record<string, unknown>,
  dimensionsValid: boolean,
  issues: LayoutValidationIssue[],
  context: IssueContext,
) {
  const itemSpan = zone.itemSpan;
  if (!isCellSpan(itemSpan)) {
    addIssue(
      issues,
      'invalid-span',
      'Ordered itemSpan must contain positive safe integer rows and cols.',
      context,
    );
    return;
  }
  const placements = zone.placements as unknown[];
  for (const placement of placements) {
    if (!isRecord(placement) || !isCellSpan(placement.span)) continue;
    if (
      placement.span.rows !== itemSpan.rows ||
      placement.span.cols !== itemSpan.cols
    )
      addIssue(
        issues,
        'span-mismatch',
        'Every ordered item span must equal the zone itemSpan.',
        {
          ...context,
          ...(typeof placement.itemId === 'string'
            ? { itemId: placement.itemId }
            : {}),
        },
      );
  }
  if (!dimensionsValid) return;
  const slots = orderedSlots(
    { rows: zone.rows as number, columns: zone.columns as number },
    itemSpan,
  );
  // Avoid multiplying dimensions: their product can overflow despite valid inputs.
  if (
    placements.length > 0 &&
    (slots.perRow === 0 ||
      Math.ceil(placements.length / slots.perRow) > slots.rows)
  ) {
    addIssue(
      issues,
      'capacity-exceeded',
      'Ordered item count exceeds the available slots.',
      context,
    );
    return;
  }
  placements.forEach((placement, index) => {
    if (!isRecord(placement) || !isCellPosition(placement.position)) return;
    const expected = slotPosition(index, itemSpan, slots.perRow);
    if (
      placement.position.row !== expected.row ||
      placement.position.col !== expected.col
    )
      addIssue(
        issues,
        'invalid-position',
        'Ordered placements must occupy reading-order slots.',
        {
          ...context,
          ...(typeof placement.itemId === 'string'
            ? { itemId: placement.itemId }
            : {}),
        },
      );
  });
}

/** Validates the complete candidate without inspecting data or modifying inputs. */
export function validateLayoutState<T>(
  state: LayoutState<T>,
): LayoutValidationResult {
  const issues: LayoutValidationIssue[] = [];
  if (!isRecord(state)) {
    return {
      valid: false,
      issues: [
        {
          code: 'invalid-structure',
          message: 'Layout state must be an object.',
        },
      ],
    };
  }
  if (!isRevision(state.revision)) {
    addIssue(
      issues,
      'invalid-revision',
      'Layout revision must be a nonnegative safe integer.',
    );
  }
  const itemIds = new Set<string>();
  if (!Array.isArray(state.items)) {
    addIssue(issues, 'invalid-structure', 'Layout items must be an array.');
  } else {
    for (const item of state.items) {
      if (!isRecord(item) || typeof item.id !== 'string') {
        addIssue(
          issues,
          'invalid-structure',
          'Each item must be an object with a string ID.',
        );
      } else if (itemIds.has(item.id)) {
        addIssue(issues, 'duplicate-id', 'Item ID must be globally unique.', {
          itemId: item.id,
        });
      } else {
        itemIds.add(item.id);
      }
      // Do not read item.data, including getters or serialization hooks.
    }
  }
  const zoneIds = new Set<string>();
  const references = new Set<string>();
  if (!Array.isArray(state.zones)) {
    addIssue(issues, 'invalid-structure', 'Layout zones must be an array.');
  } else {
    for (const zone of state.zones) {
      if (!isRecord(zone)) {
        addIssue(issues, 'invalid-structure', 'Each zone must be an object.');
        continue;
      }
      const context = typeof zone.id === 'string' ? { zoneId: zone.id } : {};
      if (typeof zone.id !== 'string') {
        addIssue(issues, 'invalid-structure', 'Zone ID must be a string.');
      } else if (zoneIds.has(zone.id)) {
        addIssue(
          issues,
          'duplicate-id',
          'Zone ID must be globally unique.',
          context,
        );
      } else {
        zoneIds.add(zone.id);
      }
      if (zone.kind === 'grid') {
        collectGridIssues(zone, itemIds, references, issues, context);
      } else if (zone.kind === 'list') {
        if (
          zone.orientation !== 'vertical' &&
          zone.orientation !== 'horizontal'
        ) {
          addIssue(
            issues,
            'invalid-orientation',
            'List orientation must be vertical or horizontal.',
            context,
          );
        }
        if (!Array.isArray(zone.itemIds)) {
          addIssue(
            issues,
            'invalid-structure',
            'List item IDs must be an array.',
            context,
          );
        } else {
          for (const itemId of zone.itemIds) {
            collectReference(itemId, itemIds, references, issues, context);
          }
        }
      } else {
        addIssue(
          issues,
          'invalid-structure',
          'Zone kind must be grid or list.',
          context,
        );
      }
    }
  }
  for (const itemId of itemIds) {
    if (!references.has(itemId)) {
      addIssue(
        issues,
        'unplaced-item',
        'Every declared item must belong to a zone.',
        { itemId },
      );
    }
  }
  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

/**
 * Imports existing spatial/ordered grids into explicit cell placements. Ordered
 * grids keep their rendered positions and their `itemSpan`, so `toGridValue`
 * restores the ordered strategy; they do not become one-dimensional lists.
 * Proposal responses are session metadata and are not copied into layout state.
 */
export function fromGridValue<T>(
  value: GridValue<T>,
  revision?: number,
): LayoutConversionResult<LayoutState<T>> {
  const validation = validateValue(value);
  if (!validation.valid) return validation;
  const nextRevision = revision ?? value.revision ?? 0;
  if (!isRevision(nextRevision)) {
    return {
      valid: false,
      issues: [
        {
          code: 'invalid-revision',
          message: 'Layout revision must be a nonnegative safe integer.',
        },
      ],
    };
  }
  const items: DndItem<T>[] = [];
  const zones: GridLayoutZone[] = [];
  for (const zone of value.zones) {
    const layout = computeZoneLayout(zone);
    if (!layout.valid) return layout;
    zones.push({
      id: zone.id,
      kind: 'grid',
      rows: zone.rows,
      columns: zone.columns,
      ...(zone.strategy === 'ordered'
        ? { itemSpan: { rows: zone.itemSpan.rows, cols: zone.itemSpan.cols } }
        : {}),
      placements: layout.items.map(item => {
        items.push({ id: item.id, data: item.data });
        return {
          itemId: item.id,
          position: { ...item.position },
          span: { ...item.span },
          ...(item.placement === undefined
            ? {}
            : { placement: item.placement }),
        };
      }),
    });
  }
  return { valid: true, value: { revision: nextRevision, items, zones } };
}

/**
 * Exports all-grid state: zones with `itemSpan` become ordered grids again and
 * the rest spatial grids; list zones require the future list adapter.
 */
export function toGridValue<T>(
  state: LayoutState<T>,
): LayoutConversionResult<GridValue<T>> {
  const validation = validateLayoutState(state);
  if (!validation.valid) return validation;
  const unsupported = state.zones.filter(zone => zone.kind !== 'grid');
  if (unsupported.length > 0) {
    return {
      valid: false,
      issues: unsupported.map(zone => ({
        code: 'unsupported-zone',
        zoneId: zone.id,
        message: 'The grid adapter cannot convert list zones.',
      })),
    };
  }
  return { valid: true, value: layoutToGridValue(state) };
}

/**
 * Internal unchecked export for a state that only contains grid zones and was
 * validated on the way in (the controller adapter converts every candidate).
 */
export function layoutToGridValue<T>(state: LayoutState<T>): GridValue<T> {
  const items = new Map(state.items.map(item => [item.id, item]));
  return {
    revision: state.revision,
    zones: (state.zones as GridLayoutZone[]).map(zone =>
      zone.itemSpan
        ? {
            id: zone.id,
            strategy: 'ordered',
            rows: zone.rows,
            columns: zone.columns,
            itemSpan: { rows: zone.itemSpan.rows, cols: zone.itemSpan.cols },
            items: zone.placements.map(placement => ({
              id: placement.itemId,
              data: items.get(placement.itemId)!.data,
              span: { ...placement.span },
              ...(placement.placement === undefined
                ? {}
                : { placement: placement.placement }),
            })),
          }
        : {
            id: zone.id,
            strategy: 'spatial',
            rows: zone.rows,
            columns: zone.columns,
            items: zone.placements.map(placement => ({
              id: placement.itemId,
              data: items.get(placement.itemId)!.data,
              position: { ...placement.position },
              span: { ...placement.span },
              ...(placement.placement === undefined
                ? {}
                : { placement: placement.placement }),
            })),
          },
    ),
  };
}
