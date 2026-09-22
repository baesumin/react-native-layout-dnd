import type { GridZone, ZoneLayoutResult } from '../types';

import { validateZone } from './validation';

/** Compute cell positions only. This never packs or changes the supplied zone. */
export function computeZoneLayout<T>(zone: GridZone<T>): ZoneLayoutResult<T> {
  const validation = validateZone(zone);
  if (!validation.valid) {
    return validation;
  }
  if (zone.strategy === 'spatial') {
    return { valid: true, items: zone.items.slice() };
  }
  // A valid empty zone can have zero slots; avoid any division in that case.
  if (zone.items.length === 0) {
    return { valid: true, items: [] };
  }
  const slotsPerRow = Math.floor(zone.columns / zone.itemSpan.cols);
  return {
    valid: true,
    items: zone.items.map((item, index) => ({
      ...item,
      position: {
        row: Math.floor(index / slotsPerRow) * zone.itemSpan.rows,
        col: (index % slotsPerRow) * zone.itemSpan.cols,
      },
    })),
  };
}
