import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import Animated, {
  type ReduceMotion,
  type SharedValue,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated';

import type { DndItem, GridPlacement } from '../contracts';
import {
  DndItemContext,
  useDndRuntime,
  useDndZoneSnapshot,
  useDndItemSnapshot,
  type DndRuntime,
} from '../runtime/dndRuntime';
import type { GridItemRenderArgs, SortableGridProps } from './dndTypes';
import { presentationRect } from '../runtime/dndPresentation';
import { getCellGeometry, itemRect } from '../pointer/geometry';

function GridCellContent<T>({
  item,
  placement,
  row,
  col,
  rows,
  cols,
  index,
  zoneId,
  revision,
  committedRevision,
  x,
  y,
  width,
  height,
  renderItem,
  hiddenItemId,
  animation,
  presentation,
  isDragging,
}: {
  item: DndItem<T>;
  placement: GridPlacement['placement'];
  row: number;
  col: number;
  rows: number;
  cols: number;
  index: number;
  zoneId: string;
  revision: number;
  committedRevision?: SharedValue<number>;
  x: number;
  y: number;
  width: number;
  height: number;
  renderItem(args: GridItemRenderArgs<T>): React.ReactNode;
  hiddenItemId: SharedValue<string | null>;
  animation: DndRuntime['animation'];
  presentation: DndRuntime['presentation'];
  isDragging: boolean;
}) {
  const ref = useAnimatedRef();
  const itemId = item.id;
  const publicSlot = useDndItemSnapshot(useDndRuntime(), zoneId, itemId);
  const itemContext = useMemo(
    () => ({ itemId, zoneId, ref }),
    [itemId, zoneId, ref],
  );
  const publicIndex = publicSlot?.index ?? index;
  const publicRow = publicSlot?.row ?? row;
  const publicCol = publicSlot?.col ?? col;
  const content = useMemo(
    () =>
      renderItem({
        item,
        index: publicIndex,
        zoneId,
        position: { row: publicRow, col: publicCol },
        span: { rows, cols },
        placement,
        width,
        height,
        isDragging,
      }),
    [
      item,
      publicIndex,
      zoneId,
      publicRow,
      publicCol,
      rows,
      cols,
      placement,
      width,
      height,
      isDragging,
      renderItem,
    ],
  );
  const fallback = useMemo(
    () => ({ x, y, width, height }),
    [x, y, width, height],
  );
  const revisionSource = committedRevision ?? revision;
  const targetRect = useDerivedValue(() => {
    const current = presentation?.get();
    const currentRevision =
      typeof revisionSource === 'number'
        ? revisionSource
        : revisionSource.get();
    return current?.revision === currentRevision
      ? (presentationRect(current, zoneId, itemId) ?? fallback)
      : fallback;
  });
  const animated = useAnimatedStyle(() => {
    const hidden = hiddenItemId.get() === itemId;
    const target = targetRect.get();
    return {
      opacity: hidden ? 0 : 1,
      width: target.width,
      height: target.height,
      transform: [
        {
          // The overlay owns motion for the hidden active cell. Put its native
          // view in the committed slot immediately so handoff can measure it.
          translateX: hidden
            ? target.x
            : withTiming(target.x, {
                duration: animation.durationMs,
                reduceMotion: animation.reduceMotion as ReduceMotion,
              }),
        },
        {
          translateY: hidden
            ? target.y
            : withTiming(target.y, {
                duration: animation.durationMs,
                reduceMotion: animation.reduceMotion as ReduceMotion,
              }),
        },
      ],
    };
  });
  return (
    <DndItemContext value={itemContext}>
      <Animated.View
        ref={ref}
        collapsable={false}
        style={[styles.cell, animated]}
      >
        {content}
      </Animated.View>
    </DndItemContext>
  );
}

// Session/target changes only rerender cells whose public render arguments or
// geometry changed. Cells deliberately do not consume the provider context.
const GridCell = memo(GridCellContent) as typeof GridCellContent;

/** Spatial cells in the same provider/session as SortableList. */
export function SortableGrid<T>({
  zoneId,
  geometry,
  renderItem,
  dropIndicatorStyle,
  children,
  style,
  onLayout,
  ...viewProps
}: SortableGridProps<T>) {
  const runtime = useDndRuntime();
  const { registerZone, unregisterZone, reportIssues } = runtime;
  const snapshot = useDndZoneSnapshot(runtime, zoneId);
  const { motion, presentation } = runtime;
  // Only visibility changes affect cells; pointer updates belong to the overlay.
  const hiddenItemId = useDerivedValue(() => {
    const state = motion.get();
    return state.visible ? state.itemId : null;
  });
  const activeToken = useDerivedValue(() => motion.get().token);
  const identity = useRef({}).current;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ref = useAnimatedRef();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const zone = snapshot.zone;
  const display = snapshot.display;
  const revision = snapshot.revision;
  const indicator = useAnimatedStyle(() => {
    const approved = presentation?.get();
    const itemId = hiddenItemId.get();
    const rect =
      approved?.revision === revision &&
      approved.token === activeToken.get() &&
      approved.releaseTarget?.target.zoneId === zoneId &&
      itemId !== null
        ? presentationRect(approved, zoneId, itemId)
        : undefined;
    return {
      opacity: rect ? 1 : 0,
      left: rect?.x ?? 0,
      top: rect?.y ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    };
  });
  const pixelRatio = PixelRatio.get();
  const cells =
    zone?.kind === 'grid' && size
      ? getCellGeometry(zone, geometry, size.width, size.height, pixelRatio)
      : null;
  // Compare values so mutating a geometry object in place cannot preserve stale
  // hit-test coordinates. Registered geometry never aliases caller-owned values.
  const geometryKey = cells
    ? JSON.stringify([
        geometry.mode,
        geometry.rowGap,
        geometry.columnGap,
        geometry.padding.top,
        geometry.padding.right,
        geometry.padding.bottom,
        geometry.padding.left,
        cells.cellWidth,
        cells.cellHeight,
        pixelRatio,
      ])
    : null;
  const measured = useMemo(
    () =>
      cells
        ? {
            cells,
            geometry: {
              ...(geometry.mode === 'fixed'
                ? {
                    mode: 'fixed' as const,
                    cellWidth: geometry.cellWidth,
                    cellHeight: geometry.cellHeight,
                  }
                : { mode: 'fit' as const }),
              rowGap: geometry.rowGap,
              columnGap: geometry.columnGap,
              padding: {
                top: geometry.padding.top,
                right: geometry.padding.right,
                bottom: geometry.padding.bottom,
                left: geometry.padding.left,
              },
            },
            pixelRatio,
          }
        : null, // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometryKey],
  );
  const data = useMemo(
    () => new Map(snapshot.items?.map(item => [item.id, item]) ?? []),
    [snapshot.items],
  );
  useLayoutEffect(() => {
    const invalid = zone?.kind !== 'grid' || (size !== null && !measured);
    reportIssues(
      `grid:${zoneId}`,
      invalid
        ? [
            {
              code:
                zone?.kind !== 'grid'
                  ? 'invalid-configuration'
                  : 'invalid-geometry',
              zoneId,
              message:
                'SortableGrid requires an existing grid zone and geometry that fits its measured viewport.',
            },
          ]
        : [],
    );
    if (zone?.kind !== 'grid' || !measured) {
      unregisterZone(zoneId, identity);
      return;
    }
    registerZone(
      {
        kind: 'grid',
        zoneId,
        revision,
        ref,
        layout: zone,
        ...measured,
        renderItem: args => {
          const placement = zone.placements.find(
            entry => entry.itemId === args.item.id,
          );
          if (!placement) return null;
          const rect = itemRect(
            placement.position,
            placement.span,
            measured.geometry,
            measured.cells,
          );
          return renderItem({
            ...args,
            item: args.item as DndItem<T>,
            position: placement.position,
            span: placement.span,
            placement: placement.placement,
            width: rect.width,
            height: rect.height,
          });
        },
      },
      identity,
    );
  }, [
    zone,
    zoneId,
    revision,
    ref,
    measured,
    size,
    registerZone,
    unregisterZone,
    reportIssues,
    identity,
    renderItem,
  ]);
  useLayoutEffect(
    () => () => {
      unregisterZone(zoneId, identity);
      reportIssues(`grid:${zoneId}`, []);
    },
    [zoneId, identity, unregisterZone, reportIssues],
  );
  return (
    <Animated.View
      {...viewProps}
      ref={ref}
      collapsable={false}
      style={[styles.zone, style]}
      onLayout={event => {
        if (!mounted.current) return;
        const { width, height } = event.nativeEvent.layout;
        setSize(current =>
          current?.width === width && current.height === height
            ? current
            : { width, height },
        );
        onLayout?.(event);
      }}
    >
      {children}
      {measured && presentation && (
        <Animated.View
          pointerEvents="none"
          style={[styles.indicator, dropIndicatorStyle, indicator]}
        />
      )}
      {!presentation &&
        measured &&
        display?.kind === 'grid' &&
        runtime.snapshot.validity === 'valid' &&
        runtime.snapshot.targetZoneId === zoneId &&
        (() => {
          const active = display.placements.find(
            entry => entry.itemId === snapshot.activeItemId,
          );
          if (!active) return null;
          const rect = itemRect(
            active.position,
            active.span,
            measured.geometry,
            measured.cells,
          );
          return (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.indicator,
                {
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                dropIndicatorStyle,
              ]}
            />
          );
        })()}
      {measured &&
        display?.kind === 'grid' &&
        display.placements.map((placement, index) => {
          const item = data.get(placement.itemId);
          if (!item) return null;
          const rect = itemRect(
            placement.position,
            placement.span,
            measured.geometry,
            measured.cells,
          );
          return (
            <GridCell
              key={item.id}
              item={item as DndItem<T>}
              placement={placement.placement}
              row={placement.position.row}
              col={placement.position.col}
              rows={placement.span.rows}
              cols={placement.span.cols}
              index={index}
              zoneId={zoneId}
              revision={revision}
              committedRevision={runtime.committedRevision}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              renderItem={renderItem}
              hiddenItemId={hiddenItemId}
              animation={runtime.animation}
              presentation={runtime.presentation}
              isDragging={snapshot.activeItemId === item.id}
            />
          );
        })}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  zone: { position: 'relative' },
  cell: { position: 'absolute', left: 0, top: 0 },
  indicator: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: '#64748B',
    backgroundColor: 'rgba(100, 116, 139, 0.12)',
  },
});
