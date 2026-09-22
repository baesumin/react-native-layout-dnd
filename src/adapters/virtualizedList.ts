import type { LayoutValidationIssue } from '../contracts';
import { isPositiveInteger, isRecord } from '../engine/validation';

/** FlatList rendering limits; enabling virtualization preserves the layout API. */
export type ListVirtualizationOptions = {
  /** Cells rendered initially. Defaults to 12. */
  initialNumToRender?: number;
  /** Maximum cells rendered in each batch. Defaults to 12. */
  maxToRenderPerBatch?: number;
  /** Render window in viewport lengths; must exceed 1. Defaults to 7. */
  windowSize?: number;
  /** Delay between render batches in milliseconds. Defaults to 50. */
  updateCellsBatchingPeriod?: number;
};

export type ListVirtualizationResult =
  | { valid: true; options: Required<ListVirtualizationOptions> | null }
  | { valid: false; issues: LayoutValidationIssue[] };

const DEFAULT_OPTIONS: Readonly<Required<ListVirtualizationOptions>> =
  Object.freeze({
    initialNumToRender: 12,
    maxToRenderPerBatch: 12,
    windowSize: 7,
    updateCellsBatchingPeriod: 50,
  });

function invalid(message: string): ListVirtualizationResult {
  return {
    valid: false,
    issues: [{ code: 'invalid-configuration', message }],
  };
}

/** Undefined/false selects ScrollView; true or an options object selects FlatList. */
export function resolveListVirtualization(
  value: unknown,
): ListVirtualizationResult {
  if (value === undefined || value === false) {
    return { valid: true, options: null };
  }
  if (value === true) return { valid: true, options: { ...DEFAULT_OPTIONS } };
  if (!isRecord(value)) {
    return invalid('virtualization must be a boolean or an options object.');
  }
  if (
    Object.keys(value).some(
      key =>
        key !== 'initialNumToRender' &&
        key !== 'maxToRenderPerBatch' &&
        key !== 'windowSize' &&
        key !== 'updateCellsBatchingPeriod',
    )
  ) {
    return invalid(
      'virtualization supports only initialNumToRender, maxToRenderPerBatch, windowSize and updateCellsBatchingPeriod.',
    );
  }
  const initialNumToRender =
    value.initialNumToRender === undefined
      ? DEFAULT_OPTIONS.initialNumToRender
      : value.initialNumToRender;
  const maxToRenderPerBatch =
    value.maxToRenderPerBatch === undefined
      ? DEFAULT_OPTIONS.maxToRenderPerBatch
      : value.maxToRenderPerBatch;
  const windowSize =
    value.windowSize === undefined
      ? DEFAULT_OPTIONS.windowSize
      : value.windowSize;
  const updateCellsBatchingPeriod =
    value.updateCellsBatchingPeriod === undefined
      ? DEFAULT_OPTIONS.updateCellsBatchingPeriod
      : value.updateCellsBatchingPeriod;
  if (!isPositiveInteger(initialNumToRender)) {
    return invalid(
      'virtualization.initialNumToRender must be a positive safe integer.',
    );
  }
  if (!isPositiveInteger(maxToRenderPerBatch)) {
    return invalid(
      'virtualization.maxToRenderPerBatch must be a positive safe integer.',
    );
  }
  if (
    typeof windowSize !== 'number' ||
    !Number.isFinite(windowSize) ||
    windowSize <= 1
  ) {
    return invalid(
      'virtualization.windowSize must be finite and greater than 1.',
    );
  }
  if (
    typeof updateCellsBatchingPeriod !== 'number' ||
    !Number.isFinite(updateCellsBatchingPeriod) ||
    updateCellsBatchingPeriod < 0
  ) {
    return invalid(
      'virtualization.updateCellsBatchingPeriod must be finite and nonnegative.',
    );
  }
  return {
    valid: true,
    options: {
      initialNumToRender,
      maxToRenderPerBatch,
      windowSize,
      updateCellsBatchingPeriod,
    },
  };
}
