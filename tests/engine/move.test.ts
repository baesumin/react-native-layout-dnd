import { computeMove } from '../../src/engine/move';
import { hasSameLayout } from '../../src/engine/sameLayout';
import * as validation from '../../src/engine/validation';
import { validateValue } from '../../src/engine/validation';
import type {
  GridDiagnosticEvent,
  GridValue,
  OrderedZone,
  PositionedItem,
  SpatialZone,
} from '../../src/types';

function board(lines: string[], id = 'home'): SpatialZone<string> {
  const positionsById = new Map<string, { row: number; col: number }[]>();
  lines.forEach((line, row) =>
    [...line].forEach((name, col) => {
      if (name === '.') return;
      const positions = positionsById.get(name) ?? [];
      positions.push({ row, col });
      positionsById.set(name, positions);
    }),
  );
  return {
    id,
    strategy: 'spatial',
    rows: lines.length,
    columns: lines[0].length,
    items: [...positionsById].map(([name, positions]) => ({
      id: name,
      data: name,
      position: positions[0],
      span: {
        rows: Math.max(...positions.map(p => p.row)) - positions[0].row + 1,
        cols: Math.max(...positions.map(p => p.col)) - positions[0].col + 1,
      },
    })),
  };
}

function ordered(ids: string[], id = 'dock', columns = 4): OrderedZone<string> {
  return {
    id,
    strategy: 'ordered',
    rows: 1,
    columns,
    itemSpan: { rows: 1, cols: 1 },
    items: ids.map(name => ({
      id: name,
      placement: 'insert',
      data: name,
      span: { rows: 1, cols: 1 },
    })),
  };
}

function cells(zone: SpatialZone<string>): string[] {
  const result = Array.from({ length: zone.rows }, () =>
    Array<string>(zone.columns).fill('.'),
  );
  for (const item of zone.items) {
    for (
      let row = item.position.row;
      row < item.position.row + item.span.rows;
      row++
    ) {
      for (
        let col = item.position.col;
        col < item.position.col + item.span.cols;
        col++
      ) {
        expect(result[row][col]).toBe('.');
        result[row][col] = item.id;
      }
    }
  }
  return result.map(row => row.join(''));
}

describe('optional move diagnostics', () => {
  const input = () => ({
    value: { zones: [board(['AB..'])] },
    itemId: 'A',
    to: {
      zoneId: 'home',
      strategy: 'spatial' as const,
      position: { row: 0, col: 2 },
    },
    searchBudget: 10,
  });
  const performance = (
    globalThis as typeof globalThis & { performance: { now(): number } }
  ).performance;

  afterEach(() => jest.restoreAllMocks());

  it('does no timing when omitted and measures the existing validations exactly once when enabled', () => {
    let clockMs = 0;
    const clock = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => clockMs++);
    const validate = jest.spyOn(validation, 'validateValue');
    const moveInput = input();
    const expected = computeMove(moveInput);
    expect(clock).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(2);
    validate.mockClear();
    const events: GridDiagnosticEvent[] = [];
    expect(
      computeMove(moveInput, event => {
        events.push(event);
        clockMs += 1000; // An expensive observer must not inflate any measured duration.
      }),
    ).toEqual(expected);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      {
        type: 'timing',
        name: 'input-validation',
        status: 'valid',
        durationMs: 1,
      },
      {
        type: 'timing',
        name: 'candidate-validation',
        status: 'valid',
        durationMs: 1,
      },
      {
        type: 'timing',
        name: 'compute-move',
        status: 'ok',
        attempts: 0,
        durationMs: 5,
      },
    ]);
  });

  it('isolates observer exceptions and payload edits from the returned candidate', () => {
    const moveInput = input();
    const expected = computeMove(moveInput);
    let count = 0;
    const observed = computeMove(moveInput, event => {
      count++;
      if (event.type === 'timing')
        event.status = 'observer changed this scalar';
      throw new Error('Observer failed');
    });
    expect(observed).toEqual(expected);
    expect(count).toBe(3);
    expect(moveInput.value.zones[0].items[0].position).toEqual({
      row: 0,
      col: 0,
    });
  });

  it('reports only stages that ran when validation fails or a move is impossible', () => {
    const events: GridDiagnosticEvent[] = [];
    const invalidInput = {
      ...input(),
      value: null as unknown as GridValue<string>,
    };
    expect(
      computeMove(invalidInput, event => events.push(event)),
    ).toMatchObject({ status: 'invalid' });
    expect(events.map(event => event.name)).toEqual([
      'input-validation',
      'compute-move',
    ]);
    expect(events[0]).toMatchObject({ status: 'invalid' });
    events.length = 0;
    const moveInput = input();
    moveInput.to.position.col = 100;
    expect(computeMove(moveInput, event => events.push(event))).toEqual({
      status: 'impossible',
      attempts: 0,
    });
    expect(events.map(event => event.name)).toEqual([
      'input-validation',
      'compute-move',
    ]);
    expect(events[1]).toMatchObject({ status: 'impossible', attempts: 0 });
  });
});

