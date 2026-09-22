import { rectanglesOverlap } from './rectangles';
import type { SpatialMoveInput } from './spatial';

/** Resolve an adjacent app drag through the same move as dragging its widget. */
export function normalizeAppWidgetMove<T>(
  input: SpatialMoveInput<T>,
): SpatialMoveInput<T> | null {
  'worklet';
  const { items, active, origin } = input;
  if (
    !origin ||
    active.placement !== 'insert' ||
    active.span.rows !== 1 ||
    active.span.cols !== 1
  )
    return null;

  const widget = items.find(
    item => item.placement !== 'insert' && rectanglesOverlap(active, item),
  );
  if (!widget) return null;
  const withinColumns =
    origin.position.col >= widget.position.col &&
    origin.position.col < widget.position.col + widget.span.cols;
  const withinRows =
    origin.position.row >= widget.position.row &&
    origin.position.row < widget.position.row + widget.span.rows;
  const above =
    withinColumns && origin.position.row === widget.position.row - 1;
  const below =
    withinColumns &&
    origin.position.row === widget.position.row + widget.span.rows;
  const left = withinRows && origin.position.col === widget.position.col - 1;
  const right =
    withinRows &&
    origin.position.col === widget.position.col + widget.span.cols;
  if (!above && !below && !left && !right) return null;

  // Restore the picked-up app before resolving the widget's one-cell move.
  // The ordinary widget policy then owns neighbor movement and boundary checks.
  return {
    ...input,
    items: [...items.filter(item => item !== widget), origin],
    origin: widget,
    active: {
      ...widget,
      position: {
        row: widget.position.row + (above ? -1 : below ? 1 : 0),
        col: widget.position.col + (left ? -1 : right ? 1 : 0),
      },
    },
  };
}
