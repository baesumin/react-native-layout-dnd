# Sortable lists and scrolling

`DndProvider`, `SortableList`, `DragHandle`, and `useDndState` implement the shared
layout contract for React Native lists. `SortableList` uses **ScrollView by
default**, or **FlatList when `virtualization` is enabled**. Vertical and horizontal
lists support fixed or measured variable sizes, reordering, automatic edge
scrolling, and atomic list-to-list moves within one provider.

`SortableGrid` and transfers between lists and grids use the same provider;
see the [shared grid/list API](mixed-layout-api.md). Native gesture continuity
through virtualized cell unmounts, accessibility
behavior, and performance still need iOS/Android device verification. The existing
grid API is documented [separately](api.md).

## Minimal list

```tsx
import { Text, View } from 'react-native';
import {
  DndProvider,
  DragHandle,
  SortableList,
  useDndState,
  type LayoutState,
} from 'react-native-layout-dnd';

type Task = { title: string; details: string };
const initial: LayoutState<Task> = {
  revision: 0,
  items: [
    { id: 'a', data: { title: 'Notes', details: 'Short content' } },
    {
      id: 'b',
      data: { title: 'Plan', details: 'Longer content wraps naturally' },
    },
  ],
  zones: [
    { id: 'tasks', kind: 'list', orientation: 'vertical', itemIds: ['a', 'b'] },
  ],
};

function Tasks() {
  const { value, onChange } = useDndState(initial);
  return (
    <DndProvider value={value} onChange={onChange} style={{ flex: 1 }}>
      <SortableList<Task>
        zoneId="tasks"
        style={{ flex: 1 }}
        estimatedItemSize={72}
        gap={8}
        renderItem={({ item }) => (
          <View style={{ padding: 12 }}>
            <Text>{item.data.details}</Text>
            <DragHandle>
              <Text>Move {item.data.title}</Text>
            </DragHandle>
          </View>
        )}
      />
    </DndProvider>
  );
}
```

Place the provider under `GestureHandlerRootView` and configure the native peers
and consumer Worklets Babel plugin as for the grid example. The provider and each
list need a bounded viewport (for example `flex: 1` within a bounded parent).
Orientation belongs to the list zone, not to `DragHandle`.

## Components

### DndProvider

