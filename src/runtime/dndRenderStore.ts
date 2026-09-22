import type { DndItem, LayoutZone } from '../contracts';
import type { DndSessionSnapshot } from '../controller/dndSession';

type DndSnapshotSource<T = unknown> = {
  getSnapshot(): DndSessionSnapshot<T>;
  subscribe(listener: () => void): () => void;
};

export type DndZoneSnapshot = {
  zone: LayoutZone | undefined;
  display: LayoutZone | undefined;
  items: readonly DndItem<unknown>[] | undefined;
  revision: number;
  displayRevision: number;
  activeItemId: string | null;
  scrollEnabled: boolean;
};

type DndItemSnapshot = {
  index: number;
  row?: number;
  col?: number;
};

/**
 * Answers once per drag session whether a zone keeps its native slots in
 * committed order while `activeItemId` is dragged. Adapters whose mounted set
 * depends on slot order (windowed lists) answer from their render window.
 */
export type RetainSlotsRule = (activeItemId: string) => boolean;

/** Native cells keep their slots during a preview. Shared geometry moves them. */
function retainNativeSlots(
  previous: LayoutZone | undefined,
  next: LayoutZone | undefined,
): LayoutZone | undefined {
  if (!previous || !next || previous.kind !== next.kind) return next;
  if (previous === next) return previous;
  if (previous.kind === 'list' && next.kind === 'list') {
    if (
      previous.orientation !== next.orientation ||
      previous.itemIds.length !== next.itemIds.length
    )
      return next;
    const ids = new Set(previous.itemIds);
    return next.itemIds.every(id => ids.has(id)) ? previous : next;
  }
  if (previous.kind === 'grid' && next.kind === 'grid') {
    if (
      previous.rows !== next.rows ||
      previous.columns !== next.columns ||
      previous.placements.length !== next.placements.length
    )
      return next;
    const placements = new Map(
      previous.placements.map(placement => [placement.itemId, placement]),
    );
    return next.placements.every(placement => {
      const old = placements.get(placement.itemId);
      return (
        old &&
        old.span.rows === placement.span.rows &&
        old.span.cols === placement.span.cols &&
        old.placement === placement.placement
      );
    })
      ? previous
      : next;
  }
  return next;
}

/** Separate React subscriptions from frame-by-frame approved presentation. */
export class DndRenderStore<T = unknown> {
  private provider: DndSessionSnapshot<T> | undefined;
  private zones = new Map<string, DndZoneSnapshot>();
  private itemIndices = new WeakMap<LayoutZone, Map<string, DndItemSnapshot>>();
  private items = new Map<string, Map<string, DndItemSnapshot>>();
  private retainDecisions = new Map<
    string,
    { sessionId: string | null; itemId: string; retain: boolean }
  >();

  constructor(private readonly source: DndSnapshotSource<T>) {}

  getSnapshot = (): DndSessionSnapshot<T> => this.source.getSnapshot();

  getProviderSnapshot = (): DndSessionSnapshot<T> => {
    const next = this.source.getSnapshot();
    const previous = this.provider;
    if (
      previous &&
      previous.value === next.value &&
      previous.phase === next.phase &&
      previous.sessionId === next.sessionId &&
      previous.itemId === next.itemId &&
      previous.sourceZoneId === next.sourceZoneId &&
      previous.targetZoneId === next.targetZoneId &&
      previous.validity === next.validity &&
      previous.disabled === next.disabled
    )
      return previous;
    return (this.provider = next);
  };

  getZoneSnapshot = (
    zoneId: string,
    preserveSlots: boolean | RetainSlotsRule = true,
  ): DndZoneSnapshot => {
    const current = this.source.getSnapshot();
    const zone = current.value?.zones.find(entry => entry.id === zoneId);
    const items = current.value?.items;
    const revision = current.value?.revision ?? 0;
    const key = `${preserveSlots === false ? 'ordered' : 'stable'}:${zoneId}`;
    const previous = this.zones.get(key);
    const candidate = current.displayValue?.zones.find(
      entry => entry.id === zoneId,
    );
    const display =
      current.phase !== 'idle' && this.retainSlots(key, current, preserveSlots)
        ? retainNativeSlots(
            previous &&
              previous.zone === zone &&
              previous.items === items &&
              previous.revision === revision
              ? previous.display
              : zone,
            candidate,
          )
        : candidate;
    // The revision of the value the display comes from: candidate geometry is
    // prepared under the candidate's revision, exactly as the provider asks
    // the adapter to prepare it for the UI runtime.
    const displayRevision =
      display === zone
        ? revision
        : display === candidate
          ? (current.displayValue?.revision ?? revision)
          : (previous?.displayRevision ?? revision);
    const next: DndZoneSnapshot = {
      zone,
      display,
      items,
      revision,
      displayRevision,
      activeItemId: current.itemId,
      scrollEnabled: current.phase === 'idle',
    };
    if (
      previous &&
      (Object.keys(next) as Array<keyof DndZoneSnapshot>).every(
        field => previous[field] === next[field],
      )
    )
      return previous;
    this.zones.set(key, next);
    return next;
  };

  /** A rule is consulted once per drag session so its answer cannot flip mid-drag. */
  private retainSlots(
    key: string,
    current: DndSessionSnapshot<T>,
    preserveSlots: boolean | RetainSlotsRule,
  ): boolean {
    if (typeof preserveSlots !== 'function') return preserveSlots;
    if (current.itemId === null) return true;
    const decision = this.retainDecisions.get(key);
    if (
      decision &&
      decision.sessionId === current.sessionId &&
      decision.itemId === current.itemId
    )
      return decision.retain;
    const retain = preserveSlots(current.itemId);
    this.retainDecisions.set(key, {
      sessionId: current.sessionId,
      itemId: current.itemId,
      retain,
    });
    return retain;
  }

  getItemSnapshot = (
    zoneId: string,
    itemId: string,
  ): DndItemSnapshot | undefined => {
    const zone = this.source
      .getSnapshot()
      .displayValue?.zones.find(entry => entry.id === zoneId);
    let indices = zone && this.itemIndices.get(zone);
    if (zone && !indices) {
      const prepared = new Map<string, DndItemSnapshot>();
      if (zone.kind === 'list')
        zone.itemIds.forEach((id, index) => prepared.set(id, { index }));
      else
        zone.placements.forEach((entry, index) =>
          prepared.set(entry.itemId, {
            index,
            row: entry.position.row,
            col: entry.position.col,
          }),
        );
      // Many mounted cells read the same approved display in one notification.
      // Build its ID index once instead of scanning the zone for every cell.
      this.itemIndices.set(zone, prepared);
      indices = prepared;
    }
    const next = indices?.get(itemId);
    let selected = this.items.get(zoneId);
    if (!next) {
      selected?.delete(itemId);
      return undefined;
    }
    const previous = selected?.get(itemId);
    if (
      previous &&
      previous.index === next.index &&
      previous.row === next.row &&
      previous.col === next.col
    )
      return previous;
    if (!selected) {
      selected = new Map();
      this.items.set(zoneId, selected);
    }
    selected.set(itemId, next);
    return next;
  };

  subscribeSelection<Selection>(
    get: () => Selection,
    listener: () => void,
  ): () => void {
    let previous = get();
    return this.source.subscribe(() => {
      const next = get();
      if (Object.is(previous, next)) return;
      previous = next;
      listener();
    });
  }

  subscribeProvider = (listener: () => void): (() => void) =>
    this.subscribeSelection(this.getProviderSnapshot, listener);
}
