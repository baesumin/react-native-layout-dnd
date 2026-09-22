import type { HostInstance } from 'react-native';
import type { AnimatedRef } from 'react-native-reanimated';

import type { GridMovementPolicy } from '../engine/movementPolicy';
import type { CellSpan, GridZone, ItemLocation } from '../types';

import type { ZoneGeometry } from '../components/gridTypes';

/**
 * Geometry vocabulary of the grid pointer policy (`pointer/geometry.ts`),
 * shared by the provider's layout targeting. The React runtime of the former
 * grid controller no longer lives here.
 */

export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type CellGeometry = { cellWidth: number; cellHeight: number };
export type ZoneRegistration = {
  zone: GridZone<undefined>;
  geometry: ZoneGeometry;
  pixelRatio: number;
  ref: AnimatedRef<HostInstance>;
};
export type MeasuredZone = Omit<ZoneRegistration, 'ref'> & {
  rect: WindowRect;
  cells: CellGeometry;
};
export type UiMotion = {
  movementPolicy?: GridMovementPolicy;
  baseRevision?: number;
  token: number;
  phase: 'idle' | 'dragging' | 'finalizing' | 'settling' | 'handoff';
  itemId: string | null;
  sourceZoneId: string | null;
  seq: number;
  target: ItemLocation | null;
  span: CellSpan;
  x: number;
  y: number;
  width: number;
  height: number;
  gripX: number;
  gripY: number;
  zones: MeasuredZone[];
  outlet: WindowRect;
  validity: 'pending' | 'valid' | 'invalid';
  visible: boolean;
  destination: WindowRect | null;
};
export const EMPTY_MOTION: UiMotion = {
  token: 0,
  phase: 'idle',
  itemId: null,
  sourceZoneId: null,
  seq: 0,
  target: null,
  span: { rows: 1, cols: 1 },
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  gripX: 0,
  gripY: 0,
  zones: [],
  outlet: { x: 0, y: 0, width: 0, height: 0 },
  validity: 'pending',
  visible: false,
  destination: null,
};
