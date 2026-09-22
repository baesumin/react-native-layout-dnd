import { screenToContent } from '../adapters/coordinates';
import type { ListLocation } from '../contracts';
import { computeListIndex } from '../engine/list';
import { findListTargetIndex } from '../engine/listIndex';
import type { DndMotion, ListRegistration } from '../runtime/dndRuntime';
import { rectContains } from './geometry';

/** Target from committed order; candidate reflow must not move its own thresholds. */
export function listTarget(
  state: DndMotion,
  registrations: ReadonlyMap<
    string,
    ListRegistration & { layoutVersion: number }
  >,
): ListLocation | null {
  if (!rectContains(state.root, state.pointer.x, state.pointer.y)) return null;
  for (const measured of state.zones) {
    const registration = registrations.get(measured.zoneId);
    if (
      !registration ||
      registration.revision !== state.revision ||
      registration.layout.revision !== state.revision ||
      registration.layoutVersion !== measured.layoutVersion ||
      !rectContains(measured.viewport.rect, state.pointer.x, state.pointer.y)
    )
      continue;
    const vertical = registration.orientation === 'vertical';
    const center = {
      x: state.pointer.x - state.grip.x + state.width / 2,
      y: state.pointer.y - state.grip.y + state.height / 2,
    };
    const content = screenToContent(
      center,
      {
        viewport: measured.viewport,
        scrollOffset: vertical
          ? { x: 0, y: measured.offset }
          : { x: measured.offset, y: 0 },
      },
      { revision: state.revision },
    );
    if (!content.valid) return null;
    const mainAxisCenter = vertical ? content.value.y : content.value.x;
    const index = registration.targetIndex
      ? findListTargetIndex(
          registration.targetIndex,
          state.itemId,
          mainAxisCenter,
        )
      : computeListIndex(registration.layout, state.itemId, mainAxisCenter);
    return index === null
      ? null
      : { kind: 'list', zoneId: measured.zoneId, index };
  }
  return null;
}
