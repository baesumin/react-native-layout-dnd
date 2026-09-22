import { HOME_GRID_MOVEMENT_POLICY } from '../../src/engine/movementPolicy';
import { computeMove } from '../../src/engine/move';
import { validateValue } from '../../src/engine/validation';
import type {
  CellPosition,
  CellSpan,
  PositionedItem,
  SpatialZone,
} from '../../src/types';

type Rect = { position: CellPosition; span: CellSpan };

// Tiny-board cell sets deliberately avoid the production rectangle/closure helpers.
function cells(rect: Rect): Set<string> {
  const result = new Set<string>();
  for (let r = 0; r < rect.span.rows; r++)
    for (let c = 0; c < rect.span.cols; c++)
      result.add(`${rect.position.row + r},${rect.position.col + c}`);
  return result;
}

const overlaps = (a: Set<string>, b: Set<string>) =>
  [...a].some(cell => b.has(cell));
const contains = (a: Set<string>, b: Set<string>) =>
  [...b].every(cell => a.has(cell));
const closed = (region: Set<string>, items: Set<string>[]) =>
  items.every(item => !overlaps(region, item) || contains(region, item));

function reference(
  zone: SpatialZone<null>,
  active: PositionedItem<null>,
  to: CellPosition,
) {
  const others = zone.items.filter(item => item !== active);
  if (
    active.placement !== 'insert' &&
    active.span.cols === zone.columns &&
    to.col === active.position.col &&
    to.row !== active.position.row
  ) {
    // Independently move labeled rows like an array block. Every row belonging
    // to a whole widget must receive the same offset, or the move cuts it.
    const rowOrder = Array.from({ length: zone.rows }, (_, row) => row);
    const sourceRows = rowOrder.splice(active.position.row, active.span.rows);
    rowOrder.splice(to.row, 0, ...sourceRows);
    const moved: PositionedItem<null>[] = [];
    for (const item of zone.items) {
      const offsets = new Set(
        Array.from({ length: item.span.rows }, (_, index) => {
          const row = item.position.row + index;
          return rowOrder.indexOf(row) - row;
        }),
      );
      if (offsets.size !== 1) return null;
      moved.push({
        ...item,
        position: {
          row: item.position.row + [...offsets][0],
          col: item.position.col,
        },
      });
    }
    return moved;
  }
  const targetCells = cells({ ...active, position: to });
  if (!others.some(item => overlaps(targetCells, cells(item))))
    return [...others, { ...active, position: to }];

  const originCells = cells(active);
  if (overlaps(originCells, targetCells)) {
    if (!closed(targetCells, others.map(cells))) return null;
    const rowStep = active.position.row - to.row;
    const colStep = active.position.col - to.col;
    const moved: PositionedItem<null>[] = [];
    for (const item of others) {
      const occupied = cells(item);
      if (!overlaps(targetCells, occupied)) {
        moved.push(item);
        continue;
      }
      // Follow each tiny-board cell independently. A widget is only movable if
      // all its cells finish in the vacated area with the same translation.
      const translations = new Set<string>();
      for (const cell of occupied) {
        const [originalRow, originalCol] = cell.split(',').map(Number);
        let row = originalRow;
        let col = originalCol;
        while (targetCells.has(`${row},${col}`)) {
          row += rowStep;
          col += colStep;
        }
        if (!originCells.has(`${row},${col}`)) return null;
        translations.add(`${row - originalRow},${col - originalCol}`);
      }
      if (translations.size !== 1) return null;
      const [rowOffset, colOffset] = [...translations][0]
        .split(',')
        .map(Number);
      moved.push({
        ...item,
        position: {
          row: item.position.row + rowOffset,
          col: item.position.col + colOffset,
        },
      });
    }
    return [...moved, { ...active, position: to }];
  }

  const regions: Rect[] = [];
  for (let row = 0; row < zone.rows; row++)
    for (let col = 0; col < zone.columns; col++)
      for (let rows = 1; rows <= zone.rows - row; rows++)
        for (let cols = 1; cols <= zone.columns - col; cols++) {
          const rect = { position: { row, col }, span: { rows, cols } };
          const occupied = cells(rect);
          if (
            contains(occupied, targetCells) &&
            closed(occupied, others.map(cells))
          )
            regions.push(rect);
        }
  regions.sort((a, b) => a.span.rows * a.span.cols - b.span.rows * b.span.cols);
  const target = regions[0];
  const targetArea = cells(target);
  const sources: Rect[] = [];
  for (let row = 0; row <= zone.rows - target.span.rows; row++)
    for (let col = 0; col <= zone.columns - target.span.cols; col++) {
      const source = { position: { row, col }, span: target.span };
      const area = cells(source);
      if (
        contains(area, cells(active)) &&
        !overlaps(area, targetArea) &&
        closed(area, zone.items.map(cells))
      )
        sources.push(source);
    }
  const distance = (source: Rect) =>
    Math.abs(
      target.position.row + active.position.row - source.position.row - to.row,
    ) +
    Math.abs(
      target.position.col + active.position.col - source.position.col - to.col,
    );
  sources.sort(
    (a, b) =>
      distance(a) - distance(b) ||
      a.position.row - b.position.row ||
      a.position.col - b.position.col,
  );
  const source = sources[0];
  if (!source) return null;
  const sourceArea = cells(source);
  return zone.items.map(item => {
    const from = contains(sourceArea, cells(item))
      ? source
      : contains(targetArea, cells(item))
        ? target
        : null;
    if (!from) return item;
    const destination = from === source ? target : source;
    return {
      ...item,
      position: {
        row: item.position.row + destination.position.row - from.position.row,
        col: item.position.col + destination.position.col - from.position.col,
      },
    };
  });
}

