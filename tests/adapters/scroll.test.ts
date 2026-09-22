import {
  computeAutoScroll,
  constrainDragPoint,
  validateAutoScrollOptions,
} from '../../src/adapters/scroll';
import type {
  AutoScrollInput,
  AutoScrollOptions,
  AutoScrollResult,
} from '../../src/adapters/scroll';

function frame(patch: Partial<AutoScrollInput> = {}): AutoScrollInput {
  return {
    pointer: 250,
    viewportStart: 50,
    viewportSize: 200,
    contentSize: 1000,
    offset: 100,
    deltaTimeMs: 16,
    ...patch,
  };
}

function validFrame(input: AutoScrollInput) {
  const result = computeAutoScroll(input);
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error(result.reason);
  expect(Number.isFinite(result.offset)).toBe(true);
  expect(Number.isFinite(result.velocity)).toBe(true);
  return result;
}

describe('edge auto scroll', () => {
  it('uses logical pixels per second at both edges', () => {
    const trailing = validFrame(frame());
    const leading = validFrame(frame({ pointer: 50 }));
    expect(trailing.offset).toBeCloseTo(109.6);
    expect(trailing.velocity).toBeCloseTo(600);
    expect(leading.offset).toBeCloseTo(90.4);
    expect(leading.velocity).toBeCloseTo(-600);
  });

  it('increases speed linearly as the pointer approaches the edge', () => {
    const leading = validFrame(frame({ pointer: 74 }));
    const trailing = validFrame(frame({ pointer: 226 }));
    expect(leading.offset).toBeCloseTo(95.2);
    expect(leading.velocity).toBeCloseTo(-300);
    expect(trailing.offset).toBeCloseTo(104.8);
    expect(trailing.velocity).toBeCloseTo(300);
  });

  it.each([98, 150, 202])('stays still in the central band at %p', pointer => {
    expect(computeAutoScroll(frame({ pointer }))).toEqual({
      valid: true,
      offset: 100,
      velocity: 0,
    });
  });

  it('supports explicit edge distance and speed', () => {
    const result = validFrame(
      frame({
        pointer: 240,
        options: { edgeThreshold: 20, maxSpeed: 1000 },
      }),
    );
    expect(result.offset).toBeCloseTo(108);
    expect(result.velocity).toBeCloseTo(500);
  });

  it('uses the same scalar calculation for horizontal and vertical viewports', () => {
    const viewport = { x: 40, y: 80, width: 200, height: 200 };
    const pointer = { x: 230, y: 270 };
    const horizontal = computeAutoScroll(
      frame({
        pointer: pointer.x,
        viewportStart: viewport.x,
        viewportSize: viewport.width,
      }),
    );
    const vertical = computeAutoScroll(
      frame({
        pointer: pointer.y,
        viewportStart: viewport.y,
        viewportSize: viewport.height,
      }),
    );
    expect(horizontal).toEqual(vertical);
    expect(validFrame(frame({ pointer: 240 })).velocity).toBeGreaterThan(0);
  });

  it('stops when leaving the viewport and resumes only on re-entry', () => {
    let offset = 100;
    const results: AutoScrollResult[] = [];
    for (const pointer of [250, 251, 400, 250, 150, 50, 49, 50]) {
      const result = validFrame(frame({ pointer, offset }));
      offset = result.offset;
      results.push(result);
    }
    expect(results).toEqual([
      { valid: true, offset: 109.6, velocity: expect.closeTo(600) },
      { valid: true, offset: 109.6, velocity: 0 },
      { valid: true, offset: 109.6, velocity: 0 },
      {
        valid: true,
        offset: expect.closeTo(119.2),
        velocity: expect.closeTo(600),
      },
      { valid: true, offset: expect.closeTo(119.2), velocity: 0 },
      { valid: true, offset: 109.6, velocity: expect.closeTo(-600) },
      { valid: true, offset: 109.6, velocity: 0 },
      { valid: true, offset: 100, velocity: expect.closeTo(-600) },
    ]);
  });

  it('stops when disabled, at zero speed, or before elapsed frame time', () => {
    for (const input of [
      frame({ options: { enabled: false } }),
      frame({ options: { maxSpeed: 0 } }),
      frame({ deltaTimeMs: 0 }),
    ]) {
      expect(computeAutoScroll(input)).toEqual({
        valid: true,
        offset: 100,
        velocity: 0,
      });
    }
  });

  it('chooses the nearer edge in a viewport smaller than both activation bands', () => {
    const small = { viewportSize: 20, viewportStart: 50 };
    const leading = validFrame(frame({ ...small, pointer: 56 }));
    const trailing = validFrame(frame({ ...small, pointer: 64 }));
    expect(leading.velocity).toBeCloseTo(-240);
    expect(trailing.velocity).toBeCloseTo(240);
    expect(computeAutoScroll(frame({ ...small, pointer: 60 }))).toEqual({
      valid: true,
      offset: 100,
      velocity: 0,
    });
  });

  it('caps a resumed frame at 64ms', () => {
    const result = validFrame(frame({ deltaTimeMs: 30000 }));
    expect(result.offset).toBeCloseTo(138.4);
    expect(result).toEqual(computeAutoScroll(frame({ deltaTimeMs: 64 })));
  });

  it('scrolls equally at 60Hz and 120Hz without depending on frame count', () => {
    function simulate(frames: number): number {
      let offset = 100;
      for (let index = 0; index < frames; index++) {
        offset = validFrame(
          frame({ contentSize: 5000, offset, deltaTimeMs: 1000 / frames }),
        ).offset;
      }
      return offset;
    }
    expect(simulate(60)).toBeCloseTo(700);
    expect(simulate(120)).toBeCloseTo(700);
  });

  it('clamps the final frame and reports the actual remaining speed', () => {
    expect(computeAutoScroll(frame({ offset: 795 }))).toEqual({
      valid: true,
      offset: 800,
      velocity: 312.5,
    });
    expect(computeAutoScroll(frame({ offset: 5, pointer: 50 }))).toEqual({
      valid: true,
      offset: 0,
      velocity: -312.5,
    });
    expect(computeAutoScroll(frame({ offset: 800 }))).toEqual({
      valid: true,
      offset: 800,
      velocity: 0,
    });
    expect(computeAutoScroll(frame({ offset: 0, pointer: 50 }))).toEqual({
      valid: true,
      offset: 0,
      velocity: 0,
    });
  });

  it.each([0, 100, 200])(
    'does not scroll short content of size %p',
    contentSize => {
      expect(computeAutoScroll(frame({ contentSize }))).toEqual({
        valid: true,
        offset: 0,
        velocity: 0,
      });
    },
  );

  it('bounds targets during native bounce without requesting idle movement', () => {
    expect(computeAutoScroll(frame({ offset: -20, pointer: 50 }))).toEqual({
      valid: true,
      offset: 0,
      velocity: 0,
    });
    expect(computeAutoScroll(frame({ offset: 850 }))).toEqual({
      valid: true,
      offset: 800,
      velocity: 0,
    });
    expect(
      computeAutoScroll(frame({ offset: -20, options: { enabled: false } })),
    ).toEqual({ valid: true, offset: 0, velocity: 0 });
    expect(validFrame(frame({ offset: -20 })).offset).toBeCloseTo(9.6);
  });

  it('does not mutate the adapter snapshot or its options', () => {
    const options = Object.freeze({ edgeThreshold: 30, maxSpeed: 800 });
    const input = Object.freeze(frame({ options }));
    expect(validFrame(input).offset).toBeCloseTo(112.8);
    expect(input.offset).toBe(100);
  });

  it('keeps extreme finite arithmetic bounded and finite', () => {
    const result = validFrame(
      frame({
        offset: Number.MAX_VALUE / 2,
        contentSize: Number.MAX_VALUE,
        deltaTimeMs: Number.MAX_VALUE,
        options: { maxSpeed: Number.MAX_VALUE },
      }),
    );
    expect(result.offset).toBeGreaterThan(Number.MAX_VALUE / 2);
    expect(result.offset).toBeLessThanOrEqual(Number.MAX_VALUE);
    expect(computeAutoScroll(frame({ deltaTimeMs: Number.MIN_VALUE }))).toEqual(
      { valid: true, offset: 100, velocity: 0 },
    );
  });

  it.each([
    null,
    [],
    {},
    frame({ pointer: NaN }),
    frame({ pointer: Infinity }),
    frame({ viewportStart: NaN }),
    frame({ viewportSize: 0 }),
    frame({ viewportSize: -10 }),
    frame({ viewportSize: Infinity }),
    frame({ offset: NaN }),
    frame({ offset: -Infinity }),
    frame({ contentSize: -1 }),
    frame({ contentSize: Infinity }),
    frame({ deltaTimeMs: -1 }),
    frame({ deltaTimeMs: NaN }),
    frame({ deltaTimeMs: Infinity }),
    frame({ pointer: Number.MAX_VALUE, viewportStart: -Number.MAX_VALUE }),
    { ...frame(), pointer: '250' },
  ])('rejects invalid adapter data: %p', input => {
    expect(computeAutoScroll(input as AutoScrollInput)).toEqual({
      valid: false,
      reason: 'invalid-input',
    });
  });

  it.each([
    null,
    [],
    1,
    { enabled: 1 },
    { enabled: null },
    { edgeThreshold: 0 },
    { edgeThreshold: -1 },
    { edgeThreshold: NaN },
    { edgeThreshold: Infinity },
    { edgeThreshold: '48' },
    { maxSpeed: -1 },
    { maxSpeed: NaN },
    { maxSpeed: Infinity },
    { maxSpeed: '600' },
    { enabled: false, maxSpeed: NaN },
  ])('rejects invalid options, including while disabled: %p', options => {
    expect(validateAutoScrollOptions(options as AutoScrollOptions)).toEqual({
      valid: false,
      reason: 'invalid-options',
    });
    expect(
      computeAutoScroll(frame({ options: options as AutoScrollOptions })),
    ).toEqual({ valid: false, reason: 'invalid-options' });
  });

  it.each([
    undefined,
    {},
    { enabled: false },
    { edgeThreshold: 20, maxSpeed: 0 },
  ])(
    'validates public options before a measured viewport exists: %p',
    options => {
      expect(validateAutoScrollOptions(options)).toEqual({ valid: true });
    },
  );
});

describe('drag axis projection', () => {
  it.each([
    ['x', { x: 100, y: 20 }],
    ['y', { x: 10, y: 200 }],
    ['both', { x: 100, y: 200 }],
  ] as const)(
    'constrains %s independently of layout direction',
    (axis, value) => {
      const point = Object.freeze({ x: 100, y: 200 });
      const origin = Object.freeze({ x: 10, y: 20 });
      expect(constrainDragPoint(point, origin, axis)).toEqual(value);
      expect(point).toEqual({ x: 100, y: 200 });
      expect(origin).toEqual({ x: 10, y: 20 });
    },
  );
});
