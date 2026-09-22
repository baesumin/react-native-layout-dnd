import type { ListLayout } from './list';

/**
 * A detached snapshot shared with UI worklets: rebuild it whenever the layout
 * geometry changes. Numeric columns are typed arrays so each crosses runtimes
 * as one buffer copy, and unchanged columns keep their identity so the runtime
 * serialization cache can reuse them.
 */
export type ListTargetIndex = {
  readonly revision: number;
  /** Boundary centers in ascending order. */
  readonly thresholds: Float64Array;
  /** `entry.index` of each boundary; a NaN index sorts last as Infinity. */
  readonly entryIndices: Float64Array;
  /** Prefixed item ID → slot in `positions` and `ranks`. */
  readonly slots: Readonly<Record<string, number>>;
  /** Position of the first matching ID in the original layout, by slot. */
  readonly positions: Int32Array;
  /** Boundary rank of the first matching ID, by slot; -1 without a boundary. */
  readonly ranks: Int32Array;
  /** Further boundary ranks of caller-edited duplicate IDs, by prefixed key. */
  readonly additionalRanks?: Readonly<Record<string, readonly number[]>>;
};

type Boundary = { threshold: number; entryIndex: number; slot: number };

function compareBoundaries(a: Boundary, b: Boundary): number {
  if (a.threshold < b.threshold) return -1;
  if (a.threshold > b.threshold) return 1;
  if (a.entryIndex < b.entryIndex) return -1;
  if (a.entryIndex > b.entryIndex) return 1;
  return 0;
}

function sameSlots(
  slots: Readonly<Record<string, number>>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(slots).length === keys.length &&
    keys.every((key, slot) => slots[key] === slot)
  );
}

function sameColumn(
  previous: Float64Array | Int32Array,
  next: Float64Array | Int32Array,
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1)
    if (previous[index] !== next[index]) return false;
  return true;
}

/**
 * Prepare once on the JS thread, then share this plain data with UI worklets.
 * Original centers retain the active item's footprint; only the returned
 * insertion index excludes it. No references to the mutable layout are kept.
 * Passing the previous index of the same zone reuses its unchanged columns.
 */
export function createListTargetIndex(
  layout: ListLayout,
  previous?: ListTargetIndex,
): ListTargetIndex {
  const boundaries: Boundary[] = [];
  const slotByKey = new Map<string, number>();
  const keys: string[] = [];
  const positionList: number[] = [];
  let ordered = true;
  for (let position = 0; position < layout.entries.length; position += 1) {
    const entry = layout.entries[position];
    // Prefixing protects arbitrary item IDs such as "__proto__" on both runtimes.
    const itemKey = `$${entry.itemId}`;
    let slot = slotByKey.get(itemKey);
    if (slot === undefined) {
      slot = keys.length;
      slotByKey.set(itemKey, slot);
      keys.push(itemKey);
      positionList.push(position);
    }
    const threshold = entry.start + entry.size / 2;
    // NaN thresholds never pass the original comparison for any center.
    if (Number.isNaN(threshold)) continue;
    const boundary = {
      threshold,
      entryIndex: Number.isNaN(entry.index) ? Infinity : entry.index,
      slot,
    };
    const last = boundaries[boundaries.length - 1];
    if (last && compareBoundaries(last, boundary) > 0) ordered = false;
    boundaries.push(boundary);
  }
  // Layouts produced by computeListLayout are already ordered: O(n) preparation.
  // Sorting also preserves the public scan's meaning for caller-edited layouts.
  if (!ordered) boundaries.sort(compareBoundaries);
  const thresholds = new Float64Array(boundaries.length);
  const entryIndices = new Float64Array(boundaries.length);
  const ranks = new Int32Array(keys.length).fill(-1);
  let additionalRanks: Record<string, number[]> | undefined;
  for (let rank = 0; rank < boundaries.length; rank += 1) {
    const boundary = boundaries[rank];
    thresholds[rank] = boundary.threshold;
    entryIndices[rank] = boundary.entryIndex;
    if (ranks[boundary.slot] < 0) ranks[boundary.slot] = rank;
    else ((additionalRanks ??= {})[keys[boundary.slot]] ??= []).push(rank);
  }
  const positions = Int32Array.from(positionList);
  const reusable =
    previous?.revision === layout.revision ? previous : undefined;
  return {
    revision: layout.revision,
    thresholds,
    entryIndices:
      reusable && sameColumn(reusable.entryIndices, entryIndices)
        ? reusable.entryIndices
        : entryIndices,
    slots:
      reusable && sameSlots(reusable.slots, keys)
        ? reusable.slots
        : Object.fromEntries(keys.map((key, slot) => [key, slot])),
    positions:
      reusable && sameColumn(reusable.positions, positions)
        ? reusable.positions
        : positions,
    ranks:
      reusable && sameColumn(reusable.ranks, ranks) ? reusable.ranks : ranks,
    ...(additionalRanks ? { additionalRanks } : {}),
  };
}

/** Find an insertion index in O(log n), without allocation or layout scanning. */
export function findListTargetIndex(
  index: ListTargetIndex,
  activeItemId: string | null,
  center: number,
): number | null {
  'worklet';
  if (!Number.isFinite(center)) return null;
  const activeKey = activeItemId === null ? null : `$${activeItemId}`;
  const slot = activeKey === null ? undefined : index.slots[activeKey];
  const activePosition = slot === undefined ? -1 : index.positions[slot];
  const activeRank = slot === undefined ? -1 : index.ranks[slot];
  let low = 0;
  let high = index.thresholds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const threshold = index.thresholds[middle];
    if (
      center > threshold ||
      (center === threshold && index.entryIndices[middle] < activePosition)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  let result = low;
  if (activeRank >= 0 && activeRank < low) result -= 1;
  // Valid layouts have unique IDs. Preserve scan semantics for caller-edited
  // duplicate IDs too, without making the normal lookup linear.
  const additionalRanks =
    activeKey === null ? undefined : index.additionalRanks?.[activeKey];
  if (additionalRanks) {
    let first = 0;
    let last = additionalRanks.length;
    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      if (additionalRanks[middle] < low) first = middle + 1;
      else last = middle;
    }
    result -= first;
  }
  return result;
}
