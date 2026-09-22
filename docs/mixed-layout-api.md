# Shared grid and list API

`SortableGrid` and `SortableList` share `DndProvider`, `DragHandle`, and
`useDndState`. One normalized `LayoutState<T>` contains all item data and all
grid/list zones. Moves within and between these zones produce one complete
candidate and one revisioned approval. The existing `GridController` API remains
available for existing consumers.

## Minimal mixed layout

```tsx
import { Text, View } from 'react-native';
import {
  DndProvider,
  DragHandle,
  SortableGrid,
  SortableList,
  useDndState,
  type CellSpan,
  type GridItemLayoutResolverArgs,
  type LayoutState,
} from 'react-native-layout-dnd';

type Card = { title: string; span: CellSpan };
const initial: LayoutState<Card> = {
  revision: 0,
  items: [
    { id: 'notes', data: { title: 'Notes', span: { rows: 1, cols: 2 } } },
  ],
  zones: [
    {
      id: 'library',
      kind: 'list',
      orientation: 'vertical',
      itemIds: ['notes'],
    },
    { id: 'board', kind: 'grid', rows: 3, columns: 4, placements: [] },
  ],
};

// A stable resolver captures destination geometry at the beginning of a drag.
function getGridItemLayout({ item }: GridItemLayoutResolverArgs<Card>) {
  return { span: item.data.span, placement: 'insert' as const };
}

function Board() {
  const { value, onChange } = useDndState(initial);
  return (
    <DndProvider
      value={value}
      onChange={onChange}
      getGridItemLayout={getGridItemLayout}
      style={{ flex: 1 }}
    >
      <SortableList<Card>
        zoneId="library"
        virtualization
        style={{ flex: 1 }}
        estimatedItemSize={72}
        renderItem={({ item }) => (
          <View style={{ padding: 12 }}>
            <DragHandle>
              <Text>{item.data.title}</Text>
            </DragHandle>
          </View>
        )}
      />
      <SortableGrid<Card>
        zoneId="board"
        style={{ height: 240 }}
        geometry={{
          mode: 'fit',
          rowGap: 8,
          columnGap: 8,
          padding: { top: 8, right: 8, bottom: 8, left: 8 },
        }}
        renderItem={({ item, width, height }) => (
          <View style={{ width, height, padding: 8 }}>
            <DragHandle>
              <Text>{item.data.title}</Text>
            </DragHandle>
          </View>
        )}
      />
    </DndProvider>
  );
}
```

Use `GestureHandlerRootView` and the consumer Worklets Babel plugin as in the
other examples. Lists and grids need bounded native viewports. This grid adapter
renders spatial placements and is not virtualized.

## SortableGrid

| Prop                 | Behavior                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `zoneId`             | Existing `kind: 'grid'` zone, mounted once per provider                                   |
| `geometry`           | Existing `ZoneGeometry`: fixed cell sizes or fit-to-viewport, gaps and four padding edges |
| `renderItem`         | `{item, index, zoneId, position, span, placement, width, height, isDragging}`             |
| `dropIndicatorStyle` | Styles the footprint of a valid destination candidate                                     |
| `children`           | Optional grid background/decorations                                                      |
| View props           | Style, layout callback, accessibility attributes and test ID                              |

`item` is the normalized `{id, data}` object. `index` addresses the placement
array, while `position` addresses grid cells. Width/height include gaps inside
the span. The component validates native dimensions with `PixelRatio` and copies
geometry before registering it. Changed cell dimensions, gaps or padding interrupt
an affected drag, even when the viewport has the same outer size.

The provider keeps the source preview dimensions and pointer grip. The grid's
destination indicator shows the resolved footprint and neighbors show the full
candidate arrangement. Pointer mapping uses the grip as a fraction of the
destination footprint, supporting different source/destination cell sizes.
Drop handoff remains immediate; native handoff and reduced-motion behavior must
still be checked on devices.

Inside the source grid, each valid permitted candidate is the baseline for the
next cell: an exchange shown on the way stays in place, a visited cell restores
its earlier preview, and the item's own cell restores the committed layout.
List targets and other zones always compute from the committed state. The grid
API's "Preview baseline" section states the full rule.

