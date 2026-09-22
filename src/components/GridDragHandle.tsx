import { DragHandle } from './DragHandle';
import type { GridDragHandleProps } from './gridTypes';

/**
 * A grid item's hit area. The provider owns one native recognizer per gesture
 * relation signature, so mounting, re-rendering or unmounting a handle never
 * creates, re-serializes or drops a native handler.
 */
export function GridDragHandle(props: GridDragHandleProps) {
  return <DragHandle {...props} />;
}
