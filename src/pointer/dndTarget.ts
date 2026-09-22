import type { LayoutLocation } from '../contracts';
import type { GridItemLayout } from '../engine/layoutMove';
import { findListTargetIndex } from '../engine/listIndex';
import type { GridMovementPolicy } from '../engine/movementPolicy';
import type { DndMotion, UiZoneRegistration } from '../runtime/dndRuntime';
import {
  isUsableRect,
  itemRect,
  orderedSlotIndex,
  orderedSlotPosition,
  readPointerTarget,
  rectContains,
} from './geometry';
import { measurePreparedGrid } from './layoutTarget';

export type DndTargetSession = {
  token: number;
  policyRevision: number;
  gridItems: Record<string, GridItemLayout>;
  movementPolicy?: GridMovementPolicy;
};

export function sameLayoutTarget(
  a: LayoutLocation | null,
  b: LayoutLocation | null,
): boolean {
  'worklet';
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.zoneId !== b.zoneId) return false;
  return a.kind === 'list'
    ? b.kind === 'list' && a.index === b.index
    : b.kind === 'grid' &&
        a.position.row === b.position.row &&
        a.position.col === b.position.col;
}

/** Prepared geometry only; policy permission and final validation stay on JS. */
export function uiLayoutTarget(
  state: DndMotion,
  registrations: readonly UiZoneRegistration[],
  session: DndTargetSession,
  previousTarget: LayoutLocation | null,
): LayoutLocation | null {
  'worklet';
  if (
    state.itemId === null ||
    !isUsableRect(state.root) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !rectContains(state.root, state.pointer.x, state.pointer.y) ||
    !Number.isFinite(state.width) ||
    state.width <= 0 ||
    !Number.isFinite(state.height) ||
    state.height <= 0 ||
    !Number.isFinite(state.grip.x) ||
    !Number.isFinite(state.grip.y)
  )
    return null;
  const previousIndex = state.zones.findIndex(
    zone => zone.zoneId === previousTarget?.zoneId,
  );
  for (let order = -1; order < state.zones.length; order++) {
    const index = order === -1 ? previousIndex : order;
    if (index < 0 || (order >= 0 && index === previousIndex)) continue;
    const measured = state.zones[index];
    const registration = registrations.find(
      zone => zone.zoneId === measured.zoneId,
    );
    if (
      !registration ||
      registration.revision !== state.revision ||
      registration.layoutVersion !== measured.layoutVersion ||
      measured.viewport.revision !== state.revision ||
      (registration.kind === 'grid' && measured.offset !== 0) ||
      measured.viewport.source !== 'measured' ||
      measured.viewport.space !== 'screen' ||
      !Number.isFinite(measured.viewport.timestampMs) ||
      measured.viewport.timestampMs < 0 ||
      !isUsableRect(measured.viewport.rect) ||
      !rectContains(measured.viewport.rect, state.pointer.x, state.pointer.y)
    )
      continue;
    if (registration.kind === 'list') {
      if (
        !registration.targetIndex ||
        registration.targetIndex.revision !== state.revision ||
        !Number.isFinite(measured.offset)
      )
        continue;
      const vertical = registration.orientation === 'vertical';
      const center = vertical
        ? state.pointer.y -
          state.grip.y +
          state.height / 2 -
          measured.viewport.rect.y +
          measured.offset
        : state.pointer.x -
          state.grip.x +
          state.width / 2 -
          measured.viewport.rect.x +
          measured.offset;
      const targetIndex = findListTargetIndex(
        registration.targetIndex,
        state.itemId,
        center,
      );
      return targetIndex === null
        ? null
        : { kind: 'list', zoneId: measured.zoneId, index: targetIndex };
    }
    const recipe = session.gridItems[`#${measured.zoneId}`];
    const grid = registration.targetGrid
      ? measurePreparedGrid(registration.targetGrid, measured)
      : null;
    if (
      !recipe ||
      !grid ||
      !Number.isSafeInteger(recipe.span.rows) ||
      recipe.span.rows <= 0 ||
      !Number.isSafeInteger(recipe.span.cols) ||
      recipe.span.cols <= 0
    )
      return null;
    const content = itemRect(
      { row: 0, col: 0 },
      { rows: grid.zone.rows, cols: grid.zone.columns },
      grid.geometry,
      grid.cells,
    );
    if (
      !rectContains(
        { ...content, x: grid.rect.x + content.x, y: grid.rect.y + content.y },
        state.pointer.x,
        state.pointer.y,
      )
    )
      continue;
    // An ordered zone reasons in slot indices; handing it a spatial position
    // would silently disable its boundary hysteresis. `resolveLayoutTarget`
    // converts the same way on JS.
    const orderedPrevious =
      previousTarget?.kind === 'grid' &&
      previousTarget.zoneId === grid.zone.id &&
      grid.zone.strategy === 'ordered'
        ? orderedSlotIndex(
            previousTarget.position,
            grid.zone.itemSpan,
            grid.zone.columns,
          )
        : null;
    const result = readPointerTarget(
      {
        token: state.token,
        phase: 'dragging',
        itemId: state.itemId,
        sourceZoneId: state.sourceZoneId,
        seq: Math.max(0, state.seq - 1),
        target:
          previousTarget?.kind !== 'grid'
            ? null
            : orderedPrevious === null
              ? {
                  zoneId: previousTarget.zoneId,
                  strategy: 'spatial',
                  position: previousTarget.position,
                }
              : {
                  zoneId: previousTarget.zoneId,
                  strategy: 'ordered',
                  index: orderedPrevious,
                },
        span: recipe.span,
        x: state.pointer.x - state.grip.x,
        y: state.pointer.y - state.grip.y,
        width: state.width,
        height: state.height,
        gripX: Math.max(0, Math.min(1, state.grip.x / state.width)),
        gripY: Math.max(0, Math.min(1, state.grip.y / state.height)),
        zones: [grid],
        outlet: state.root,
        validity: 'pending',
        visible: state.visible,
        destination: null,
        movementPolicy: session.movementPolicy,
        baseRevision: state.revision,
      },
      state.pointer.x,
      state.pointer.y,
    );
    if (result.target?.strategy === 'spatial')
      return {
        kind: 'grid',
        zoneId: result.target.zoneId,
        position: result.target.position,
      };
    // Without this branch an ordered zone reports no target at all, so the
    // frame gate sees no change and stops requesting candidates mid-drag.
    if (
      result.target?.strategy === 'ordered' &&
      grid.zone.strategy === 'ordered'
    )
      return {
        kind: 'grid',
        zoneId: result.target.zoneId,
        position: orderedSlotPosition(
          result.target.index,
          grid.zone.itemSpan,
          grid.zone.columns,
        ),
      };
  }
  return null;
}
