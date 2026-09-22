import type { GridDiagnosticEvent } from './types';

export type DiagnosticObserver = (event: GridDiagnosticEvent) => void;
export type TimingDiagnostic = Extract<GridDiagnosticEvent, { type: 'timing' }>;

export function diagnosticNow(): number {
  // RN provides this JS monotonic clock; ambient native declarations omit it.
  return (
    globalThis as typeof globalThis & { performance: { now(): number } }
  ).performance.now();
}

/** Observers receive newly-created scalar payloads and cannot fail a drag. */
export function emitDiagnostic(
  observer: DiagnosticObserver,
  event: GridDiagnosticEvent,
): void {
  try {
    observer(event);
  } catch {
    // Diagnostics must not alter placement, response or cleanup behavior.
  }
}
