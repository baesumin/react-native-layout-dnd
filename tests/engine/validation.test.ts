import {
  validatePackInput,
  validateValue,
  validateZone,
} from '../../src/engine/validation';
import type {
  GridItem,
  GridValue,
  GridZone,
  PackInput,
  PositionedItem,
  SpatialZone,
  ValidationResult,
} from '../../src/types';

function item(id: string, row = 0, col = 0): PositionedItem<unknown> {
  return {
    id,
    span: { rows: 1, cols: 1 },
    position: { row, col },
    data: undefined,
  };
}

function spatial(items: PositionedItem<unknown>[] = []): SpatialZone<unknown> {
  return { id: 'home', rows: 4, columns: 4, strategy: 'spatial', items };
}

function codes(result: ValidationResult) {
  return result.valid ? [] : result.issues.map(issue => issue.code);
}

describe('validateValue and validateZone', () => {
  it.each([null, '', 'nearest', 1, {}, []])(
    'rejects invalid explicit placement: %p',
    placement => {
      const zone = spatial([
        { ...item('A'), placement } as PositionedItem<unknown>,
      ]);
      expect(validateZone(zone)).toMatchObject({
        valid: false,
        issues: [{ code: 'invalid-placement', zoneId: 'home', itemId: 'A' }],
      });
      expect(
        codes(
          validatePackInput({
            items: zone.items,
            rows: 4,
            columns: 4,
            searchBudget: 10,
          }),
        ),
      ).toEqual(['invalid-placement']);
    },
  );

  it.each([undefined, 'insert', 'exchange'] as const)(
    'accepts caller-selected placement independent of item size: %s',
    placement => {
      expect(
        validateZone(
          spatial([{ ...item('A'), placement, span: { rows: 2, cols: 2 } }]),
        ),
      ).toEqual({ valid: true });
    },
  );
  it.each([null, undefined, 4, 'grid', [], { zones: null }])(
    'classifies malformed grid structure without throwing: %p',
    value => {
      expect(
        codes(validateValue(value as unknown as GridValue<unknown>)),
      ).toEqual(['invalid-structure']);
    },
  );

  it('accepts an empty grid and an empty string ID as specified', () => {
    expect(validateValue({ zones: [] })).toEqual({ valid: true });
    expect(validateZone({ ...spatial([item('')]), id: '' })).toEqual({
      valid: true,
    });
  });

  it('rejects malformed and missing entries in sparse zone and item arrays', () => {
    expect(
      codes(validateValue({ zones: new Array<GridZone<unknown>>(2) })),
    ).toEqual(['invalid-structure', 'invalid-structure']);
    expect(
      codes(validateZone(spatial(new Array<PositionedItem<unknown>>(2)))),
    ).toEqual(['invalid-structure', 'invalid-structure']);
  });

  it('uses independent global namespaces for zone IDs and item IDs', () => {
    const value: GridValue<unknown> = {
      zones: [
        spatial([item('home')]),
        { ...spatial([item('home')]), id: 'dock' },
        { ...spatial(), id: 'dock' },
      ],
    };
    expect(validateValue(value)).toEqual({
      valid: false,
      issues: [
        expect.objectContaining({
          code: 'duplicate-id',
          zoneId: 'dock',
          itemId: 'home',
        }),
        expect.objectContaining({ code: 'duplicate-id', zoneId: 'dock' }),
      ],
    });
    expect(validateZone(spatial([item('home')]))).toEqual({ valid: true });
  });

  it.each([0, -1, 1.5, NaN, Infinity, '4', Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed dimensions without deriving bounds or overlap: %p',
    rows => {
      const zone = { ...spatial([item('A'), item('B')]), rows };
      expect(codes(validateZone(zone as GridZone<unknown>))).toEqual([
        'invalid-dimension',
      ]);
    },
  );

  it.each([
    undefined,
    null,
    [],
    { rows: 0, cols: 1 },
    { rows: 1, cols: Infinity },
    { rows: Number.MAX_SAFE_INTEGER + 1, cols: 1 },
  ])(
    'classifies malformed span without derivative geometry issues: %p',
    span => {
      const malformed = { ...item('A', -1), span } as PositionedItem<unknown>;
      expect(codes(validateZone(spatial([malformed, item('B')])))).toEqual([
        'invalid-span',
      ]);
    },
  );

  it.each([
    undefined,
    null,
    [],
    { row: 0.5, col: 0 },
    { row: 0, col: Infinity },
    { row: Number.MAX_SAFE_INTEGER + 1, col: 0 },
  ])(
    'classifies malformed position without derivative bounds: %p',
    position => {
      const malformed = { ...item('A'), position } as PositionedItem<unknown>;
      expect(codes(validateZone(spatial([malformed, item('B')])))).toEqual([
        'invalid-position',
      ]);
    },
  );

  it('classifies negative integers and valid rectangles outside bounds separately', () => {
    const zone = spatial([
      item('negative-row', -1, 0),
      item('negative-col', 0, -1),
      item('past-end', 4, 0),
      { ...item('oversized'), span: { rows: 5, cols: 1 } },
    ]);
    expect(codes(validateZone(zone))).toEqual([
      'out-of-bounds',
      'out-of-bounds',
      'out-of-bounds',
      'out-of-bounds',
    ]);
  });

  it('allows edge contact and reports rectangle overlap deterministically', () => {
    const first = { ...item('A'), span: { rows: 2, cols: 2 } };
    expect(
      validateZone(spatial([first, item('B', 0, 2), item('C', 2)])),
    ).toEqual({
      valid: true,
    });
    const value = spatial([first, item('B', 1, 1), item('C', 1, 1)]);
    const validation = validateZone(value);
    expect(codes(validation)).toEqual(['overlap', 'overlap', 'overlap']);
    expect(validateZone(value)).toEqual(validation);
  });

  it('checks safe integer boundary coordinates without a cell matrix', () => {
    const zone = {
      ...spatial([
        {
          ...item('A'),
          span: { rows: 1, cols: Number.MAX_SAFE_INTEGER - 1 },
        },
        item('B', 0, Number.MAX_SAFE_INTEGER - 1),
      ]),
      rows: Number.MAX_SAFE_INTEGER,
      columns: Number.MAX_SAFE_INTEGER,
    };
    expect(validateZone(zone)).toEqual({ valid: true });
    zone.items[1].position.col = Number.MAX_SAFE_INTEGER;
    expect(codes(validateZone(zone))).toEqual(['out-of-bounds']);
  });

  it('requires itemSpan on empty ordered zones but permits zero capacity', () => {
    const zone = {
      id: 'dock',
      rows: 1,
      columns: 1,
      strategy: 'ordered' as const,
      items: [],
    };
    expect(codes(validateZone(zone as unknown as GridZone<unknown>))).toEqual([
      'missing-item-span',
    ]);
    expect(
      codes(
        validateZone({
          ...zone,
          itemSpan: null,
        } as unknown as GridZone<unknown>),
      ),
    ).toEqual(['invalid-span']);
    expect(validateZone({ ...zone, itemSpan: { rows: 2, cols: 2 } })).toEqual({
      valid: true,
    });
  });

  it('rejects nonempty zero-capacity and over-capacity ordered zones', () => {
    const shared = {
      id: 'dock',
      rows: 1,
      columns: 3,
      strategy: 'ordered' as const,
      itemSpan: { rows: 1, cols: 2 },
    };
    const items = [
      { id: 'A', span: shared.itemSpan, data: null },
      { id: 'B', span: shared.itemSpan, data: null },
    ];
    expect(codes(validateZone({ ...shared, items }))).toEqual([
      'capacity-exceeded',
    ]);
    expect(
      codes(validateZone({ ...shared, columns: 1, items: items.slice(0, 1) })),
    ).toEqual(['capacity-exceeded']);
  });

  it('validates ordered item spans and ignores irrelevant supplied positions', () => {
    const zone = {
      id: 'dock',
      rows: 2,
      columns: 4,
      strategy: 'ordered' as const,
      itemSpan: { rows: 1, cols: 2 },
      items: [item('A')],
    };
    expect(codes(validateZone(zone))).toEqual(['span-mismatch']);
    expect(
      validateZone({
        ...zone,
        items: [{ ...item('A', -1), span: zone.itemSpan }],
      }),
    ).toEqual({ valid: true });
  });

  it('does not read, inspect or serialize item data', () => {
    const opaqueItem = item('A');
    Object.defineProperty(opaqueItem, 'data', {
      get() {
        throw new Error('Data was inspected');
      },
    });
    expect(validateZone(spatial([opaqueItem]))).toEqual({ valid: true });
    expect(
      validatePackInput({
        items: [opaqueItem],
        rows: 1,
        columns: 1,
        searchBudget: 1,
      }),
    ).toEqual({ valid: true });
  });

  it('validates optional proposal response shape without altering it', () => {
    const value = {
      zones: [],
      proposalResponse: Object.freeze({
        sessionId: 'session',
        accepted: false,
      }),
    };
    expect(validateValue(value)).toEqual({ valid: true });
    expect(value.proposalResponse).toEqual({
      sessionId: 'session',
      accepted: false,
    });
    expect(
      codes(
        validateValue({
          zones: [],
          proposalResponse: null,
        } as unknown as GridValue<unknown>),
      ),
    ).toEqual(['invalid-structure']);
  });
});

describe('validatePackInput', () => {
  it('only validates input shape, leaving oversized valid spans to the packer', () => {
    expect(
      validatePackInput({
        rows: 1,
        columns: 1,
        searchBudget: 1,
        items: [{ id: 'A', span: { rows: 3, cols: 2 }, data: null }],
      }),
    ).toEqual({ valid: true });
  });

  it.each([null, [], 0, 'input'])('rejects malformed pack input: %p', input => {
    expect(
      codes(validatePackInput(input as unknown as PackInput<unknown>)),
    ).toEqual(['invalid-structure']);
  });

  it.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid search budget: %p',
    searchBudget => {
      expect(
        codes(
          validatePackInput({ items: [], rows: 1, columns: 1, searchBudget }),
        ),
      ).toEqual(['invalid-budget']);
    },
  );

  it('shares item error classification with zone and value validation', () => {
    const malformed = {
      ...item('A'),
      span: null,
    } as unknown as PositionedItem<unknown>;
    const items = [malformed, item('A', 0, 1)];
    const expected = ['invalid-span', 'duplicate-id'];
    expect(codes(validateZone(spatial(items)))).toEqual(expected);
    expect(codes(validateValue({ zones: [spatial(items)] }))).toEqual(expected);
    expect(
      codes(validatePackInput({ items, rows: 4, columns: 4, searchBudget: 1 })),
    ).toEqual(expected);
  });

  it('rejects sparse item arrays without throwing', () => {
    expect(
      codes(
        validatePackInput({
          items: new Array<GridItem<unknown>>(1),
          rows: 1,
          columns: 1,
          searchBudget: 1,
        }),
      ),
    ).toEqual(['invalid-structure']);
  });
});