| Prop                                            | Behavior                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`, `onChange(next, proposal)`             | Controlled `DndValue<T>` and complete revisioned proposal                                                                                                                 |
| `canDrop(proposal)`                             | `{allowed: boolean, reason?: string}`; checked during preview and again at release                                                                                        |
| `activation`                                    | `{delayMs: 250}` by default                                                                                                                                               |
| `dragAxis`                                      | `'both'` by default; `'x'` or `'y'` constrains the screen pointer independently of orientation                                                                            |
| `motion`                                        | Neighbor movement duration/reduced-motion options; default 180ms and `'system'`                                                                                           |
| `renderDragPreview`                             | Optional renderer; defaults to the source list renderer                                                                                                                   |
| `waitForDragPreviewReady`                       | Keep the original visible until the custom preview calls `onReady`; false by default                                                                                      |
| `dragPreviewStyle`                              | Styles the provider-owned overlay                                                                                                                                         |
| `responseTimeoutMs`                             | 2000ms by default for externally controlled responses                                                                                                                     |
| `disabled`                                      | Disables activation and interrupts active work                                                                                                                            |
| `onDragStart`, `onDragEnd`, `onValidationError` | Lifecycle and input validation callbacks                                                                                                                                  |
| `onDragSettled`                                 | The `onDragEnd` event again once the drag preview has settled, or right after `onDragEnd` when nothing animates                                                           |
| `onDiagnostic`                                  | Optional JS-only timing and lifecycle events (`compute-move`, `policy`, `request`, `request-coalesced`, `release`, `proposal`, `response`, `end`); exceptions are ignored |
| `ref`                                           | `DndProviderHandle` with `invalidateGeometry()`, which cancels the drag with `geometry-changed`                                                                           |

`motion` accepts `{durationMs?, reduceMotion?: 'system' | 'always' | 'never'}`.
`renderDragPreview` receives the item renderer arguments plus `sessionId`,
`targetZoneId`, `width`, `height`, `validity` (`pending`, `valid`, or `invalid`)
and `onReady`, which a custom preview calls once its drawable content has
committed when `waitForDragPreviewReady` is set.

The overlay keeps the original pointer grip and source dimensions. It remains
mounted when the pointer leaves a list; releasing outside cancels. A response
commits the destination layout or restores the latest owner layout, then clears
the overlay. List settling currently hands off immediately; the existing grid's
custom preview readiness and animated settling APIs are not part of this list
adapter yet. Native handoff still requires verification.

### SortableList

| Prop                         | Behavior                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `zoneId`                     | Unique mounted list zone in the provider value                                                        |
| `renderItem`                 | Receives `{item, index, zoneId, isDragging}`; item is `{id, data}`                                    |
| `estimatedItemSize`          | Main-axis estimate before measurement; default 48 logical pixels                                      |
| `itemSize`                   | Optional authoritative number or `(itemId, index) => number`; omitting enables native measured sizing |
| `gap`                        | Main-axis gap; default 0                                                                              |
| `paddingStart`, `paddingEnd` | Main-axis content padding; default 0                                                                  |
| `autoScroll`                 | `{enabled?, edgeThreshold?, maxSpeed?}`; defaults true, 48px, 600px/second                            |
| `scrollEnabled`              | Allows normal scrolling and automatic edge scrolling; default true                                    |
| `showsScrollIndicator`       | Default true                                                                                          |
| `onScrollOffsetChange`       | Receives observed native `{x, y}` offsets                                                             |
| `virtualization`             | `false` by default; `true` or a `ListVirtualizationOptions` object enables FlatList                   |
| View props                   | Viewport style, layout callback, accessibility attributes, test ID                                    |

Provide content padding through `paddingStart` and `paddingEnd`. The cross-axis
size comes from the viewport. Vertical content can measure its natural height;
horizontal variable content should supply a natural width in its renderer, or
use `itemSize`. `itemSize` overrides measured sizes and also sizes the cell.

Native measurements are cached by item ID. Reordering retains their association;
new data arrays or cross-axis geometry create a fresh measurement context and
remeasure even when no new native layout event fires. Late callbacks from old
contexts, revisions, or unmounted cells are ignored. Computed rectangles carry
the layout revision they describe.

During a drag, ordinary touch scrolling is disabled so the handle owns the
gesture. Programmatic edge scrolling continues. The adapter observes actual
native offsets rather than assuming a requested `scrollTo` has completed. Those
offsets update the candidate even while the pointer stays still. Changing an
offset does not advance state revision or cancel a drag. External data edits must
advance revision, as `setValue` does. A revision or structural layout change,
viewport resize, active zone removal, or gesture interruption cancels the drag.

Auto-scroll only runs when the constrained pointer is inside the viewport on
both axes. Speed grows linearly toward an edge, clamps to the content extent,
and caps elapsed time at 64ms per frame to avoid a large jump after suspension.
It stops when the pointer exits or the session ends. This adapter owns its
scrolling container and does not provide arbitrary external scroll-container
integration.

### FlatList virtualization

Enable windowed rendering on an existing list with `virtualization`:

```tsx
<SortableList<Task>
  zoneId="tasks"
  style={{ flex: 1 }}
  virtualization={{ initialNumToRender: 12, windowSize: 7 }}
  estimatedItemSize={72}
  gap={8}
  renderItem={({ item }) => (
    <DragHandle>
      <View style={{ padding: 12 }}>
        <Text>{item.data.title}</Text>
        <Text>{item.data.details}</Text>
      </View>
    </DragHandle>
  )}
