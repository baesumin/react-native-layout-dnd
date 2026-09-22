import type { LayoutState, LayoutValidationResult } from '../../src/contracts';
import {
  fromGridValue,
  toGridValue,
  validateLayoutState,
} from '../../src/engine/layoutState';
import type { GridValue } from '../../src/types';

function mixedState(): LayoutState<unknown> {
  return {
    revision: 3,
    items: [
      { id: 'large', data: { custom: true } },
      { id: 'small', data: undefined },
      { id: 'list-item', data: null },
    ],
    zones: [
      {
        id: 'grid',
        kind: 'grid',
        rows: 3,
        columns: 7,
        placements: [
          {
            itemId: 'large',
            position: { row: 0, col: 0 },
            span: { rows: 2, cols: 3 },
            placement: 'exchange',
          },
          {
            itemId: 'small',
            position: { row: 2, col: 6 },
            span: { rows: 1, cols: 1 },
            placement: 'insert',
          },
        ],
      },
      {
        id: 'list',
        kind: 'list',
        orientation: 'horizontal',
        itemIds: ['list-item'],
      },
    ],
  };
}

function codes(result: LayoutValidationResult) {
  return result.valid ? [] : result.issues.map(issue => issue.code);
}

function gridValue(): GridValue<object> {
  return {
    zones: [
      {
        id: 'spatial',
        strategy: 'spatial',
        rows: 3,
        columns: 7,
        items: [
          {
            id: 'A',
            data: { value: 1 },
            position: { row: 1, col: 3 },
            span: { rows: 2, cols: 2 },
            placement: 'exchange',
          },
        ],
      },
      {
        id: 'ordered',
        strategy: 'ordered',
        rows: 2,
        columns: 4,
        itemSpan: { rows: 1, cols: 2 },
        items: ['B', 'C', 'D'].map(id => ({
          id,
          data: { id },
          span: { rows: 1, cols: 2 },
          placement: 'insert',
        })),
      },
    ],
  };
}

describe('validateLayoutState', () => {
  it('validates mixed spans and a genuine one-dimensional list without deriving list dimensions', () => {
    expect(validateLayoutState(mixedState())).toEqual({ valid: true });
    expect(validateLayoutState({ revision: 0, items: [], zones: [] })).toEqual({
      valid: true,
    });
  });

  it.each([null, undefined, [], 'layout', 3])(
    'rejects malformed state without throwing: %p',
    state => {
      expect(
        codes(validateLayoutState(state as unknown as LayoutState<unknown>)),
      ).toEqual(['invalid-structure']);
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects invalid revisions: %p',
    revision => {
      expect(
        codes(
          validateLayoutState({
            ...mixedState(),
            revision,
          } as LayoutState<unknown>),
        ),
      ).toEqual(['invalid-revision']);
    },
  );

  it('requires every declared item to resolve exactly once across all zones', () => {
    const state = mixedState();
    state.zones.push({
      id: 'other',
      kind: 'list',
      orientation: 'vertical',
      itemIds: ['large', 'missing', 'missing'],
    });
    state.items.push({ id: 'unused', data: {} });
    expect(codes(validateLayoutState(state))).toEqual([
      'duplicate-reference',
      'unknown-item',
      'unknown-item',
      'duplicate-reference',
      'unplaced-item',
    ]);
  });

  it('uses global item and zone ID namespaces independently', () => {
    const state = mixedState();
    state.items.push({ id: 'grid', data: undefined });
    state.zones.push({
      id: 'shared-name',
      kind: 'list',
      orientation: 'vertical',
      itemIds: ['grid'],
    });
    expect(validateLayoutState(state)).toEqual({ valid: true });
    state.items.push({ id: 'large', data: undefined });
    state.zones.push({
      id: 'list',
      kind: 'list',
      orientation: 'vertical',
      itemIds: [],
    });
    expect(codes(validateLayoutState(state))).toEqual([
      'duplicate-id',
      'duplicate-id',
    ]);
  });

  it('rejects missing and malformed array entries', () => {
    const state = { revision: 0, items: new Array(1), zones: new Array(1) };
    expect(codes(validateLayoutState(state))).toEqual([
      'invalid-structure',
      'invalid-structure',
    ]);
    expect(
      codes(
        validateLayoutState({
          revision: 0,
          items: null,
          zones: null,
        } as unknown as LayoutState<unknown>),
      ),
    ).toEqual(['invalid-structure', 'invalid-structure']);
  });

  it.each([
    { kind: 'grid', rows: 1, columns: 1, placements: null },
    { kind: 'grid', rows: 1, columns: 1, placements: [null] },
    { kind: 'list', orientation: 'vertical', itemIds: null },
    { kind: 'list', orientation: 'vertical', itemIds: [1] },
    { kind: 'ordered', rows: 1, columns: 1, itemIds: [] },
  ])('rejects malformed zone contents: %p', zone => {
    const state = {
      revision: 0,
      items: [],
      zones: [{ id: 'bad', ...zone }],
    } as unknown as LayoutState<unknown>;
    expect(codes(validateLayoutState(state))).toEqual(['invalid-structure']);
  });

  it('rejects invalid orientation independently of item order', () => {
    const state = {
      revision: 0,
      items: [],
      zones: [{ id: 'list', kind: 'list', orientation: 'both', itemIds: [] }],
    } as unknown as LayoutState<unknown>;
    expect(codes(validateLayoutState(state))).toEqual(['invalid-orientation']);
  });

  it('checks placement shape, geometry and bounds before overlap', () => {
    const state = mixedState();
    const zone = state.zones[0];
    if (zone.kind !== 'grid') throw new Error('Expected grid');
    zone.placements[1].position = { row: 1, col: 1 };
    expect(codes(validateLayoutState(state))).toEqual(['overlap']);
    zone.placements[1].position = { row: 3, col: 1 };
    expect(codes(validateLayoutState(state))).toEqual(['out-of-bounds']);
    zone.placements[1].position = { row: 0.5, col: 1 };
    zone.placements[1].span = { rows: 0, cols: 1 };
    expect(codes(validateLayoutState(state))).toEqual([
      'invalid-span',
      'invalid-position',
    ]);
  });

  it('does not multiply large dimensions or add unsafe coordinate endpoints', () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const state: LayoutState<undefined> = {
      revision: maximum,
      items: [
        { id: 'A', data: undefined },
        { id: 'B', data: undefined },
      ],
      zones: [
        {
          id: 'large',
          kind: 'grid',
          rows: maximum,
          columns: maximum,
          placements: [
            {
              itemId: 'A',
              position: { row: 0, col: 0 },
              span: { rows: 1, cols: maximum - 1 },
            },
            {
              itemId: 'B',
              position: { row: 0, col: maximum - 1 },
              span: { rows: 1, cols: 1 },
            },
          ],
        },
      ],
    };
    expect(validateLayoutState(state)).toEqual({ valid: true });
  });

  it('does not inspect application data or mutate frozen inputs', () => {
    const state = mixedState();
    for (const item of state.items) {
      Object.defineProperty(item, 'data', {
        get() {
          throw new Error('Opaque data was read');
        },
      });
      Object.freeze(item);
    }
    Object.freeze(state.items);
    Object.freeze(state.zones);
    Object.freeze(state);
    expect(validateLayoutState(state)).toEqual({ valid: true });
  });
});

