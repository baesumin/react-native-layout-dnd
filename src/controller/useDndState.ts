import type { LayoutState } from '../contracts';

import {
  createDndStateStore,
  type DndStateStore,
  type DndValue,
} from './dndState';
import { useStoreState } from './useStoreState';

export type DndState<T> = Pick<
  DndStateStore<T>,
  'onChange' | 'setValue' | 'respond'
> & {
  value: DndValue<T>;
};

/** Own normalized state and synchronously acknowledge proposals; initialValue is read once. */
export function useDndState<T>(
  initialValue: LayoutState<T> | (() => LayoutState<T>),
): DndState<T> {
  return useStoreState(() =>
    createDndStateStore(
      typeof initialValue === 'function' ? initialValue() : initialValue,
    ),
  );
}
