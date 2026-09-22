import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';
import { computeMove } from '../../src/engine/move';
import { hasSameLayout } from '../../src/engine/sameLayout';
import { validateValue } from '../../src/engine/validation';
import type { GridValue, PositionedItem, SpatialZone } from '../../src/types';

function item(
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
  placement: 'insert' | 'exchange' = 'exchange',
): PositionedItem<unknown> {
  return {
    id,
    data: null,
    placement,
    position: { row, col },
    span: { rows, cols },
  };
}

const app = (id: string, row: number, col: number) =>
  item(id, row, col, 1, 1, 'insert');

function home(
  items: PositionedItem<unknown>[],
  rows = 5,
  columns = 4,
): GridValue<unknown> {
  return {
    zones: [{ id: 'home', strategy: 'spatial', rows, columns, items }],
  };
}

function move(value: GridValue<unknown>, row: number, col = 0, itemId = 'A') {
  return computeMove({
    movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    value,
    itemId,
    to: { zoneId: 'home', strategy: 'spatial', position: { row, col } },
    searchBudget: 1,
  });
}

function positions(value: GridValue<unknown>) {
  return Object.fromEntries(
    (value.zones[0] as SpatialZone<unknown>).items.map(current => [
      current.id,
      current.position,
    ]),
  );
}

function appsAboveWidget() {
  return home([
    app('left', 0, 0),
    app('A', 0, 1),
    app('right', 0, 2),
    item('Widget', 1, 0, 4, 4),
  ]);
}

