/**
 * Snapshot ownership shared by both session coordinators: subscribers,
 * batched notification, shallow patching with `Object.is` change detection
 * and the response deadline timer. The subclasses own their snapshot shapes,
 * candidate calculation and lifecycle events.
 */
export abstract class CoordinatorBase<Snapshot extends object> {
  protected snapshot: Snapshot;
  protected changed = false;
  private listeners = new Set<() => void>();
  private depth = 0;
  private responseTimer: ReturnType<typeof setTimeout> | undefined;

  protected constructor(initial: Snapshot) {
    this.snapshot = initial;
  }

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Nested batches notify subscribers once, after the outermost one ends. */
  protected batch<R>(work: () => R): R {
    this.batchStarted();
    this.depth++;
    try {
      return work();
    } finally {
      this.depth--;
      if (this.depth === 0) {
        try {
          if (this.changed) {
            this.changed = false;
            for (const listener of this.listeners) listener();
          }
        } finally {
          this.batchFinished();
        }
      }
    }
  }

  protected batchStarted(): void {}

  /** Runs after subscribers were notified, even when one of them threw. */
  protected batchFinished(): void {}

  protected get batchDepth(): number {
    return this.depth;
  }

  protected update(patch: Partial<Snapshot>): void {
    if (
      !Object.keys(patch).some(
        key =>
          !Object.is(
            this.snapshot[key as keyof Snapshot],
            patch[key as keyof Snapshot],
          ),
      )
    )
      return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.changed = true;
  }

  /** Put back an earlier snapshot and its pending-notification flag. */
  protected restore(snapshot: Snapshot, changed: boolean): void {
    this.snapshot = snapshot;
    this.changed = changed;
  }

  /**
   * Wait for a proposal response until `deadline`. The timer re-arms while the
   * clock has not reached the deadline (fake timers, long sleeps) and calls
   * `onExpire` inside a batch once it has, unless `isPending` says the
   * proposal was already settled.
   */
  protected armDeadline(
    deadline: number | undefined,
    isPending: () => boolean,
    onExpire: () => void,
  ): void {
    const remaining = Math.max(0, (deadline ?? now()) - now());
    this.responseTimer = setTimeout(
      () =>
        this.batch(() => {
          this.responseTimer = undefined;
          if (!isPending()) return;
          if (deadline !== undefined && now() < deadline)
            this.armDeadline(deadline, isPending, onExpire);
          else onExpire();
        }),
      Math.min(remaining, 2147483647),
    );
  }

  protected clearDeadline(): void {
    clearTimeout(this.responseTimer);
    this.responseTimer = undefined;
  }
}

/** RN provides this monotonic clock; its generated ambient declarations omit it. */
export function now(): number {
  return (
    globalThis as typeof globalThis & { performance: { now(): number } }
  ).performance.now();
}

export function reportCallbackError(scope: string, error: unknown): void {
  console.error(`[${scope}] Callback failed`, error);
}
