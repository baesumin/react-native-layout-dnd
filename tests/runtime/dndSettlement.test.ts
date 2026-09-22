import {
  interpolateSettlementRect,
  settlementDestination,
  settlementTarget,
} from '../../src/runtime/dndSettlement';
import type { LayoutRect } from '../../src/contracts';

function fixture() {
  return {
    root: { x: 20, y: 40, width: 500, height: 700 },
    viewport: { x: 40, y: 100, width: 300, height: 400 },
    contentRect: { x: 10, y: 520, width: 100, height: 60 },
    nativeRect: { x: 50, y: 220, width: 100, height: 60 },
    scrollOffset: { x: 0, y: 400 },
    pixelRatio: 2,
  };
}

describe('logical settlement target', () => {
  it('returns the committed slot before a native cell mounts or reaches it', () => {
    const input = fixture();
    const expected = { x: 30, y: 180, width: 100, height: 60 };
    const unmounted = { ...input, nativeRect: null };
    expect(settlementTarget(unmounted)).toEqual(expected);
    input.nativeRect.y = 0;
    expect(settlementTarget(input)).toEqual(expected);
    expect(settlementDestination(input)).toBeNull();
  });

  it('uses both scroll axes and preserves negative overscroll offsets', () => {
    const input = fixture();
    input.scrollOffset = { x: 40, y: -10 };
    input.contentRect = { x: 70, y: 20, width: 100, height: 60 };
    expect(settlementTarget(input)).toEqual({
      x: 50,
      y: 90,
      width: 100,
      height: 60,
    });
  });

  it.each(['root', 'viewport'] as const)(
    'rejects a committed slot clipped by the %s',
    parent => {
      const input = fixture();
      input[parent].height = 130;
      expect(settlementTarget(input)).toBeNull();
    },
  );

  it('does not clamp a scrolled-off committed slot into the viewport', () => {
    const input = fixture();
    input.scrollOffset.y = 1000;
    expect(settlementTarget(input)).toBeNull();
  });

  it.each(['root', 'viewport', 'contentRect'] as const)(
    'rejects invalid %s geometry',
    key => {
      const input = fixture();
      input[key].width = 0;
      expect(settlementTarget(input)).toBeNull();
      input[key].width = 100;
      input[key].y = NaN;
      expect(settlementTarget(input)).toBeNull();
    },
  );

  it.each([0, -1, NaN, Infinity])(
    'rejects invalid pixel ratio %p',
    pixelRatio => {
      expect(settlementTarget({ ...fixture(), pixelRatio })).toBeNull();
    },
  );

  it('rejects malformed scroll offsets', () => {
    expect(
      settlementTarget({ ...fixture(), scrollOffset: { x: NaN, y: 400 } }),
    ).toBeNull();
  });
});

describe('settlement destination', () => {
  it('waits for measured content coordinates and returns a root-relative rectangle', () => {
    const input = fixture();
    expect(settlementDestination(input)).toEqual({
      x: 30,
      y: 180,
      width: 100,
      height: 60,
    });
    expect(settlementDestination({ ...input, nativeRect: null })).toBeNull();
  });

  it('includes both native scroll axes and preserves negative overscroll offsets', () => {
    const input = fixture();
    input.scrollOffset = { x: 40, y: -10 };
    input.contentRect = { x: 70, y: 20, width: 100, height: 60 };
    input.nativeRect = { x: 70, y: 130, width: 100, height: 60 };
    expect(settlementDestination(input)).toEqual({
      x: 50,
      y: 90,
      width: 100,
      height: 60,
    });
    input.scrollOffset.x++;
    expect(settlementDestination(input)).toBeNull();
  });

  it.each(['x', 'y', 'width', 'height'] as const)(
    'does not settle while native %s still belongs to another slot or size',
    coordinate => {
      const input = fixture();
      input.nativeRect[coordinate] += 20;
      expect(settlementDestination(input)).toBeNull();
    },
  );

  it('permits at most one physical pixel of native rounding error', () => {
    const input = fixture();
    input.nativeRect.x += 0.5;
    input.nativeRect.width -= 0.5;
    expect(settlementDestination(input)).toEqual({
      x: 30.5,
      y: 180,
      width: 99.5,
      height: 60,
    });
    input.nativeRect.x += 0.01;
    expect(settlementDestination(input)).toBeNull();
  });

  it.each(['root', 'viewport'] as const)(
    'rejects a destination clipped by the %s even when the cell is mounted',
    parent => {
      const input = fixture();
      input[parent].height = 130;
      expect(settlementDestination(input)).toBeNull();
    },
  );

  it('checks the actual native edge as well as the expected edge', () => {
    const input = fixture();
    input.root.height = 240;
    // Expected bottom is exactly root.bottom; native is half a point lower.
    input.nativeRect.y += 0.5;
    expect(settlementDestination(input)).toBeNull();
  });

  it('rejects a scrolled-off destination rather than clamping it into the viewport', () => {
    const input = fixture();
    input.scrollOffset.y = 1000;
    input.nativeRect.y = -380;
    expect(settlementDestination(input)).toBeNull();
  });

  it.each(['root', 'viewport', 'contentRect', 'nativeRect'] as const)(
    'rejects invalid %s dimensions and coordinates',
    key => {
      const input = fixture();
      input[key].width = 0;
      expect(settlementDestination(input)).toBeNull();
      input[key].width = 100;
      input[key].y = NaN;
      expect(settlementDestination(input)).toBeNull();
    },
  );

  it.each([0, -1, NaN, Infinity])(
    'rejects invalid pixel ratio %p',
    pixelRatio => {
      expect(settlementDestination({ ...fixture(), pixelRatio })).toBeNull();
    },
  );

  it('rejects malformed scroll offsets', () => {
    const input = fixture();
    input.scrollOffset.y = NaN;
    expect(settlementDestination(input)).toBeNull();
  });
});

describe('settlement rectangle interpolation', () => {
  const from: LayoutRect = { x: 10, y: 20, width: 200, height: 60 };
  const to: LayoutRect = { x: 100, y: 200, width: 80, height: 120 };

  it('interpolates source and destination sizes together with position', () => {
    expect(interpolateSettlementRect(from, to, 0)).toEqual(from);
    expect(interpolateSettlementRect(from, to, 0.5)).toEqual({
      x: 55,
      y: 110,
      width: 140,
      height: 90,
    });
    expect(interpolateSettlementRect(from, to, 1)).toEqual(to);
  });

  it('clamps progress to the animation endpoints', () => {
    expect(interpolateSettlementRect(from, to, -0.2)).toEqual(from);
    expect(interpolateSettlementRect(from, to, 1.2)).toEqual(to);
  });

  it('does not propagate invalid geometry or animation values to native styles', () => {
    expect(interpolateSettlementRect(from, to, NaN)).toBeNull();
    expect(interpolateSettlementRect({ ...from, width: 0 }, to, 0)).toBeNull();
    expect(
      interpolateSettlementRect(from, { ...to, x: Infinity }, 1),
    ).toBeNull();
  });
});