describe('app row rotation across a full-width widget', () => {
  it('moves the entire app row and its hole across any cell of an adjacent 4×4 widget', () => {
    const initial = appsAboveWidget();
    const widgetMove = move(initial, 0, 0, 'Widget');
    expect(widgetMove.status).toBe('ok');
    if (widgetMove.status !== 'ok') throw new Error(widgetMove.status);

    for (let row = 1; row < 5; row++) {
      for (let col = 0; col < 4; col++) {
        const result = move(initial, row, col);
        expect(result).toMatchObject({
          status: 'ok',
          attempts: 1,
          to: { position: { row: 4, col: 1 } },
        });
        if (result.status !== 'ok') throw new Error(result.status);
        expect(positions(result.value)).toEqual({
          left: { row: 4, col: 0 },
          A: { row: 4, col: 1 },
          right: { row: 4, col: 2 },
          Widget: { row: 0, col: 0 },
        });
        expect(hasSameLayout(result.value, widgetMove.value)).toBe(true);
        expect(validateValue(result.value)).toEqual({ valid: true });
      }
    }
    expect(initial).toEqual(appsAboveWidget());
  });

  it('restores every coordinate by dragging the app back into any cell of the widget', () => {
    const initial = appsAboveWidget();
    const down = move(initial, 2, 3);
    expect(down.status).toBe('ok');
    if (down.status !== 'ok') throw new Error(down.status);
    const widgetMove = move(down.value, 1, 0, 'Widget');
    expect(widgetMove.status).toBe('ok');
    if (widgetMove.status !== 'ok') throw new Error(widgetMove.status);

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const up = move(down.value, row, col);
        expect(up).toMatchObject({
          status: 'ok',
          attempts: 1,
          to: { position: { row: 0, col: 1 } },
        });
        if (up.status !== 'ok') throw new Error(up.status);
        expect(up.value).toEqual(initial);
        expect(hasSameLayout(up.value, widgetMove.value)).toBe(true);
      }
    }
  });

  it('rotates a sparse app row across a 2×4 widget while preserving outside items and opaque data', () => {
    const above = app('above', 0, 3);
    const below = app('below', 4, 0);
    const active = app('A', 3, 2);
    const opaque = { self: null as unknown };
    opaque.self = opaque;
    active.data = Object.freeze(opaque);
    const initial = home([above, item('Widget', 1, 0, 2, 4), active, below]);
    for (const zone of initial.zones) {
      for (const current of (zone as SpatialZone<unknown>).items) {
        Object.freeze(current.position);
        Object.freeze(current.span);
        Object.freeze(current);
      }
      Object.freeze(zone.items);
      Object.freeze(zone);
    }
    Object.freeze(initial.zones);
    Object.freeze(initial);

    const up = move(initial, 1, 0);
    expect(up).toMatchObject({ status: 'ok', attempts: 1 });
    if (up.status !== 'ok') throw new Error(up.status);
    expect(positions(up.value)).toEqual({
      above: { row: 0, col: 3 },
      Widget: { row: 2, col: 0 },
      A: { row: 1, col: 2 },
      below: { row: 4, col: 0 },
    });
    expect(up.value.zones[0].items[0]).toBe(above);
    expect(up.value.zones[0].items[3]).toBe(below);
    up.value.zones[0].items.forEach((current, index) => {
      expect(current.span).toBe(initial.zones[0].items[index].span);
      expect(current.data).toBe(initial.zones[0].items[index].data);
    });
    const down = move(up.value, 3, 3);
    expect(down.status).toBe('ok');
    if (down.status !== 'ok') throw new Error(down.status);
    expect(down.value).toEqual(initial);
  });

  it('rejects a tall neighbor that crosses the app row boundary without trying a larger exchange', () => {
    const initial = home(
      [
        item('neighbor', 0, 0, 2, 1),
        app('A', 1, 1),
        item('Widget', 2, 0, 4, 4),
      ],
      6,
    );
    const before = JSON.stringify(initial);
    expect(move(initial, 4, 3)).toEqual({ status: 'impossible', attempts: 1 });
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('treats an omitted widget placement as exchange and does not depend on item array order', () => {
    const initial = appsAboveWidget();
    const zone = initial.zones[0] as SpatialZone<unknown>;
    delete zone.items[3].placement;
    const reordered = home([...zone.items].reverse());
    const first = move(initial, 2, 3);
    const second = move(reordered, 2, 3);
    expect(first).toMatchObject({ status: 'ok', attempts: 1 });
    expect(second).toMatchObject({ status: 'ok', attempts: 1 });
    if (first.status !== 'ok' || second.status !== 'ok')
      throw new Error('Expected both item orders to resolve');
    expect(first.to).toEqual(second.to);
    expect(hasSameLayout(first.value, second.value)).toBe(true);
    expect(first.value.zones[0].items[3].placement).toBeUndefined();
  });

  it('keeps a nonadjacent app on the existing equal-region exchange policy', () => {
    const initial = home(
      [app('A', 0, 1), app('middle', 1, 2), item('Widget', 2, 0, 2, 4)],
      6,
    );
    const result = move(initial, 2, 1);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      A: { row: 2, col: 1 },
      middle: { row: 3, col: 2 },
      Widget: { row: 0, col: 0 },
    });
  });

  it.each([
    [
      'an exchange item',
      item('A', 0, 1),
      item('Widget', 1, 0, 4, 4),
      'impossible',
    ],
    [
      'an item without explicit insertion',
      { ...item('A', 0, 1), placement: undefined },
      item('Widget', 1, 0, 4, 4),
      'impossible',
    ],
    [
      'a larger insertion item',
      item('A', 0, 0, 1, 2, 'insert'),
      item('Widget', 1, 0, 4, 4),
      'impossible',
    ],
    [
      'an insertion target',
      app('A', 0, 1),
      item('Widget', 1, 0, 4, 4, 'insert'),
      'impossible',
    ],
  ])(
    'does not rotate app rows for %s',
    (_description, active, widget, status) => {
      expect(move(home([active, widget]), 1, 0).status).toBe(status);
    },
  );

  it('does not move an app row across zones into an occupied full-width widget', () => {
    const initial = home([item('Widget', 1, 0, 4, 4)]);
    initial.zones.push({
      id: 'other',
      strategy: 'spatial',
      rows: 1,
      columns: 4,
      items: [app('A', 0, 1)],
    });
    expect(move(initial, 2, 3)).toEqual({ status: 'impossible', attempts: 0 });
  });
});

