import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DndDragEndEvent } from '../controller/dndSession';
import type { DndProposal, DndValue } from '../controller/dndState';
import {
  convertGridValue,
  gridChangeOf,
  gridEndEvent,
  gridIssues,
  gridItemIndex,
  type PreviousConversion,
} from '../controller/gridAdapter';
import type { LayoutValidationIssue } from '../contracts';
import { layoutToGridValue } from '../engine/layoutState';
import type { GridItem } from '../types';

import { DndProvider } from './DndProvider';
import type { DndPreviewArgs } from './dndTypes';
import type { GridControllerProps, ItemRenderArgs } from './gridTypes';

/** What `GridZoneView` needs from its controller to render the grid API's items. */
export type GridAdapterScope<T> = {
  renderItem(args: ItemRenderArgs<T>): ReactNode;
  /** The caller's own item object, so render callbacks see stable identities. */
  itemOf(itemId: string): GridItem<T> | undefined;
};

export const GridAdapterContext =
  createContext<GridAdapterScope<unknown> | null>(null);

const EMPTY_STATE: DndValue<never> = { revision: 0, items: [], zones: [] };

/**
 * The grid API on the shared provider. `GridValue` is converted to the
 * provider's layout state once per committed value; candidates, changes and
 * end events are converted back with their ordered zones, item data and
 * revision intact. Zones render through `GridZoneView`, handles through
 * `GridDragHandle`; both are thin wrappers over the provider's components.
 * `onDragEnd` is delivered once the preview has settled, as the grid API
 * always did (the provider's `onDragSettled` timing).
 */
export function GridController<T>({
  value,
  onChange,
  renderItem,
  renderDragPreview,
  waitForDragPreviewReady = false,
  dragPreviewStyle,
  canDrop,
  onDragStart,
  onDragEnd,
  onValidationError,
  onDiagnostic,
  searchBudget,
  activation,
  movementPolicy,
  motion,
  responseTimeoutMs,
  disabled = false,
  ref,
  children,
  ...viewProps
}: GridControllerProps<T>) {
  // Values without a revision get a synthetic one that advances with each
  // layout change; a response without a base revision answers the pending
  // proposal.
  const previous = useRef<PreviousConversion<T> | null>(null);
  const pendingProposal = useRef<DndProposal<T> | null>(null);
  const [lastValidState, setLastValidState] = useState<DndValue<T> | null>(
    null,
  );
  const converted = useMemo(
    () =>
      convertGridValue(
        value,
        previous.current,
        pendingProposal.current?.baseRevision,
      ),
    [value],
  );
  previous.current = {
    value,
    revision: converted.revision,
    state: converted.state ?? previous.current?.state ?? null,
  };
  const state =
    converted.state ?? lastValidState ?? (EMPTY_STATE as DndValue<T>);
  useEffect(() => {
    if (converted.state) setLastValidState(converted.state);
  }, [converted.state]);
  const includeBaseRevision = value.revision !== undefined;

  const items = useMemo(() => gridItemIndex(value), [value]);
  const itemOf = useCallback((itemId: string) => items.get(itemId), [items]);
  const scope = useMemo<GridAdapterScope<T>>(
    () => ({ renderItem, itemOf }),
    [renderItem, itemOf],
  );

  // Input validation keeps the grid API's issue codes; provider issues (zone
  // geometry, handles) are translated. Repeating the same issues does not
  // notify again, and an invalid value silences the zone issues it causes.
  const valueValid = converted.state !== null;
  const lastValueIssues = useRef<string | null>(null);
  const lastProviderIssues = useRef<string | null>(null);
  useEffect(() => {
    const key = converted.issues.length
      ? JSON.stringify(converted.issues)
      : null;
    if (key === lastValueIssues.current) return;
    lastValueIssues.current = key;
    if (key) onValidationError?.(converted.issues);
  }, [converted.issues, onValidationError]);
  const handleProviderIssues = useCallback(
    (issues: LayoutValidationIssue[]) => {
      if (!valueValid) return;
      const key = issues.length ? JSON.stringify(issues) : null;
      if (key === lastProviderIssues.current) return;
      lastProviderIssues.current = key;
      if (key) onValidationError?.(gridIssues(issues));
    },
    [onValidationError, valueValid],
  );

  const handleChange = useCallback(
    (next: DndValue<T>, proposal: DndProposal<T>) => {
      pendingProposal.current = proposal;
      onChange(
        layoutToGridValue(next),
        gridChangeOf(proposal, includeBaseRevision),
      );
    },
    [onChange, includeBaseRevision],
  );
  const handleDrop = useMemo(
    () =>
      canDrop
        ? (proposal: DndProposal<T>) => {
            const item = itemOf(proposal.itemId);
            if (!item) return { allowed: false, reason: 'unknown-item' };
            return canDrop({
              item,
              change: gridChangeOf(proposal, includeBaseRevision),
              proposedValue: layoutToGridValue(proposal.value),
            });
          }
        : undefined,
    [canDrop, itemOf, includeBaseRevision],
  );
  const handleEnd = useCallback(
    (event: DndDragEndEvent<T>) => {
      pendingProposal.current = null;
      onDragEnd?.(gridEndEvent(event, includeBaseRevision));
    },
    [onDragEnd, includeBaseRevision],
  );
  const handlePreview = useMemo(
    () =>
      renderDragPreview
        ? (args: DndPreviewArgs<T>) => {
            const item = itemOf(args.item.id);
            if (!item) return null;
            return renderDragPreview({
              item,
              width: args.width,
              height: args.height,
              isDragging: true,
              sessionId: args.sessionId,
              onReady: args.onReady,
              sourceZoneId: args.zoneId,
              targetZoneId: args.targetZoneId,
              validity: args.validity,
            });
          }
        : undefined,
    [renderDragPreview, itemOf],
  );

  return (
    <DndProvider<T>
      {...viewProps}
      ref={ref}
      value={state}
      onChange={handleChange}
      canDrop={handleDrop}
      onDragStart={onDragStart}
      onDragSettled={handleEnd}
      onValidationError={handleProviderIssues}
      onDiagnostic={onDiagnostic}
      searchBudget={searchBudget}
      activation={activation}
      movementPolicy={movementPolicy}
      motion={motion}
      responseTimeoutMs={responseTimeoutMs}
      disabled={disabled || converted.state === null}
      renderDragPreview={handlePreview}
      waitForDragPreviewReady={waitForDragPreviewReady}
      dragPreviewStyle={dragPreviewStyle}
    >
      <GridAdapterContext value={scope as GridAdapterScope<unknown>}>
        {children}
      </GridAdapterContext>
    </DndProvider>
  );
}