describe('atomic logical moves', () => {
  it.each([
    {
      before: ['AAB.', 'AA.C', 'D...'],
      itemId: 'D',
      row: 1,
      col: 2,
      after: ['AAB.', 'AADC', '....'],
    },
    {
      before: ['BCAA', 'DEAA'],
      itemId: 'A',
      row: 0,
      col: 0,
      after: ['AABC', 'AADE'],
    },
  ])(
    'matches the documented spatial example $before',
    ({ before, itemId, row, col, after }) => {
      const value = { zones: [board(before)] };
      const snapshot = JSON.stringify(value);
      const result = computeMove({
        value,
        itemId,
        to: { zoneId: 'home', strategy: 'spatial', position: { row, col } },
        searchBudget: 10000,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('Expected a candidate');
      expect(cells(result.value.zones[0] as SpatialZone<string>)).toEqual(
        after,
      );
      expect(validateValue(result.value)).toEqual({ valid: true });
      expect(JSON.stringify(value)).toBe(snapshot);
      expect(result.changed).toBe(true);
    },
  );

  it('distinguishes area from a usable rectangle and never returns a partial value', () => {
    const value = { zones: [board(['AABB', 'AABB'])] };
    const result = computeMove({
      value,
      itemId: 'A',
      to: { zoneId: 'home', strategy: 'spatial', position: { row: 0, col: 1 } },
      searchBudget: 100,
    });
    expect(result).toMatchObject({ status: 'impossible' });
    expect(result).not.toHaveProperty('value');
    expect(cells(value.zones[0])).toEqual(['AABB', 'AABB']);
  });

  it('uses one exchange candidate instead of searching for a nearby empty cell', () => {
    const input = {
      value: { zones: [board(['AB'])] },
      itemId: 'A',
      to: {
        zoneId: 'home',
        strategy: 'spatial' as const,
        position: { row: 0, col: 1 },
      },
      searchBudget: 1,
    };
    const result = computeMove(input);
    expect(result).toMatchObject({ status: 'ok', attempts: 1 });
    if (result.status === 'ok')
      expect(cells(result.value.zones[0] as SpatialZone<string>)).toEqual([
        'BA',
      ]);
  });

  it('inserts from Dock and shifts the following apps atomically', () => {
    const source = ordered(['X']);
    const target = board(['ABCD', '....']);
    target.items = target.items.map(item => ({ ...item, placement: 'insert' }));
    const untouched = ordered(['Q'], 'other');
    const result = computeMove({
      value: {
        zones: [source, target, untouched],
        proposalResponse: { sessionId: 'old', accepted: true },
      },
      itemId: 'X',
      to: { zoneId: 'home', strategy: 'spatial', position: { row: 0, col: 1 } },
      searchBudget: 100,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.zones[0].items).toEqual([]);
    expect(cells(result.value.zones[1] as SpatialZone<string>)).toEqual([
      'AXBC',
      'D...',
    ]);
    expect(result.value.zones[2]).toBe(untouched);
    expect(result.value).not.toHaveProperty('proposalResponse');
    expect(result.from).toEqual({
      zoneId: 'dock',
      strategy: 'ordered',
      index: 0,
    });
    expect(result.value.zones[1].items.find(item => item.id === 'A')).toBe(
      target.items.find(item => item.id === 'A'),
    );
    expect(source.items.map(item => item.id)).toEqual(['X']);
  });

  it.each([0, 1, 2])(
    'inserts after removing the active ordered item, at index %s',
    index => {
      const value = { zones: [ordered(['A', 'B', 'C'])] };
      const result = computeMove({
        value,
        itemId: 'B',
        to: { zoneId: 'dock', strategy: 'ordered', index },
        searchBudget: 1,
      });
      if (result.status !== 'ok') throw new Error('Expected ordered move');
      expect(result.value.zones[0].items.map(item => item.id)).toEqual(
        [
          ['B', 'A', 'C'],
          ['A', 'B', 'C'],
          ['A', 'C', 'B'],
        ][index],
      );
      expect(result.changed).toBe(index !== 1);
      expect(result.attempts).toBe(0);
    },
  );

  it('preserves data and span references and removes position when entering ordered', () => {
    const opaque: { run: () => void; self?: unknown } = { run() {} };
    opaque.self = opaque;
    Object.freeze(opaque);
    const span = Object.freeze({ rows: 1, cols: 1 });
    const item = Object.freeze({
      id: 'X',
      data: opaque,
      span,
      position: Object.freeze({ row: 0, col: 0 }),
    });
    const value: GridValue<typeof opaque> = {
      zones: [
        { id: 'home', strategy: 'spatial', rows: 1, columns: 2, items: [item] },
        {
          id: 'dock',
          strategy: 'ordered',
          rows: 1,
          columns: 2,
          itemSpan: span,
          items: [],
        },
      ],
    };
    value.zones.forEach(zone => {
      Object.freeze(zone.items);
      Object.freeze(zone);
    });
    Object.freeze(value.zones);
    Object.freeze(value);
    const result = computeMove({
      value,
      itemId: 'X',
      to: { zoneId: 'dock', strategy: 'ordered', index: 0 },
      searchBudget: 10,
    });
    if (result.status !== 'ok') throw new Error('Expected conversion');
    expect(result.value.zones[0].items).toEqual([]);
    const inserted = result.value.zones[1].items[0];
    expect(inserted.data).toBe(opaque);
    expect(inserted.span).toBe(span);
    expect(inserted).not.toHaveProperty('position');
    expect(value.zones[0].items[0]).toBe(item);
  });

  it.each([
    { target: ordered(['B'], 'dock', 1), source: board(['A']) },
    { target: ordered([], 'dock', 2), source: board(['AA']) },
    {
      target: { ...ordered([], 'dock', 1), itemSpan: { rows: 2, cols: 1 } },
      source: board(['A', 'A']),
    },
  ])(
    'rejects full, incompatible, and zero-capacity ordered targets atomically',
    ({ target, source }) => {
      const value = { zones: [source, target] };
      const before = JSON.stringify(value);
      expect(
        computeMove({
          value,
          itemId: 'A',
          to: { zoneId: 'dock', strategy: 'ordered', index: 0 },
          searchBudget: 100,
        }),
      ).toEqual({ status: 'impossible', attempts: 0 });
      expect(JSON.stringify(value)).toBe(before);
    },
  );

  it('keeps spatial results independent of spatial input array order', () => {
    const zone = board(['BCAA', 'DEAA']);
    const to = {
      zoneId: 'home',
      strategy: 'spatial' as const,
      position: { row: 0, col: 0 },
    };
    const a = computeMove({
      value: { zones: [zone] },
      itemId: 'A',
      to,
      searchBudget: 1000,
    });
    const b = computeMove({
      value: { zones: [{ ...zone, items: [...zone.items].reverse() }] },
      itemId: 'A',
      to,
      searchBudget: 1000,
    });
    if (a.status !== 'ok' || b.status !== 'ok')
      throw new Error('Expected both candidates');
    expect(hasSameLayout(a.value, b.value)).toBe(true);
    expect(a.attempts).toBe(b.attempts);
  });

  it('rejects malformed targets instead of treating them as unchanged', () => {
    const value = { zones: [ordered(['A'])] };
    for (const index of [-1, 1, NaN, 0.5]) {
      const result = computeMove({
        value,
        itemId: 'A',
        to: { zoneId: 'dock', strategy: 'ordered', index },
        searchBudget: 10,
      });
      expect(result.status).toBe('invalid');
    }
    expect(
      computeMove({
        value,
        itemId: 'missing',
        to: { zoneId: 'dock', strategy: 'ordered', index: 0 },
        searchBudget: 1,
      }).status,
    ).toBe('invalid');
    expect(
      computeMove(null as unknown as Parameters<typeof computeMove>[0]).status,
    ).toBe('invalid');
  });

  it('preserves the spatial vacancy and item policy across a Dock round trip', () => {
    const home = board(['A.B.']);
    home.items[0].placement = 'insert';
    const out = computeMove({
      value: { zones: [home, ordered([])] },
      itemId: 'A',
      to: { zoneId: 'dock', strategy: 'ordered', index: 0 },
      searchBudget: 10,
    });
    if (out.status !== 'ok') throw new Error('Expected a Dock move');
    expect(cells(out.value.zones[0] as SpatialZone<string>)).toEqual(['..B.']);
    expect(out.value.zones[0].items[0]).toBe(home.items[1]);
    expect(out.value.zones[1].items[0].placement).toBe('insert');
    const back = computeMove({
      value: out.value,
      itemId: 'A',
      to: { zoneId: 'home', strategy: 'spatial', position: { row: 0, col: 3 } },
      searchBudget: 10,
    });
    if (back.status !== 'ok')
      throw new Error('Expected a return to the empty cell');
    expect(cells(back.value.zones[0] as SpatialZone<string>)).toEqual(['..BA']);
    expect(
      back.value.zones[0].items.find(item => item.id === 'A')?.placement,
    ).toBe('insert');
  });

  it('reports the actual active anchor after exchanging differently sized regions', () => {
    const input = board(['MMMM', 'MMMM', 'PPCC', 'PPCC', '....', '....']);
    const result = computeMove({
      value: { zones: [input] },
      itemId: 'C',
      to: { zoneId: 'home', strategy: 'spatial', position: { row: 0, col: 0 } },
      searchBudget: 100,
    });
    if (result.status !== 'ok') throw new Error('Expected a grouped exchange');
    expect(cells(result.value.zones[0] as SpatialZone<string>)).toEqual([
      'PPCC',
      'PPCC',
      'MMMM',
      'MMMM',
      '....',
      '....',
    ]);
    expect(result.to).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 2 },
    });
    expect(cells(input)).toEqual([
      'MMMM',
      'MMMM',
      'PPCC',
      'PPCC',
      '....',
      '....',
    ]);
  });
});