describe('app exchange across a narrower adjacent widget', () => {
  it.each([
    { widgetCol: 0, above: true },
    { widgetCol: 1, above: true },
    { widgetCol: 2, above: true },
    { widgetCol: 0, above: false },
    { widgetCol: 1, above: false },
    { widgetCol: 2, above: false },
  ])(
    'matches the widget drag and restores the layout for a 2×2 at column $widgetCol with apps above=$above',
    ({ widgetCol, above }) => {
      const widgetRow = above ? 1 : 2;
      const appRow = above ? 0 : 4;
      const shiftedWidgetRow = widgetRow + (above ? -1 : 1);
      const shiftedAppRow = appRow + (above ? 2 : -2);
      for (const activeOffset of [0, 1]) {
        for (const withSibling of [true, false]) {
          const fixed = [0, 1, 2, 3]
            .filter(col => col < widgetCol || col >= widgetCol + 2)
            .map(col => app(`outside-${col}`, appRow, col));
          const initial = home([
            item('Widget', widgetRow, widgetCol, 2, 2),
            app('A', appRow, widgetCol + activeOffset),
            ...(withSibling
              ? [app('sibling', appRow, widgetCol + 1 - activeOffset)]
              : []),
            ...fixed,
          ]);
          const expected = {
            Widget: { row: shiftedWidgetRow, col: widgetCol },
            A: { row: shiftedAppRow, col: widgetCol + activeOffset },
            ...(withSibling
              ? {
                  sibling: {
                    row: shiftedAppRow,
                    col: widgetCol + 1 - activeOffset,
                  },
                }
              : {}),
            ...Object.fromEntries(
              fixed.map(current => [current.id, current.position]),
            ),
          };
          const direct = move(initial, shiftedWidgetRow, widgetCol, 'Widget');
          expect(direct.status).toBe('ok');
          if (direct.status !== 'ok') throw new Error(direct.status);

          for (let row = widgetRow; row < widgetRow + 2; row++) {
            for (let col = widgetCol; col < widgetCol + 2; col++) {
              const result = move(initial, row, col);
              expect(result).toMatchObject({
                status: 'ok',
                attempts: 1,
                to: {
                  position: {
                    row: shiftedAppRow,
                    col: widgetCol + activeOffset,
                  },
                },
              });
              if (result.status !== 'ok') throw new Error(result.status);
              expect(positions(result.value)).toEqual(expected);
              expect(hasSameLayout(result.value, direct.value)).toBe(true);
              expect(validateValue(result.value)).toEqual({ valid: true });
              for (const outside of fixed) {
                expect(
                  result.value.zones[0].items.find(
                    current => current.id === outside.id,
                  ),
                ).toBe(outside);
              }

              for (
                let returnRow = shiftedWidgetRow;
                returnRow < shiftedWidgetRow + 2;
                returnRow++
              ) {
                for (
                  let returnCol = widgetCol;
                  returnCol < widgetCol + 2;
                  returnCol++
                ) {
                  const restored = move(result.value, returnRow, returnCol);
                  expect(restored.status).toBe('ok');
                  if (restored.status !== 'ok')
                    throw new Error(restored.status);
                  expect(restored.value).toEqual(initial);
                }
              }
            }
          }
        }
      }
    },
  );

  it('supports a 4×2 widget and preserves frozen inputs, opaque data, and item order', () => {
    const active = app('A', 0, 1);
    const opaque = { self: null as unknown };
    opaque.self = opaque;
    active.data = Object.freeze(opaque);
    const outside = item('outside', 0, 2, 5, 2);
    const initial = home([outside, item('Widget', 1, 0, 4, 2), active]);
    for (const zone of initial.zones) {
      for (const current of (zone as SpatialZone<unknown>).items) {
        Object.freeze(current.position);
        Object.freeze(current.span);
        Object.freeze(current);
      }
      Object.freeze(zone.items);
      Object.freeze(zone);
    }
    Object.freeze(initial.zones);
    Object.freeze(initial);

    const result = move(initial, 3, 0);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      outside: { row: 0, col: 2 },
      Widget: { row: 0, col: 0 },
      A: { row: 4, col: 1 },
    });
    expect(result.value.zones[0].items[0]).toBe(outside);
    result.value.zones[0].items.forEach((current, index) => {
      expect(current.id).toBe(initial.zones[0].items[index].id);
      expect(current.span).toBe(initial.zones[0].items[index].span);
      expect(current.data).toBe(initial.zones[0].items[index].data);
    });
    const back = move(result.value, 2, 1);
    expect(back.status).toBe('ok');
    if (back.status !== 'ok') throw new Error(back.status);
    expect(back.value).toEqual(initial);
  });

  it.each([
    {
      boundary: 'width',
      active: app('A', 0, 0),
      neighbor: item('neighbor', 0, 1, 1, 2),
      widget: item('Widget', 1, 0, 2, 2),
      targetRow: 1,
      widgetTargetRow: 0,
    },
    {
      boundary: 'height',
      active: app('A', 1, 1),
      neighbor: item('neighbor', 0, 0, 2, 1),
      widget: item('Widget', 2, 0, 2, 2),
      targetRow: 2,
      widgetTargetRow: 1,
    },
  ])(
    'rejects the same $boundary boundary crossing when either the app or widget is grabbed',
    ({ active, neighbor, widget, targetRow, widgetTargetRow }) => {
      const initial = home([active, neighbor, widget]);
      const before = JSON.stringify(initial);
      expect(move(initial, targetRow, 0)).toEqual({
        status: 'impossible',
        attempts: 1,
      });
      expect(move(initial, widgetTargetRow, 0, 'Widget')).toEqual({
        status: 'impossible',
        attempts: 1,
      });
      expect(JSON.stringify(initial)).toBe(before);
    },
  );

  it.each([0, 3])(
    'does not include an app originating outside the widget columns at column %i',
    col => {
      const initial = home([app('A', 4, col), item('Widget', 2, 1, 2, 2)]);
      expect(move(initial, 2, 1)).toEqual({
        status: 'impossible',
        attempts: 1,
      });
    },
  );

  it('keeps a nonadjacent app on the existing local exchange without moving the intervening row', () => {
    const middle = app('middle', 1, 3);
    const initial = home([app('A', 0, 1), middle, item('Widget', 2, 0, 2, 2)]);
    const result = move(initial, 2, 1);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      A: { row: 2, col: 1 },
      middle: { row: 1, col: 3 },
      Widget: { row: 0, col: 0 },
    });
    expect(result.value.zones[0].items[1]).toBe(middle);
  });

  it('does not normalize an incoming app from a different zone', () => {
    const initial = home([item('Widget', 2, 0, 2, 2)]);
    initial.zones.push({
      id: 'other',
      strategy: 'spatial',
      rows: 5,
      columns: 4,
      items: [app('A', 4, 1)],
    });
    expect(move(initial, 2, 0)).toEqual({ status: 'impossible', attempts: 0 });
  });

  it('also uses the existing disjoint exchange for a one-row widget', () => {
    const outside = app('outside', 0, 2);
    const initial = home([
      app('A', 0, 1),
      app('sibling', 0, 0),
      outside,
      item('Widget', 1, 0, 1, 2),
    ]);
    const direct = move(initial, 0, 0, 'Widget');
    const result = move(initial, 1, 0);
    expect(direct.status).toBe('ok');
    expect(result.status).toBe('ok');
    if (direct.status !== 'ok' || result.status !== 'ok')
      throw new Error('Expected app and widget moves to resolve');
    expect(positions(result.value)).toEqual({
      A: { row: 1, col: 1 },
      sibling: { row: 1, col: 0 },
      outside: { row: 0, col: 2 },
      Widget: { row: 0, col: 0 },
    });
    expect(hasSameLayout(result.value, direct.value)).toBe(true);
    const back = move(result.value, 0, 0);
    expect(back.status).toBe('ok');
    if (back.status !== 'ok') throw new Error(back.status);
    expect(back.value).toEqual(initial);
  });
});

