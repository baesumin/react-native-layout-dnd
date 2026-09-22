import type {
  LayoutRect,
  LayoutValidationIssue,
  ListLayoutZone,
} from '../contracts';

import { isRecord } from './validation';

export type ListMeasurementContext = {
  orientation: ListLayoutZone['orientation'];
  /** Available width for vertical lists, or height for horizontal lists. */
  crossSize: number;
  /** Advance after content/font changes that invalidate measured item sizes. */
  epoch?: number;
};

type CachedSize = {
  size: number;
  context: ListMeasurementContext;
  measurementRevision: number;
};

function isNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRevision(value: unknown): value is number {
  return isNonnegative(value) && Number.isSafeInteger(value);
}

function isContext(context: ListMeasurementContext): boolean {
  return (
    isRecord(context) &&
    (context.orientation === 'vertical' ||
      context.orientation === 'horizontal') &&
    isNonnegative(context.crossSize) &&
    isRevision(context.epoch ?? 0)
  );
}

function sameContext(a: ListMeasurementContext, b: ListMeasurementContext) {
  return (
    a.orientation === b.orientation &&
    a.crossSize === b.crossSize &&
    (a.epoch ?? 0) === (b.epoch ?? 0)
  );
}

/**
 * Sizes belong to IDs, never array positions. A measurement is reusable after
 * reordering, but only with matching orientation, cross-axis size and epoch.
 * The measurement revision prevents delayed events from replacing newer sizes.
 */
export class ListSizeCache {
  private sizes = new Map<string, CachedSize>();

  get(itemId: string, context: ListMeasurementContext): number | undefined {
    if (typeof itemId !== 'string' || !isContext(context)) return undefined;
    const cached = this.sizes.get(itemId);
    return cached && sameContext(cached.context, context)
      ? cached.size
      : undefined;
  }

  set(
    itemId: string,
    size: number,
    context: ListMeasurementContext,
    measurementRevision = 0,
  ): boolean {
    if (
      typeof itemId !== 'string' ||
      !isNonnegative(size) ||
      !isContext(context) ||
      !isRevision(measurementRevision)
    ) {
      return false;
    }
    const cached = this.sizes.get(itemId);
    if (
      cached &&
      ((context.epoch ?? 0) < (cached.context.epoch ?? 0) ||
        ((context.epoch ?? 0) === (cached.context.epoch ?? 0) &&
          measurementRevision < cached.measurementRevision))
    ) {
      return false;
    }
    this.sizes.set(itemId, {
      size,
      context: { ...context },
      measurementRevision,
    });
    return true;
  }

  prune(itemIds: readonly string[]): void {
    const retained = new Set(itemIds);
    for (const itemId of this.sizes.keys()) {
      if (!retained.has(itemId)) this.sizes.delete(itemId);
    }
  }

  clear(): void {
    this.sizes.clear();
  }
}

export type ListLayoutEntry = {
  itemId: string;
  index: number;
  /** Main-axis content coordinate, including start padding. */
  start: number;
  size: number;
  source: 'measured' | 'estimated';
  rect: LayoutRect;
  /** Rect coordinates belong to this layout revision, unlike reusable sizes. */
  revision: number;
};

export type ListLayout = {
  orientation: ListLayoutZone['orientation'];
  crossSize: number;
  revision: number;
  entries: ListLayoutEntry[];
  totalSize: number;
};

export type ListLayoutInput = {
  itemIds: readonly string[];
  orientation: ListLayoutZone['orientation'];
  crossSize: number;
  estimatedItemSize: number;
  /** Authoritative size used by fixed-size or caller-sized item rendering. */
  itemSize?: number | ((itemId: string, index: number) => number);
  cache?: ListSizeCache;
  measurementEpoch?: number;
  gap?: number;
  paddingStart?: number;
  paddingEnd?: number;
  revision: number;
};

export type ListLayoutResult =
  | ({ valid: true } & ListLayout)
  | { valid: false; issues: LayoutValidationIssue[] };

function invalid(
  code: LayoutValidationIssue['code'],
  message: string,
  itemId?: string,
): ListLayoutResult {
  return {
    valid: false,
    issues: [{ code, message, ...(itemId === undefined ? {} : { itemId }) }],
  };
}

