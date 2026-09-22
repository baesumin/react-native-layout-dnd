import type { ReactNode, Ref } from 'react';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';

import type { AutoScrollOptions, DragAxis } from '../adapters/scroll';
import type { ListVirtualizationOptions } from '../adapters/virtualizedList';
import type { DndItem, GridPlacement } from '../contracts';
import type {
  DndDragEndEvent,
  DndSessionOptions,
} from '../controller/dndSession';
import type { HandleViewProps } from './handleViewProps';
import type { GridMotionConfig } from '../pointer/motion';
import type { GestureRelations, ZoneGeometry } from './gridTypes';

export type DndMotionConfig = GridMotionConfig;

export type ListItemRenderArgs<T> = {
  item: DndItem<T>;
  index: number;
  zoneId: string;
  isDragging: boolean;
};
export type GridItemRenderArgs<T> = ListItemRenderArgs<T> & {
  position: GridPlacement['position'];
  span: GridPlacement['span'];
  placement?: GridPlacement['placement'];
  width: number;
  height: number;
};

/** Spatial grid under the shared provider; cells use the existing geometry contract. */
export type SortableGridProps<T> = Omit<ViewProps, 'children'> & {
  zoneId: string;
  geometry: ZoneGeometry;
  renderItem(args: GridItemRenderArgs<T>): ReactNode;
  dropIndicatorStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

export type DndPreviewArgs<T> = ListItemRenderArgs<T> & {
  sessionId: string;
  targetZoneId: string | null;
  width: number;
  height: number;
  validity: 'pending' | 'valid' | 'invalid';
  /** Call after the custom preview's drawable content has committed. Late sessions are ignored. */
  onReady(): void;
};

export type DndProviderHandle = {
  /** Cancel the current drag because zone geometry moved under it. */
  invalidateGeometry(): void;
};

export type DndProviderProps<T> = Omit<ViewProps, 'children'> &
  DndSessionOptions<T> & {
    children: ReactNode;
    activation?: { delayMs: number };
    /** Independent of list orientation. Defaults to both screen axes. */
    dragAxis?: DragAxis;
    motion?: DndMotionConfig;
    renderDragPreview?(args: DndPreviewArgs<T>): ReactNode;
    /** Keep the original visible until the custom preview calls onReady. Defaults to false. */
    waitForDragPreviewReady?: boolean;
    dragPreviewStyle?: StyleProp<ViewStyle>;
    /**
     * The `onDragEnd` event again once the drag preview has finished settling
     * into its cell, or right after `onDragEnd` when nothing animates.
     * `GridController.onDragEnd` uses this timing.
     */
    onDragSettled?(event: DndDragEndEvent<T>): void;
    ref?: Ref<DndProviderHandle>;
  };

/** ScrollView by default; enable virtualization for FlatList. Sizes are logical pixels. */
export type SortableListProps<T> = Omit<ViewProps, 'children'> & {
  zoneId: string;
  renderItem(args: ListItemRenderArgs<T>): ReactNode;
  /** Main-axis estimate before a cell has been measured. Defaults to 48. */
  estimatedItemSize?: number;
  /** Optional authoritative main-axis size, constant or per item. */
  itemSize?: number | ((itemId: string, index: number) => number);
  gap?: number;
  paddingStart?: number;
  paddingEnd?: number;
  autoScroll?: AutoScrollOptions;
  scrollEnabled?: boolean;
  showsScrollIndicator?: boolean;
  onScrollOffsetChange?(offset: { x: number; y: number }): void;
  /** Use FlatList windowing. True selects defaults; false is the default. */
  virtualization?: boolean | ListVirtualizationOptions;
};

/** Accessibility and test attributes forwarded to the handle's native view. */
export type DragHandleViewProps = HandleViewProps;

export type DragHandleProps = DragHandleViewProps & {
  children: ReactNode;
  itemId?: string;
  disabled?: boolean;
  gestureRelations?: GestureRelations;
};
