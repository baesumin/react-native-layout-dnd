import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
} from 'react';
import {
  GestureDetector,
  useCompetingGestures,
  useManualGesture,
  type ManualGestureConfig,
  type PanGesture,
} from 'react-native-gesture-handler';

import {
  createGroupingState,
  groupGestureOwners,
  type GestureGroupProps,
  type GestureOwner,
  type GestureRegistry,
} from './gestureGrouping';
import type { GestureRelations } from '../components/gridTypes';

export type GestureHostProps<Registration, Runtime> = {
  registry: GestureRegistry<Registration>;
  runtime: Runtime;
};

const SENTINEL_CONFIG: ManualGestureConfig = {
  enabled: false,
  onTouchesDown: () => {
    'worklet';
  },
};

/**
 * Builds a host that owns one native recognizer per gesture relation
 * signature. Handle mounts publish through the registry; the host groups them,
 * renders one `Group` per signature and composes their recognizers on a single
 * detector around the root content. Root content updates never render the
 * detector or the groups.
 */
export function createGestureHost<
  Registration extends { gestureRelations?: GestureRelations },
  Target,
  Runtime,
>({
  Group,
  toTarget,
}: {
  Group: ComponentType<GestureGroupProps<Runtime, Target>>;
  toTarget(owner: GestureOwner<Registration>): Target;
}) {
  const RootContentContext = createContext<ReactElement | null>(null);

  // Only this descendant consumes changing root content. Its context update does
  // not render the detector or re-run the gesture composition hooks above it.
  function NativeRoot() {
    return useContext(RootContentContext);
  }

  const GestureGroup = memo(Group);

  const NativeGestureDetector = memo(function NativeGestureDetectorImpl({
    nativeGestures,
  }: {
    nativeGestures: ReadonlyMap<number, PanGesture>;
  }) {
    // Keep the native component type stable while no handle is registered.
    const sentinel = useManualGesture(SENTINEL_CONFIG);
    const gesture = useCompetingGestures(sentinel, ...nativeGestures.values());
    return (
      <GestureDetector gesture={gesture}>
        <NativeRoot />
      </GestureDetector>
    );
  });

  const GestureHost = memo(function GestureHostImpl({
    registry,
    runtime,
  }: GestureHostProps<Registration, Runtime>) {
    const owners = useSyncExternalStore(
      registry.subscribe,
      registry.getSnapshot,
      registry.getSnapshot,
    );
    const mounted = useRef(true);
    const gestureValues = useRef(new Map<number, PanGesture>());
    const [gestureVersion, setGestureVersion] = useState(0);
    // Group layout effects can publish several changes in one commit. Update
    // their private map in O(1), then copy once when React renders the combined
    // update. Never mutate the snapshot passed to the memoized detector.
    const nativeGestures = useMemo(
      () => new Map(gestureValues.current),
      // The version explicitly invalidates this snapshot of the mutable registry.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [gestureVersion],
    );
    useLayoutEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);
    const publish = useCallback((id: number, gesture: PanGesture | null) => {
      if (!mounted.current) return;
      const current = gestureValues.current;
      if (gesture ? current.get(id) === gesture : !current.has(id)) return;
      if (gesture) current.set(id, gesture);
      else current.delete(id);
      setGestureVersion(version => version + 1);
    }, []);
    const grouping = useRef(
      createGroupingState<Registration, Target>(),
    ).current;
    // Re-running this for the same owners is idempotent, which keeps StrictMode
    // and discarded renders from producing different group identities.
    const groups = useMemo(
      () => groupGestureOwners(owners, grouping, toTarget),
      [owners, grouping],
    );
    // Publish after commit: the group's subscription effect is registered first.
    useLayoutEffect(() => {
      for (const group of groups) group.channel.set(group.targets);
    }, [groups]);

    return (
      <>
        <NativeGestureDetector nativeGestures={nativeGestures} />
        {groups.map(group => (
          <GestureGroup
            key={group.groupId}
            groupId={group.groupId}
            relations={group.relations}
            channel={group.channel}
            runtime={runtime}
            publish={publish}
          />
        ))}
      </>
    );
  });

  return function Host({
    children,
    registry,
    runtime,
  }: GestureHostProps<Registration, Runtime> & { children: ReactElement }) {
    return (
      <RootContentContext value={children}>
        <GestureHost registry={registry} runtime={runtime} />
      </RootContentContext>
    );
  };
}
