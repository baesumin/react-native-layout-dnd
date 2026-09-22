import type {
  GridLayoutZone,
  GridPlacement,
  LayoutState,
  ListLayoutZone,
} from '../../src/contracts';
import {
  computeLayoutMove,
  computeValidatedLayoutMove,
} from '../../src/engine/layoutMove';
import type { LayoutMoveInput } from '../../src/engine/layoutMove';
import { validateLayoutState } from '../../src/engine/layoutState';
import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';

function state(): LayoutState<object> {
  return {
    revision: 5,
    items: ['a', 'b', 'c', 'd', 'g'].map(id => ({ id, data: { id } })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['a', 'b', 'c'],
      },
      { id: 'target', kind: 'list', orientation: 'horizontal', itemIds: ['d'] },
      { id: 'empty', kind: 'list', orientation: 'vertical', itemIds: [] },
      {
        id: 'grid',
        kind: 'grid',
        columns: 3,
        rows: 4,
        placements: [
          {
            itemId: 'g',
            span: { rows: 2, cols: 1 },
            position: { row: 1, col: 2 },
          },
        ],
      },
    ],
  };
}

function move(value = state(), index = 2, zoneId = 'source') {
  return computeLayoutMove({
    value,
    itemId: 'b',
    to: { kind: 'list', zoneId, index },
  });
}

describe('computeLayoutMove', () => {
  it.each([
    [0, ['b', 'a', 'c']],
    [2, ['a', 'c', 'b']],
  ])('reorders with an index after removal: %p', (index, itemIds) => {
    const value = state();
    const result = move(value, index as number);
    expect(result).toMatchObject({
      status: 'ok',
      changed: true,
      attempts: 0,
      from: { kind: 'list', zoneId: 'source', index: 1 },
      to: { kind: 'list', zoneId: 'source', index },
      value: { revision: 6 },
    });
    if (result.status !== 'ok') throw new Error('Expected move');
    expect((result.value.zones[0] as ListLayoutZone).itemIds).toEqual(itemIds);
    expect((value.zones[0] as ListLayoutZone).itemIds).toEqual(['a', 'b', 'c']);
    expect(result.value.zones[1]).toBe(value.zones[1]);
    expect(result.value.zones[3]).toBe(value.zones[3]);
    expect(result.value.items).toBe(value.items);
    expect(validateLayoutState(result.value)).toEqual({ valid: true });
  });

  it.each([0, 1])(
    'moves between vertical and horizontal lists atomically at index %p',
    index => {
      const value = state();
      const result = move(value, index, 'target');
      if (result.status !== 'ok') throw new Error('Expected move');
      expect(result.changed).toBe(true);
      expect(result.value.revision).toBe(6);
      expect((result.value.zones[0] as ListLayoutZone).itemIds).toEqual([
        'a',
        'c',
      ]);
      expect((result.value.zones[1] as ListLayoutZone).itemIds).toEqual(
        index === 0 ? ['b', 'd'] : ['d', 'b'],
      );
      expect((value.zones[0] as ListLayoutZone).itemIds).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect((value.zones[1] as ListLayoutZone).itemIds).toEqual(['d']);
      expect(result.value.items).toBe(value.items);
      expect(validateLayoutState(result.value)).toEqual({ valid: true });
    },
  );

  it('exposes a validated entry that skips only the baseline pass', () => {
    const value = state();
    const input: LayoutMoveInput<object> = {
      value,
      itemId: 'b',
      to: { kind: 'list', zoneId: 'target', index: 1 },
    };
    expect(computeValidatedLayoutMove(input)).toEqual(computeLayoutMove(input));

    const duplicated: LayoutState<object> = {
      ...value,
      items: [...value.items, value.items[0]!],
    };
    expect(computeLayoutMove({ ...input, value: duplicated })).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'duplicate-id' })],
    });
    // The candidate itself is still validated by the internal entry.
    const result = computeValidatedLayoutMove({ ...input, value: duplicated });
    expect(result.status).toBe('invalid');
  });

  it('inserts into an empty target and removes the final source item', () => {
    const value = state();
    const result = computeLayoutMove({
      value,
      itemId: 'd',
      to: { kind: 'list', zoneId: 'empty', index: 0 },
    });
    if (result.status !== 'ok') throw new Error('Expected move');
    expect((result.value.zones[1] as ListLayoutZone).itemIds).toEqual([]);
    expect((result.value.zones[2] as ListLayoutZone).itemIds).toEqual(['d']);
  });

  it('retains value identity and revision on a no-op even at maximum revision', () => {
    const value = { ...state(), revision: Number.MAX_SAFE_INTEGER };
    const result = move(value, 1);
    expect(result).toMatchObject({ status: 'ok', changed: false });
    if (result.status !== 'ok') throw new Error('Expected no-op');
    expect(result.value).toBe(value);
    expect(move(value, 0)).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-revision' }],
    });
  });

  it('never reads or clones opaque data and accepts frozen snapshots', () => {
    const value = state();
    value.items[1] = {
      id: 'b',
      get data(): object {
        throw new Error('Do not read data');
      },
    };
    Object.freeze(value.items[1]);
    Object.freeze(value.items);
    for (const zone of value.zones) {
      if (zone.kind === 'list') Object.freeze(zone.itemIds);
      Object.freeze(zone);
    }
    Object.freeze(value.zones);
    Object.freeze(value);
    expect(move(value, 1, 'target')).toMatchObject({ status: 'ok' });
  });

  it.each([-1, 3, 1.5, NaN, Infinity, '1'])(
    'rejects invalid same-list index %p without partial mutation',
    index => {
      const value = state();
      const before = JSON.stringify(value);
      expect(move(value, index as number)).toMatchObject({
        status: 'invalid',
        issues: [{ code: 'invalid-position' }],
      });
      expect(JSON.stringify(value)).toBe(before);
    },
  );

  it('rejects an out-of-range cross-list destination before removing the source', () => {
    const value = state();
    expect(move(value, 2, 'target')).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-position' }],
    });
    expect((value.zones[0] as ListLayoutZone).itemIds).toContain('b');
  });

  it.each([null, undefined, [], 4])(
    'rejects malformed move input %p',
    value => {
      expect(
        computeLayoutMove(value as unknown as LayoutMoveInput<object>),
      ).toMatchObject({
        status: 'invalid',
        issues: [{ code: 'invalid-structure' }],
      });
    },
  );

  it.each([
    { itemId: 'missing' },
    { itemId: 2 },
    { to: null },
    { to: { zoneId: 2, kind: 'list', index: 0 } },
    { to: { zoneId: 'missing', kind: 'list', index: 0 } },
    { to: { zoneId: 'source', kind: 'grid', position: { row: 0, col: 0 } } },
  ])('rejects missing items/zones or malformed targets: %p', overrides => {
    expect(
      computeLayoutMove({
        value: state(),
        itemId: 'b',
        to: { kind: 'list', zoneId: 'source', index: 0 },
        ...overrides,
      } as LayoutMoveInput<object>),
    ).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-structure' }],
    });
  });

  it('validates the whole baseline including unrelated grids and duplicate references', () => {
    const duplicate = state();
    (duplicate.zones[1] as ListLayoutZone).itemIds.push('b');
    expect(move(duplicate)).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'duplicate-reference', itemId: 'b' }],
    });
    const invalidGrid = state();
    const invalidZone = invalidGrid.zones[3];
    if (invalidZone.kind !== 'grid') throw new Error('Expected grid');
    invalidZone.placements[0].position.row = 10;
    expect(move(invalidGrid)).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'out-of-bounds' }],
    });
  });
});

