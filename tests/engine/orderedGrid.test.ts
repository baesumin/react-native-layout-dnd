import type {
  GridLayoutZone,
  LayoutState,
  LayoutValidationResult,
} from '../../src/contracts';
import { respondToDndProposal } from '../../src/controller/dndState';
import {
  orderedSlots,
  packOrderedPlacements,
  slotIndex,
  slotPosition,
} from '../../src/engine/gridPlacements';
import { computeLayoutMove } from '../../src/engine/layoutMove';
import {
  fromGridValue,
  toGridValue,
  validateLayoutState,
} from '../../src/engine/layoutState';
import type { GridValue } from '../../src/types';

const span = { rows: 1, cols: 1 };

/** A 2 × 4 page of apps beside a one-row dock that holds three of four slots. */
function home(dockIds = ['d1', 'd2', 'd3']): LayoutState<string> {
  const pageIds = ['p1', 'p2', 'w1'];
  return {
    revision: 0,
    items: [...pageIds, ...dockIds].map(id => ({ id, data: id })),
    zones: [
      {
        id: 'page',
        kind: 'grid',
        rows: 2,
        columns: 4,
        placements: [
          {
            itemId: 'p1',
            position: { row: 0, col: 0 },
            span,
            placement: 'insert',
          },
          {
            itemId: 'p2',
            position: { row: 0, col: 1 },
            span,
            placement: 'insert',
          },
          {
            itemId: 'w1',
            position: { row: 0, col: 2 },
            span: { rows: 2, cols: 2 },
            placement: 'exchange',
          },
        ],
      },
      dock(dockIds),
    ],
  };
}

function dock(ids: string[], columns = 4): GridLayoutZone {
  return {
    id: 'dock',
    kind: 'grid',
    rows: 1,
    columns,
    itemSpan: span,
    placements: ids.map((itemId, index) => ({
      itemId,
      position: { row: 0, col: index },
      span,
      placement: 'insert',
    })),
  };
}

function codes(result: LayoutValidationResult) {
  return result.valid ? [] : result.issues.map(issue => issue.code);
}

function order(value: LayoutState<string>, zoneId = 'dock') {
  const zone = value.zones.find(entry => entry.id === zoneId);
  if (!zone || zone.kind !== 'grid') throw new Error('Expected a grid zone');
  return zone.placements.map(
    placement =>
      `${placement.itemId}@${placement.position.row},${placement.position.col}`,
  );
}

const at = (row: number, col: number, zoneId = 'dock') => ({
  kind: 'grid' as const,
  zoneId,
  position: { row, col },
});

describe('ordered slots', () => {
  it('maps indices to reading-order slots and back', () => {
    const itemSpan = { rows: 2, cols: 2 };
    const slots = orderedSlots({ rows: 4, columns: 5 }, itemSpan);
    expect(slots).toEqual({ perRow: 2, rows: 2 });
    expect(slotPosition(3, itemSpan, slots.perRow)).toEqual({ row: 2, col: 2 });
    expect(slotIndex({ row: 2, col: 2 }, itemSpan, slots.perRow)).toBe(3);
    // Not a slot origin, or beyond the last slot of a row.
    expect(slotIndex({ row: 1, col: 2 }, itemSpan, slots.perRow)).toBeNull();
    expect(slotIndex({ row: 0, col: 4 }, itemSpan, slots.perRow)).toBeNull();
    expect(slotIndex({ row: 0, col: 0 }, itemSpan, 0)).toBeNull();
  });

  it('reuses placement objects whose slot did not change', () => {
    const before = dock(['a', 'b', 'c']).placements;
    const packed = packOrderedPlacements(
      [before[0], before[2], before[1]],
      span,
      4,
      before,
    );
    expect(packed[0]).toBe(before[0]);
    expect(packed[1]).not.toBe(before[2]);
    expect(packed.map(item => item.position.col)).toEqual([0, 1, 2]);
  });
});

describe('ordered grid validation', () => {
  it('accepts reading-order placements within capacity', () => {
    expect(validateLayoutState(home())).toEqual({ valid: true });
    expect(validateLayoutState(home([]))).toEqual({ valid: true });
  });

  it('rejects an invalid itemSpan, foreign spans, gaps and overflow', () => {
    const badSpan = home();
    (badSpan.zones[1] as GridLayoutZone).itemSpan = { rows: 0, cols: 1 };
    expect(codes(validateLayoutState(badSpan))).toEqual(['invalid-span']);

    const widget = home();
    (widget.zones[1] as GridLayoutZone).placements[1] = {
      itemId: 'd2',
      position: { row: 0, col: 1 },
      span: { rows: 1, cols: 2 },
    };
    expect(codes(validateLayoutState(widget))).toContain('span-mismatch');

    const gap = home();
    (gap.zones[1] as GridLayoutZone).placements[2] = {
      itemId: 'd3',
      position: { row: 0, col: 3 },
      span,
    };
    expect(codes(validateLayoutState(gap))).toEqual(['invalid-position']);

    const overflow = home(['d1', 'd2', 'd3', 'd4', 'd5']);
    const zone = overflow.zones[1] as GridLayoutZone;
    zone.placements[4] = {
      ...zone.placements[4],
      position: { row: 0, col: 0 },
    };
    expect(codes(validateLayoutState(overflow))).toContain('capacity-exceeded');
  });
});