it.each([2, 4])(
  'matches independent row ordering and closed exchanges with widths up to %i',
  maxWidth => {
    let seed = 721;
    const random = (limit: number) => {
      seed = (seed * 16807) % 2147483647;
      return seed % limit;
    };
    const positions = (items: PositionedItem<null>[]) =>
      items.map(item => [item.id, item.position.row, item.position.col]).sort();
    for (let sample = 0; sample < 50; sample++) {
      const zone: SpatialZone<null> = {
        id: 'home',
        strategy: 'spatial',
        rows: 3,
        columns: 4,
        items: [],
      };
      for (let attempt = 0; attempt < 8; attempt++) {
        const span = { rows: 1 + random(2), cols: 1 + random(maxWidth) };
        const item: PositionedItem<null> = {
          id: String(attempt),
          data: null,
          placement: 'exchange',
          span,
          position: {
            row: random(zone.rows - span.rows + 1),
            col: random(zone.columns - span.cols + 1),
          },
        };
        if (!zone.items.some(other => overlaps(cells(other), cells(item))))
          zone.items.push(item);
      }
      const before = JSON.stringify(zone);
      for (const active of zone.items)
        for (let row = 0; row <= zone.rows - active.span.rows; row++)
          for (let col = 0; col <= zone.columns - active.span.cols; col++) {
            const to = { row, col };
            const expected = reference(zone, active, to);
            const input = {
              movementPolicy: HOME_GRID_MOVEMENT_POLICY,
              value: { zones: [zone] },
              itemId: active.id,
              to: {
                zoneId: zone.id,
                strategy: 'spatial' as const,
                position: to,
              },
              searchBudget: 100,
            };
            const result = computeMove(input);
            expect(result.status).toBe(expected ? 'ok' : 'impossible');
            if (result.status !== 'ok' || !expected) continue;
            expect(validateValue(result.value)).toEqual({ valid: true });
            expect(
              positions((result.value.zones[0] as SpatialZone<null>).items),
            ).toEqual(positions(expected));
            if (active.span.cols === zone.columns) {
              const reverse = computeMove({
                ...input,
                value: result.value,
                to: { ...input.to, position: active.position },
              });
              expect(reverse.status).toBe('ok');
              if (reverse.status !== 'ok') throw new Error(reverse.status);
              expect(
                positions((reverse.value.zones[0] as SpatialZone<null>).items),
              ).toEqual(positions(zone.items));
            }
            expect(
              computeMove({
                ...input,
                value: {
                  zones: [{ ...zone, items: [...zone.items].reverse() }],
                },
              }),
            ).toMatchObject({
              status: 'ok',
              to: result.to,
              attempts: result.attempts,
            });
          }
      expect(JSON.stringify(zone)).toBe(before);
    }
  },
);
