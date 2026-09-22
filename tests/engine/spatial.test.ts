import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';
import type { PlacementSearchResult } from '../../src/engine/search';
import {
  resolveSpatialMove,
  type SpatialMoveInput,
} from '../../src/engine/spatial';
import { validateValue } from '../../src/engine/validation';
import type { PositionedItem } from '../../src/types';

const item = (
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
  placement?: 'insert' | 'exchange',
): PositionedItem<null> => ({
  id,
  position: { row, col },
  span: { rows, cols },
  data: null,
  ...(placement ? { placement } : {}),
});
const app = (id: string, row: number, col: number, rows = 1, cols = 1) =>
  item(id, row, col, rows, cols, 'insert');

function move(
  origin: PositionedItem<null>,
  items: readonly PositionedItem<null>[],
  row: number,
  col: number,
  options: Partial<SpatialMoveInput<null>> = {},
) {
  return resolveSpatialMove({
    movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    origin,
    items,
    active: { ...origin, position: { row, col } },
    rows: 6,
    columns: 4,
    searchBudget: 100,
    ...options,
  });
}

function positions(result: PlacementSearchResult<null>) {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('Expected a valid placement.');
  return Object.fromEntries(
    result.placements.map(value => [value.id, value.position]),
  );
}

function expectValid(
  result: PlacementSearchResult<null>,
  rows = 6,
  columns = 4,
) {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('Expected a valid placement.');
  expect(
    validateValue({
      zones: [
        {
          id: 'home',
          strategy: 'spatial',
          rows,
          columns,
          items: result.placements,
        },
      ],
    }),
  ).toEqual({ valid: true });
}

