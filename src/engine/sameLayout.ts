import type { GridValue, GridZone } from '../types';

function sameZone<T>(a: GridZone<T>, b: GridZone<T>): boolean {
  if (
    a.strategy !== b.strategy ||
    a.rows !== b.rows ||
    a.columns !== b.columns ||
    a.items.length !== b.items.length
  )
    return false;
  if (a.strategy === 'ordered' && b.strategy === 'ordered') {
    return (
      a.itemSpan.rows === b.itemSpan.rows &&
      a.itemSpan.cols === b.itemSpan.cols &&
      a.items.every((item, index) => {
        const other = b.items[index];
        return (
          item.id === other.id &&
          (item.placement ?? 'exchange') === (other.placement ?? 'exchange') &&
          item.span.rows === other.span.rows &&
          item.span.cols === other.span.cols
        );
      })
    );
  }
  if (a.strategy !== 'spatial' || b.strategy !== 'spatial') return false;
  const byId = new Map(b.items.map(item => [item.id, item]));
  return a.items.every(item => {
    const other = byId.get(item.id);
    return (
      other !== undefined &&
      (item.placement ?? 'exchange') === (other.placement ?? 'exchange') &&
      item.span.rows === other.span.rows &&
      item.span.cols === other.span.cols &&
      item.position.row === other.position.row &&
      item.position.col === other.position.col
    );
  });
}

/** Compare validated layouts. Data, responses and spatial array order are not layout. */
export function hasSameLayout<T>(a: GridValue<T>, b: GridValue<T>): boolean {
  if (a === b) return true;
  if (a.zones.length !== b.zones.length) return false;
  const byId = new Map(b.zones.map(zone => [zone.id, zone]));
  return a.zones.every(zone => {
    const other = byId.get(zone.id);
    return other !== undefined && sameZone(zone, other);
  });
}
