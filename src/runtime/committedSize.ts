export type ViewSize = { width: number; height: number };

type MeasurableHost = {
  measureLayout(
    relativeTo: unknown,
    onSuccess: (x: number, y: number, width: number, height: number) => void,
    onFail?: () => void,
  ): void;
  getNativeScrollRef?(): unknown;
};

function hostOf(instance: unknown): MeasurableHost | null {
  const candidate = instance as Partial<MeasurableHost> | null | undefined;
  const host =
    typeof candidate?.getNativeScrollRef === 'function'
      ? (candidate.getNativeScrollRef() as Partial<MeasurableHost> | null)
      : candidate;
  return host && typeof host.measureLayout === 'function'
    ? (host as MeasurableHost)
    : null;
}

/**
 * The size the latest React commit gave a host view, read from a layout
 * effect. Fabric commits and lays out the shadow tree before layout effects
 * run and answers a self-relative `measureLayout` synchronously, with the
 * same untransformed frame that onLayout later reports. Props that change in
 * the same commit as the view size can therefore be validated against that
 * size instead of the previous onLayout event.
 *
 * Returns null when no answer arrives synchronously or the view has no
 * layout (unmounted, `display: 'none'`, a renderer without the API); callers
 * keep their onLayout size then.
 */
export function readCommittedSize(instance: unknown): ViewSize | null {
  const host = hostOf(instance);
  if (!host) return null;
  let size = null as ViewSize | null;
  try {
    host.measureLayout(
      host,
      (_x, _y, width, height) => {
        size = { width, height };
      },
      () => {},
    );
  } catch {
    return null;
  }
  // An answer that arrives after this returns is ignored.
  const result = size;
  return result &&
    Number.isFinite(result.width) &&
    Number.isFinite(result.height) &&
    result.width >= 0 &&
    result.height >= 0
    ? result
    : null;
}

export function sameViewSize(a: ViewSize | null, b: ViewSize | null): boolean {
  return (
    a === b || (!!a && !!b && a.width === b.width && a.height === b.height)
  );
}
