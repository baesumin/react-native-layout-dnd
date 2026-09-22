import {
  DEFAULT_GRID_MOTION,
  resolveGridMotion,
} from '../../src/pointer/motion';

describe('grid movement and settling configuration', () => {
  test.each([
    undefined,
    {},
    { durationMs: undefined, reduceMotion: undefined },
  ])(
    'retains the baseline duration and system accessibility preference for %p',
    value => {
      expect(resolveGridMotion(value)).toEqual({
        valid: true,
        motion: { durationMs: 180, reduceMotion: 'system' },
      });
    },
  );

  test('uses the same requested duration for immediate or animated movement', () => {
    for (const durationMs of [0, 50.5, 400]) {
      expect(resolveGridMotion({ durationMs })).toEqual({
        valid: true,
        motion: { durationMs, reduceMotion: 'system' },
      });
    }
  });

  test('makes always-reduced motion immediate and preserves an explicit animation override', () => {
    expect(
      resolveGridMotion({ durationMs: 400, reduceMotion: 'always' }),
    ).toEqual({
      valid: true,
      motion: { durationMs: 0, reduceMotion: 'always' },
    });
    expect(
      resolveGridMotion({ durationMs: 400, reduceMotion: 'never' }),
    ).toEqual({
      valid: true,
      motion: { durationMs: 400, reduceMotion: 'never' },
    });
  });

  test.each([
    null,
    true,
    180,
    'always',
    [],
    { duration: 180 },
    { durationMs: -1 },
    { durationMs: NaN },
    { durationMs: Infinity },
    { durationMs: -Infinity },
    { durationMs: '180' },
    { durationMs: null },
    { durationMs: -1, reduceMotion: 'always' },
    { reduceMotion: null },
    { reduceMotion: true },
    { reduceMotion: 'sometimes' },
  ])('rejects malformed configuration %p before starting animations', value => {
    expect(resolveGridMotion(value)).toMatchObject({
      valid: false,
      issues: [{ code: 'invalid-configuration' }],
    });
  });

  test('copies settings without mutating the input or shared defaults', () => {
    const config = Object.freeze({ durationMs: 300, reduceMotion: 'always' });
    expect(resolveGridMotion(config)).toMatchObject({
      motion: { durationMs: 0 },
    });
    expect(config.durationMs).toBe(300);
    expect(DEFAULT_GRID_MOTION).toEqual({
      durationMs: 180,
      reduceMotion: 'system',
    });
    const result = resolveGridMotion(undefined);
    if (!result.valid) throw new Error('Expected default motion');
    expect(result.motion).not.toBe(DEFAULT_GRID_MOTION);
  });
});