describe('ordered grid conversions', () => {
  const gridValue: GridValue<string> = {
    revision: 2,
    zones: [
      {
        id: 'page',
        strategy: 'spatial',
        rows: 2,
        columns: 4,
        items: [
          { id: 'p1', data: 'p1', span, position: { row: 0, col: 0 } },
          {
            id: 'w1',
            data: 'w1',
            span: { rows: 2, cols: 2 },
            placement: 'exchange',
            position: { row: 0, col: 2 },
          },
        ],
      },
      {
        id: 'dock',
        strategy: 'ordered',
        rows: 1,
        columns: 4,
        itemSpan: span,
        items: [
          { id: 'd1', data: 'd1', span, placement: 'insert' },
          { id: 'd2', data: 'd2', span, placement: 'insert' },
        ],
      },
    ],
  };

  it('keeps the ordered strategy through a round trip', () => {
    const converted = fromGridValue(gridValue);
    if (!converted.valid) throw new Error('Expected a layout state');
    expect(converted.value.zones[1]).toMatchObject({
      kind: 'grid',
      itemSpan: span,
      placements: [
        { itemId: 'd1', position: { row: 0, col: 0 } },
        { itemId: 'd2', position: { row: 0, col: 1 } },
      ],
    });
    const back = toGridValue(converted.value);
    if (!back.valid) throw new Error('Expected a grid value');
    expect(back.value).toEqual(gridValue);
  });
});

describe('ordered grid moves', () => {
  it('reorders inside the dock by inserting at the addressed slot', () => {
    const result = computeLayoutMove({
      value: home(),
      itemId: 'd1',
      to: at(0, 2),
    });
    if (result.status !== 'ok') throw new Error('Expected a move');
    expect(order(result.value)).toEqual(['d2@0,0', 'd3@0,1', 'd1@0,2']);
    expect(result).toMatchObject({
      changed: true,
      from: at(0, 0),
      to: at(0, 2),
      value: { revision: 1 },
    });
    expect(validateLayoutState(result.value)).toEqual({ valid: true });
  });

  it('treats the item’s own slot as unchanged', () => {
    const value = home();
    const result = computeLayoutMove({ value, itemId: 'd2', to: at(0, 1) });
    expect(result).toMatchObject({ status: 'ok', changed: false });
    if (result.status !== 'ok') throw new Error('Expected a move');
    expect(result.value).toBe(value);
  });

  it('inserts a page app into the dock and closes the dock gap when one leaves', () => {
    const entered = computeLayoutMove({
      value: home(),
      itemId: 'p2',
      to: at(0, 1),
    });
    if (entered.status !== 'ok') throw new Error('Expected a move');
    expect(order(entered.value)).toEqual([
      'd1@0,0',
      'p2@0,1',
      'd2@0,2',
      'd3@0,3',
    ]);
    expect(order(entered.value, 'page')).toEqual(['p1@0,0', 'w1@0,2']);

    const left = computeLayoutMove({
      value: home(),
      itemId: 'd1',
      to: at(1, 0, 'page'),
    });
    if (left.status !== 'ok') throw new Error('Expected a move');
    expect(order(left.value)).toEqual(['d2@0,0', 'd3@0,1']);
    expect(order(left.value, 'page')).toContain('d1@1,0');
    expect(validateLayoutState(left.value)).toEqual({ valid: true });
  });

  it('rejects a full dock and a foreign span as impossible', () => {
    const full = computeLayoutMove({
      value: home(['d1', 'd2', 'd3', 'd4']),
      itemId: 'p1',
      to: at(0, 3),
    });
    expect(full).toEqual({ status: 'impossible', attempts: 0 });
    const widget = computeLayoutMove({
      value: home(),
      itemId: 'w1',
      to: at(0, 3),
    });
    expect(widget).toEqual({ status: 'impossible', attempts: 0 });
  });

  it('reports a target beyond the slots after removal or off the slot grid', () => {
    const beyond = computeLayoutMove({
      value: home(['d1']),
      itemId: 'p1',
      to: at(0, 3),
    });
    expect(beyond).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-position', zoneId: 'dock', itemId: 'p1' }],
    });
    const wide = home();
    wide.zones[1] = {
      ...dock(['d1'], 4),
      rows: 2,
      itemSpan: { rows: 2, cols: 2 },
      placements: [
        {
          itemId: 'd1',
          position: { row: 0, col: 0 },
          span: { rows: 2, cols: 2 },
        },
      ],
    };
    wide.items = wide.items.filter(
      item => item.id === 'd1' || !item.id.startsWith('d'),
    );
    const offGrid = computeLayoutMove({
      value: wide,
      itemId: 'w1',
      to: at(0, 1),
    });
    expect(offGrid).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-position' }],
    });
  });

  it('is approved atomically and rejects a changed itemSpan', () => {
    const value = home();
    const result = computeLayoutMove({ value, itemId: 'd1', to: at(0, 2) });
    if (result.status !== 'ok') throw new Error('Expected a move');
    const proposal = {
      sessionId: 's',
      baseRevision: 0,
      itemId: 'd1',
      from: result.from,
      to: result.to,
      value: result.value,
    };
    expect(respondToDndProposal(value, proposal, true).status).toBe('accepted');
    const tampered = {
      ...proposal,
      value: {
        ...result.value,
        zones: result.value.zones.map(zone =>
          zone.id === 'dock' && zone.kind === 'grid'
            ? { ...zone, itemSpan: { rows: 1, cols: 2 } }
            : zone,
        ),
      },
    };
    expect(respondToDndProposal(value, tampered, true)).toMatchObject({
      status: 'invalid',
    });
  });
});
