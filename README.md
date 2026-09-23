# React Native Layout DnD

[![npm](https://img.shields.io/npm/v/react-native-layout-dnd)](https://www.npmjs.com/package/react-native-layout-dnd)
[![CI](https://github.com/baesumin/react-native-layout-dnd/actions/workflows/ci.yml/badge.svg)](https://github.com/baesumin/react-native-layout-dnd/actions/workflows/ci.yml)

Drag and drop for React Native grids and lists, built on Reanimated worklets and
Gesture Handler.

One provider owns a normalized layout state. An item can be reordered inside a
list, placed by coordinates in a grid, or moved between the two, and every move
arrives at your state layer as one complete candidate that you can accept or
reject.

> **Alpha.** Only one combination of peer versions has been built and run, and
> device verification is incomplete. Read
> [Status and limitations](#status-and-limitations) before adopting it.

## Why this library

- **Grids and lists in one drag session.** A single `DndProvider` hosts any
  number of list and grid zones. List-to-list, grid-to-grid and list-to-grid
  moves all produce one candidate and one approval.
- **Grids with mixed spans.** Items occupy `rows x cols` cells at explicit
  coordinates. Insertion and exchange are separate placement policies, and
  rules such as full-width row rotation are configurable per provider.
- **Ordered grid zones.** Give a grid zone an `itemSpan` and it behaves like a
  dock: array order is item order, a move inserts at the addressed slot,
  removal closes the gap, and capacity is the slot count.
- **Lists that scroll.** Vertical and horizontal, fixed or measured variable
  sizes, edge auto-scroll during a drag, and optional `FlatList` windowing for
  long lists.
- **Your state stays in control.** Every move is a revisioned proposal. Reject
  it synchronously with `canDrop`, or answer asynchronously within a timeout.
  Rejection, cancellation and expiry restore the current layout without
  overwriting a later external edit.
- **A pure engine you can call directly.** `react-native-layout-dnd/engine`
  computes moves, packing and layout without loading React Native components,
  so input that is not a gesture, such as a screen-reader action or an undo,
  uses exactly the same rules as dragging.

## Requirements

| Peer dependency              | Accepted range   | Verified |
| ---------------------------- | ---------------- | -------- |
| React Native                 | `>=0.78.0`       | 0.87.1   |
| React Native Gesture Handler | `>=3.0.0 <4.0.0` | 3.3.0    |
| React Native Reanimated      | `>=4.0.0 <5.0.0` | 4.6.0    |
| React Native Worklets        | `>=0.5.0 <1.0.0` | 0.12.2   |

React is a peer too, at 19 or newer, but your React Native version already
decides it. The New Architecture is required, because Reanimated 4 supports
nothing else.

Only the **Verified** column has been built and run end to end. The rest of
each range is accepted but untested, so pin what works for you.

Your app must also render the provider under `GestureHandlerRootView` and enable
the Worklets Babel plugin. This package ships worklet directives uncompiled so
that your plugin version transforms them:

```js
// babel.config.js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-worklets/plugin'],
};
```

## Installation

```sh
yarn add react-native-layout-dnd
# or: npm install react-native-layout-dnd
```

Install the peers too if your app does not have them yet, then rebuild the
native app:

```sh
yarn add react-native-gesture-handler react-native-reanimated react-native-worklets
```

## Quick start

A sortable vertical list. `useDndState` holds the layout and acknowledges each
proposal for you, and `DragHandle` marks the part of an item that starts a drag.

```tsx
import { Text, View } from 'react-native';
import {
  DndProvider,
  DragHandle,
  SortableList,
  useDndState,
  type LayoutState,
} from 'react-native-layout-dnd';

type Task = { title: string };

const initial: LayoutState<Task> = {
  revision: 0,
  items: [
    { id: 'a', data: { title: 'Notes' } },
    { id: 'b', data: { title: 'Plan' } },
  ],
  zones: [
    { id: 'tasks', kind: 'list', orientation: 'vertical', itemIds: ['a', 'b'] },
  ],
};

export function Tasks() {
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

The provider and every zone need a bounded viewport, for example `flex: 1`
inside a bounded parent. A drag starts after a 250 ms long press by default.

### Moving between a list and a grid

Add a `SortableGrid` to the same provider. A list item carries no grid
footprint, so `getGridItemLayout` decides the span an incoming item takes. Keep
that function stable, because it is captured once per drag.

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

function getGridItemLayout({ item }: GridItemLayoutResolverArgs<Card>) {
  return { span: item.data.span, placement: 'insert' as const };
}

export function Board() {
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
        estimatedItemSize={48}
        renderItem={({ item }) => (
          <DragHandle>
            <Text>{item.data.title}</Text>
          </DragHandle>
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
          <View style={{ width, height }}>
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

A grid zone with `rows`, `columns` and `placements` is spatial. Add `itemSpan`
and it becomes an ordered zone instead, which is how a dock behaves.

## How a move reaches your state

1. The gesture resolves a target cell or index.
2. The engine computes the **whole next layout**, including every item the move
   displaces. It never commits partial work, so a move that cannot be placed
   fails as a whole.
3. `canDrop(proposal)` may reject the candidate synchronously, during the
   preview and again at release.
4. `onChange(next, proposal)` publishes the candidate together with
   `proposal.baseRevision`. Answer it by committing a value whose revision is
   that base plus one, or by rejecting it. `useDndState` and
   `createDndStateStore` do this for you.
5. `onDragEnd` reports the outcome: `accepted`, `rejected`, `expired`,
   `mismatch`, `interrupted`, or a cancellation with its reason.

An unanswered proposal expires after `responseTimeoutMs`, 2000 ms by default,
and an external edit during a drag interrupts the session instead of being
overwritten.

For input that is not a gesture, compute the same move and commit it yourself:

```ts
import { computeLayoutMove } from 'react-native-layout-dnd/engine';

const result = computeLayoutMove({
  value,
  itemId,
  to: { kind: 'list', zoneId: 'tasks', index: targetIndex },
});
if (result.status === 'ok' && result.changed) setValue(result.value);
```

## Documentation

- [Lists and scrolling](docs/list-scroll-api.md) covers `DndProvider`,
  `SortableList`, `DragHandle`, `useDndState`, virtualization, auto-scroll and
  accessibility.
- [Grids and mixed layouts](docs/mixed-layout-api.md) covers `SortableGrid`,
  spans, transfers between zones, approval and failure reasons.
- [Grid contracts and the `GridController` API](docs/api.md) covers the shared
  layout contract, movement policies and preview rules, plus `GridController`,
  a grid-only interface over the same provider.
- [Contributing](CONTRIBUTING.md) lists the checks and the native test
  checklist.

Runnable examples live in [`example/`](example/), including a 580-item
`FlatList` tab and a mixed grid and list screen. To run them, clone the
repository and follow
[Run the native example](CONTRIBUTING.md#run-the-native-example).

## Status and limitations

Known gaps, stated so you can judge the risk:

- **Alpha.** The public API may still change before `0.1.0`.
- **One verified combination.** The peer ranges above come from the APIs this
  package calls, not from a test matrix. Only the versions in the Verified
  column have been built and run, and Expo has not been tried.
- **Device verification is incomplete.** iOS simulator measurement and an
  Android emulator driver pass. Dragging across rotation and app backgrounding,
  Android release-build touch input, and a physical-device run are still open.
- **Screen readers.** Handles forward accessibility view props and reduced
  motion follows the system setting, but the drag state itself is not announced
  and no move actions are wired up for you. See the
  [accessibility support level](docs/list-scroll-api.md#accessibility-reduced-motion-and-alternative-movement).
- **Virtualization is list-only.** Grid zones render every placement, and there
  are no FlashList or LegendList adapters.

## License

[MIT](LICENSE) — baesumin.
