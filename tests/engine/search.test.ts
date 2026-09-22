import {
  createPlacementSearch,
  nearestCandidates,
} from '../../src/engine/search';
import type { GridItem } from '../../src/types';

const item = (id: string): GridItem<null> => ({
  id,
  span: { rows: 1, cols: 1 },
  data: null,
});

describe('placement search budget and resumability', () => {
  test('a zero-sized chunk does not consume candidates', () => {
    const search = createPlacementSearch({
      items: [item('A')],
      rows: 1,
      columns: 1,
      searchBudget: 1,
    });
    expect(search.advance(0)).toEqual({ status: 'pending', attempts: 0 });
    expect(search.advance(1)).toMatchObject({ status: 'ok', attempts: 1 });
  });

  test.each([1, 2, 3, 20])(
    'chunk size %i has the same traversal and result',
    chunk => {
      const input = {
        items: [item('A'), item('B'), item('C')],
        rows: 2,
        columns: 2,
        searchBudget: 20,
      };
      const expected = createPlacementSearch(input).advance(input.searchBudget);
      const search = createPlacementSearch(input);
      let actual = search.advance(chunk);
      while (actual.status === 'pending') {
        actual = search.advance(chunk);
      }
      expect(actual).toEqual(expected);
      expect(actual).toMatchObject({ status: 'ok', attempts: 6 });
      expect(search.advance(chunk)).toBe(actual);
    },
  );

  test.each([1, 2, 3])(
    'chunk size %i keeps the global unresolved result',
    chunk => {
      const input = {
        items: [item('A'), item('B'), item('C')],
        rows: 2,
        columns: 2,
        searchBudget: 5,
      };
      const search = createPlacementSearch(input);
      let result = search.advance(chunk);
      while (result.status === 'pending') {
        result = search.advance(chunk);
      }
      expect(result).toEqual({ status: 'unresolved', attempts: 5 });
    },
  );

  test.each([
    [2, 'unresolved'],
    [3, 'impossible'],
    [4, 'impossible'],
  ])(
    'budget %i distinguishes exhaustive failure from interruption',
    (budget, status) => {
      const result = createPlacementSearch({
        items: [{ ...item('B'), span: { rows: 2, cols: 2 } }],
        fixedItems: [
          {
            ...item('A'),
            span: { rows: 2, cols: 2 },
            position: { row: 0, col: 1 },
          },
        ],
        rows: 2,
        columns: 4,
        searchBudget: budget as number,
      }).advance(budget as number);
      expect(result).toEqual({
        status,
        attempts: Math.min(budget as number, 3),
      });
    },
  );

  test.each([
    [19, 'unresolved'],
    [20, 'impossible'],
  ] as const)(
    'budget %i counts repeated candidates after backtracking',
    (searchBudget, status) => {
      const result = createPlacementSearch({
        items: ['A', 'B'].map(id => ({
          ...item(id),
          span: { rows: 2, cols: 2 },
        })),
        rows: 3,
        columns: 3,
        searchBudget,
      }).advance(searchBudget);
      expect(result).toEqual({ status, attempts: searchBudget });
    },
  );

  test('nearest traversal matches distance/row/column sorting on small grids', () => {
    for (let rows = 1; rows <= 4; rows++) {
      for (let columns = 1; columns <= 4; columns++) {
        const cells = Array.from({ length: rows * columns }, (_, index) => ({
          row: Math.floor(index / columns),
          col: index % columns,
        }));
        for (const origin of cells) {
          const ordered = [...cells].sort(
            (a, b) =>
              Math.abs(a.row - origin.row) +
                Math.abs(a.col - origin.col) -
                Math.abs(b.row - origin.row) -
                Math.abs(b.col - origin.col) ||
              a.row - b.row ||
              a.col - b.col,
          );
          expect([...nearestCandidates(rows - 1, columns - 1, origin)]).toEqual(
            ordered,
          );
        }
      }
    }
  });

  test.each(['row', 'col'] as const)(
    'very large %s bounds do not preallocate a grid',
    axis => {
      const origin = { row: 0, col: 0, [axis]: Number.MAX_SAFE_INTEGER - 1 };
      const candidates = nearestCandidates(
        axis === 'row' ? Number.MAX_SAFE_INTEGER - 1 : 0,
        axis === 'col' ? Number.MAX_SAFE_INTEGER - 1 : 0,
        origin,
      );
      expect(candidates.next().value).toEqual(origin);
      expect(candidates.next().value).toEqual({
        ...origin,
        [axis]: origin[axis] - 1,
      });
    },
  );

  test('empty and oversized inputs finish without inspecting candidates', () => {
    expect(
      createPlacementSearch({
        items: [],
        rows: 1,
        columns: 1,
        searchBudget: 1,
      }).advance(0),
    ).toEqual({ status: 'ok', attempts: 0, placements: [] });
    expect(
      createPlacementSearch({
        items: [{ ...item('A'), span: { rows: 2, cols: 1 } }],
        rows: 1,
        columns: 1,
        searchBudget: 1,
      }).advance(0),
    ).toEqual({ status: 'impossible', attempts: 0 });
  });
});