function grid(value: LayoutState<unknown>, zoneId = 'grid'): GridLayoutZone {
  const zone = value.zones.find(entry => entry.id === zoneId);
  if (zone?.kind !== 'grid') throw new Error('Expected grid');
  return zone;
}

function placement(
  itemId: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
  behavior: 'insert' | 'exchange' = 'exchange',
): GridPlacement {
  return {
    itemId,
    position: { row, col },
    span: { rows, cols },
    placement: behavior,
  };
}

function gridState(
  placements: GridPlacement[],
  rows: number,
  columns: number,
  incoming = false,
): LayoutState<object> {
  return {
    revision: 7,
    items: [
      ...placements.map(item => item.itemId),
      ...(incoming ? ['X'] : []),
    ].map(id => ({ id, data: { id } })),
    zones: [
      { id: 'grid', kind: 'grid', rows, columns, placements },
      {
        id: 'list',
        kind: 'list',
        orientation: 'vertical',
        itemIds: incoming ? ['X'] : [],
      },
    ],
  };
}

describe('computeLayoutMove mixed grid and list moves', () => {
  it('requires explicit target geometry when a list item enters a grid', () => {
    const value = state();
    const before = JSON.stringify(value);
    expect(
      computeLayoutMove({
        value,
        itemId: 'b',
        to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
      }),
    ).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'missing-item-span', itemId: 'b', zoneId: 'grid' }],
    });
    expect(JSON.stringify(value)).toBe(before);
  });

  it('atomically inserts a list item with caller-provided span and placement while preserving opaque items', () => {
    const value = state();
    const result = computeLayoutMove({
      value,
      itemId: 'b',
      to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
      gridItem: { span: { rows: 2, cols: 2 }, placement: 'exchange' },
    });
    expect(result).toMatchObject({
      status: 'ok',
      changed: true,
      attempts: 0,
      from: { kind: 'list', zoneId: 'source', index: 1 },
      to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
    });
    if (result.status !== 'ok') throw new Error('Expected transfer');
    expect(grid(result.value).placements).toContainEqual({
      itemId: 'b',
      position: { row: 0, col: 0 },
      span: { rows: 2, cols: 2 },
      placement: 'exchange',
    });
    expect((result.value.zones[0] as ListLayoutZone).itemIds).toEqual([
      'a',
      'c',
    ]);
    expect(result.value.items).toBe(value.items);
    expect(result.value.revision).toBe(6);
    expect(result.value.zones[1]).toBe(value.zones[1]);
    expect(result.value.zones[2]).toBe(value.zones[2]);
    expect(grid(result.value).placements[0]).toBe(grid(value).placements[0]);
    expect(validateLayoutState(result.value)).toEqual({ valid: true });
  });

  it('drops the grid footprint on list entry and requires a descriptor when returning', () => {
    const value = state();
    const result = computeLayoutMove({
      value,
      itemId: 'g',
      to: { kind: 'list', zoneId: 'target', index: 1 },
    });
    if (result.status !== 'ok') throw new Error('Expected transfer');
    expect(result.from).toEqual({
      kind: 'grid',
      zoneId: 'grid',
      position: { row: 1, col: 2 },
    });
    expect(grid(result.value).placements).toEqual([]);
    expect((result.value.zones[1] as ListLayoutZone).itemIds).toEqual([
      'd',
      'g',
    ]);
    expect(result.value.items).toBe(value.items);
    expect(result.value.items.find(item => item.id === 'g')).not.toHaveProperty(
      'span',
    );
    expect(
      computeLayoutMove({
        value: result.value,
        itemId: 'g',
        to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
      }),
    ).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'missing-item-span' }],
    });
    const back = computeLayoutMove({
      value: result.value,
      itemId: 'g',
      to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
      gridItem: { span: { rows: 1, cols: 3 }, placement: 'insert' },
    });
    expect(back).toMatchObject({ status: 'ok', value: { revision: 7 } });
    if (back.status !== 'ok') throw new Error('Expected return transfer');
    expect(grid(back.value).placements[0]).toMatchObject({
      itemId: 'g',
      span: { rows: 1, cols: 3 },
      placement: 'insert',
    });
  });

  it.each([
    undefined,
    { span: { rows: 1, cols: 3 }, placement: 'insert' as const },
  ])(
    'supports cross-grid movement with inherited or explicitly converted geometry: %p',
    descriptor => {
      const value = state();
      value.zones.push({
        id: 'second-grid',
        kind: 'grid',
        rows: 4,
        columns: 4,
        placements: [],
      });
      const result = computeLayoutMove({
        value,
        itemId: 'g',
        to: {
          kind: 'grid',
          zoneId: 'second-grid',
          position: { row: 0, col: 1 },
        },
        gridItem: descriptor,
      });
      if (result.status !== 'ok') throw new Error('Expected grid transfer');
      expect(grid(result.value).placements).toEqual([]);
      expect(grid(result.value, 'second-grid').placements).toEqual([
        {
          itemId: 'g',
          position: { row: 0, col: 1 },
          span: descriptor?.span ?? { rows: 2, cols: 1 },
          ...(descriptor?.placement === undefined
            ? {}
            : { placement: descriptor.placement }),
        },
      ]);
      expect(result.value.zones[0]).toBe(value.zones[0]);
      expect(result.value.items).toBe(value.items);
      expect(validateLayoutState(result.value)).toEqual({ valid: true });
    },
  );

  it('refuses same-grid footprint changes while allowing identical geometry descriptors', () => {
    const value = state();
    const input = {
      value,
      itemId: 'g',
      to: {
        kind: 'grid' as const,
        zoneId: 'grid',
        position: { row: 0, col: 0 },
      },
    };
    expect(
      computeLayoutMove({ ...input, gridItem: { span: { rows: 1, cols: 1 } } }),
    ).toMatchObject({ status: 'invalid', issues: [{ code: 'span-mismatch' }] });
    expect(
      computeLayoutMove({ ...input, gridItem: { span: { rows: 2, cols: 1 } } }),
    ).toMatchObject({ status: 'ok' });
    expect(grid(value).placements[0].span).toEqual({ rows: 2, cols: 1 });
  });

  it('preserves same-grid no-op identity at the maximum revision and rejects overflowing changes', () => {
    const value = { ...state(), revision: Number.MAX_SAFE_INTEGER };
    const noOp = computeLayoutMove({
      value,
      itemId: 'g',
      to: { kind: 'grid', zoneId: 'grid', position: { row: 1, col: 2 } },
    });
    expect(noOp).toMatchObject({ status: 'ok', changed: false });
    if (noOp.status !== 'ok') throw new Error('Expected no-op');
    expect(noOp.value).toBe(value);
    expect(
      computeLayoutMove({
        value,
        itemId: 'g',
        to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
      }),
    ).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-revision' }],
    });
  });

  it('keeps ordinary insertion and explicit exchange priority consistent with the grid engine', () => {
    const value = gridState(
      ['A', 'B', 'C'].map((id, col) => placement(id, 0, col, 1, 1, 'insert')),
      1,
      3,
    );
    const input = {
      value,
      itemId: 'A',
      to: {
        kind: 'grid' as const,
        zoneId: 'grid',
        position: { row: 0, col: 2 },
      },
    };
    const inserted = computeLayoutMove(input);
    const exchanged = computeLayoutMove({
      ...input,
      movementPolicy: { candidateOrder: ['exchange', 'insert'] },
    });
    if (inserted.status !== 'ok' || exchanged.status !== 'ok')
      throw new Error('Expected grid moves');
    expect(
      grid(inserted.value).placements.map(item => [
        item.itemId,
        item.position.col,
      ]),
    ).toEqual([
      ['A', 2],
      ['B', 0],
      ['C', 1],
    ]);
    expect(
      grid(exchanged.value).placements.map(item => [
        item.itemId,
        item.position.col,
      ]),
    ).toEqual([
      ['A', 2],
      ['B', 1],
      ['C', 0],
    ]);
    expect(inserted.attempts).toBe(1);
    expect(exchanged.attempts).toBe(1);
  });

  it('keeps neutral and HOME policies distinct and reports the actual normalized destination', () => {
    const value = gridState(
      [
        placement('active', 0, 1, 1, 1, 'insert'),
        placement('neighbor', 0, 3, 1, 1, 'insert'),
        placement('panel', 1, 0, 4, 4),
      ],
      5,
      4,
    );
    const input = {
      value,
      itemId: 'active',
      to: {
        kind: 'grid' as const,
        zoneId: 'grid',
        position: { row: 1, col: 1 },
      },
    };
    expect(computeLayoutMove(input).status).toBe('impossible');
    const result = computeLayoutMove({
      ...input,
      movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    });
    if (result.status !== 'ok') throw new Error('Expected home normalization');
    expect(result.to).toEqual({
      kind: 'grid',
      zoneId: 'grid',
      position: { row: 4, col: 1 },
    });
    expect(
      grid(result.value).placements.map(item => [item.itemId, item.position]),
    ).toEqual([
      ['active', { row: 4, col: 1 }],
      ['neighbor', { row: 4, col: 3 }],
      ['panel', { row: 0, col: 0 }],
    ]);
    expect(validateLayoutState(result.value)).toEqual({ valid: true });
  });

  it('distinguishes insufficient search budget from full capacity without removing a list source', () => {
    const value = gridState(
      [placement('A', 0, 0, 1, 1, 'insert'), placement('panel', 0, 1)],
      1,
      3,
      true,
    );
    const before = JSON.stringify(value);
    const input = {
      value,
      itemId: 'X',
      to: {
        kind: 'grid' as const,
        zoneId: 'grid',
        position: { row: 0, col: 0 },
      },
      gridItem: { span: { rows: 1, cols: 1 }, placement: 'insert' as const },
    };
    expect(computeLayoutMove({ ...input, searchBudget: 2 })).toEqual({
      status: 'unresolved',
      attempts: 2,
    });
    const enough = computeLayoutMove({ ...input, searchBudget: 3 });
    expect(enough).toMatchObject({ status: 'ok', attempts: 3 });
    if (enough.status !== 'ok') throw new Error('Expected insertion');
    expect(
      grid(enough.value).placements.map(item => [
        item.itemId,
        item.position.col,
      ]),
    ).toEqual([
      ['A', 2],
      ['panel', 1],
      ['X', 0],
    ]);
    const full = {
      ...value,
      zones: value.zones.map(zone =>
        zone.kind === 'grid' ? { ...zone, columns: 2 } : zone,
      ),
    };
    expect(
      computeLayoutMove({ ...input, value: full, searchBudget: 100 }),
    ).toEqual({ status: 'impossible', attempts: 2 });
    expect(JSON.stringify(value)).toBe(before);
    expect((full.zones[1] as ListLayoutZone).itemIds).toEqual(['X']);
  });

  it('keeps incoming exchange origin absent and never exchanges into a list source slot', () => {
    const value = gridState([placement('A', 0, 0)], 1, 2, true);
    expect(
      computeLayoutMove({
        value,
        itemId: 'X',
        to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
        gridItem: { span: { rows: 1, cols: 1 }, placement: 'exchange' },
      }),
    ).toMatchObject({ status: 'impossible' });
    expect((value.zones[1] as ListLayoutZone).itemIds).toEqual(['X']);
    expect(grid(value).placements).toHaveLength(1);
  });

  it.each([
    { row: -1, col: 0 },
    { row: 4, col: 0 },
    { row: 0, col: 3 },
  ])(
    'returns impossible for a valid out-of-bounds target %p without a partial value',
    position => {
      const value = state();
      const result = computeLayoutMove({
        value,
        itemId: 'b',
        to: { kind: 'grid', zoneId: 'grid', position },
        gridItem: { span: { rows: 1, cols: 1 } },
      });
      expect(result).toEqual({ status: 'impossible', attempts: 0 });
      expect((value.zones[0] as ListLayoutZone).itemIds).toContain('b');
    },
  );

  it.each([
    null,
    {},
    { row: NaN, col: 0 },
    { row: 0.5, col: 0 },
    { row: 0, col: '0' },
  ])('rejects malformed grid target position %p', position => {
    expect(
      computeLayoutMove({
        value: state(),
        itemId: 'g',
        to: { kind: 'grid', zoneId: 'grid', position },
      } as LayoutMoveInput<object>),
    ).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-position' }],
    });
  });

  it.each([
    null,
    {},
    { span: { rows: 0, cols: 1 } },
    { span: { rows: 1, cols: Infinity } },
    { span: { rows: 1.5, cols: 1 } },
  ])('rejects malformed grid geometry %p', gridItem => {
    expect(
      computeLayoutMove({
        value: state(),
        itemId: 'b',
        to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
        gridItem,
      } as LayoutMoveInput<object>),
    ).toMatchObject({ status: 'invalid', issues: [{ code: 'invalid-span' }] });
  });

  it.each([
    [
      { gridItem: { span: { rows: 1, cols: 1 }, placement: 'resize' } },
      'invalid-placement',
    ],
    [{ searchBudget: null }, 'invalid-budget'],
    [{ searchBudget: 0 }, 'invalid-budget'],
    [{ searchBudget: 1.5 }, 'invalid-budget'],
    [{ movementPolicy: { candidateOrder: [] } }, 'invalid-configuration'],
    [{ movementPolicy: null }, 'invalid-configuration'],
  ])(
    'rejects invalid optional configuration before producing any candidate: %p',
    (overrides, code) => {
      expect(
        computeLayoutMove({
          value: state(),
          itemId: 'b',
          to: { kind: 'list', zoneId: 'source', index: 0 },
          ...(overrides as object),
        } as LayoutMoveInput<object>),
      ).toMatchObject({ status: 'invalid', issues: [{ code }] });
    },
  );

  it('does not read opaque data even when the spatial solver displaces neighbors in a frozen snapshot', () => {
    const value = gridState([placement('A', 0, 0, 1, 1, 'insert')], 1, 2, true);
    value.items = value.items.map(item =>
      Object.freeze({
        id: item.id,
        get data(): object {
          throw new Error('Opaque data must not be read');
        },
      }),
    );
    for (const item of grid(value).placements) {
      Object.freeze(item.span);
      Object.freeze(item.position);
      Object.freeze(item);
    }
    for (const zone of value.zones) {
      if (zone.kind === 'grid') Object.freeze(zone.placements);
      else Object.freeze(zone.itemIds);
      Object.freeze(zone);
    }
    Object.freeze(value.items);
    Object.freeze(value.zones);
    Object.freeze(value);
    const result = computeLayoutMove({
      value,
      itemId: 'X',
      to: { kind: 'grid', zoneId: 'grid', position: { row: 0, col: 0 } },
      gridItem: { span: { rows: 1, cols: 1 }, placement: 'insert' },
    });
    if (result.status !== 'ok') throw new Error('Expected insertion');
    expect(result.value.items).toBe(value.items);
    expect(
      grid(result.value).placements.map(item => [
        item.itemId,
        item.position.col,
      ]),
    ).toEqual([
      ['A', 1],
      ['X', 0],
    ]);
    expect(grid(value).placements[0].position.col).toBe(0);
  });
});