describe('spatial region exchange', () => {
  test('moving an exchange item into empty space leaves other items and intentional holes unchanged', () => {
    const fixed = [app('B', 0, 1), item('C', 2, 0, 2, 2)];
    const active = item('A', 0, 0);
    const result = move(active, fixed, 4, 3);
    expect(result).toEqual({
      status: 'ok',
      attempts: 0,
      placements: [...fixed, item('A', 4, 3)],
    });
    if (result.status === 'ok') {
      expect(result.placements[0]).toBe(fixed[0]);
      expect(result.placements[1]).toBe(fixed[1]);
    }
  });

  test('equal widgets exchange their source positions instead of finding a nearby hole', () => {
    const origin = item('Photo', 2, 2, 2, 2);
    const calendar = item('Calendar', 2, 0, 2, 2);
    const result = move(origin, [calendar], 2, 0);
    expect(result).toEqual({
      status: 'ok',
      attempts: 1,
      placements: [item('Calendar', 2, 2, 2, 2), item('Photo', 2, 0, 2, 2)],
    });
    expectValid(result);
  });

  test('the recorded 6 by 4 layout preserves the diagonal app group and both holes', () => {
    const music = item('Music', 0, 0, 2, 4);
    const calendar = item('Calendar', 2, 0, 2, 2);
    const origin = item('Photo', 2, 2, 2, 2);
    const result = move(
      origin,
      [music, calendar, app('Chrome', 4, 2), app('ChatGPT', 5, 3)],
      4,
      2,
    );
    expect(positions(result)).toEqual({
      Music: { row: 0, col: 0 },
      Calendar: { row: 2, col: 0 },
      Chrome: { row: 2, col: 2 },
      ChatGPT: { row: 3, col: 3 },
      Photo: { row: 4, col: 2 },
    });
    if (result.status === 'ok') {
      expect(result.placements[0]).toBe(music);
      expect(result.placements[1]).toBe(calendar);
    }
    expectValid(result);
  });

  test.each([0, 2])(
    'small widget at column %i carries its neighbor when swapping with a wide widget',
    col => {
      const origin = item('Calendar', 2, col, 2, 2);
      const result = move(
        origin,
        [item('Photo', 2, 2 - col, 2, 2), item('Music', 0, 0, 2, 4)],
        0,
        0,
      );
      expect(positions(result)).toEqual({
        Photo: { row: 0, col: 2 - col },
        Music: { row: 2, col: 0 },
        Calendar: { row: 0, col },
      });
      expectValid(result);
    },
  );

  test('a large widget exchanges with both smaller target widgets', () => {
    const result = move(
      item('Music', 0, 0, 2, 4),
      [item('Photo', 2, 0, 2, 2), item('Calendar', 2, 2, 2, 2)],
      2,
      0,
    );
    expect(positions(result)).toEqual({
      Photo: { row: 0, col: 0 },
      Calendar: { row: 0, col: 2 },
      Music: { row: 2, col: 0 },
    });
    expectValid(result);
  });

  test('target closure includes a partly overlapped widget without splitting it', () => {
    const result = move(
      item('A', 3, 0, 1, 2),
      [item('B', 0, 1, 1, 2), app('C', 0, 3)],
      0,
      0,
      { rows: 4, columns: 4 },
    );
    expect(positions(result)).toEqual({
      B: { row: 3, col: 1 },
      C: { row: 0, col: 3 },
      A: { row: 0, col: 0 },
    });
    expectValid(result, 4, 4);
  });

  test('a target expansion discovers further items crossing its new boundary', () => {
    // B extends to column 3; that includes C's lower cell, so C expands the top edge.
    const result = move(
      item('A', 4, 0, 2, 2),
      [item('C', 0, 2, 2, 1), item('B', 2, 1, 1, 2)],
      1,
      0,
      { rows: 6, columns: 3 },
    );
    expectValid(result, 6, 3);
    expect(positions(result)).toEqual({
      C: { row: 3, col: 2 },
      B: { row: 5, col: 1 },
      A: { row: 1, col: 0 },
    });
  });

  test('rejects an exchange that cuts through a source-side neighbor', () => {
    const result = move(
      item('A', 2, 0, 1, 1),
      [item('Target', 0, 0, 1, 2), item('Crossing', 2, 1, 1, 2)],
      0,
      0,
      { rows: 3, columns: 3 },
    );
    expect(result).toEqual({ status: 'impossible', attempts: 1 });
  });

  test('rejects overlapping movement when the target must expand around a whole neighbor', () => {
    const result = move(item('A', 0, 0, 2, 2), [item('B', 0, 2, 2, 2)], 0, 1, {
      rows: 2,
      columns: 4,
    });
    expect(result).toEqual({ status: 'impossible', attempts: 1 });
  });

  test('an incoming widget cannot exchange with items in another zone', () => {
    expect(
      move(item('A', 0, 0, 2, 2), [item('B', 0, 0, 2, 2)], 0, 0, {
        origin: undefined,
      }),
    ).toEqual({ status: 'impossible', attempts: 0 });
  });

  test('an incoming widget can still occupy an empty rectangle', () => {
    const result = move(item('A', 0, 0, 2, 2), [item('B', 0, 0, 2, 2)], 2, 2, {
      origin: undefined,
    });
    expect(result).toMatchObject({ status: 'ok', attempts: 0 });
    expectValid(result);
  });

  test('exchange is the default and does not infer insertion from a one-cell span', () => {
    const result = move(item('A', 0, 0), [item('B', 0, 2)], 0, 2, {
      rows: 1,
      columns: 4,
    });
    expect(positions(result)).toEqual({
      B: { row: 0, col: 0 },
      A: { row: 0, col: 2 },
    });
  });

  test('the first invalid source rectangle consumes its budget before trying another alignment', () => {
    const origin = item('A', 2, 1);
    const items = [item('Target', 0, 0, 1, 2), item('Crossing', 2, 2, 1, 2)];
    const short = move(origin, items, 0, 0, {
      rows: 3,
      columns: 4,
      searchBudget: 1,
    });
    expect(short).toEqual({ status: 'unresolved', attempts: 1 });
    const enough = move(origin, items, 0, 0, {
      rows: 3,
      columns: 4,
      searchBudget: 2,
    });
    expect(enough).toMatchObject({ status: 'ok', attempts: 2 });
    expect(positions(enough)).toEqual({
      Target: { row: 2, col: 0 },
      Crossing: { row: 2, col: 2 },
      A: { row: 0, col: 1 },
    });
    expect(enough).toEqual(
      move(origin, items, 0, 0, { rows: 3, columns: 4, searchBudget: 100 }),
    );
    expectValid(enough, 3, 4);
  });

  test('exhausting all invalid source rectangles is impossible, not unresolved', () => {
    const result = move(
      item('A', 2, 1),
      [
        item('Target', 0, 0, 1, 2),
        item('CrossingRight', 2, 2, 1, 2),
        item('CrossingBelow', 2, 0, 2, 1),
      ],
      0,
      0,
      { rows: 4, columns: 4, searchBudget: 2 },
    );
    expect(result).toEqual({ status: 'impossible', attempts: 2 });
  });

  test('input order and opaque data references survive atomic exchange', () => {
    const origin = item('A', 2, 0);
    const items = [item('C', 3, 3), item('B', 0, 0)];
    for (const value of [origin, ...items]) {
      Object.freeze(value.position);
      Object.freeze(value.span);
      Object.freeze(value);
    }
    Object.freeze(items);
    const result = move(origin, items, 0, 0);
    expect(result).toMatchObject({
      status: 'ok',
      placements: [item('C', 3, 3), item('B', 2, 0), item('A', 0, 0)],
    });
    if (result.status === 'ok') expect(result.placements[0]).toBe(items[0]);
    expect(origin.position).toEqual({ row: 2, col: 0 });
    expect(items[1].position).toEqual({ row: 0, col: 0 });
  });

  test('large safe integer coordinates do not require a grid-sized allocation', () => {
    const size = Number.MAX_SAFE_INTEGER;
    const result = move(
      item('A', size - 1, size - 1),
      [item('B', 0, 0)],
      0,
      0,
      { rows: size, columns: size, searchBudget: 1 },
    );
    expect(positions(result)).toEqual({
      B: { row: size - 1, col: size - 1 },
      A: { row: 0, col: 0 },
    });
    expectValid(result, size, size);
  });
});

