import { packItems } from '../../src/engine/pack';
import type { GridItem } from '../../src/types';

const item = (id: string, rows = 1, cols = 1): GridItem<{ id: string }> => ({
  id,
  span: { rows, cols },
  data: { id },
});

describe('packItems', () => {
  test('extra input fields do not become internal search options', () => {
    const input = {
      items: [item('A')],
      rows: 1,
      columns: 1,
      searchBudget: 1,
      fixedItems: null,
    };
    expect(packItems(input)).toMatchObject({
      status: 'ok',
      placements: [{ id: 'A', position: { row: 0, col: 0 } }],
    });
  });

  test('input order governs placement and data/span references survive', () => {
    const items = [item('small'), item('large', 2, 2)];
    for (const value of items) {
      Object.freeze(value.span);
      Object.freeze(value.data);
      Object.freeze(value);
    }
    Object.freeze(items);
    const result = packItems({ items, rows: 2, columns: 3, searchBudget: 10 });
    expect(result).toMatchObject({
      status: 'ok',
      placements: [
        { id: 'small', position: { row: 0, col: 0 } },
        { id: 'large', position: { row: 0, col: 1 } },
      ],
    });
    if (result.status !== 'ok') {
      throw new Error('Expected successful packing');
    }
    result.placements.forEach((placement, index) => {
      expect(placement.span).toBe(items[index].span);
      expect(placement.data).toBe(items[index].data);
    });
  });

  test('backtracks instead of treating the first greedy failure as impossible', () => {
    const result = packItems({
      items: [item('A'), item('B'), item('C', 3, 2)],
      rows: 3,
      columns: 3,
      searchBudget: 1000,
    });
    expect(result).toMatchObject({
      status: 'ok',
      placements: [
        { id: 'A', position: { row: 0, col: 0 } },
        { id: 'B', position: { row: 1, col: 0 } },
        { id: 'C', position: { row: 0, col: 1 } },
      ],
    });
  });

  test('failed candidates consume budget and no partial result escapes', () => {
    const input = { items: [item('A'), item('B')], rows: 1, columns: 2 };
    expect(packItems({ ...input, searchBudget: 2 })).toEqual({
      status: 'unresolved',
    });
    expect(packItems({ ...input, searchBudget: 3 })).toMatchObject({
      status: 'ok',
    });
  });

  test('empty input succeeds and geometric impossibility differs from invalid input', () => {
    expect(
      packItems({ items: [], rows: 1, columns: 1, searchBudget: 1 }),
    ).toEqual({
      status: 'ok',
      placements: [],
    });
    expect(
      packItems({
        items: [item('wide', 1, 3)],
        rows: 2,
        columns: 2,
        searchBudget: 1,
      }),
    ).toEqual({
      status: 'impossible',
    });
    expect(
      packItems({
        items: [item('A'), item('B')],
        rows: 1,
        columns: 1,
        searchBudget: 1,
      }),
    ).toEqual({
      status: 'impossible',
    });
    expect(
      packItems({
        items: [item('A', 0)],
        rows: 2,
        columns: 2,
        searchBudget: 1,
      }),
    ).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'invalid-span' })],
    });
    expect(
      packItems({
        items: [item('A'), item('A')],
        rows: 2,
        columns: 2,
        searchBudget: 1,
      }),
    ).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'duplicate-id' })],
    });
  });
});