/>
```

`true` uses all defaults; an options object enables FlatList and overrides only
the supplied fields. `false` or an omitted prop uses ScrollView.

| Option                      | Default | Requirement                                       |
| --------------------------- | ------- | ------------------------------------------------- |
| `initialNumToRender`        | 12      | Positive safe integer                             |
| `maxToRenderPerBatch`       | 12      | Positive safe integer                             |
| `windowSize`                | 7       | Finite number greater than 1, in viewport lengths |
| `updateCellsBatchingPeriod` | 50      | Finite, nonnegative milliseconds                  |

Invalid options report `invalid-configuration` through `onValidationError` and
disable dragging. These are the supported FlatList tuning options; arbitrary
FlatList props and an external list ref are not exposed. Switching between
ScrollView and FlatList remounts the viewport, resets its scroll offset, and
interrupts a drag involving that zone.

Native cells are windowed, while layout metadata covers the complete item order.
Unmounted items retain ID-based size measurements in the current measurement
context. Never-measured items use `estimatedItemSize`; choose an estimate close to
their typical size. A cell measures its natural content after mounting, then
updates the cache, content extent, and insertion coordinates. Offscreen estimates
remain estimates until that item is measured.

The FlatList data uses item IDs as keys and stays in the committed order while an
item of the same list is dragged: a candidate change renders nothing, and the
shared presentation moves the mounted cells to their candidate positions on the
UI runtime. The order commits once, on drop. This holds while the render window
can cover the preview's displacement, which is at most the dragged item plus its
gap; VirtualizedList keeps `(windowSize - 1) / 2` viewport lengths beyond each
viewport edge, so the default `windowSize` of 7 covers any item shorter than
three viewports. A larger item, an index-dependent `itemSize` function, or an
item arriving from another list makes the data follow the displayed candidate
order for that drag, so the cells that become visible are mounted. Each native
slot has the item's current size plus its following gap, with no gap after the
last item. Its `getItemLayout` offset includes start padding; padding is applied
once to the content container. The natural-size child is measured inside the
slot, so an estimated slot does not become the child's measured size. The slot
and metrics update together when a measurement arrives. Cell content is
positioned by a plain slot offset that changes in the same React commit as the
slot itself, plus the animated content start owned by the UI runtime; the adapter
never measures native slots per frame, so a reorder cannot show a cell at its
new slot before its content start has moved there. Target selection continues to
use the committed order, keeping candidate reflow out of insertion thresholds.

The provider owns the active gesture and drag overlay independently of the source
cell. The source cell keeps its committed slot during a same-list preview, so a
long auto-scroll can carry that slot out of the render window and unmount the
cell; the item mounts again at its committed slot when the drop commits. The
source can also be removed from its list's candidate order while the session
continues. This lifecycle is covered by mocked
bridge tests; actual iOS/Android gesture delivery, long-list frame rates, and
estimate correction during native scrolling remain release checks. Virtualized
rendering does not remove the cost of computing layout metadata for the full list.

### DragHandle

Render it inside the item renderer. `itemId` is optional and, when supplied,
must match the enclosing item. It supports `disabled` and `gestureRelations`
(`block`, `requireToFail`, `simultaneousWith`). The copy inside a preview does not
attach another gesture. Activation captures revision, axis, delay and measured
geometry; obsolete queued activations are rejected.

Handles that share one gesture relation signature share one native Pan
recognizer owned by the provider; touch-down and activation measure the
registered handles under the pointer to pick the item. Mounting or unmounting
cells therefore does not create, drop or recompose native recognizers, and the
recognizer survives the source cell leaving a virtualized window.

`DragHandleViewProps` (`accessible`, `accessibilityLabel`, `accessibilityHint`,
`accessibilityRole`, `accessibilityState`, `accessibilityActions`,
`onAccessibilityAction`, `importantForAccessibility`, `testID`) are forwarded to
the handle's native view, including the non-interactive copy inside a drag
preview. The library sets no default label, role or hint.

### Accessibility, reduced motion and alternative movement

Support level in this release:

- **Reduced motion**: `motion.reduceMotion` on `DndProvider` (and
  `GridController`) accepts `'system' | 'always' | 'never'` and defaults to the
  device accessibility setting. Item movement, preview settling and grid
  animations use it; `'always'` also sets the animation duration to 0.
- **Labels and roles**: supply them through the `DragHandle` view props above.
  Announcing the drag state itself (VoiceOver/TalkBack) is not implemented.
- **Alternative movement**: the gesture is the only built-in input. For
  keyboard, switch or screen-reader users, compute a move without a gesture and
  commit it through the same state path:

```tsx
import { computeLayoutMove } from 'react-native-layout-dnd/engine';