describe('layout equivalence', () => {
  it.each(['home', 'dock'])(
    'compares effective placement policies in %s',
    zoneId => {
      const initial = { zones: [board(['AB']), ordered(['X'])] };
      const changed = (placement: 'insert' | 'exchange') =>
        ({
          zones: initial.zones.map(zone =>
            zone.id === zoneId
              ? {
                  ...zone,
                  items: zone.items.map(item => ({ ...item, placement })),
                }
              : zone,
          ),
        }) as GridValue<string>;
      expect(
        hasSameLayout(
          initial,
          changed(zoneId === 'home' ? 'exchange' : 'insert'),
        ),
      ).toBe(true);
      expect(
        hasSameLayout(
          initial,
          changed(zoneId === 'home' ? 'insert' : 'exchange'),
        ),
      ).toBe(false);
    },
  );
  it('ignores data, proposal metadata and spatial order while detecting coordinates and ordered order', () => {
    const a: GridValue<string> = {
      zones: [board(['AB']), ordered(['X', 'Y'])],
    };
    const b: GridValue<string> = {
      zones: [
        a.zones[1],
        {
          ...(a.zones[0] as SpatialZone<string>),
          items: [...(a.zones[0].items as PositionedItem<string>[])]
            .reverse()
            .map(item => ({ ...item, data: 'new' })),
        },
      ],
      proposalResponse: { sessionId: 'response', accepted: false },
    };
    expect(hasSameLayout(a, b)).toBe(true);
    expect(hasSameLayout(a, { zones: [board(['BA']), a.zones[1]] })).toBe(
      false,
    );
    expect(hasSameLayout(a, { zones: [a.zones[0], ordered(['Y', 'X'])] })).toBe(
      false,
    );
    expect(
      hasSameLayout(a, {
        zones: [a.zones[0], { ...ordered(['X', 'Y']), columns: 5 }],
      }),
    ).toBe(false);
  });
});
