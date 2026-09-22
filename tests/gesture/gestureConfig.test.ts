import { validateGestureRelations } from '../../src/gesture/gestureConfig';

function native(handlerTag = 1) {
  return {
    type: 'NativeViewGestureHandler',
    handlerTag,
    config: {},
    detectorCallbacks: {},
    gestureRelations: {
      simultaneousHandlers: [],
      waitFor: [],
      blocksHandlers: [],
    },
  };
}

describe('external gesture relation validation', () => {
  test('accepts absent relationships and normalizes singles/arrays without cloning gesture objects', () => {
    const gesture = native();
    expect(validateGestureRelations(undefined)).toEqual({
      valid: true,
      relations: undefined,
    });
    const result = validateGestureRelations({ block: [gesture, gesture] });
    expect(result).toEqual({ valid: true, relations: { block: [gesture] } });
    if (!result.valid || !Array.isArray(result.relations?.block))
      throw new Error('Expected normalized block');
    expect(result.relations.block[0]).toBe(gesture);
    expect(
      validateGestureRelations({ block: gesture, simultaneousWith: native(2) })
        .valid,
    ).toBe(true);
  });

  test.each([
    null,
    [],
    { unknown: [] },
    { block: null },
    { block: 1 },
    { block: {} },
    { block: { current: native() } },
    { block: [native(), null] },
    { block: { ...native(), handlerTag: 0 } },
    { block: { ...native(), gestureRelations: {} } },
    {
      simultaneousWith: {
        ...native(),
        gestureRelations: {
          simultaneousHandlers: null,
          waitFor: [],
          blocksHandlers: [],
        },
      },
    },
    { block: { ...native(), config: null } },
  ])(
    'rejects malformed relationship %# before creating a native recognizer',
    value => {
      expect(validateGestureRelations(value)).toMatchObject({
        valid: false,
        issues: [{ code: 'invalid-configuration' }],
      });
    },
  );

  test.each([
    ['block', 'requireToFail'],
    ['block', 'simultaneousWith'],
    ['requireToFail', 'simultaneousWith'],
  ])('rejects the same object in %s and %s', (first, second) => {
    const gesture = native();
    expect(
      validateGestureRelations({ [first]: gesture, [second]: [gesture] }).valid,
    ).toBe(false);
  });

  test('detects conflicting native tags in different objects and composed/child gestures', () => {
    expect(
      validateGestureRelations({ block: native(1), requireToFail: native(1) })
        .valid,
    ).toBe(false);
    const child = native(2);
    const composed = {
      type: 'SimultaneousGesture',
      handlerTags: [1, 2],
      config: {},
      detectorCallbacks: {},
      gestures: [native(1), child],
      externalSimultaneousHandlers: [],
    };
    expect(validateGestureRelations({ block: composed }).valid).toBe(true);
    expect(
      validateGestureRelations({ block: composed, simultaneousWith: child })
        .valid,
    ).toBe(false);
  });
});
