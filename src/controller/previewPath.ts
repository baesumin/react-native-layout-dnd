/**
 * Cumulative preview path of one drag session inside one zone.
 *
 * Every valid, permitted candidate the session displays becomes the baseline
 * for the next target in the same zone, so an exchange made on the way stays
 * where the user saw it (moving a widget A → B → C swaps at C against the
 * layout shown at B, as launchers do). Returning to a target visited earlier
 * restores exactly that layout, and the item's committed location always
 * restores the committed layout. The path is dropped whenever the display
 * returns to the committed value: leaving every zone, entering another zone,
 * a rejected or failed candidate, or a candidate equal to the committed layout.
 */
type PreviewStep<Location, Value> = {
  /** The logical target that produced the step. */
  target: Location;
  /** The item's committed location, reported as the origin of every candidate. */
  from: Location;
  /** Where the candidate placed the dragged item. */
  to: Location;
  value: Value;
};

export type PreviewBaseline<Location, Value> =
  | { kind: 'restored'; step: PreviewStep<Location, Value> }
  | {
      kind: 'compute';
      base: Value;
      /** True when the base is an earlier preview rather than the committed value. */
      cumulative: boolean;
    };

export class PreviewPath<Location, Value> {
  private steps: PreviewStep<Location, Value>[] = [];
  private committed: Value | null = null;

  constructor(
    private readonly sameLocation: (
      first: Location,
      second: Location,
    ) => boolean,
    /** Re-attach a stored layout to a recommit that changed only item data. */
    private readonly rebase: (value: Value, committed: Value) => Value,
  ) {}

  get length(): number {
    return this.steps.length;
  }

  reset(): void {
    this.steps.length = 0;
  }

  /** Choose the layout a new target builds on, or the earlier step it restores. */
  resolve(
    committed: Value,
    origin: Location,
    target: Location,
  ): PreviewBaseline<Location, Value> {
    if (this.sameLocation(target, origin)) {
      this.reset();
      return { kind: 'compute', base: committed, cumulative: false };
    }
    this.sync(committed);
    const index = this.steps.findIndex(step =>
      this.sameLocation(step.target, target),
    );
    if (index !== -1) {
      this.steps.length = index + 1;
      return { kind: 'restored', step: this.steps[index] };
    }
    const newest = this.steps[this.steps.length - 1];
    return newest
      ? { kind: 'compute', base: newest.value, cumulative: true }
      : { kind: 'compute', base: committed, cumulative: false };
  }

  /** Record a displayed candidate that differs from the committed layout. */
  push(committed: Value, step: PreviewStep<Location, Value>): void {
    this.sync(committed);
    this.steps.push(step);
  }

  private sync(committed: Value): void {
    if (this.committed === committed) return;
    if (this.committed !== null)
      for (const step of this.steps)
        step.value = this.rebase(step.value, committed);
    this.committed = committed;
  }
}
