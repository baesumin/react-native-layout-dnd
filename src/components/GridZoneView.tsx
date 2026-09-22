import { useCallback, useContext } from 'react';
import { StyleSheet } from 'react-native';

import type { GridItem } from '../types';

import type { GridItemRenderArgs } from './dndTypes';
import { GridAdapterContext } from './GridController';
import type { GridZoneViewProps } from './gridTypes';
import { SortableGrid } from './SortableGrid';

/**
 * One zone of a `GridController`: the provider's grid adapter rendering the
 * controller's `renderItem` with the grid API's arguments. Ordered zones
 * (`strategy: 'ordered'`) keep their slot layout and capacity.
 */
export function GridZoneView({
  zoneId,
  geometry,
  children,
  ...props
}: GridZoneViewProps) {
  const scope = useContext(GridAdapterContext);
  if (!scope) throw new Error('GridZoneView must be inside GridController.');
  const { renderItem, itemOf } = scope;
  const renderCell = useCallback(
    (args: GridItemRenderArgs<unknown>) => {
      const item: GridItem<unknown> = itemOf(args.item.id) ?? {
        id: args.item.id,
        data: args.item.data,
        span: args.span,
        ...(args.placement === undefined ? {} : { placement: args.placement }),
      };
      return renderItem({
        item,
        zoneId: args.zoneId,
        width: args.width,
        height: args.height,
        isDragging: args.isDragging,
      });
    },
    [renderItem, itemOf],
  );
  return (
    <SortableGrid
      {...props}
      zoneId={zoneId}
      geometry={geometry}
      renderItem={renderCell}
      // The grid API moves neighbors instead of drawing a destination marker.
      dropIndicatorStyle={styles.noIndicator}
    >
      {children}
    </SortableGrid>
  );
}

const styles = StyleSheet.create({ noIndicator: { display: 'none' } });
