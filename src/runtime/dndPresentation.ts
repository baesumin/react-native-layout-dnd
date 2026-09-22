import type { LayoutLocation, LayoutRect } from '../contracts';

/**
 * Only validated numeric geometry crosses into the UI runtime. Coordinates
 * form one typed array so a zone table crosses runtimes as a single buffer;
 * the slot map is reused while a zone keeps the same items, so repeated
 * candidates serialize only the coordinates.
 */
export type DndZonePresentation = {
  /** Prefixed item ID → slot; four coordinates per slot in `rects`. */
  slots: Readonly<Record<string, number>>;
  /** x, y, width and height of each slot, in zone content coordinates. */
  rects: Float64Array;
};

export type DndPresentation = {
  token: number;
  revision: number;
  zones: Record<string, DndZonePresentation>;
  /** Last policy-approved preview, usable for motion before JS acknowledges release. */
  releaseTarget?: {
    target: LayoutLocation;
    policyRevision: number;
    /** Final pointer already validated by JS; controlled state may still be pending. */
    releasedSeq?: number;
  };
};

export const EMPTY_DND_PRESENTATION: DndPresentation = {
  token: 0,
  revision: 0,
  zones: {},
};

export function presentationRect(
  presentation: DndPresentation | undefined,
  zoneId: string,
  itemId: string,
): LayoutRect | undefined {
  'worklet';
  const zone = presentation?.zones[`#${zoneId}`];
  if (zone === undefined) return undefined;
  const slot = zone.slots[`#${itemId}`];
  if (slot === undefined) return undefined;
  const offset = slot * 4;
  return {
    x: zone.rects[offset],
    y: zone.rects[offset + 1],
    width: zone.rects[offset + 2],
    height: zone.rects[offset + 3],
  };
}

/**
 * Build a zone table from item rects. The previous table's slot map is kept
 * when it lists exactly these items, so unchanged maps keep their identity.
 */
export function createZonePresentation(
  entries: ReadonlyArray<readonly [itemId: string, rect: LayoutRect]>,
  previous?: DndZonePresentation | null,
): DndZonePresentation {
  let slots = previous?.slots;
  let count = slots ? Object.keys(slots).length : 0;
  if (
    !slots ||
    count !== entries.length ||
    entries.some(([itemId]) => slots![`#${itemId}`] === undefined)
  ) {
    const next: Record<string, number> = {};
    count = 0;
    for (const [itemId] of entries) {
      const key = `#${itemId}`;
      if (next[key] === undefined) next[key] = count++;
    }
    slots = next;
  }
  const rects = new Float64Array(count * 4);
  for (const [itemId, rect] of entries) {
    const offset = slots[`#${itemId}`] * 4;
    rects[offset] = rect.x;
    rects[offset + 1] = rect.y;
    rects[offset + 2] = rect.width;
    rects[offset + 3] = rect.height;
  }
  return { slots, rects };
}

/** Build a zone table from a `#itemId` keyed rect record. */
export function zonePresentationFromRects(
  rects: Readonly<Record<string, LayoutRect>>,
): DndZonePresentation {
  return createZonePresentation(
    Object.entries(rects).map(([key, rect]) => [key.slice(1), rect] as const),
  );
}

/** Read a zone table back as a `#itemId` keyed rect record. */
export function zonePresentationRects(
  zone: DndZonePresentation | undefined,
): Record<string, LayoutRect> {
  const result: Record<string, LayoutRect> = {};
  if (!zone) return result;
  for (const [key, slot] of Object.entries(zone.slots)) {
    const offset = slot * 4;
    result[key] = {
      x: zone.rects[offset],
      y: zone.rects[offset + 1],
      width: zone.rects[offset + 2],
      height: zone.rects[offset + 3],
    };
  }
  return result;
}
