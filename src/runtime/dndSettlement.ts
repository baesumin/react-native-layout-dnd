import type { LayoutPoint, LayoutRect } from '../contracts';

import { isUsableRect } from '../pointer/geometry';

type SettlementGeometry = {
  /** Root and viewport use screen coordinates; contentRect excludes scrolling. */
  root: LayoutRect;
  viewport: LayoutRect;
  contentRect: LayoutRect;
  nativeRect: LayoutRect | null;
  scrollOffset: LayoutPoint;
  pixelRatio?: number;
};

function containsPixels(
  outer: LayoutRect,
  inner: LayoutRect,
  pixelRatio: number,
): boolean {
  'worklet';
  return (
    Math.round(inner.x * pixelRatio) >= Math.round(outer.x * pixelRatio) &&
    Math.round(inner.y * pixelRatio) >= Math.round(outer.y * pixelRatio) &&
    Math.round((inner.x + inner.width) * pixelRatio) <=
      Math.round((outer.x + outer.width) * pixelRatio) &&
    Math.round((inner.y + inner.height) * pixelRatio) <=
      Math.round((outer.y + outer.height) * pixelRatio)
  );
}

/** Resolve the committed logical slot without waiting for a native cell. */
export function settlementTarget({
  root,
  viewport,
  contentRect,
  scrollOffset,
  pixelRatio = 1,
}: Omit<SettlementGeometry, 'nativeRect'>): LayoutRect | null {
  'worklet';
  if (
    !isUsableRect(root) ||
    !isUsableRect(viewport) ||
    !isUsableRect(contentRect) ||
    !Number.isFinite(scrollOffset.x) ||
    !Number.isFinite(scrollOffset.y) ||
    !Number.isFinite(pixelRatio) ||
    pixelRatio <= 0
  )
    return null;
  const expected = {
    x: viewport.x + contentRect.x - scrollOffset.x,
    y: viewport.y + contentRect.y - scrollOffset.y,
    width: contentRect.width,
    height: contentRect.height,
  };
  if (
    !isUsableRect(expected) ||
    !containsPixels(viewport, expected, pixelRatio) ||
    !containsPixels(root, expected, pixelRatio)
  )
    return null;
  return { ...expected, x: expected.x - root.x, y: expected.y - root.y };
}

/** Native alignment gates only the final handoff, not the overlay animation. */
export function settlementDestination({
  root,
  viewport,
  contentRect,
  nativeRect,
  scrollOffset,
  pixelRatio = 1,
}: SettlementGeometry): LayoutRect | null {
  'worklet';
  const target = settlementTarget({
    root,
    viewport,
    contentRect,
    scrollOffset,
    pixelRatio,
  });
  if (!target || !isUsableRect(nativeRect)) return null;
  const tolerance = 1 / pixelRatio;
  if (
    Math.abs(nativeRect.x - root.x - target.x) > tolerance ||
    Math.abs(nativeRect.y - root.y - target.y) > tolerance ||
    Math.abs(nativeRect.width - target.width) > tolerance ||
    Math.abs(nativeRect.height - target.height) > tolerance ||
    !containsPixels(viewport, nativeRect, pixelRatio) ||
    !containsPixels(root, nativeRect, pixelRatio)
  )
    return null;
  return {
    x: nativeRect.x - root.x,
    y: nativeRect.y - root.y,
    width: nativeRect.width,
    height: nativeRect.height,
  };
}

/** Both rectangles use root coordinates; progress is the native animation value. */
export function interpolateSettlementRect(
  from: LayoutRect,
  to: LayoutRect,
  progress: number,
): LayoutRect | null {
  'worklet';
  if (!isUsableRect(from) || !isUsableRect(to) || !Number.isFinite(progress))
    return null;
  const amount = Math.max(0, Math.min(1, progress));
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    width: from.width + (to.width - from.width) * amount,
    height: from.height + (to.height - from.height) * amount,
  };
}
