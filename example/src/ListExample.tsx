import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  DndProvider,
  DragHandle,
  SortableList,
  useDndState,
  type LayoutState,
  type ListItemRenderArgs,
} from 'react-native-layout-dnd';

type Task = {
  title: string;
  details: string;
  height: number;
  width: number;
  color: string;
};
function initial(virtualized: boolean): LayoutState<Task> {
  const taskCount = virtualized ? 500 : 18;
  const pinnedCount = virtualized ? 80 : 4;
  return {
    revision: 0,
    items: Array.from({ length: taskCount + pinnedCount }, (_, index) => ({
      id: `task-${index}`,
      data: {
        title: `Task ${index + 1}`,
        details:
          index % 3 === 0
            ? 'A taller card with room for extra details.'
            : 'Hold the handle and move.',
        height: 68 + (index % 3) * 24,
        width: 128 + (index % 3) * 36,
        color: ['#DBEAFE', '#DCFCE7', '#FEF3C7'][index % 3],
      },
    })),
    zones: [
      {
        id: 'tasks',
        kind: 'list',
        orientation: 'vertical',
        itemIds: Array.from(
          { length: taskCount },
          (_, index) => `task-${index}`,
        ),
      },
      {
        id: 'pinned',
        kind: 'list',
        orientation: 'horizontal',
        itemIds: Array.from(
          { length: pinnedCount },
          (_, index) => `task-${index + taskCount}`,
        ),
      },
    ],
  };
}

// Native verification reads this after a drop: a FlatList source cell that
// leaves the window while its drag is active is otherwise indistinguishable
// from a clipped one. Only the real cell (not the drag preview) reports here.
const dragTrace = { itemId: null as string | null, sourceReleased: false };
const PREVIEW_COLOR = '#FBCFE8';

// renderItem is called as a plain render function, so the unmount hook lives
// in this child component.
function SourceUnmountTrace({ itemId }: { itemId: string }) {
  useEffect(
    () => () => {
      if (dragTrace.itemId === itemId) dragTrace.sourceReleased = true;
    },
    [itemId],
  );
  return null;
}

function TaskCard({
  item,
  zoneId,
  sessionId,
}: ListItemRenderArgs<Task> & { sessionId?: string }) {
  return (
    <View
      style={[
        styles.card,
        // The drag copy gets its own tint so it reads as the moving card and
        // stays distinguishable from list cells in screen recordings.
        {
          backgroundColor:
            sessionId === undefined ? item.data.color : PREVIEW_COLOR,
        },
        zoneId === 'tasks'
          ? { height: item.data.height }
          : [styles.pinnedCard, { width: item.data.width }],
      ]}
    >
      <Text style={styles.title}>{item.data.title}</Text>
      <Text numberOfLines={2}>{item.data.details}</Text>
      <DragHandle>
        <Text
          accessibilityLabel={`Move ${item.data.title}`}
          style={styles.handle}
        >
          ☰ Move
        </Text>
      </DragHandle>
      {sessionId === undefined && <SourceUnmountTrace itemId={item.id} />}
    </View>
  );
}

export function ListExample({
  virtualized = false,
}: {
  virtualized?: boolean;
}) {
  const { value, onChange, setValue } = useDndState(() => initial(virtualized));
  const [rejectDrops, setRejectDrops] = useState(false);
  const [sourceReleased, setSourceReleased] = useState<
    'none yet' | 'yes' | 'no'
  >('none yet');
  return (
    <DndProvider
      value={value}
      onChange={onChange}
      onDragStart={event => {
        dragTrace.itemId = event.itemId;
        dragTrace.sourceReleased = false;
      }}
      onDragEnd={() => {
        setSourceReleased(dragTrace.sourceReleased ? 'yes' : 'no');
        dragTrace.itemId = null;
      }}
      style={styles.root}
      canDrop={() =>
        rejectDrops
          ? { allowed: false, reason: 'example-rejection' }
          : { allowed: true }
      }
      renderDragPreview={args => <TaskCard {...args} />}
    >
      <Text style={styles.heading}>
        {virtualized ? '580 items · FlatList' : 'Variable size lists'}
      </Text>
      <Text style={styles.instructions}>
        Hold a handle. Keep it near an edge to scroll, or move between the two
        lists.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setRejectDrops(current => !current)}
        style={styles.button}
      >
        <Text>
          {rejectDrops
            ? 'Drops are rejected — tap to allow'
            : 'Drops are allowed — tap to reject'}
        </Text>
      </Pressable>
      {virtualized && (
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          onPress={() =>
            setValue(current => ({
              ...current,
              items: current.items.map(item => ({
                ...item,
                data: {
                  ...item.data,
                  height: item.data.height >= 130 ? 80 : item.data.height + 24,
                  width: item.data.width >= 220 ? 128 : item.data.width + 24,
                },
              })),
            }))
          }
        >
          <Text>Change card sizes</Text>
        </Pressable>
      )}
      <SortableList<Task>
        zoneId="tasks"
        renderItem={TaskCard}
        estimatedItemSize={92}
        gap={10}
        paddingStart={8}
        paddingEnd={8}
        style={styles.tasks}
        virtualization={virtualized}
      />
      <Text style={styles.section}>Pinned · horizontal</Text>
      <SortableList<Task>
        zoneId="pinned"
        renderItem={TaskCard}
        estimatedItemSize={160}
        gap={10}
        paddingStart={8}
        paddingEnd={8}
        style={styles.pinned}
        virtualization={virtualized}
      />
      <Text style={styles.revision}>Revision {value.revision}</Text>
      <Text style={styles.revision}>
        Source cell released during drag: {sourceReleased}
      </Text>
    </DndProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 8 },
  heading: { fontSize: 23, fontWeight: '700', color: '#0F172A' },
  instructions: { color: '#475569' },
  button: { padding: 10, backgroundColor: '#E2E8F0', borderRadius: 8 },
  tasks: { flex: 1, backgroundColor: '#F1F5F9' },
  pinned: { height: 108, flexGrow: 0, backgroundColor: '#F1F5F9' },
  section: { fontSize: 16, fontWeight: '600' },
  card: { padding: 10, borderRadius: 10, justifyContent: 'space-between' },
  pinnedCard: { height: 100 },
  title: { fontWeight: '600', fontSize: 16 },
  handle: { paddingVertical: 4, color: '#334155', fontWeight: '600' },
  revision: { color: '#64748B', fontSize: 12 },
});
