import {
  DndGestureGroup,
  type DndGestureRuntime,
  type DndHandleTarget,
} from './DndGestureGroup';
import type { DndHandleRegistration } from '../runtime/dndRuntime';
import {
  createGestureRegistry,
  groupGestureOwners as groupOwners,
  type GestureGroupSnapshot,
  type GestureOwner,
  type GestureRegistry,
  type GroupingState,
} from './gestureGrouping';
import { createGestureHost } from './gestureHost';

function toDndTarget({
  id,
  registration,
}: GestureOwner<DndHandleRegistration>): DndHandleTarget {
  return {
    id,
    itemId: registration.itemId,
    zoneId: registration.zoneId,
    ref: registration.ref,
    sourceRef: registration.sourceRef,
    disabled: registration.disabled,
  };
}

/** Handle mounts update their native owners without rendering the Provider. */
export function createDndGestureRegistry(): GestureRegistry<DndHandleRegistration> {
  return createGestureRegistry<DndHandleRegistration>();
}

export type DndGestureRegistry = GestureRegistry<DndHandleRegistration>;

/** Groups the published owners by gesture relation signature; see `groupGestureOwners`. */
export function groupGestureOwners(
  owners: readonly GestureOwner<DndHandleRegistration>[],
  state: GroupingState<DndHandleRegistration, DndHandleTarget>,
): readonly GestureGroupSnapshot<DndHandleTarget>[] {
  return groupOwners(owners, state, toDndTarget);
}

export const DndGestureHost = createGestureHost<
  DndHandleRegistration,
  DndHandleTarget,
  DndGestureRuntime
>({ Group: DndGestureGroup, toTarget: toDndTarget });