describe('app and widget exchanges on a five-row, six-column grid', () => {
  it.each([
    { row: 1, col: 2, rows: 2, cols: 2 },
    { row: 1, col: 1, rows: 2, cols: 4 },
    { row: 0, col: 1, rows: 4, cols: 4 },
    { row: 0, col: 0, rows: 2, cols: 2 },
    { row: 3, col: 4, rows: 2, cols: 2 },
  ])(
    'matches either handle and restores a $rows-row, $cols-column widget at ($row, $col)',
    ({ row, col, rows, cols }) => {
      for (const direction of [-1, 1]) {
        const appCol = direction < 0 ? col - 1 : col + cols;
        if (appCol < 0 || appCol >= 6) continue;
        for (const activeOffset of [0, rows - 1]) {
          for (const withSibling of [false, true]) {
            const fixed = [0, 1, 2, 3, 4]
              .filter(fixedRow => fixedRow < row || fixedRow >= row + rows)
              .map(fixedRow => app(`outside-${fixedRow}`, fixedRow, appCol));
            const initial = home(
              [
                item('Widget', row, col, rows, cols),
                app('A', row + activeOffset, appCol),
                ...(withSibling
                  ? [app('sibling', row + rows - 1 - activeOffset, appCol)]
                  : []),
                ...fixed,
              ],
              5,
              6,
            );
            const before = JSON.stringify(initial);
            const shiftedWidgetCol = col + direction;
            const shiftedAppCol = appCol - direction * cols;
            const direct = move(initial, row, shiftedWidgetCol, 'Widget');
            expect(direct.status).toBe('ok');
            if (direct.status !== 'ok') throw new Error(direct.status);
            const expected = {
              Widget: { row, col: shiftedWidgetCol },
              A: { row: row + activeOffset, col: shiftedAppCol },
              ...(withSibling
                ? {
                    sibling: {
                      row: row + rows - 1 - activeOffset,
                      col: shiftedAppCol,
                    },
                  }
                : {}),
              ...Object.fromEntries(
                fixed.map(current => [current.id, current.position]),
              ),
            };

            // Any cell of the adjacent widget selects the same one-column move.
            for (let targetRow = row; targetRow < row + rows; targetRow++) {
              for (let targetCol = col; targetCol < col + cols; targetCol++) {
                const result = move(initial, targetRow, targetCol);
                expect(result).toMatchObject({
                  status: 'ok',
                  attempts: 1,
                  to: { position: expected.A },
                });
                if (result.status !== 'ok') throw new Error(result.status);
                expect(positions(result.value)).toEqual(expected);
                expect(hasSameLayout(result.value, direct.value)).toBe(true);
                expect(validateValue(result.value)).toEqual({ valid: true });
                for (const outside of fixed) {
                  expect(
                    result.value.zones[0].items.find(
                      current => current.id === outside.id,
                    ),
                  ).toBe(outside);
                }

                // Either the original app, another exchanged app, or the widget
                // can drive the return trip after the first move was committed.
                for (const handle of withSibling
                  ? ['A', 'sibling', 'Widget']
                  : ['A', 'Widget']) {
                  const restored = move(
                    result.value,
                    row,
                    handle === 'Widget' ? col : shiftedWidgetCol,
                    handle,
                  );
                  expect(restored.status).toBe('ok');
                  if (restored.status !== 'ok')
                    throw new Error(restored.status);
                  expect(restored.value).toEqual(initial);
                  expect(restored.to).toEqual({
                    zoneId: 'home',
                    strategy: 'spatial',
                    position: positions(initial)[handle],
                  });
                }
              }
            }
            expect(JSON.stringify(initial)).toBe(before);
          }
        }
      }
    },
  );

  it.each([true, false])(
    'also preserves the outside columns in a 4×4 vertical exchange with apps above=%s',
    above => {
      const widgetRow = above ? 1 : 0;
      const appRow = above ? 0 : 4;
      const initial = home(
        [
          item('Widget', widgetRow, 1, 4, 4),
          app('A', appRow, 1),
          app('sibling', appRow, 4),
          app('left', appRow, 0),
          app('right', appRow, 5),
        ],
        5,
        6,
      );
      const shiftedWidgetRow = above ? 0 : 1;
      const direct = move(initial, shiftedWidgetRow, 1, 'Widget');
      const result = move(initial, widgetRow, 4);
      expect(direct.status).toBe('ok');
      expect(result.status).toBe('ok');
      if (direct.status !== 'ok' || result.status !== 'ok')
        throw new Error('Expected both handles to resolve');
      expect(hasSameLayout(result.value, direct.value)).toBe(true);
      expect(positions(result.value)).toEqual({
        Widget: { row: shiftedWidgetRow, col: 1 },
        A: { row: above ? 4 : 0, col: 1 },
        sibling: { row: above ? 4 : 0, col: 4 },
        left: { row: appRow, col: 0 },
        right: { row: appRow, col: 5 },
      });
      const restored = move(result.value, shiftedWidgetRow, 4, 'sibling');
      expect(restored.status).toBe('ok');
      if (restored.status !== 'ok') throw new Error(restored.status);
      expect(restored.value).toEqual(initial);
    },
  );

  it.each([
    { boundary: 'height', neighbor: item('neighbor', 0, 4, 2, 1) },
    { boundary: 'width', neighbor: item('neighbor', 1, 4, 1, 2) },
    { boundary: 'both axes', neighbor: item('neighbor', 0, 4, 2, 2) },
  ])(
    'rejects a neighbor crossing the $boundary boundary with either horizontal handle',
    ({ neighbor }) => {
      const initial = home(
        [item('Widget', 1, 2, 2, 2), app('A', 2, 4), neighbor],
        5,
        6,
      );
      const before = JSON.stringify(initial);
      expect(move(initial, 1, 2)).toEqual({
        status: 'impossible',
        attempts: 1,
      });
      expect(move(initial, 1, 3, 'Widget')).toEqual({
        status: 'impossible',
        attempts: 1,
      });
      expect(JSON.stringify(initial)).toBe(before);
    },
  );

  it.each([
    { widgetRow: 0, appRow: 4, appCol: 0 },
    { widgetRow: 0, appRow: 4, appCol: 5 },
    { widgetRow: 1, appRow: 0, appCol: 0 },
    { widgetRow: 1, appRow: 0, appCol: 5 },
  ])(
    'does not turn a diagonal app at ($appRow, $appCol) into an adjacent 4×4 exchange',
    ({ widgetRow, appRow, appCol }) => {
      const initial = home(
        [item('Widget', widgetRow, 1, 4, 4), app('A', appRow, appCol)],
        5,
        6,
      );
      expect(move(initial, widgetRow, 1)).toEqual({
        status: 'impossible',
        attempts: 1,
      });
    },
  );

  it('keeps nonadjacent horizontal exchange local instead of moving an intervening app', () => {
    const middle = app('middle', 1, 3);
    const initial = home(
      [app('A', 1, 1), middle, item('Widget', 1, 4, 2, 2)],
      5,
      6,
    );
    const result = move(initial, 1, 4);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      A: { row: 1, col: 4 },
      middle: { row: 1, col: 3 },
      Widget: { row: 1, col: 1 },
    });
    expect(result.value.zones[0].items[1]).toBe(middle);
  });

  it('keeps an intervening app fixed when a narrow widget jumps to an empty target', () => {
    const middle = app('middle', 2, 1);
    const initial = home([item('Widget', 0, 0, 2, 2), middle], 5, 6);
    const result = move(initial, 3, 0, 'Widget');
    expect(result).toMatchObject({ status: 'ok', attempts: 0 });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(positions(result.value)).toEqual({
      Widget: { row: 3, col: 0 },
      middle: { row: 2, col: 1 },
    });
    expect(result.value.zones[0].items[1]).toBe(middle);
    const restored = move(result.value, 0, 0, 'Widget');
    expect(restored.status).toBe('ok');
    if (restored.status !== 'ok') throw new Error(restored.status);
    expect(restored.value).toEqual(initial);
  });
});
