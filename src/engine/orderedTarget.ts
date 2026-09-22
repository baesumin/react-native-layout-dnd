import type { CellSpan, ValidationIssue } from '../types';

import { isCellSpan, isPositiveInteger, isRecord } from './validation';

export type OrderedIndexInput = {
  rows: number;
  columns: number;
  itemSpan: CellSpan;
  /** Target item count after removing the active item for a same-zone move. */
  itemCount: number;
  /** Moving item's center, relative to the target content origin (without padding). */
  center: { x: number; y: number };
  cellWidth: number;
  cellHeight: number;
  rowGap: number;
  columnGap: number;
};
export type OrderedIndexResult =
  | { status: 'ok'; index: number }
  | { status: 'impossible' }
  | { status: 'invalid'; issues: ValidationIssue[] };

/**
 * Raw ordered boundary. The caller first hit-tests the pointer against actual zones,
 * removes the active item, and then applies the same hysteresis for preview and drop.
 */
export function computeOrderedIndex(
  input: OrderedIndexInput,
): OrderedIndexResult {
  const fail = (
    code: ValidationIssue['code'],
    message: string,
  ): OrderedIndexResult => ({
    status: 'invalid',
    issues: [{ code, message }],
  });
  if (!isRecord(input))
    return fail('invalid-structure', 'Expected ordered target geometry.');
  if (!isPositiveInteger(input.rows) || !isPositiveInteger(input.columns))
    return fail(
      'invalid-dimension',
      'Grid dimensions must be positive safe integers.',
    );
  if (input.itemSpan === undefined)
    return fail('missing-item-span', 'Ordered targeting requires itemSpan.');
  if (!isCellSpan(input.itemSpan))
    return fail(
      'invalid-span',
      'itemSpan must contain positive safe integers.',
    );
  if (!Number.isSafeInteger(input.itemCount) || input.itemCount < 0)
    return fail(
      'invalid-structure',
      'itemCount must be a non-negative safe integer.',
    );
  if (
    !isRecord(input.center) ||
    !Number.isFinite(input.center.x) ||
    !Number.isFinite(input.center.y) ||
    !Number.isFinite(input.cellWidth) ||
    input.cellWidth <= 0 ||
    !Number.isFinite(input.cellHeight) ||
    input.cellHeight <= 0 ||
    !Number.isFinite(input.rowGap) ||
    input.rowGap < 0 ||
    !Number.isFinite(input.columnGap) ||
    input.columnGap < 0
  )
    return fail(
      'invalid-geometry',
      'Center, cell sizes and gaps must be finite valid geometry.',
    );

  const {
    rows,
    columns,
    itemSpan,
    itemCount,
    cellWidth,
    cellHeight,
    rowGap,
    columnGap,
  } = input;
  const slotsPerRow = Math.floor(columns / itemSpan.cols);
  const slotRows = Math.floor(rows / itemSpan.rows);
  const width = columns * cellWidth + (columns - 1) * columnGap;
  const height = rows * cellHeight + (rows - 1) * rowGap;
  const slotWidth = itemSpan.cols * cellWidth + (itemSpan.cols - 1) * columnGap;
  const slotHeight = itemSpan.rows * cellHeight + (itemSpan.rows - 1) * rowGap;
  const strideX = slotWidth + columnGap;
  const strideY = slotHeight + rowGap;
  if (
    ![width, height, slotWidth, slotHeight, strideX, strideY].every(
      n => Number.isFinite(n) && n > 0,
    )
  )
    return fail(
      'invalid-geometry',
      'Computed content and slot dimensions must be finite and positive.',
    );
  if (!slotsPerRow || !slotRows) return { status: 'impossible' };
  if (Math.ceil(itemCount / slotsPerRow) > slotRows)
    return fail('capacity-exceeded', 'itemCount exceeds the ordered capacity.');
  const x = Math.max(0, Math.min(width, input.center.x));
  const y = Math.max(0, Math.min(height, input.center.y));

  // Unfillable bottom rows are after the whole array, including a partly filled last row.
  if (rows % itemSpan.rows !== 0 && y >= slotRows * strideY - rowGap)
    return { status: 'ok', index: itemCount };
  const row = Math.max(
    0,
    Math.min(slotRows - 1, Math.floor((y - slotHeight / 2) / strideY + 0.5)),
  );
  // Right-hand remainder belongs to this row's end, not the whole array's end.
  if (columns % itemSpan.cols !== 0 && x >= slotsPerRow * strideX - columnGap)
    return {
      status: 'ok',
      index: Math.min(itemCount, (row + 1) * slotsPerRow),
    };
  const col = Math.max(
    0,
    Math.min(slotsPerRow - 1, Math.floor((x - slotWidth / 2) / strideX + 0.5)),
  );
  const slot = row * slotsPerRow + col;
  if (slot >= itemCount) return { status: 'ok', index: itemCount };
  const after =
    slotsPerRow === 1
      ? y >= row * strideY + slotHeight / 2
      : x >= col * strideX + slotWidth / 2;
  return { status: 'ok', index: Math.min(itemCount, slot + Number(after)) };
}