const result = computeLayoutMove({
  value,
  itemId,
  to: { kind: 'list', zoneId: 'tasks', index: targetIndex },
});
if (result.status === 'ok' && result.changed) setValue(result.value);
```

`setValue` advances the revision like any external edit; `respond` is not
needed because no drag session proposed the change. Pair this with
`accessibilityActions` on the handle (for example `increment`/`decrement`)
to offer "move up"/"move down" actions. The library does not provide those
actions itself, and focus management after a drop is left to the consumer.

## State and atomic moves

`useDndState(initial)` returns `value`, `onChange`, `setValue`, and `respond`.
The initial layout is read once. `setValue(valueOrUpdater)` advances revision
for external changes and clears the previous response. Use immutable updates.

`createDndStateStore` exposes the same path without React and can be subscribed
to with `useSyncExternalStore`. `respondToDndProposal(current, proposal, allowed)`
returns `accepted`, `rejected`, `stale`, or `invalid` plus the resulting value.
The store tracks previously answered proposals, but does not receive coordinator
cancellation or timeout notifications. External owners must discard expired or
cancelled asynchronous decisions before calling `respond` on the store/hook or
applying the pure response reducer.

Each accepted move preserves caller-owned item objects and data, removes the
source ID, inserts it into the destination order, validates the entire state,
then publishes one revision. Rejection changes neither order nor revision.
An external revision change interrupts the session and keeps the new owner
state. Unrelated responses cannot accept a proposal, and timeout cleans up the
session without restoring an old snapshot.

Add another list zone to the same value and render a second `SortableList` in the
provider for list-to-list movement. Different orientations and measured sizes
are supported; the destination calculates its own sizes. ScrollView mode retains
the source cell during a cross-list preview. FlatList mode can unmount that cell;
the provider keeps the session, active gesture, and drag overlay. Native handoff
still needs verification in both modes.

## Pure engine and adapter exports

Root and `/engine` export:

- `ListSizeCache`: `get`, `set`, `prune`, `clear`; contexts include orientation,
  cross-axis size and optional measurement epoch.
- `computeListLayout`: revisioned main-axis offsets and measured/estimated
  rectangles, including padding and gaps.
- `computeListIndex`: insertion index after removal of the active ID, using
  committed item centers. Candidate reflow never changes its own hit thresholds.
- `computeLayoutMove`: complete, immutable candidate for moves within or between
  lists and grids; list-to-grid moves require an explicit `gridItem` descriptor.
  Grid search distinguishes impossible placement from exhausted search budget.
- `computeAutoScroll`, `validateAutoScrollOptions`, `constrainDragPoint`:
  worklet-safe scrolling and axis calculations.
- `resolveListVirtualization`: validates enablement and rendering limits, returning
  resolved options or `null` for ScrollView; `ListVirtualizationOptions` and
  `ListVirtualizationResult` describe its public configuration and result.
- `createDndStateStore`, `respondToDndProposal` and their public types.

See the [example](../example/src/ListExample.tsx) for variable sizes, both axes,
cross-list movement, and a rejection toggle. Automatic tests use mocked native
measurement/gesture bridges; the native checklist remains a release gate.
