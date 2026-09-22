# React Native Layout DnD

Drag and drop for React Native grids and lists, built on Reanimated worklets and
Gesture Handler.

One provider owns a normalized layout state. An item can be reordered inside a
list, placed by coordinates in a grid, or moved between the two, and every move
arrives at your state layer as one complete candidate that you can accept or
reject.

> **Pre-release.** This package is not on npm yet, and its peer versions are
> pinned to the exact combination it has been verified against. Read
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
| React                        | `>=19.0.0`       | 19.2.3   |
| React Native                 | `>=0.78.0`       | 0.87.1   |
| React Native Gesture Handler | `>=3.0.0 <4.0.0` | 3.3.0    |
| React Native Reanimated      | `>=4.0.0 <5.0.0` | 4.6.0    |
| React Native Worklets        | `>=0.5.0 <1.0.0` | 0.12.2   |

The New Architecture is required, because Reanimated 4 supports nothing else.

Each lower bound is the release that introduced an API this package calls: the
v3 gesture hooks in Gesture Handler 3.0.0, the worklets package split in
Reanimated 4.0.0, `scheduleOnUI`, `scheduleOnRN` and `runOnUISync` in Worklets
0.5.0, and refs as props plus context components in React 19. Only the
**Verified** column has actually been built and run end to end, so treat the
rest of the range as accepted rather than tested, and pin what works for you.
Reanimated and Worklets constrain your React Native version further through
their own peer ranges.

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

Not published yet. Build a tarball from a clone and install it by path:

```sh
git clone https://github.com/baesumin/react-native-layout-dnd.git
cd react-native-layout-dnd
node .yarn/releases/yarn-4.11.0.cjs install
npm pack
```

```sh
# in your app
yarn add /absolute/path/to/react-native-layout-dnd-0.1.0-alpha.0.tgz
```

Installing straight from the Git URL does not work, because the entry points
come from a build that only runs while packing.

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
<DndProvider
  value={value}
  onChange={onChange}
  getGridItemLayout={({ item }) => ({
    span: item.data.span,
    placement: 'insert',
  })}
  style={{ flex: 1 }}
>
  <SortableList<Card> zoneId="library" virtualization ... />
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
  layout contract, movement policies and preview rules, plus the grid-only API
  kept for existing consumers, which is now an adapter over the same provider.
- [Contributing](CONTRIBUTING.md) lists the checks and the native test
  checklist.

Runnable examples live in [`example/`](example/), including a 580-item
`FlatList` tab and a mixed grid and list screen:

```sh
node .yarn/releases/yarn-4.11.0.cjs example start
node .yarn/releases/yarn-4.11.0.cjs example ios     # or: example android
```

## Status and limitations

Automated verification passes 51 suites and 1,215 tests, seven
performance-tooling tests, TypeScript, ESLint, the build, and an isolated check
of the packed API and its types.

Known gaps, stated so you can judge the risk:

- **Not published.** The package stays `private` until the release criteria are
  met, and the public API may still change.
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

## Development

Use the Node version in [`.nvmrc`](.nvmrc). The repository pins Yarn 4.11.0, so
you do not need to change a global Yarn installation:

```sh
node .yarn/releases/yarn-4.11.0.cjs install
node .yarn/releases/yarn-4.11.0.cjs typecheck
node .yarn/releases/yarn-4.11.0.cjs lint
node .yarn/releases/yarn-4.11.0.cjs test
node .yarn/releases/yarn-4.11.0.cjs build
node .yarn/releases/yarn-4.11.0.cjs check:package
```

With Yarn 4 configured, `yarn` works in place of the release path. The example
app resolves the library source directly, so it does not replace the tarball
check above.

## License

[MIT](LICENSE) — baesumin.