/** Compute content rects from one order snapshot without modifying the cache. */
export function computeListLayout(input: ListLayoutInput): ListLayoutResult {
  if (!isRecord(input) || !Array.isArray(input.itemIds)) {
    return invalid('invalid-structure', 'List item IDs must be an array.');
  }
  if (input.orientation !== 'vertical' && input.orientation !== 'horizontal') {
    return invalid(
      'invalid-orientation',
      'List orientation must be vertical or horizontal.',
    );
  }
  if (!isRevision(input.revision)) {
    return invalid(
      'invalid-revision',
      'Revision must be a nonnegative safe integer.',
    );
  }
  if (
    !isNonnegative(input.crossSize) ||
    !isNonnegative(input.estimatedItemSize) ||
    !isNonnegative(input.gap ?? 0) ||
    !isNonnegative(input.paddingStart ?? 0) ||
    !isNonnegative(input.paddingEnd ?? 0) ||
    !isRevision(input.measurementEpoch ?? 0) ||
    (input.itemSize !== undefined &&
      typeof input.itemSize !== 'function' &&
      !isNonnegative(input.itemSize)) ||
    (input.cache !== undefined && !(input.cache instanceof ListSizeCache))
  ) {
    return invalid(
      'invalid-configuration',
      'List sizes, gap and padding must be finite and nonnegative; the cache and measurement epoch must be valid.',
    );
  }
  const knownIds = new Set<string>();
  for (const itemId of input.itemIds) {
    if (typeof itemId !== 'string') {
      return invalid(
        'invalid-structure',
        'Every list item ID must be a string.',
      );
    }
    if (knownIds.has(itemId)) {
      return invalid(
        'duplicate-reference',
        'List item IDs must be unique.',
        itemId,
      );
    }
    knownIds.add(itemId);
  }

  const context: ListMeasurementContext = {
    orientation: input.orientation,
    crossSize: input.crossSize,
    epoch: input.measurementEpoch ?? 0,
  };
  const entries: ListLayoutEntry[] = [];
  let start = input.paddingStart ?? 0;
  for (let index = 0; index < input.itemIds.length; index += 1) {
    const itemId = input.itemIds[index];
    const measured = input.cache?.get(itemId, context);
    let declared: number | undefined;
    try {
      declared =
        typeof input.itemSize === 'function'
          ? input.itemSize(itemId, index)
          : input.itemSize;
    } catch {
      return invalid(
        'invalid-configuration',
        'The item size callback failed.',
        itemId,
      );
    }
    if (input.itemSize !== undefined && !isNonnegative(declared)) {
      return invalid(
        'invalid-configuration',
        'Every item size must be finite and nonnegative.',
        itemId,
      );
    }
    const size = declared ?? measured ?? input.estimatedItemSize;
    const source = measured === size ? 'measured' : 'estimated';
    const rect: LayoutRect =
      input.orientation === 'vertical'
        ? { x: 0, y: start, width: input.crossSize, height: size }
        : { x: start, y: 0, width: size, height: input.crossSize };
    entries.push({
      itemId,
      index,
      start,
      size,
      source,
      rect,
      revision: input.revision,
    });
    start += size + (index < input.itemIds.length - 1 ? (input.gap ?? 0) : 0);
    if (!Number.isFinite(start)) {
      return invalid(
        'invalid-configuration',
        'List content size must remain finite.',
      );
    }
  }
  const totalSize = start + (input.paddingEnd ?? 0);
  if (!Number.isFinite(totalSize)) {
    return invalid(
      'invalid-configuration',
      'List content size must remain finite.',
    );
  }
  return {
    valid: true,
    orientation: input.orientation,
    crossSize: input.crossSize,
    revision: input.revision,
    entries,
    totalSize,
  };
}

/**
 * Return an insertion index in the order AFTER removing the active item.
 * Thresholds are the original non-active item centers, including the active
 * footprint and all original gaps. Never measure a compressed preview here.
 * An ID absent from the target list is allowed for cross-list insertion.
 */
export function computeListIndex(
  layout: ListLayout,
  activeItemId: string | null,
  center: number,
): number | null {
  if (!Number.isFinite(center)) return null;
  const activeIndex = layout.entries.findIndex(
    entry => entry.itemId === activeItemId,
  );
  let index = 0;
  for (const entry of layout.entries) {
    if (entry.itemId === activeItemId) continue;
    const threshold = entry.start + entry.size / 2;
    if (
      center > threshold ||
      (center === threshold && entry.index < activeIndex)
    ) {
      index += 1;
    }
  }
  return index;
}