describe('spatial insertion', () => {
  test('forward insertion preserves the relative order of the other apps', () => {
    const result = move(
      app('A', 0, 0),
      [app('D', 0, 3), app('B', 0, 1), app('C', 0, 2)],
      0,
      2,
      { rows: 1, columns: 4 },
    );
    expect(positions(result)).toEqual({
      D: { row: 0, col: 3 },
      B: { row: 0, col: 0 },
      C: { row: 0, col: 1 },
      A: { row: 0, col: 2 },
    });
    expect(result).toMatchObject({ attempts: 1 });
    expectValid(result, 1, 4);
  });

  test('backward insertion shifts the intervening apps forward', () => {
    const result = move(
      app('D', 0, 3),
      [app('A', 0, 0), app('B', 0, 1), app('C', 0, 2)],
      0,
      1,
      { rows: 1, columns: 4 },
    );
    expect(positions(result)).toEqual({
      A: { row: 0, col: 0 },
      B: { row: 0, col: 2 },
      C: { row: 0, col: 3 },
      D: { row: 0, col: 1 },
    });
    expectValid(result, 1, 4);
  });

  test('insertion skips deliberate holes and fixed widgets, including across a row boundary', () => {
    const fixed = item('Widget', 0, 2, 1, 2);
    const result = move(
      app('A', 0, 0),
      [fixed, app('B', 1, 0), app('C', 1, 2)],
      1,
      2,
      { rows: 2, columns: 4 },
    );
    expect(positions(result)).toEqual({
      Widget: { row: 0, col: 2 },
      B: { row: 0, col: 0 },
      C: { row: 1, col: 0 },
      A: { row: 1, col: 2 },
    });
    if (result.status === 'ok') expect(result.placements[0]).toBe(fixed);
    expectValid(result, 2, 4);
  });

  test('a larger insertion span uses occupied equal-size aligned slots', () => {
    const result = move(
      app('A', 0, 0, 2, 2),
      [app('B', 0, 2, 2, 2), app('C', 2, 0, 2, 2)],
      2,
      0,
      { rows: 4, columns: 4 },
    );
    expect(positions(result)).toEqual({
      B: { row: 0, col: 0 },
      C: { row: 0, col: 2 },
      A: { row: 2, col: 0 },
    });
    expectValid(result, 4, 4);
  });

  test('moving an app into an empty slot shifts intervening apps and keeps the requested slot', () => {
    const result = move(app('A', 0, 0), [app('B', 0, 1), app('C', 0, 2)], 1, 2);
    expect(positions(result)).toEqual({
      B: { row: 0, col: 0 },
      C: { row: 0, col: 1 },
      A: { row: 1, col: 2 },
    });
    expect(result).toMatchObject({ attempts: 1 });
  });

  test('a different insertion span between source and target rejects the whole rotation', () => {
    expect(
      move(app('A', 0, 0), [app('Wide', 0, 1, 1, 2), app('B', 1, 0)], 1, 0),
    ).toEqual({ status: 'impossible', attempts: 1 });
  });

  test('a partially overlapping target is not interpreted as an insertion slot', () => {
    expect(move(app('A', 2, 0, 2, 2), [app('B', 0, 0, 2, 2)], 0, 1)).toEqual({
      status: 'impossible',
      attempts: 0,
    });
  });

  test('a misaligned source or target cannot participate in insertion', () => {
    expect(move(app('A', 2, 1, 2, 2), [app('B', 0, 0, 2, 2)], 0, 0)).toEqual({
      status: 'impossible',
      attempts: 1,
    });
    expect(move(app('A', 2, 0, 2, 2), [app('B', 0, 1, 2, 2)], 0, 1)).toEqual({
      status: 'impossible',
      attempts: 0,
    });
  });

  test('insert items with different spans reject instead of falling back to exchange', () => {
    expect(move(app('A', 2, 0), [app('B', 0, 0, 2, 2)], 0, 0)).toEqual({
      status: 'impossible',
      attempts: 0,
    });
  });

  test('incoming insertion shifts to the first forward vacancy without filling earlier holes', () => {
    const result = move(
      app('X', 0, 0),
      [app('A', 0, 1), app('B', 0, 2), app('C', 1, 0)],
      0,
      1,
      { rows: 2, columns: 4, origin: undefined },
    );
    expect(positions(result)).toEqual({
      A: { row: 0, col: 2 },
      B: { row: 0, col: 3 },
      C: { row: 1, col: 0 },
      X: { row: 0, col: 1 },
    });
    expect(result).toMatchObject({ attempts: 3 });
    expectValid(result, 2, 4);
  });

  test('incoming insertion wraps rows and skips fixed widgets', () => {
    const widget = item('Widget', 0, 2, 1, 2);
    const result = move(
      app('X', 0, 0),
      [app('A', 0, 1), widget, app('B', 1, 0)],
      0,
      1,
      { rows: 2, columns: 4, origin: undefined },
    );
    expect(positions(result)).toEqual({
      A: { row: 1, col: 0 },
      Widget: { row: 0, col: 2 },
      B: { row: 1, col: 1 },
      X: { row: 0, col: 1 },
    });
    expect(result).toMatchObject({ attempts: 5 });
    expectValid(result, 2, 4);
    if (result.status === 'ok') expect(result.placements[1]).toBe(widget);
  });

  test('incoming insertion rejects a full destination and never falls back to an earlier hole', () => {
    const result = move(
      app('X', 0, 0),
      [app('A', 0, 1), app('B', 0, 2)],
      0,
      1,
      { rows: 1, columns: 3, origin: undefined },
    );
    expect(result).toEqual({ status: 'impossible', attempts: 2 });
  });

  test('incoming insertion stops atomically at a mismatched insertion span', () => {
    const result = move(
      app('X', 0, 0),
      [app('A', 0, 0), app('Wide', 0, 1, 1, 2)],
      0,
      0,
      { rows: 2, columns: 4, origin: undefined },
    );
    expect(result).toEqual({ status: 'impossible', attempts: 2 });
  });

  test('incoming insertion counts each visited slot, including fixed widget slots', () => {
    const origin = app('X', 0, 0);
    const items = [app('A', 0, 0), item('Widget', 0, 1)];
    expect(
      move(origin, items, 0, 0, {
        rows: 1,
        columns: 3,
        origin: undefined,
        searchBudget: 2,
      }),
    ).toEqual({ status: 'unresolved', attempts: 2 });
    expect(
      move(origin, items, 0, 0, {
        rows: 1,
        columns: 3,
        origin: undefined,
        searchBudget: 3,
      }),
    ).toMatchObject({ status: 'ok', attempts: 3 });
  });

  test('incoming insertion supports aligned rectangular slots and ignores a trailing partial column', () => {
    const result = move(app('X', 0, 0, 2, 2), [app('A', 0, 2, 2, 2)], 0, 2, {
      rows: 4,
      columns: 5,
      origin: undefined,
    });
    expect(positions(result)).toEqual({
      A: { row: 2, col: 0 },
      X: { row: 0, col: 2 },
    });
    expect(result).toMatchObject({ attempts: 2 });
    expectValid(result, 4, 5);
  });

  test('near the safe coordinate limit, incoming insertion terminates at the last slot', () => {
    const size = Number.MAX_SAFE_INTEGER;
    expect(
      move(app('X', 0, 0), [app('A', size - 1, size - 1)], size - 1, size - 1, {
        rows: size,
        columns: size,
        origin: undefined,
        searchBudget: 1,
      }),
    ).toEqual({ status: 'impossible', attempts: 1 });
  });

  test('a frozen snapshot is reusable for both successful and budget-limited insertion', () => {
    const origin = app('X', 0, 0);
    const items = [app('B', 0, 0), app('C', 0, 1)];
    for (const value of [origin, ...items]) {
      Object.freeze(value.position);
      Object.freeze(value.span);
      Object.freeze(value);
    }
    Object.freeze(items);
    const input = { rows: 1, columns: 3, origin: undefined };
    expect(move(origin, items, 0, 0, { ...input, searchBudget: 2 })).toEqual({
      status: 'unresolved',
      attempts: 2,
    });
    const result = move(origin, items, 0, 0, { ...input, searchBudget: 3 });
    expect(positions(result)).toEqual({
      B: { row: 0, col: 1 },
      C: { row: 0, col: 2 },
      X: { row: 0, col: 0 },
    });
    expect(items.map(value => value.position.col)).toEqual([0, 1]);
  });
});
