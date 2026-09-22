/* eslint-disable no-bitwise -- Tiny-board occupancy oracle uses one bit per cell. */
import { packItems } from '../../src/engine/pack';
import {
  createPlacementSearch,
  type PlacementSearchResult,
} from '../../src/engine/search';
import type { CellPosition, CellSpan, PositionedItem } from '../../src/types';

/** Exhaustive occupancy sets on tiny boards; independent of DFS and candidate priorities. */
function feasible(rows: number, columns: number, spans: CellSpan[]): boolean {
  let occupied = new Set([0]);
  for (const span of spans) {
    const footprints: number[] = [];
    for (let row = 0; row <= rows - span.rows; row++) {
      for (let col = 0; col <= columns - span.cols; col++) {
        let mask = 0;
        for (let dr = 0; dr < span.rows; dr++) {
          for (let dc = 0; dc < span.cols; dc++)
            mask |= 1 << ((row + dr) * columns + col + dc);
        }
        footprints.push(mask);
      }
    }
    const next = new Set<number>();
    for (const state of occupied) {
      for (const mask of footprints)
        if ((state & mask) === 0) next.add(state | mask);
    }
    occupied = next;
  }
  return occupied.size > 0;
}

it.each([
  [2, 3],
  [3, 3],
])(
  'matches exhaustive occupancy feasibility on a %sx%s board',
  (rows, columns) => {
    const choices = [
      { rows: 1, cols: 1 },
      { rows: 1, cols: 2 },
      { rows: 2, cols: 1 },
      { rows: 2, cols: 2 },
    ];
    for (const a of choices)
      for (const b of choices)
        for (const c of choices) {
          const spans = [a, b, c];
          const items = spans.map((span, index) => ({
            id: String(index),
            span,
            data: { index },
          }));
          const input = { rows, columns, items, searchBudget: 10000 };
          const result = packItems(input);
          expect(result.status).toBe(
            feasible(rows, columns, spans) ? 'ok' : 'impossible',
          );
          expect(packItems(input)).toEqual(result);
          if (result.status !== 'ok') continue;
          const taken = new Set<number>();
          result.placements.forEach((item, index) => {
            expect(item.id).toBe(items[index].id);
            expect(item.span).toBe(items[index].span);
            expect(item.data).toBe(items[index].data);
            expect(item.position.row).toBeGreaterThanOrEqual(0);
            expect(item.position.col).toBeGreaterThanOrEqual(0);
            expect(item.position.row + item.span.rows).toBeLessThanOrEqual(
              rows,
            );
            expect(item.position.col + item.span.cols).toBeLessThanOrEqual(
              columns,
            );
            for (let dr = 0; dr < item.span.rows; dr++)
              for (let dc = 0; dc < item.span.cols; dc++) {
                const cell =
                  (item.position.row + dr) * columns + item.position.col + dc;
                expect(taken.has(cell)).toBe(false);
                taken.add(cell);
              }
          });
        }
  },
);

type OracleBoard = {
  name: string;
  rows: number;
  columns: number;
  items: PositionedItem<null>[];
  fixedItems: PositionedItem<null>[];
};

function positioned(
  id: string,
  row: number,
  col: number,
  rows = 1,
  cols = 1,
): PositionedItem<null> {
  return { id, data: null, position: { row, col }, span: { rows, cols } };
}

