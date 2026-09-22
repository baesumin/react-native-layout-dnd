import type { ValidationIssue } from '../types';

export type GridMotionConfig = {
  /** Duration in milliseconds for item movement and preview settling. Defaults to 180. */
  durationMs?: number;
  /** Respect the device accessibility setting by default. */
  reduceMotion?: 'system' | 'always' | 'never';
};

type ResolvedGridMotionConfig = Required<GridMotionConfig>;

export const DEFAULT_GRID_MOTION: Readonly<ResolvedGridMotionConfig> =
  Object.freeze({ durationMs: 180, reduceMotion: 'system' });

type GridMotionResult =
  | { valid: true; motion: ResolvedGridMotionConfig }
  | { valid: false; issues: ValidationIssue[] };

/** Validate before sharing animation settings with the UI runtime. */
export function resolveGridMotion(value: unknown): GridMotionResult {
  const fail = (message: string): GridMotionResult => ({
    valid: false,
    issues: [{ code: 'invalid-configuration', message }],
  });
  if (value === undefined)
    return { valid: true, motion: { ...DEFAULT_GRID_MOTION } };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('motion must be an object with durationMs and reduceMotion.');
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some(
      key => key !== 'durationMs' && key !== 'reduceMotion',
    )
  )
    return fail('motion supports only durationMs and reduceMotion.');

  const durationMs =
    config.durationMs === undefined
      ? DEFAULT_GRID_MOTION.durationMs
      : config.durationMs;
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    return fail('motion.durationMs must be a finite non-negative number.');

  const reduceMotion =
    config.reduceMotion === undefined
      ? DEFAULT_GRID_MOTION.reduceMotion
      : config.reduceMotion;
  if (
    reduceMotion !== 'system' &&
    reduceMotion !== 'always' &&
    reduceMotion !== 'never'
  )
    return fail('motion.reduceMotion must be system, always or never.');

  return {
    valid: true,
    motion: {
      durationMs: reduceMotion === 'always' ? 0 : durationMs,
      reduceMotion,
    },
  };
}
