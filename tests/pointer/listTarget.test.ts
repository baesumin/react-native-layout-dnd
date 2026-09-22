import {
  computeAutoScroll,
  constrainDragPoint,
} from '../../src/adapters/scroll';
import type { DndMotion, ListRegistration } from '../../src/runtime/dndRuntime';
import { listTarget } from '../../src/pointer/listTarget';
import type { ListLayoutZone } from '../../src/contracts';
import { DndSessionCoordinator } from '../../src/controller/dndSession';
import type { DndValue } from '../../src/controller/dndState';
import {
  computeListIndex,
  computeListLayout,
  ListSizeCache,
} from '../../src/engine/list';

const itemIds = ['a', 'b', 'c', 'd'];
const sizes: Record<string, number> = { a: 40, b: 100, c: 60, d: 80 };

function fixture(orientation: ListLayoutZone['orientation'] = 'vertical') {
  const cache = new ListSizeCache();
  for (const itemId of itemIds) {
    cache.set(itemId, sizes[itemId], { orientation, crossSize: 120 }, 4);
  }
  const layoutInput = {
    itemIds,
    orientation,
    crossSize: 120,
    cache,
    estimatedItemSize: 40,
    paddingStart: 12,
    paddingEnd: 8,
    gap: 10,
    revision: 4,
  };
  const layout = computeListLayout(layoutInput);
  if (!layout.valid) throw new Error('Invalid fixture layout');
  const registration: ListRegistration & { layoutVersion: number } = {
    kind: 'list',
    zoneId: 'list',
    orientation,
    revision: 4,
    layoutVersion: 3,
    ref: null as unknown as ListRegistration['ref'],
    offset: { get: () => 0 } as ListRegistration['offset'],
    contentSize: layout.totalSize,
    layout,
    renderItem: () => null,
  };
  const registrations = new Map([['list', registration]]);
  const vertical = orientation === 'vertical';
  const state: DndMotion = {
    token: 1,
    handleId: null,
    seq: 0,
    phase: 'dragging',
    itemId: 'a',
    sourceZoneId: 'list',
    revision: 4,
    configRevision: 0,
    pointer: vertical ? { x: 70, y: 100 } : { x: 60, y: 110 },
    origin: vertical ? { x: 70, y: 100 } : { x: 60, y: 110 },
    axis: 'both',
    activationDelayMs: 250,
    grip: vertical ? { x: 30, y: 10 } : { x: 10, y: 30 },
    width: vertical ? 120 : 40,
    height: vertical ? 40 : 120,
    root: { x: 0, y: 0, width: 500, height: 600 },
    zones: [
      {
        zoneId: 'list',
        offset: 0,
        layoutVersion: 3,
        viewport: {
          source: 'measured',
          space: 'screen',
          revision: 4,
          timestampMs: 100,
          rect: {
            x: 40,
            y: 80,
            width: vertical ? 120 : 160,
            height: vertical ? 160 : 120,
          },
        },
      },
    ],
    visible: true,
  };
  const value: DndValue<string> = {
    revision: 4,
    items: itemIds.map(id => ({ id, data: id.toUpperCase() })),
    zones: [{ id: 'list', kind: 'list', orientation, itemIds: [...itemIds] }],
  };
  return { state, registrations, registration, value, layoutInput };
}

function expectedTarget(index: number) {
  return { kind: 'list', zoneId: 'list', index };
}

