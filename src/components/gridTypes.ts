import type { ReactNode, Ref } from 'react';
import type { StyleProp, ViewProps, ViewStyle } from 'react-native';
import type { PanGestureConfig } from 'react-native-gesture-handler';
import type { GridMovementPolicy } from '../engine/movementPolicy';
import type { HandleViewProps } from './handleViewProps';
import type { GridMotionConfig } from '../pointer/motion';

import type {
  CanDropArgs,
  DragEndEvent,
  DragStartEvent,
  DropDecision,
  GridChange,
  GridDiagnosticEvent,
  GridItem,
  GridValue,
  ValidationIssue,
} from '../types';

export type GestureRelations = Pick<
  PanGestureConfig,
  'block' | 'requireToFail' | 'simultaneousWith'
>;
export type GridInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
export type ZoneGeometry = {
  rowGap: number;
  columnGap: number;
  padding: GridInsets;
} & (
  { mode: 'fixed'; cellWidth: number; cellHeight: number } | { mode: 'fit' }
);
export type ItemRenderArgs<T> = {
  item: GridItem<T>;
  zoneId: string;
  width: number;
  height: number;
  isDragging: boolean;
};
export type DragPreviewArgs<T> = Omit<ItemRenderArgs<T>, 'zoneId'> & {
  sessionId: string;
  /** Call after the custom preview's drawable content has committed. Late sessions are ignored. */
  onReady(): void;
  sourceZoneId: string;
  targetZoneId: string | null;
  validity: 'pending' | 'valid' | 'invalid';
};
export type GridControllerHandle = { invalidateGeometry(): void };
export type GridControllerProps<T> = Omit<ViewProps, 'children'> & {
  value: GridValue<T>;
  onChange(nextValue: GridValue<T>, change: GridChange): void;
  renderItem(args: ItemRenderArgs<T>): ReactNode;
  renderDragPreview?(args: DragPreviewArgs<T>): ReactNode;
  /** Keep the original visible until the custom preview calls onReady. Defaults to false. */
  waitForDragPreviewReady?: boolean;
  /** Optional preview surface styling (background, border, clipping, shadow). */
  dragPreviewStyle?: StyleProp<ViewStyle>;
  canDrop?(args: CanDropArgs<T>): DropDecision;
  onDragStart?(event: DragStartEvent): void;
  /** Fires once the drag preview has settled into its cell, or at once when nothing animates. */
  onDragEnd?(event: DragEndEvent): void;
  onValidationError?(issues: ValidationIssue[]): void;
  /** Optional JS-only observation. Exceptions are ignored; omit to disable timing. */
  onDiagnostic?(event: GridDiagnosticEvent): void;
  /** Defaults to 10,000 bounded search steps. */
  searchBudget?: number;
  /** Defaults to a 250ms long press. */
  activation?: { delayMs: number };
  /** Generic rules by default; opt into HOME_GRID_MOVEMENT_POLICY for home compatibility. */
  movementPolicy?: GridMovementPolicy;
  motion?: GridMotionConfig;
  responseTimeoutMs?: number;
  disabled?: boolean;
  ref?: Ref<GridControllerHandle>;
  children: ReactNode;
};
export type GridZoneViewProps = ViewProps & {
  zoneId: string;
  geometry: ZoneGeometry;
};
export type GridDragHandleProps = HandleViewProps & {
  itemId: string;
  gestureRelations?: GestureRelations;
  disabled?: boolean;
  children: ReactNode;
};
