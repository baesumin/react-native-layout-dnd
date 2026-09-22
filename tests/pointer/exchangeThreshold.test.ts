import {
  DEFAULT_GRID_MOVEMENT_POLICY,
  HOME_GRID_MOVEMENT_POLICY,
} from '../../src/engine/movementPolicy';
import { readPointerTarget } from '../../src/pointer/geometry';
import {
  EMPTY_MOTION,
  type MeasuredZone,
  type UiMotion,
} from '../../src/runtime/gridRuntime';
import { computeMove } from '../../src/engine/move';
import type { ItemPlacement, PositionedItem } from '../../src/types';

function item(
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
  placement: ItemPlacement | undefined = 'insert',
): PositionedItem<undefined> {
  return {
    id,
    data: undefined,
    position: { row, col },
    span: { rows, cols },
    ...(placement === undefined ? {} : { placement }),
  };
}

function dragging(
  items: PositionedItem<undefined>[],
  rows: number,
  columns: number,
  rowGap = 0,
  columnGap = 0,
) {
  const active = items.find(entry => entry.id === 'active')!;
  const cellWidth = 50;
  const cellHeight = 60;
  const measured: MeasuredZone = {
    zone: { id: 'home', strategy: 'spatial', rows, columns, items },
    geometry: {
      mode: 'fixed',
      cellWidth,
      cellHeight,
      rowGap,
      columnGap,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
    },
    cells: { cellWidth, cellHeight },
    pixelRatio: 1,
    rect: {
      x: 30,
      y: 40,
      width: columns * cellWidth + (columns - 1) * columnGap,
      height: rows * cellHeight + (rows - 1) * rowGap,
    },
  };
  const width =
    active.span.cols * cellWidth + (active.span.cols - 1) * columnGap;
  const height =
    active.span.rows * cellHeight + (active.span.rows - 1) * rowGap;
  const x = measured.rect.x + active.position.col * (cellWidth + columnGap);
  const y = measured.rect.y + active.position.row * (cellHeight + rowGap);
  const motion: UiMotion = {
    ...EMPTY_MOTION,
    movementPolicy: HOME_GRID_MOVEMENT_POLICY,
    phase: 'dragging',
    token: 1,
    seq: 1,
    itemId: active.id,
    sourceZoneId: 'home',
    zones: [measured],
    outlet: { x: 0, y: 0, width: 1000, height: 1000 },
    target: {
      zoneId: 'home',
      strategy: 'spatial',
      position: active.position,
    },
    span: active.span,
    width,
    height,
    x,
    y,
    gripX: 0.5,
    gripY: 0.5,
  };
  // Distances use one cell pitch, not the active widget's full width/height.
  const pointer = (colDistance: number, rowDistance: number) =>
    [
      x + width / 2 + colDistance * (cellWidth + columnGap),
      y + height / 2 + rowDistance * (cellHeight + rowGap),
    ] as const;
  return { motion, pointer };
}

function phoneWidget() {
  return dragging(
    [
      item('A', 0, 0),
      item('B', 0, 1),
      item('C', 0, 2),
      item('active', 1, 0, 4, 4, 'exchange'),
    ],
    5,
    4,
  );
}