describe('list targets from measured scroll viewports', () => {
  it('subtracts the screen origin and grip before testing variable-size centers', () => {
    const { state, registrations } = fixture();
    state.grip.y = 35;
    state.pointer.y = 205;
    // Drag center: 205 - 35 + 20 - 80 = 110; item b center is 112.
    expect(listTarget(state, registrations)).toEqual(expectedTarget(0));
    state.pointer.y = 208;
    expect(listTarget(state, registrations)).toEqual(expectedTarget(1));
  });

  it('keeps the target when both viewport and pointer move in screen space', () => {
    const { state, registrations } = fixture();
    state.pointer.y = 205;
    const before = listTarget(state, registrations);
    state.pointer.y += 130;
    state.zones[0].viewport.rect.y += 130;
    expect(before).toEqual(expectedTarget(1));
    expect(listTarget(state, registrations)).toEqual(before);
  });

  it('updates a stationary pointer after observed scrolling without ending the session', () => {
    const { state, registrations, registration, value } = fixture();
    const onChange = jest.fn();
    const onDragEnd = jest.fn();
    const coordinator = new DndSessionCoordinator({
      value,
      onChange,
      onDragEnd,
    });
    const sessionId = coordinator.start('a', 4)!;
    expect(sessionId).not.toBeNull();
    state.pointer.y = 220;
    coordinator.requestTarget(sessionId, 0, listTarget(state, registrations));
    expect(coordinator.getSnapshot().target).toEqual(expectedTarget(1));

    for (let seq = 1; seq <= 5; seq++) {
      const measured = state.zones[0];
      const scroll = computeAutoScroll({
        pointer: state.pointer.y,
        viewportStart: measured.viewport.rect.y,
        viewportSize: measured.viewport.rect.height,
        contentSize: registration.contentSize,
        offset: measured.offset,
        deltaTimeMs: 32,
      });
      expect(scroll.valid).toBe(true);
      if (!scroll.valid) throw new Error(scroll.reason);
      // Model the next native onScroll observation, with the pointer unchanged.
      measured.offset = scroll.offset;
      coordinator.requestTarget(
        sessionId,
        seq,
        listTarget(state, registrations),
      );
    }

    expect(state.pointer).toEqual({ x: 70, y: 220 });
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'dragging',
      sessionId,
      target: expectedTarget(2),
      validity: 'valid',
    });
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('applies horizontal scroll offsets to horizontal insertion coordinates', () => {
    const { state, registrations } = fixture('horizontal');
    state.pointer.x = 190;
    expect(listTarget(state, registrations)).toEqual(expectedTarget(1));
    state.zones[0].offset = 70;
    expect(listTarget(state, registrations)).toEqual(expectedTarget(2));
  });

  it('preserves native negative bounce offsets in candidate coordinates', () => {
    const { state, registrations } = fixture();
    state.pointer.y = 190;
    expect(listTarget(state, registrations)).toEqual(expectedTarget(1));
    state.zones[0].offset = -20;
    expect(listTarget(state, registrations)).toEqual(expectedTarget(0));
  });

  it.each(['vertical', 'horizontal'] as const)(
    'projects the drag axis before viewport targeting in a %s list',
    orientation => {
      const { state, registrations } = fixture(orientation);
      const vertical = orientation === 'vertical';
      const point = vertical ? { x: 400, y: 205 } : { x: 165, y: 400 };
      state.pointer = point;
      expect(listTarget(state, registrations)).toBeNull();
      state.pointer = constrainDragPoint(
        point,
        state.origin,
        vertical ? 'y' : 'x',
      );
      expect(listTarget(state, registrations)).toEqual(expectedTarget(1));
    },
  );

  it('requires the actual pointer to be inside on the cross axis', () => {
    const { state, registrations } = fixture();
    state.pointer = { x: 161, y: 205 };
    // The dragged rectangle still overlaps the viewport; the pointer is outside.
    expect(listTarget(state, registrations)).toBeNull();
    state.pointer.x = 160;
    expect(listTarget(state, registrations)).toEqual(expectedTarget(1));
  });

  it('rejects a viewport point clipped by the provider root', () => {
    const { state, registrations } = fixture();
    state.root.height = 180;
    state.pointer.y = 205;
    expect(listTarget(state, registrations)).toBeNull();
  });

  it('handles leaving, re-entering, and cancellation without publishing a move', () => {
    const { state, registrations, value } = fixture();
    const onChange = jest.fn();
    const onDragEnd = jest.fn();
    const coordinator = new DndSessionCoordinator({
      value,
      onChange,
      onDragEnd,
    });
    const sessionId = coordinator.start('a')!;
    state.pointer.y = 205;
    coordinator.requestTarget(sessionId, 0, listTarget(state, registrations));
    expect(coordinator.getSnapshot().candidate).not.toBeNull();
    state.pointer.y = 241;
    coordinator.requestTarget(sessionId, 1, listTarget(state, registrations));
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'dragging',
      sessionId,
      target: null,
      candidate: null,
      displayValue: value,
      validity: 'invalid',
    });
    state.pointer.y = 205;
    coordinator.requestTarget(sessionId, 2, listTarget(state, registrations));
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'dragging',
      sessionId,
      target: expectedTarget(1),
      validity: 'valid',
    });
    coordinator.cancel('gesture-interrupted');
    // An already queued scroll observation cannot revive a cancelled drag.
    state.zones[0].offset = 100;
    coordinator.requestTarget(sessionId, 3, listTarget(state, registrations));
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'idle',
      candidate: null,
      displayValue: value,
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'cancelled',
        reason: 'gesture-interrupted',
      }),
    );
    coordinator.dispose();
  });

  it('cancels a release outside the viewport without proposing its last candidate', () => {
    const { state, registrations, value } = fixture();
    const onChange = jest.fn();
    const onDragEnd = jest.fn();
    const coordinator = new DndSessionCoordinator({
      value,
      onChange,
      onDragEnd,
    });
    const sessionId = coordinator.start('a')!;
    state.pointer.y = 205;
    coordinator.requestTarget(sessionId, 0, listTarget(state, registrations));
    state.pointer.y = 241;
    coordinator.release(sessionId, 1, listTarget(state, registrations));
    expect(coordinator.getSnapshot().phase).toBe('idle');
    expect(onChange).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'cancelled',
        reason: 'outside-zones',
      }),
    );
    coordinator.dispose();
  });

  it.each(['viewport-revision', 'registration-revision', 'layout-version'])(
    'rejects a stale %s snapshot',
    stale => {
      const { state, registrations, registration } = fixture();
      state.pointer.y = 205;
      if (stale === 'viewport-revision') state.zones[0].viewport.revision = 3;
      if (stale === 'registration-revision') registration.revision = 3;
      if (stale === 'layout-version') state.zones[0].layoutVersion = 2;
      expect(listTarget(state, registrations)).toBeNull();
    },
  );

  it('rejects a layout whose revision differs from its registration', () => {
    const { state, registrations, registration } = fixture();
    state.pointer.y = 205;
    registration.layout = { ...registration.layout, revision: 3 };
    expect(listTarget(state, registrations)).toBeNull();
  });

  it('uses committed thresholds when the preview has already moved the active item', () => {
    const { state, registrations, value, layoutInput } = fixture();
    const coordinator = new DndSessionCoordinator({
      value,
      onChange: jest.fn(),
    });
    const sessionId = coordinator.start('a')!;
    state.pointer.y = 205;
    coordinator.requestTarget(sessionId, 0, listTarget(state, registrations));
    const preview = coordinator.getSnapshot().displayValue!
      .zones[0] as ListLayoutZone;
    expect(preview.itemIds).toEqual(['b', 'a', 'c', 'd']);
    const previewLayout = computeListLayout({
      ...layoutInput,
      itemIds: preview.itemIds,
    });
    if (!previewLayout.valid) throw new Error('Invalid preview layout');

    state.pointer.y = 170;
    // Preview b has moved upward: its center is 62 rather than the committed 112.
    expect(computeListIndex(previewLayout, 'a', 100)).toBe(1);
    expect(listTarget(state, registrations)).toEqual(expectedTarget(0));
    coordinator.requestTarget(sessionId, 1, listTarget(state, registrations));
    expect(coordinator.getSnapshot().displayValue!.zones[0]).toMatchObject({
      itemIds: ['a', 'b', 'c', 'd'],
    });
    coordinator.dispose();
  });

  it('stops targeting after a zone is unregistered or its viewport disappears', () => {
    const { state, registrations } = fixture();
    state.pointer.y = 205;
    expect(listTarget(state, registrations)).toEqual(expectedTarget(1));
    expect(listTarget(state, new Map())).toBeNull();
    state.zones = [];
    expect(listTarget(state, registrations)).toBeNull();
  });

  it('rejects nonfinite native offsets instead of producing a guessed index', () => {
    const { state, registrations } = fixture();
    state.pointer.y = 205;
    state.zones[0].offset = NaN;
    expect(listTarget(state, registrations)).toBeNull();
  });
});