A grid zone with `itemSpan` is an ordered grid, such as a dock: `SortableGrid`
renders its placements at their reading-order slots, the pointer maps to the
slot after the item it passes (with the same boundary hysteresis as the old
controller), the engine inserts at that slot and re-packs, and a full dock or
an item of another span is `unresolvable`. Cell positions reported to
`renderItem` are the slots; the entering item's `getGridItemLayout` span must
equal the zone's `itemSpan`.

## Grid sizing and movement policy

`DndProvider` adds:

| Prop                                             | Behavior                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `getGridItemLayout({item, from, target, value})` | Returns `{span: {rows, cols}, placement?: 'insert' \| 'exchange'}` or `null`                |
| `movementPolicy`                                 | Existing generic grid policy; explicitly pass `HOME_GRID_MOVEMENT_POLICY` for home behavior |
| `searchBudget`                                   | Positive safe integer; defaults to 10,000 bounded search steps                              |

The resolver is evaluated once per grid destination at drag start. Its output
is copied and shared by pointer targeting and engine calculation. Keep its
function identity stable during a drag. Policy, search budget or resolver changes
interrupt the session; partial calculations never become proposals.

- **List → grid:** a valid resolver result is required. Missing, invalid or
  `null` results disable that grid destination for the session. List moves remain
  available. A resolver exception cancels with `policy-error`.
- **Grid → list:** the engine removes the grid placement and inserts the ID at
  the list index. Grid span is not stored on list membership. Keep a preferred
  span in caller data if the item should return to a grid later.
- **Grid → another grid:** without a resolver, preserve the source span and
  placement. With a resolver, use its destination descriptor.
- **Within one grid:** preserve its existing span/placement and use the existing
  spatial solver. The conversion resolver is not called for that source zone.

Placement defaults to the existing grid engine behavior (`exchange` when omitted).
Cross-zone moves have no vacant origin inside the target grid; its existing
placement rules determine whether occupants can be rearranged. The engine does
not silently move a destination occupant into the source list.

The existing pointer hysteresis and exchange thresholds are reused, including
the home policy. Grid padding does not accept drops. The engine's final resolved
placement is checked against the current measured viewport and provider bounds,
including cases where an exchange resolves to a different anchor.

## Approval and failure

The same `canDrop(proposal)` sees the complete mixed candidate before preview and
again at release. `onChange(next, proposal)` publishes both zones at once.
`useDndState` and `createDndStateStore` share the approval reducer: item objects and
data are retained, both zones update together, and revision advances once.
Rejection, cancellation or expiry restores the current owner layout without
overwriting a later external edit.

`onDragEnd` distinguishes unsuccessful layout computation:

- `unresolvable`: no valid placement under the selected rules.
- `search-budget`: bounded search stopped without proving impossibility.
- `policy-rejected`: `canDrop` rejected the candidate, including a clipped final
  footprint (`policyReason: 'clipped-target'`).
- Other reasons retain the existing gesture, geometry, data and lifecycle rules.

Offscreen source-cell unmounts keep the provider-owned native recognizer and
preview, including a FlatList source moved to a grid. Native gesture delivery
through real virtualization remains a release gate.

The [mixed example](../example/src/MixedExample.tsx) demonstrates a long variable
list, mixed spans, rejection, `useDndState`, and an external
`createDndStateStore` consumed with `useSyncExternalStore`.

## Pure moves

`computeLayoutMove` is exported from root and `/engine`. In addition to
`value`, `itemId`, and `to`, it accepts `gridItem`, `movementPolicy`, and
`searchBudget`. `gridItem: GridItemLayout` is required for list-to-grid moves and
can convert cross-grid dimensions. It is a resolved value, not a callback.

Results are `ok` (full candidate, from/to, changed, attempts), `invalid` (issues),
`impossible` (attempts), or `unresolved` (attempts). The spatial solver receives
only geometry, never caller data. Failed moves return no partial candidate.

This implementation does not complete the first release: native iOS/Android
acceptance, accessibility, compatibility and publication work remain. See
[status and limitations](../README.md#status-and-limitations).