describe('distance threshold for spatial region exchanges', () => {
  it.each([0.7, 0.79])(
    'keeps the phone 4×4 widget at its original logical row after moving %f cell pitches',
    distance => {
      const { motion, pointer } = phoneWidget();
      const next = readPointerTarget(motion, ...pointer(0, -distance));
      expect(next.target).toEqual(motion.target);
      // The floating widget follows the finger while the exchange waits.
      expect(next.y).toBeLessThan(motion.y);
    },
  );

  it('switches immediately past 80% and resolves the same target again on release', () => {
    const { motion, pointer } = phoneWidget();
    const absolute = pointer(0, -0.801);
    const preview = readPointerTarget(motion, ...absolute);
    expect(preview.target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 0 },
    });
    expect(
      readPointerTarget(
        { ...motion, ...preview, seq: motion.seq + 1 },
        ...absolute,
      ),
    ).toEqual(preview);
  });

  it('holding the pointer below 80% never substitutes dwell for distance', () => {
    const { motion, pointer } = phoneWidget();
    let current = motion;
    for (let repeat = 0; repeat < 10; repeat++) {
      const next = readPointerTarget(current, ...pointer(0, -0.79));
      expect(next.target).toEqual(motion.target);
      current = { ...current, ...next, seq: current.seq + 1 };
    }
  });

  it('keeps the shown exchange through small reversals and returns at the empty-source boundary', () => {
    const { motion, pointer } = phoneWidget();
    const preview = readPointerTarget(motion, ...pointer(0, -0.81));
    let current = { ...motion, ...preview };
    for (const distance of [-0.75, -0.5, -0.4]) {
      const next = readPointerTarget(current, ...pointer(0, distance));
      expect(next.target).toEqual(preview.target);
      current = { ...current, ...next };
    }
    expect(readPointerTarget(current, ...pointer(0, -0.37)).target).toEqual(
      motion.target,
    );
  });

  it('uses the original widget anchor when reentering its source zone with no previous target', () => {
    const { motion, pointer } = phoneWidget();
    const reentering = { ...motion, target: null, seq: 2 };
    expect(readPointerTarget(reentering, ...pointer(0, -0.7)).target).toEqual(
      motion.target,
    );
    expect(readPointerTarget(reentering, ...pointer(0, -0.801)).target).toEqual(
      {
        zoneId: 'home',
        strategy: 'spatial',
        position: { row: 0, col: 0 },
      },
    );
  });

  it('requires 80% of each cell pitch when a fast pointer update crosses multiple rows', () => {
    const { motion, pointer } = dragging(
      [
        item('active', 0, 0, 1, 1, 'exchange'),
        item('B', 1, 0),
        item('C', 2, 0),
      ],
      4,
      1,
    );
    const first = readPointerTarget(motion, ...pointer(0, 1.6));
    expect(first.target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 1, col: 0 },
    });
    const second = readPointerTarget(motion, ...pointer(0, 1.81));
    expect(second.target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 2, col: 0 },
    });
    expect(
      readPointerTarget({ ...motion, ...first }, ...pointer(0, 1.81)).target,
    ).toEqual(second.target);
  });

  it('uses the horizontal cell pitch including its gap for a wide widget exchange', () => {
    const { motion, pointer } = dragging(
      [
        item('A', 0, 0),
        item('B', 2, 0),
        item('active', 0, 1, 4, 4, 'exchange'),
      ],
      4,
      5,
      8,
      10,
    );
    expect(readPointerTarget(motion, ...pointer(-0.7, 0)).target).toEqual(
      motion.target,
    );
    expect(readPointerTarget(motion, ...pointer(-0.79, 0)).target).toEqual(
      motion.target,
    );
    expect(readPointerTarget(motion, ...pointer(-0.801, 0)).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 0 },
    });
  });

  it.each([
    { originRow: 0, otherRow: 2, direction: 1, waitingRow: 2, targetRow: 3 },
    { originRow: 3, otherRow: 2, direction: -1, waitingRow: 1, targetRow: 0 },
  ])(
    'requires 80% when a full-width widget crosses an app into empty row $targetRow',
    ({ originRow, otherRow, direction, waitingRow, targetRow }) => {
      const { motion, pointer } = dragging(
        [
          item('active', originRow, 0, 2, 4, 'exchange'),
          item('app', otherRow, 1),
        ],
        5,
        4,
        8,
      );
      const waiting = readPointerTarget(
        motion,
        ...pointer(0, direction * 2.79),
      );
      expect(waiting.target).toEqual({
        zoneId: 'home',
        strategy: 'spatial',
        position: { row: waitingRow, col: 0 },
      });
      const absolute = pointer(0, direction * 2.801);
      const preview = readPointerTarget({ ...motion, ...waiting }, ...absolute);
      expect(preview.target).toEqual({
        zoneId: 'home',
        strategy: 'spatial',
        position: { row: targetRow, col: 0 },
      });
      expect(readPointerTarget(motion, ...absolute)).toEqual(preview);
      expect(readPointerTarget({ ...motion, ...preview }, ...absolute)).toEqual(
        preview,
      );
    },
  );

  it('uses the source anchor when a wide widget reenters at an empty target beyond an app', () => {
    const active = item('active', 0, 0, 2, 4);
    delete active.placement;
    const { motion, pointer } = dragging([active, item('app', 2, 1)], 5, 4);
    const reentering = { ...motion, target: null, seq: 2 };
    expect(readPointerTarget(reentering, ...pointer(0, 2.79)).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 2, col: 0 },
    });
    expect(readPointerTarget(reentering, ...pointer(0, 2.801)).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 3, col: 0 },
    });
  });

  it.each([
    { columns: 4, cols: 2, placement: 'exchange' as const },
    { columns: 4, cols: 4, placement: 'insert' as const },
  ])(
    'keeps the existing empty-target threshold for span $cols of $columns columns with $placement placement',
    ({ columns, cols, placement }) => {
      const { motion, pointer } = dragging(
        [item('active', 0, 0, 2, cols, placement), item('app', 2, 1)],
        5,
        columns,
      );
      expect(readPointerTarget(motion, ...pointer(0, 2.63)).target).toEqual({
        zoneId: 'home',
        strategy: 'spatial',
        position: { row: 3, col: 0 },
      });
    },
  );

  it('keeps 62% when other items are outside a full-width widget movement corridor', () => {
    const { motion, pointer } = dragging(
      [item('active', 0, 0, 2, 4, 'exchange'), item('app', 4, 1)],
      5,
      4,
    );
    expect(readPointerTarget(motion, ...pointer(0, 0.63)).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 1, col: 0 },
    });
  });

  it('keeps insert-only app moves responsive at the existing 62% threshold', () => {
    const { motion, pointer } = dragging(
      [item('active', 0, 0), item('B', 0, 1)],
      1,
      4,
    );
    expect(readPointerTarget(motion, ...pointer(0.63, 0)).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 1 },
    });
  });

  it('keeps an exchange widget moving into empty cells at the existing 62% threshold', () => {
    const { motion, pointer } = dragging(
      [item('active', 1, 0, 2, 2, 'exchange')],
      3,
      2,
    );
    expect(readPointerTarget(motion, ...pointer(0, -0.63)).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 0 },
    });
  });

  it('treats an omitted active placement as exchange', () => {
    const active = item('active', 1, 0, 4, 4);
    delete active.placement;
    const { motion, pointer } = dragging([item('A', 0, 0), active], 5, 4);
    expect(readPointerTarget(motion, ...pointer(0, -0.79)).target).toEqual(
      motion.target,
    );
    expect(readPointerTarget(motion, ...pointer(0, -0.801)).target).toEqual({
      zoneId: 'home',
      strategy: 'spatial',
      position: { row: 0, col: 0 },
    });
  });

  it.each(['exchange', undefined] as const)(
    'uses 80% when an insert app collides with a target whose placement is %s',
    placement => {
      const target = item('target', 0, 1);
      if (placement === undefined) delete target.placement;
      else target.placement = placement;
      const { motion, pointer } = dragging(
        [item('active', 0, 0), target],
        1,
        4,
      );
      expect(readPointerTarget(motion, ...pointer(0.79, 0)).target).toEqual(
        motion.target,
      );
      expect(readPointerTarget(motion, ...pointer(0.801, 0)).target).toEqual({
        zoneId: 'home',
        strategy: 'spatial',
        position: { row: 0, col: 1 },
      });
    },
  );

  it.each([
    { originRow: 0, widgetRow: 1, direction: 1, finalRow: 4 },
    { originRow: 4, widgetRow: 0, direction: -1, finalRow: 0 },
  ])(
    'rotates the app row from $originRow across a 4×4 widget only after 80%, including release',
    ({ originRow, widgetRow, direction, finalRow }) => {
      const { motion, pointer } = dragging(
        [
          item('active', originRow, 1),
          item('neighbor', originRow, 3),
          item('widget', widgetRow, 0, 4, 4, 'exchange'),
        ],
        5,
        4,
        8,
      );
      const value = { zones: motion.zones.map(measured => measured.zone) };
      const waiting = readPointerTarget(
        motion,
        ...pointer(0, direction * 0.79),
      );
      expect(waiting.target).toEqual(motion.target);
      expect(
        computeMove({
          movementPolicy: HOME_GRID_MOVEMENT_POLICY,
          value,
          itemId: 'active',
          to: waiting.target!,
          searchBudget: 1,
        }),
      ).toMatchObject({ status: 'ok', changed: false });

      const absolute = pointer(0, direction * 0.801);
      const preview = readPointerTarget(motion, ...absolute);
      expect(preview.target).toEqual({
        zoneId: 'home',
        strategy: 'spatial',
        position: { row: originRow + direction, col: 1 },
      });
      const proposed = computeMove({
        movementPolicy: HOME_GRID_MOVEMENT_POLICY,
        value,
        itemId: 'active',
        to: preview.target!,
        searchBudget: 1,
      });
      expect(proposed).toMatchObject({
        status: 'ok',
        changed: true,
        to: { position: { row: finalRow, col: 1 } },
        value: {
          zones: [
            {
              items: [
                { id: 'active', position: { row: finalRow, col: 1 } },
                { id: 'neighbor', position: { row: finalRow, col: 3 } },
                {
                  id: 'widget',
                  position: { row: widgetRow - direction, col: 0 },
                },
              ],
            },
          ],
        },
      });

      const release = readPointerTarget({ ...motion, ...preview }, ...absolute);
      expect(release).toEqual(preview);
      expect(
        computeMove({
          movementPolicy: HOME_GRID_MOVEMENT_POLICY,
          value,
          itemId: 'active',
          to: release.target!,
          searchBudget: 1,
        }),
      ).toEqual(proposed);
    },
  );

  it.each([
    { originRow: 2, widgetRow: 3, direction: 1, finalRow: 4, col: 0 },
    { originRow: 2, widgetRow: 3, direction: 1, finalRow: 4, col: 2 },
    { originRow: 4, widgetRow: 2, direction: -1, finalRow: 2, col: 0 },
    { originRow: 4, widgetRow: 2, direction: -1, finalRow: 2, col: 2 },
  ])(
    'uses the same 80% preview and release for a 2×2 widget at column $col with an app from row $originRow',
    ({ originRow, widgetRow, direction, finalRow, col }) => {
      const fixed = item('outside', originRow, col === 0 ? 3 : 0);
      const { motion, pointer } = dragging(
        [
          item('active', originRow, col),
          item('neighbor', originRow, col + 1),
          item('widget', widgetRow, col, 2, 2, 'exchange'),
          fixed,
        ],
        5,
        4,
        8,
        6,
      );
      expect(
        readPointerTarget(motion, ...pointer(0, direction * 0.79)).target,
      ).toEqual(motion.target);

      const value = { zones: motion.zones.map(measured => measured.zone) };
      let current = motion;
      let firstProposal: ReturnType<typeof computeMove> | undefined;
      for (const distance of [0.801, 1.801]) {
        const absolute = pointer(1, direction * distance);
        const preview = readPointerTarget(current, ...absolute);
        const proposed = computeMove({
          movementPolicy: HOME_GRID_MOVEMENT_POLICY,
          value,
          itemId: 'active',
          to: preview.target!,
          searchBudget: 1,
        });
        expect(proposed).toMatchObject({
          status: 'ok',
          to: { position: { row: finalRow, col } },
          value: {
            zones: [
              {
                items: [
                  { id: 'active', position: { row: finalRow, col } },
                  {
                    id: 'neighbor',
                    position: { row: finalRow, col: col + 1 },
                  },
                  {
                    id: 'widget',
                    position: { row: widgetRow - direction, col },
                  },
                  fixed,
                ],
              },
            ],
          },
        });
        if (firstProposal) expect(proposed).toEqual(firstProposal);
        else firstProposal = proposed;
        current = { ...current, ...preview, seq: current.seq + 1 };
        const release = readPointerTarget(current, ...absolute);
        expect(release.target).toEqual(preview.target);
        expect(
          computeMove({
            movementPolicy: HOME_GRID_MOVEMENT_POLICY,
            value,
            itemId: 'active',
            to: release.target!,
            searchBudget: 1,
          }),
        ).toEqual(proposed);
      }
    },
  );

  it.each([
    { originRow: 0, widgetRow: 1, direction: 1, finalRow: 4 },
    { originRow: 4, widgetRow: 0, direction: -1, finalRow: 0 },
  ])(
    'keeps one app-row rotation while the pointer travels through the widget from row $originRow',
    ({ originRow, widgetRow, direction, finalRow }) => {
      const { motion, pointer } = dragging(
        [
          item('active', originRow, 1),
          item('widget', widgetRow, 0, 4, 4, 'exchange'),
        ],
        5,
        4,
      );
      const value = { zones: motion.zones.map(measured => measured.zone) };
      let current = motion;
      let firstProposal: ReturnType<typeof computeMove> | undefined;
      for (const distance of [0.801, 1.801, 2.801, 3.801]) {
        const preview = readPointerTarget(
          current,
          ...pointer(1, direction * distance),
        );
        const proposed = computeMove({
          movementPolicy: HOME_GRID_MOVEMENT_POLICY,
          value,
          itemId: 'active',
          to: preview.target!,
          searchBudget: 1,
        });
        expect(proposed).toMatchObject({
          status: 'ok',
          to: { position: { row: finalRow, col: 1 } },
        });
        if (firstProposal) expect(proposed).toEqual(firstProposal);
        else firstProposal = proposed;
        current = { ...current, ...preview, seq: current.seq + 1 };
      }

      const returned = readPointerTarget(current, ...pointer(0, 0));
      expect(returned.target).toEqual(motion.target);
      expect(
        computeMove({
          movementPolicy: HOME_GRID_MOVEMENT_POLICY,
          value,
          itemId: 'active',
          to: returned.target!,
          searchBudget: 1,
        }),
      ).toMatchObject({ status: 'ok', changed: false });
    },
  );
});

