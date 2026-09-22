import type { GridValue, RevisionedGridValue } from '../types';

import { createGridStateStore, type GridStateStore } from './gridState';
import { useStoreState } from './useStoreState';

export type GridState<T> = Pick<
  GridStateStore<T>,
  'onChange' | 'setValue' | 'respond'
> & {
  value: RevisionedGridValue<T>;
};

/** Own grid state and acknowledge proposals synchronously; initialValue is read once. */
export function useGridState<T>(
  initialValue: GridValue<T> | (() => GridValue<T>),
): GridState<T> {
  return useStoreState(() =>
    createGridStateStore(
      typeof initialValue === 'function' ? initialValue() : initialValue,
    ),
  );
}