// These tiny boards fit in a bitmask. Spans fit individually and total area
// does not exceed capacity, so the engine's free impossibility shortcuts do
// not change the candidate count compared with exhaustive reference search.
const budgetBoards: OracleBoard[] = [
  {
    name: 'colliding original anchor before a swap',
    rows: 1,
    columns: 2,
    items: [positioned('B', 0, 1)],
    fixedItems: [positioned('A', 0, 1)],
  },
  {
    name: 'four colliders around a fixed large item',
    rows: 2,
    columns: 4,
    items: [
      positioned('B', 0, 0),
      positioned('C', 0, 1),
      positioned('D', 1, 0),
      positioned('E', 1, 1),
    ],
    fixedItems: [positioned('A', 0, 0, 2, 2)],
  },
  {
    name: 'backtracking with fixed obstacles',
    rows: 3,
    columns: 3,
    items: [positioned('B', 1, 1), positioned('C', 1, 2, 2, 1)],
    fixedItems: [positioned('A', 1, 1, 1, 2), positioned('E', 0, 1)],
  },
  {
    name: 'free area fragmented by a fixed rectangle',
    rows: 2,
    columns: 4,
    items: [positioned('B', 0, 2, 2, 2)],
    fixedItems: [positioned('A', 0, 1, 2, 2)],
  },
  {
    name: 'packing backtracks from the first available anchor',
    rows: 3,
    columns: 3,
    items: [
      positioned('A', 0, 0),
      positioned('B', 0, 1),
      positioned('C', 0, 1, 3, 2),
    ],
    fixedItems: [],
  },
  {
    name: 'exhaustive backtracking proves impossibility',
    rows: 3,
    columns: 3,
    items: [positioned('A', 0, 0, 2, 2), positioned('B', 1, 1, 2, 2)],
    fixedItems: [],
  },
  {
    name: 'equal distances prefer the earlier row and column',
    rows: 3,
    columns: 3,
    items: [positioned('moving', 1, 1)],
    fixedItems: [positioned('fixed', 1, 1)],
  },
];

/** Independent reference: eager sorted anchors, bitmasks, recursive traversal. */
function referenceSearch(
  board: OracleBoard,
  budget: number,
): PlacementSearchResult<null> {
  function footprint(position: CellPosition, span: CellSpan): number {
    let mask = 0;
    for (let row = position.row; row < position.row + span.rows; row++) {
      for (let col = position.col; col < position.col + span.cols; col++) {
        mask |= 1 << (row * board.columns + col);
      }
    }
    return mask;
  }

  const candidates = board.items.map(item => {
    const positions: CellPosition[] = [];
    for (let row = 0; row <= board.rows - item.span.rows; row++) {
      for (let col = 0; col <= board.columns - item.span.cols; col++) {
        positions.push({ row, col });
      }
    }
    return positions.map(position => ({
      position,
      mask: footprint(position, item.span),
    }));
  });
  const fixedMask = board.fixedItems.reduce(
    (mask, item) => mask | footprint(item.position, item.span),
    0,
  );
  let attempts = 0;

  function visit(
    occupied: number,
    placements: PositionedItem<null>[],
  ): PlacementSearchResult<null> {
    const index = placements.length;
    if (index === board.items.length) {
      return { status: 'ok', placements, attempts };
    }
    for (const candidate of candidates[index]) {
      if (attempts === budget) {
        return { status: 'unresolved', attempts };
      }
      attempts++;
      if ((occupied & candidate.mask) !== 0) continue;
      const result = visit(occupied | candidate.mask, [
        ...placements,
        { ...board.items[index], position: candidate.position },
      ]);
      if (result.status !== 'impossible') return result;
    }
    return { status: 'impossible', attempts };
  }
  return visit(fixedMask, []);
}

it('matches independent row-major DFS at every budget through completion', () => {
  for (const board of budgetBoards) {
    const full = referenceSearch(board, 1000);
    expect({ board: board.name, status: full.status }).not.toEqual({
      board: board.name,
      status: 'unresolved',
    });
    for (
      let searchBudget = 1;
      searchBudget <= full.attempts + 1;
      searchBudget++
    ) {
      const expected = referenceSearch(board, searchBudget);
      const actual = createPlacementSearch({
        items: board.items,
        fixedItems: board.fixedItems,
        rows: board.rows,
        columns: board.columns,
        searchBudget,
      }).advance(searchBudget);
      // Include case/budget in mismatch output instead of hiding a failure
      // somewhere inside the bounded exhaustive loop.
      expect({ board: board.name, searchBudget, result: actual }).toEqual({
        board: board.name,
        searchBudget,
        result: expected,
      });
    }
  }
});
