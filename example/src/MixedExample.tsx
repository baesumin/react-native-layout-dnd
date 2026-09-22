import { useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  createDndStateStore,
  DndProvider,
  DragHandle,
  SortableGrid,
  SortableList,
  useDndState,
  type CellSpan,
  type DndProviderProps,
  type DndValue,
  type GridItemRenderArgs,
  type LayoutState,
  type ListItemRenderArgs,
} from 'react-native-layout-dnd';

type Card = { title: string; span: CellSpan; height: number; color: string };
function initial(): LayoutState<Card> {
  return {
    revision: 0,
    items: Array.from({ length: 122 }, (_, index) => ({
      id: `card-${index}`,
      data: {
        title: `Card ${index + 1}`,
        span: { rows: index % 5 === 0 ? 2 : 1, cols: index % 3 === 0 ? 2 : 1 },
        height: 64 + (index % 3) * 18,
        color: ['#DBEAFE', '#DCFCE7', '#FEF3C7'][index % 3],
      },
    })),
    zones: [
      {
        id: 'list',
        kind: 'list',
        orientation: 'vertical',
        itemIds: Array.from({ length: 120 }, (_, index) => `card-${index + 2}`),
      },
      {
        id: 'board',
        kind: 'grid',
        rows: 3,
        columns: 4,
        placements: [
          {
            itemId: 'card-0',
            position: { row: 0, col: 0 },
            span: { rows: 2, cols: 2 },
            placement: 'exchange',
          },
          {
            itemId: 'card-1',
            position: { row: 2, col: 0 },
            span: { rows: 1, cols: 1 },
            placement: 'insert',
          },
        ],
      },
    ],
  };
}
const getGridItemLayout: NonNullable<
  DndProviderProps<Card>['getGridItemLayout']
> = ({ item }) => ({
  span: item.data.span,
  placement:
    item.data.span.rows === 1 && item.data.span.cols === 1
      ? 'insert'
      : 'exchange',
});

function Content({ item }: Pick<ListItemRenderArgs<Card>, 'item'>) {
  return (
    <>
      <Text numberOfLines={1} style={styles.cardTitle}>
        {item.data.title}
      </Text>
      <Text>
        {item.data.span.rows} × {item.data.span.cols}
      </Text>
      <DragHandle>
        <Text
          accessibilityLabel={`Move ${item.data.title}`}
          style={styles.handle}
        >
          ☰ Move
        </Text>
      </DragHandle>
    </>
  );
}
function ListCard({ item }: ListItemRenderArgs<Card>) {
  return (
    <View
      style={[
        styles.card,
        { height: item.data.height, backgroundColor: item.data.color },
      ]}
    >
      <Content item={item} />
    </View>
  );
}
function GridCard({ item, width, height }: GridItemRenderArgs<Card>) {
  return (
    <View
      style={[styles.card, { width, height, backgroundColor: item.data.color }]}
    >
      <Content item={item} />
    </View>
  );
}

function Board({
  value,
  onChange,
  external,
}: {
  value: DndValue<Card>;
  onChange: DndProviderProps<Card>['onChange'];
  external: boolean;
}) {
  const [reject, setReject] = useState(false);
  const [status, setStatus] = useState(
    'Move a card between the list and board.',
  );
  return (
    <DndProvider
      value={value}
      onChange={onChange}
      getGridItemLayout={getGridItemLayout}
      canDrop={() =>
        reject
          ? { allowed: false, reason: 'example-rejection' }
          : { allowed: true }
      }
      onDragEnd={event =>
        setStatus(
          event.outcome === 'proposed'
            ? event.response === 'accepted'
              ? 'Move accepted.'
              : 'Move was not accepted.'
            : event.outcome === 'unchanged'
              ? 'Kept the same position.'
              : event.reason === 'unresolvable'
                ? 'No room for this card.'
                : event.reason === 'search-budget'
                  ? 'Layout search limit reached.'
                  : 'Move cancelled.',
        )
      }
      style={styles.root}
    >
      <Text style={styles.heading}>List ↔ grid</Text>
      <Text>
        {external ? 'External store' : 'State hook'} · Revision {value.revision}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setReject(current => !current)}
        style={styles.button}
      >
        <Text>
          {reject
            ? 'Rejecting moves · tap to allow'
            : 'Allowing moves · tap to reject'}
        </Text>
      </Pressable>
      <SortableList<Card>
        zoneId="list"
        virtualization
        estimatedItemSize={82}
        gap={8}
        renderItem={ListCard}
        style={styles.list}
      />
      <Text>{status}</Text>
      <SortableGrid<Card>
        zoneId="board"
        geometry={{
          mode: 'fit',
          rowGap: 6,
          columnGap: 6,
          padding: { top: 6, right: 6, bottom: 6, left: 6 },
        }}
        renderItem={GridCard}
        style={styles.board}
      />
    </DndProvider>
  );
}
function HookBoard() {
  const { value, onChange } = useDndState(initial);
  return <Board value={value} onChange={onChange} external={false} />;
}
function StoreBoard() {
  const [store] = useState(() => createDndStateStore(initial()));
  const value = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return <Board value={value} onChange={store.onChange} external />;
}
export function MixedExample() {
  const [external, setExternal] = useState(false);
  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        style={styles.button}
        onPress={() => setExternal(current => !current)}
      >
        <Text>Switch to {external ? 'state hook' : 'external store'} demo</Text>
      </Pressable>
      {external ? <StoreBoard /> : <HookBoard />}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, padding: 8, gap: 8 },
  heading: { fontSize: 22, fontWeight: '700' },
  button: { padding: 8, borderRadius: 8, backgroundColor: '#E2E8F0' },
  list: { flex: 1, minHeight: 100, backgroundColor: '#F1F5F9' },
  board: { height: 246, backgroundColor: '#E2E8F0' },
  card: { padding: 6, borderRadius: 6, justifyContent: 'space-between' },
  cardTitle: { fontWeight: '600' },
  handle: { color: '#334155', fontWeight: '600', paddingVertical: 2 },
});
