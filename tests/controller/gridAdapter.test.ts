import type { LayoutState } from '../../src/contracts';
import type { DndDragEndEvent } from '../../src/controller/dndSession';
import type { DndProposal } from '../../src/controller/dndState';
import {
  convertGridValue,
  gridChangeOf,
  gridEndEvent,
  gridIssues,
  gridItemIndex,
  toItemLocation,
  toLayoutLocation,
} from '../../src/controller/gridAdapter';
import { layoutToGridValue } from '../../src/engine/layoutState';
import type { GridValue } from '../../src/types';

const span = { rows: 1, cols: 1 };

function home(revision?: number): GridValue<string> {
  return {
    ...(revision === undefined ? {} : { revision }),
    zones: [
      {
        id: 'page',
        strategy: 'spatial',
        rows: 2,
        columns: 4,
        items: [
          {
            id: 'p1',
            data: 'p1',
            span,
            placement: 'insert',
            position: { row: 0, col: 0 },
          },
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
}

function state(value = home(3)): LayoutState<string> {
  const converted = convertGridValue(value, null, undefined);
  if (!converted.state) throw new Error('Expected a valid conversion');
  return converted.state;
}

describe('grid adapter locations', () => {
  it('maps spatial cells both ways and ordered slots to indices', () => {
    const layout = state();
    expect(
      toItemLocation(layout, {
        kind: 'grid',
        zoneId: 'page',
        position: { row: 1, col: 3 },
      }),
    ).toEqual({
      zoneId: 'page',
      strategy: 'spatial',
      position: { row: 1, col: 3 },
    });
    expect(
      toItemLocation(layout, {
        kind: 'grid',
        zoneId: 'dock',
        position: { row: 0, col: 2 },
      }),
    ).toEqual({ zoneId: 'dock', strategy: 'ordered', index: 2 });
    expect(
      toLayoutLocation(layout, {
        zoneId: 'dock',
        strategy: 'ordered',
        index: 3,
      }),
    ).toEqual({ kind: 'grid', zoneId: 'dock', position: { row: 0, col: 3 } });
    expect(
      toLayoutLocation(layout, {
        zoneId: 'page',
        strategy: 'spatial',
        position: { row: 1, col: 1 },
      }),
    ).toEqual({ kind: 'grid', zoneId: 'page', position: { row: 1, col: 1 } });
    // Mismatched strategies, unknown zones and slots past capacity name nothing.
    expect(
      toLayoutLocation(layout, {
        zoneId: 'dock',
        strategy: 'spatial',
        position: { row: 0, col: 0 },
      }),
    ).toBeNull();
    expect(
      toLayoutLocation(layout, {
        zoneId: 'page',
        strategy: 'ordered',
        index: 0,
      }),
    ).toBeNull();
    expect(
      toLayoutLocation(layout, {
        zoneId: 'dock',
        strategy: 'ordered',
        index: 4,
      }),
    ).toBeNull();
    expect(
      toLayoutLocation(layout, {
        zoneId: 'missing',
        strategy: 'ordered',
        index: 0,
      }),
    ).toBeNull();
  });
});

describe('grid adapter values', () => {
  it('keeps a supplied revision, item data and the proposal response', () => {
    const value = home(7);
    value.proposalResponse = {
      sessionId: 's1',
      baseRevision: 6,
      accepted: true,
    };
    const converted = convertGridValue(value, null, 99);
    expect(converted.revision).toBe(7);
    expect(converted.issues).toEqual([]);
    expect(converted.state).toMatchObject({
      revision: 7,
      proposalResponse: { sessionId: 's1', baseRevision: 6, accepted: true },
    });
    expect(converted.state!.items.find(item => item.id === 'w1')!.data).toBe(
      'w1',
    );
    const back = layoutToGridValue(converted.state!);
    expect(back.zones).toEqual(value.zones);
  });

  it('synthesizes a revision for legacy values and attributes bare responses to the pending proposal', () => {
    const first = convertGridValue(home(), null, undefined);
    expect(first.revision).toBe(0);
    const sameLayout = convertGridValue(
      home(),
      { value: home(), revision: 0, state: null },
      undefined,
    );
    expect(sameLayout.revision).toBe(0);
    const moved = home();
    moved.zones[1].items.reverse();
    const changed = convertGridValue(
      moved,
      { value: home(), revision: 0, state: null },
      undefined,
    );
    expect(changed.revision).toBe(1);
    const answered = convertGridValue(
      { ...home(), proposalResponse: { sessionId: 's1', accepted: false } },
      { value: home(), revision: 4, state: null },
      4,
    );
    expect(answered.state?.proposalResponse).toEqual({
      sessionId: 's1',
      accepted: false,
      baseRevision: 4,
    });
  });

  it('reports invalid grid values with the grid API codes and no state', () => {
    const broken = home(1);
    broken.zones[0].items.push({
      id: 'p1',
      data: 'dup',
      span,
      position: { row: 1, col: 0 },
    });
    const converted = convertGridValue(broken, null, undefined);
    expect(converted.state).toBeNull();
    expect(converted.issues).toEqual([
      expect.objectContaining({ code: 'duplicate-id' }),
    ]);
    expect(
      gridIssues([
        { code: 'unknown-item', message: 'm', itemId: 'x' },
        { code: 'invalid-geometry', message: 'g', zoneId: 'z' },
      ]),
    ).toEqual([
      { code: 'invalid-structure', message: 'm', itemId: 'x' },
      { code: 'invalid-geometry', message: 'g', zoneId: 'z' },
    ]);
  });

  it('indexes the caller’s own item objects', () => {
    const value = home();
    const index = gridItemIndex(value);
    expect(index.get('d2')).toBe(value.zones[1].items[1]);
    expect(index.get('w1')).toBe(value.zones[0].items[1]);
  });
});

describe('grid adapter changes and end events', () => {
  const proposal: DndProposal<string> = {
    sessionId: 's1',
    baseRevision: 3,
    itemId: 'p1',
    from: { kind: 'grid', zoneId: 'page', position: { row: 0, col: 0 } },
    to: { kind: 'grid', zoneId: 'dock', position: { row: 0, col: 1 } },
    value: state(),
  };

  it('describes a proposal as a grid change with or without its base revision', () => {
    expect(gridChangeOf(proposal, true)).toEqual({
      sessionId: 's1',
      baseRevision: 3,
      itemId: 'p1',
      from: {
        zoneId: 'page',
        strategy: 'spatial',
        position: { row: 0, col: 0 },
      },
      to: { zoneId: 'dock', strategy: 'ordered', index: 1 },
    });
    expect(gridChangeOf(proposal, false)).not.toHaveProperty('baseRevision');
  });

  it('translates every end event outcome', () => {
    const base = { sessionId: 's1', itemId: 'p1', sourceZoneId: 'page' };
    expect(
      gridEndEvent(
        { ...base, outcome: 'unchanged' } as DndDragEndEvent<string>,
        true,
      ),
    ).toEqual({ ...base, outcome: 'unchanged' });
    expect(
      gridEndEvent(
        {
          ...base,
          outcome: 'cancelled',
          reason: 'policy-rejected',
          targetZoneId: 'dock',
          policyReason: 'full',
          error: 'why',
        },
        true,
      ),
    ).toEqual({
      ...base,
      outcome: 'cancelled',
      reason: 'policy-rejected',
      targetZoneId: 'dock',
      policyReason: 'full',
      error: 'why',
    });
    expect(
      gridEndEvent(
        {
          ...base,
          outcome: 'proposed',
          proposal,
          targetZoneId: 'dock',
          response: 'accepted',
        },
        false,
      ),
    ).toEqual({
      ...base,
      outcome: 'proposed',
      change: gridChangeOf(proposal, false),
      targetZoneId: 'dock',
      response: 'accepted',
    });
    expect(
      gridEndEvent(
        {
          ...base,
          outcome: 'proposed',
          proposal,
          targetZoneId: 'dock',
          response: 'interrupted',
          reason: 'gesture-interrupted',
        },
        true,
      ),
    ).toMatchObject({ response: 'interrupted', reason: 'gesture-interrupted' });
  });
});
