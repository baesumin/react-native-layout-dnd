import { useContext, useLayoutEffect, useRef } from 'react';
import { type HostInstance, View } from 'react-native';
import { useAnimatedRef } from 'react-native-reanimated';

import { validateGestureRelations } from '../gesture/gestureConfig';
import {
  DndItemContext,
  useDndHandleActive,
  useDndRuntime,
} from '../runtime/dndRuntime';
import type { DragHandleProps } from './dndTypes';
import { pickHandleViewProps as viewProps } from './handleViewProps';

/** Registers a hit area. Native gesture ownership stays with the Provider. */
export function DragHandle(props: DragHandleProps) {
  const runtime = useDndRuntime();
  const scope = useContext(DndItemContext);
  const ref = useAnimatedRef<HostInstance>();
  const identity = useRef({}).current;
  const relations = validateGestureRelations(props.gestureRelations);
  const valid =
    !!scope &&
    (props.itemId === undefined || props.itemId === scope.itemId) &&
    relations.valid;
  const { cancel, reportIssues, registerHandle, unregisterHandle } = runtime;
  const itemId = scope?.itemId;
  const disabledWhileActive = useDndHandleActive(
    runtime,
    itemId,
    props.disabled === true,
  );
  useLayoutEffect(() => {
    if (scope?.preview) return;
    const owner = `handle:${scope?.zoneId}:${itemId}`;
    reportIssues(
      owner,
      valid
        ? []
        : [
            {
              code: 'invalid-configuration',
              itemId,
              message:
                'DragHandle must be inside its matching list item with valid gesture relations.',
            },
          ],
    );
    if (disabledWhileActive) cancel('disabled');
    return () => reportIssues(owner, []);
  }, [
    cancel,
    itemId,
    props.disabled,
    reportIssues,
    disabledWhileActive,
    scope?.preview,
    scope?.zoneId,
    valid,
  ]);
  useLayoutEffect(() => {
    if (!valid || !scope || scope.preview || !relations.valid) {
      unregisterHandle(identity);
      return;
    }
    registerHandle(
      {
        itemId: scope.itemId,
        zoneId: scope.zoneId,
        ref,
        sourceRef: scope.ref,
        disabled: props.disabled === true,
        gestureRelations: relations.relations,
      },
      identity,
    );
  });
  useLayoutEffect(
    () => () => unregisterHandle(identity),
    [identity, unregisterHandle],
  );
  // The preview copy keeps the same labels but never attaches a gesture.
  if (!valid || !scope || scope.preview)
    return <View {...viewProps(props)}>{props.children}</View>;
  return (
    <View {...viewProps(props)} ref={ref} collapsable={false}>
      {props.children}
    </View>
  );
}
