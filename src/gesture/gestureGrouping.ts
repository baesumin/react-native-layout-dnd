import type { PanGesture } from 'react-native-gesture-handler';

import { sameGestureRelations } from './gestureConfig';

import type { GestureRelations } from '../components/gridTypes';

/** One registered handle as the gesture host sees it. */
export type GestureOwner<Registration> = {
  id: number;
  registration: Registration;
};

export type GestureRegistry<Registration> = {
  getSnapshot(): readonly GestureOwner<Registration>[];
  subscribe(listener: () => void): () => void;
  setOwners(next: readonly GestureOwner<Registration>[]): void;
};

/** Handle mounts update their native owners without rendering the controller. */
export function createGestureRegistry<
  Registration,
>(): GestureRegistry<Registration> {
  let owners: readonly GestureOwner<Registration>[] = [];
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => owners,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOwners(next) {
      if (
        next.length === owners.length &&
        next.every(
          (owner, index) =>
            owner.id === owners[index]!.id &&
            owner.registration === owners[index]!.registration,
        )
      )
        return;
      owners = next.map(({ id, registration }) => ({ id, registration }));
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/**
 * Delivers a group's hit targets without re-rendering the group. A re-render
 * would make Reanimated and Gesture Handler rebuild and re-register the native
 * event handler, which costs a serialization of every callback closure.
 */
export type TargetChannel<Target> = {
  readonly targets: readonly Target[];
  subscribe(listener: (targets: readonly Target[]) => void): () => void;
};

export type PublishedTargetChannel<Target> = TargetChannel<Target> & {
  set(targets: readonly Target[]): void;
};

export function createTargetChannel<Target>(
  initial: readonly Target[],
): PublishedTargetChannel<Target> {
  let targets = initial;
  const listeners = new Set<(targets: readonly Target[]) => void>();
  return {
    get targets() {
      return targets;
    },
    set(next) {
      if (next === targets) return;
      targets = next;
      for (const listener of Array.from(listeners)) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Props of one shared-recognizer component rendered by a gesture host. */
export type GestureGroupProps<Runtime, Target> = {
  groupId: number;
  relations: GestureRelations | undefined;
  channel: TargetChannel<Target>;
  runtime: Runtime;
  publish(groupId: number, gesture: PanGesture | null): void;
};

/** Handles sharing one relation signature share one native recognizer. */
export type GestureGroupSnapshot<Target> = {
  groupId: number;
  relations: GestureRelations | undefined;
  targets: readonly Target[];
  /** Stable per group; the group element never re-renders for target changes. */
  channel: PublishedTargetChannel<Target>;
};

export type GroupingState<Registration, Target> = {
  targets: Map<number, { registration: Registration; target: Target }>;
  signatures: Array<{
    relations: GestureRelations | undefined;
    groupId: number;
  }>;
  nextGroupId: number;
  groups: readonly GestureGroupSnapshot<Target>[];
};

export function createGroupingState<Registration, Target>(): GroupingState<
  Registration,
  Target
> {
  return { targets: new Map(), signatures: [], nextGroupId: 0, groups: [] };
}

function sameTargets<Target>(
  previous: readonly Target[],
  next: readonly Target[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((target, index) => target === next[index])
  );
}

/**
 * Groups the published owners by gesture relation signature. Target objects
 * stay identical while their registration is unchanged and a group's target
 * array stays identical while its content is unchanged, so an unchanged group
 * publishes nothing to the UI runtime.
 */
export function groupGestureOwners<
  Registration extends { gestureRelations?: GestureRelations },
  Target,
>(
  owners: readonly GestureOwner<Registration>[],
  state: GroupingState<Registration, Target>,
  toTarget: (owner: GestureOwner<Registration>) => Target,
): readonly GestureGroupSnapshot<Target>[] {
  const targets = new Map<
    number,
    { registration: Registration; target: Target }
  >();
  const collected = new Map<
    number,
    { relations: GestureRelations | undefined; targets: Target[] }
  >();
  for (const owner of owners) {
    const cached = state.targets.get(owner.id);
    const target =
      cached?.registration === owner.registration
        ? cached.target
        : toTarget(owner);
    targets.set(owner.id, { registration: owner.registration, target });
    let signature = state.signatures.find(entry =>
      sameGestureRelations(
        entry.relations,
        owner.registration.gestureRelations,
      ),
    );
    if (!signature) {
      signature = {
        relations: owner.registration.gestureRelations,
        groupId: ++state.nextGroupId,
      };
      state.signatures.push(signature);
    }
    const group = collected.get(signature.groupId);
    if (group) group.targets.push(target);
    else
      collected.set(signature.groupId, {
        relations: signature.relations,
        targets: [target],
      });
  }
  state.targets = targets;
  // A signature without handles releases its native recognizer.
  state.signatures = state.signatures.filter(entry =>
    collected.has(entry.groupId),
  );
  const groups = Array.from(collected, ([groupId, group]) => {
    const previous = state.groups.find(entry => entry.groupId === groupId);
    const hitTargets =
      previous && sameTargets(previous.targets, group.targets)
        ? previous.targets
        : group.targets;
    return {
      groupId,
      relations: previous?.relations ?? group.relations,
      targets: hitTargets,
      channel: previous?.channel ?? createTargetChannel(hitTargets),
    };
  });
  state.groups =
    groups.length === state.groups.length &&
    groups.every(
      (group, index) =>
        group.groupId === state.groups[index]!.groupId &&
        group.targets === state.groups[index]!.targets &&
        group.relations === state.groups[index]!.relations,
    )
      ? state.groups
      : groups;
  return state.groups;
}
