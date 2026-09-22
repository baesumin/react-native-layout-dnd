import {
  computeMove,
  DEFAULT_GRID_MOVEMENT_POLICY,
  HOME_GRID_MOVEMENT_POLICY,
  resolveGridMovementPolicy,
  validateGridMovementPolicy,
  type GridMovementPolicy,
} from '../../src/engine';
import type { GridValue, MoveInput, PositionedItem } from '../../src/types';

const item = (
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
  placement: 'insert' | 'exchange' = 'exchange',
): PositionedItem<object> => ({
  id,
  position: { row, col },
  span: { rows, cols },
  placement,
  data: { id, type: id === 'active' ? 'app' : 'widget' },
});

function move(
  items: PositionedItem<object>[],
  row: number,
  col: number,
  movementPolicy?: GridMovementPolicy,
  rows = 11,
  columns = 7,
) {
  return computeMove({
    value: {
      zones: [{ id: 'canvas', strategy: 'spatial', rows, columns, items }],
    },
    itemId: 'active',
    to: { zoneId: 'canvas', strategy: 'spatial', position: { row, col } },
    movementPolicy,
  });
}

function positions(value: GridValue<object>) {
  const zone = value.zones[0];
  if (zone.strategy !== 'spatial') throw new Error('Expected spatial zone');
  return Object.fromEntries(
    zone.items.map(entry => [entry.id, entry.position]),
  );
}

describe('declarative grid movement policies', () => {
  it('defaults an omitted search budget while rejecting an explicit null budget', () => {
    const input: MoveInput<object> = {
      value: {
        zones: [
          {
            id: 'canvas',
            strategy: 'spatial',
            rows: 1,
            columns: 2,
            items: [item('active', 0, 0)],
          },
        ],
      },
      itemId: 'active',
      to: {
        zoneId: 'canvas',
        strategy: 'spatial',
        position: { row: 0, col: 1 },
      },
    };
    expect(computeMove(input)).toMatchObject({ status: 'ok' });
    expect(
      computeMove({ ...input, searchBudget: null as unknown as number }),
    ).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid-budget' }],
    });
  });

  it('keeps intervening items and opaque application data unchanged by default on an 11×7 canvas', () => {
    const active = item('active', 0, 0, 3, 7);
    const middle = item('middle', 4, 2, 1, 2);
    const result = move([active, middle], 7, 0);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      active: { row: 7, col: 0 },
      middle: { row: 4, col: 2 },
    });
    expect(result.value.zones[0].items[0].data).toBe(active.data);
    expect(result.value.zones[0].items[1]).toBe(middle);
  });

  it('allows general row rotation independently of the home normalization', () => {
    const original = [item('active', 0, 0, 3, 7), item('middle', 4, 2, 1, 2)];
    const result = move(original, 7, 0, { rowRotation: 'full-width' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      active: { row: 7, col: 0 },
      middle: { row: 1, col: 2 },
    });
    const zone = result.value.zones[0];
    if (zone.strategy !== 'spatial') throw new Error('Expected spatial zone');
    const reverse = move(zone.items, 0, 0, { rowRotation: 'full-width' });
    expect(reverse).toMatchObject({
      status: 'ok',
      value: { zones: [{ items: original }] },
    });
  });

  it('requires the explicit home preset to normalize a one-cell insert drag across an adjacent widget', () => {
    const original = [
      item('active', 0, 1, 1, 1, 'insert'),
      item('neighbor', 0, 3, 1, 1, 'insert'),
      item('panel', 1, 0, 4, 4),
    ];
    expect(move(original, 1, 1, undefined, 5, 4).status).toBe('impossible');
    const result = move(original, 1, 1, HOME_GRID_MOVEMENT_POLICY, 5, 4);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      active: { row: 4, col: 1 },
      neighbor: { row: 4, col: 3 },
      panel: { row: 0, col: 0 },
    });
  });

  it('uses the first applicable candidate and preserves terminal row-rotation rejection', () => {
    const original = [item('active', 0, 0, 2, 7), item('neighbor', 4, 0, 2, 2)];
    expect(move(original, 3, 0, { rowRotation: 'full-width' })).toEqual({
      status: 'impossible',
      attempts: 1,
    });
    const result = move(original, 3, 0, {
      rowRotation: 'full-width',
      candidateOrder: ['exchange', 'row-rotation', 'insert'],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      active: { row: 3, col: 0 },
      neighbor: { row: 1, col: 0 },
    });
  });

  it('supports exchange priority and disabling collision rules without changing insertion data', () => {
    const original = ['active', 'B', 'C'].map((id, col) =>
      item(id, 0, col, 1, 1, 'insert'),
    );
    const insertion = move(original, 0, 2);
    const exchange = move(original, 0, 2, {
      candidateOrder: ['exchange', 'insert'],
    });
    expect(insertion.status).toBe('ok');
    expect(exchange.status).toBe('ok');
    if (insertion.status !== 'ok' || exchange.status !== 'ok')
      throw new Error('Expected candidates');
    expect(positions(insertion.value)).toEqual({
      active: { row: 0, col: 2 },
      B: { row: 0, col: 0 },
      C: { row: 0, col: 1 },
    });
    expect(positions(exchange.value)).toEqual({
      active: { row: 0, col: 2 },
      B: { row: 0, col: 1 },
      C: { row: 0, col: 0 },
    });
    expect(
      move([item('active', 0, 0), item('B', 0, 1)], 0, 1, {
        candidateOrder: ['insert'],
      }).status,
    ).toBe('impossible');
  });

  it('copies nested caller configuration for a stable session snapshot', () => {
    const policy: GridMovementPolicy = {
      candidateOrder: ['insert', 'exchange'],
      pointer: { exchangeThreshold: 0.9 },
    };
    const resolved = resolveGridMovementPolicy(policy);
    (policy.candidateOrder as string[]).reverse();
    policy.pointer!.exchangeThreshold = 0.6;
    expect(resolved.candidateOrder).toEqual(['insert', 'exchange']);
    expect(resolved.pointer.exchangeThreshold).toBe(0.9);
    expect(resolveGridMovementPolicy()).toEqual(DEFAULT_GRID_MOVEMENT_POLICY);
  });

  it.each([
    null,
    false,
    [],
    { rowRotation: 'all' },
    { adjacentInsertExchange: true },
    { candidateOrder: [] },
    { candidateOrder: Array(1) },
    { candidateOrder: ['insert', 'insert'] },
    { candidateOrder: ['pack'] },
    { pointer: null },
    { pointer: { cellHysteresis: -1 } },
    { pointer: { cellHysteresis: 0.6 } },
    { pointer: { exchangeThreshold: 0.4 } },
    { pointer: { exchangeThreshold: 1.1 } },
    { pointer: { boundaryHysteresis: -1 } },
    { pointer: { boundaryHysteresis: Infinity } },
  ])(
    'rejects invalid configuration before computing a move: %j',
    movementPolicy => {
      expect(validateGridMovementPolicy(movementPolicy)).toMatchObject({
        valid: false,
        issues: [{ code: 'invalid-configuration' }],
      });
      const input = {
        value: {
          zones: [
            {
              id: 'canvas',
              strategy: 'spatial',
              rows: 1,
              columns: 2,
              items: [item('active', 0, 0)],
            },
          ],
        },
        itemId: 'active',
        to: {
          zoneId: 'canvas',
          strategy: 'spatial',
          position: { row: 0, col: 1 },
        },
        movementPolicy,
      } as MoveInput<object>;
      expect(computeMove(input)).toMatchObject({
        status: 'invalid',
        issues: [{ code: 'invalid-configuration' }],
      });
    },
  );
});