describe('grid layout adapters', () => {
  it('expands ordered grids to explicit cell positions and preserves data identity', () => {
    const input = gridValue();
    const snapshot = JSON.stringify(input);
    const result = fromGridValue(input, 8);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.revision).toBe(8);
    expect(validateLayoutState(result.value)).toEqual({ valid: true });
    expect(result.value.items[0].data).toBe(input.zones[0].items[0].data);
    expect(result.value.zones[1]).toMatchObject({
      kind: 'grid',
      placements: [
        { itemId: 'B', position: { row: 0, col: 0 } },
        { itemId: 'C', position: { row: 0, col: 2 } },
        { itemId: 'D', position: { row: 1, col: 0 } },
      ],
    });
    expect(JSON.stringify(input)).toBe(snapshot);
    const output = toGridValue(result.value);
    expect(output.valid).toBe(true);
    if (!output.valid) return;
    expect(output.value.revision).toBe(8);
    expect(fromGridValue(output.value)).toMatchObject({
      valid: true,
      value: { revision: 8 },
    });
    expect(output.value.zones[0]).toEqual(input.zones[0]);
    expect(output.value.zones[1]).toEqual(input.zones[1]);
    expect(output.value.zones[0].items[0].data).toBe(
      input.zones[0].items[0].data,
    );
    expect(output.value.zones[0].items[0].span).not.toBe(
      input.zones[0].items[0].span,
    );
  });

  it('uses revision zero by default and rejects invalid revisions and grid inputs', () => {
    expect(fromGridValue({ zones: [] })).toEqual({
      valid: true,
      value: { revision: 0, items: [], zones: [] },
    });
    expect(fromGridValue({ zones: [] }, -1)).toMatchObject({
      valid: false,
      issues: [{ code: 'invalid-revision' }],
    });
    expect(fromGridValue(null as unknown as GridValue<unknown>)).toMatchObject({
      valid: false,
      issues: [{ code: 'invalid-structure' }],
    });
  });

  it('rejects list export explicitly and validates the complete input first', () => {
    expect(toGridValue(mixedState())).toMatchObject({
      valid: false,
      issues: [{ code: 'unsupported-zone', zoneId: 'list' }],
    });
    const state = mixedState();
    state.items.push({ id: 'unused', data: undefined });
    expect(toGridValue(state)).toMatchObject({
      valid: false,
      issues: [{ code: 'unplaced-item' }],
    });
  });
});
