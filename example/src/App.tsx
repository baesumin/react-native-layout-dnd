import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  GridController,
  GridDragHandle,
  GridZoneView,
  useGridState,
  type GridValue,
  type ItemRenderArgs,
} from 'react-native-layout-dnd';
import { ListExample } from './ListExample';
import { MixedExample } from './MixedExample';

type CardData = { title: string; color: string };

const INITIAL_VALUE: GridValue<CardData> = {
  zones: [
    {
      id: 'board',
      strategy: 'spatial',
      rows: 3,
      columns: 3,
      items: [
        {
          id: 'studio',
          position: { row: 0, col: 0 },
          span: { rows: 2, cols: 2 },
          placement: 'exchange',
          data: { title: 'Studio', color: '#C7D2FE' },
        },
        {
          id: 'notes',
          position: { row: 0, col: 2 },
          span: { rows: 1, cols: 1 },
          placement: 'insert',
          data: { title: 'Notes', color: '#FDE68A' },
        },
        {
          id: 'ideas',
          position: { row: 1, col: 2 },
          span: { rows: 1, cols: 1 },
          placement: 'insert',
          data: { title: 'Ideas', color: '#A7F3D0' },
        },
        {
          id: 'tasks',
          position: { row: 2, col: 0 },
          span: { rows: 1, cols: 1 },
          placement: 'insert',
          data: { title: 'Tasks', color: '#FECDD3' },
        },
      ],
    },
  ],
};

function Card({
  item,
  width,
  height,
}: Pick<ItemRenderArgs<CardData>, 'item' | 'width' | 'height'>) {
  return (
    <View
      style={[styles.card, { width, height, backgroundColor: item.data.color }]}
    >
      <Text style={styles.cardTitle}>{item.data.title}</Text>
    </View>
  );
}

function GridExample() {
  const { value, onChange } = useGridState(INITIAL_VALUE);
  const { width, height } = useWindowDimensions();
  const cell = Math.max(
    1,
    Math.floor((Math.min(width - 48, height - 180, 360) - 20) / 3),
  );
  const boardSize = cell * 3 + 20;

  return (
    <View style={styles.root}>
      <GridController
        style={styles.content}
        value={value}
        onChange={onChange}
        renderItem={args => (
          <GridDragHandle itemId={args.item.id}>
            <Card {...args} />
          </GridDragHandle>
        )}
        renderDragPreview={args => <Card {...args} />}
      >
        <Text style={styles.title}>Grid example</Text>
        <Text style={styles.instruction}>
          Touch and hold a card, then drag it to move.
        </Text>
        <GridZoneView
          zoneId="board"
          geometry={{
            mode: 'fixed',
            cellWidth: cell,
            cellHeight: cell,
            rowGap: 10,
            columnGap: 10,
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
          }}
          style={[styles.board, { width: boardSize, height: boardSize }]}
        />
      </GridController>
    </View>
  );
}

export default function App() {
  const [screen, setScreen] = useState<
    'mixed' | 'lists' | 'virtualized' | 'grid'
  >('mixed');
  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.tabs}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setScreen('mixed')}
          style={styles.tab}
        >
          <Text>Mixed</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setScreen('virtualized')}
          style={styles.tab}
        >
          <Text>FlatList</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setScreen('lists')}
          style={styles.tab}
        >
          <Text>Lists</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setScreen('grid')}
          style={styles.tab}
        >
          <Text>Grid</Text>
        </Pressable>
      </View>
      {screen === 'mixed' ? (
        <MixedExample />
      ) : screen === 'grid' ? (
        <GridExample />
      ) : (
        <ListExample key={screen} virtualized={screen === 'virtualized'} />
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F8FAFC' },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 48,
    gap: 6,
  },
  tab: { padding: 8, borderRadius: 8, backgroundColor: '#E2E8F0' },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: { color: '#0F172A', fontSize: 28, fontWeight: '700', marginBottom: 8 },
  instruction: {
    color: '#475569',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
  },
  board: { backgroundColor: '#E2E8F0', borderRadius: 16 },
  card: { borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { color: '#0F172A', fontSize: 16, fontWeight: '600' },
});