describe('shared configurable pointer and movement policies', () => {
  it('does not delay a neutral full-width move over an untouched intermediate item', () => {
    const { motion, pointer } = dragging(
      [item('active', 0, 0, 2, 7, 'exchange'), item('middle', 2, 3)],
      9,
      7,
    );
    motion.movementPolicy = DEFAULT_GRID_MOVEMENT_POLICY;
    const preview = readPointerTarget(motion, ...pointer(0, 2.7));
    expect(preview.target).toMatchObject({ position: { row: 3, col: 0 } });
    const result = computeMove({
      value: { zones: motion.zones.map(entry => entry.zone) },
      itemId: 'active',
      to: preview.target!,
      movementPolicy: motion.movementPolicy,
    });
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        zones: [
          {
            items: [
              { id: 'active', position: { row: 3, col: 0 } },
              { id: 'middle', position: { row: 2, col: 3 } },
            ],
          },
        ],
      },
    });
    expect(
      readPointerTarget({ ...motion, ...preview }, ...pointer(0, 2.7)),
    ).toEqual(preview);
  });

  it('shares opt-in row rotation and a custom exchange threshold on a 9×7 grid', () => {
    const { motion, pointer } = dragging(
      [item('active', 0, 0, 2, 7, 'exchange'), item('middle', 2, 3)],
      9,
      7,
    );
    motion.movementPolicy = {
      rowRotation: 'full-width',
      pointer: { exchangeThreshold: 0.9 },
    };
    expect(readPointerTarget(motion, ...pointer(0, 2.85)).target).toMatchObject(
      { position: { row: 2, col: 0 } },
    );
    const preview = readPointerTarget(motion, ...pointer(0, 2.901));
    expect(preview.target).toMatchObject({ position: { row: 3, col: 0 } });
    const result = computeMove({
      value: { zones: motion.zones.map(entry => entry.zone) },
      itemId: 'active',
      to: preview.target!,
      movementPolicy: motion.movementPolicy,
    });
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        zones: [
          {
            items: [
              { id: 'active', position: { row: 3, col: 0 } },
              { id: 'middle', position: { row: 0, col: 3 } },
            ],
          },
        ],
      },
    });
    expect(
      readPointerTarget({ ...motion, ...preview }, ...pointer(0, 2.901)),
    ).toEqual(preview);
  });

  it('uses exchange sensitivity when custom priorities choose exchange between insert items', () => {
    const { motion, pointer } = dragging(
      [item('active', 0, 0), item('B', 0, 1)],
      1,
      7,
    );
    motion.movementPolicy = { candidateOrder: ['exchange', 'insert'] };
    expect(readPointerTarget(motion, ...pointer(0.7, 0)).target).toEqual(
      motion.target,
    );
    expect(
      readPointerTarget(motion, ...pointer(0.801, 0)).target,
    ).toMatchObject({ position: { row: 0, col: 1 } });
  });

  it('allows exchange sensitivity below the ordinary cell hysteresis', () => {
    const { motion, pointer } = dragging(
      [item('active', 0, 0, 1, 1, 'exchange'), item('B', 0, 1)],
      1,
      7,
    );
    motion.movementPolicy = { pointer: { exchangeThreshold: 0.55 } };
    expect(readPointerTarget(motion, ...pointer(0.54, 0)).target).toEqual(
      motion.target,
    );
    const preview = readPointerTarget(motion, ...pointer(0.56, 0));
    expect(preview.target).toMatchObject({ position: { row: 0, col: 1 } });
    const release = readPointerTarget(
      { ...motion, ...preview },
      ...pointer(0.56, 0),
    );
    expect(release).toEqual(preview);
    const input = {
      value: { zones: motion.zones.map(entry => entry.zone) },
      itemId: 'active',
      movementPolicy: motion.movementPolicy,
    };
    const proposed = computeMove({ ...input, to: preview.target! });
    expect(proposed).toMatchObject({
      status: 'ok',
      to: { position: { row: 0, col: 1 } },
    });
    expect(computeMove({ ...input, to: release.target! })).toEqual(proposed);
  });

  it('measures ordinary cell hysteresis in cell pitches including gaps', () => {
    const { motion, pointer } = dragging([item('active', 0, 0)], 1, 7, 0, 10);
    motion.movementPolicy = { pointer: { cellHysteresis: 0.2 } };
    expect(readPointerTarget(motion, ...pointer(0.69, 0)).target).toEqual(
      motion.target,
    );
    expect(
      readPointerTarget(motion, ...pointer(0.701, 0)).target,
    ).toMatchObject({ position: { row: 0, col: 1 } });
  });

  it('measures zone entry margins in logical pixels independently of cell size', () => {
    const { motion } = dragging([item('active', 0, 0)], 1, 7);
    const reentering = { ...motion, target: null, seq: 2 };
    expect(readPointerTarget(reentering, 32, 70).target).toBeNull();
    reentering.movementPolicy = { pointer: { boundaryHysteresis: 0 } };
    expect(readPointerTarget(reentering, 32, 70).target).toMatchObject({
      position: { row: 0, col: 0 },
    });
  });
});
