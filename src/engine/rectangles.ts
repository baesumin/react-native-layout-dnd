import type { CellPosition, CellSpan } from '../types';

type CellRectangle = { position: CellPosition; span: CellSpan };

/** Internal: rectangles have validated nonnegative anchors and positive spans. */
export function rectanglesOverlap(a: CellRectangle, b: CellRectangle): boolean {
  'worklet';
  // Anchor differences stay exact without adding a span to a large coordinate.
  const rowsOverlap =
    a.position.row <= b.position.row
      ? b.position.row - a.position.row < a.span.rows
      : a.position.row - b.position.row < b.span.rows;
  const colsOverlap =
    a.position.col <= b.position.col
      ? b.position.col - a.position.col < a.span.cols
      : a.position.col - b.position.col < b.span.cols;
  return rowsOverlap && colsOverlap;
}
