import type { LayoutLocation, LayoutState } from '../contracts';
import type { GridValue, ItemLocation } from '../types';

/** Where a validated grid value places the item, or null when it is absent. */
export function itemLocation<T>(
  value: GridValue<T>,
  itemId: string,
): ItemLocation | null {
  const zone = value.zones.find(candidate =>
    candidate.items.some(item => item.id === itemId),
  );
  if (!zone) return null;
  const index = zone.items.findIndex(item => item.id === itemId);
  return zone.strategy === 'ordered'
    ? { zoneId: zone.id, strategy: 'ordered', index }
    : {
        zoneId: zone.id,
        strategy: 'spatial',
        position: zone.items[index].position,
      };
}

export function sameItemLocation(
  first: ItemLocation,
  second: ItemLocation | null,
): boolean {
  if (!second || first.zoneId !== second.zoneId) return false;
  return first.strategy === 'ordered' && second.strategy === 'ordered'
    ? first.index === second.index
    : first.strategy === 'spatial' &&
        second.strategy === 'spatial' &&
        first.position.row === second.position.row &&
        first.position.col === second.position.col;
}

/** Where a validated layout state places the item, or null when it is absent. */
export function layoutLocation<T>(
  value: LayoutState<T>,
  itemId: string,
): LayoutLocation | null {
  for (const zone of value.zones) {
    if (zone.kind === 'list') {
      const index = zone.itemIds.indexOf(itemId);
      if (index !== -1) return { kind: 'list', zoneId: zone.id, index };
    } else {
      const item = zone.placements.find(
        placement => placement.itemId === itemId,
      );
      if (item)
        return { kind: 'grid', zoneId: zone.id, position: item.position };
    }
  }
  return null;
}

export function sameLayoutLocation(
  first: LayoutLocation,
  second: LayoutLocation | null,
): boolean {
  if (!second || first.zoneId !== second.zoneId) return false;
  return first.kind === 'list' && second.kind === 'list'
    ? first.index === second.index
    : first.kind === 'grid' &&
        second.kind === 'grid' &&
        first.position.row === second.position.row &&
        first.position.col === second.position.col;
}
