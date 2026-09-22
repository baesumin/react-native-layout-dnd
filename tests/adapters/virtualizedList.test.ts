import { resolveListVirtualization } from '../../src/adapters/virtualizedList';
import type { ListVirtualizationOptions } from '../../src/adapters/virtualizedList';

const defaults = {
  initialNumToRender: 12,
  maxToRenderPerBatch: 12,
  windowSize: 7,
  updateCellsBatchingPeriod: 50,
};

describe('list virtualization configuration', () => {
  it.each([undefined, false])('keeps ScrollView for %p', value => {
    expect(resolveListVirtualization(value)).toEqual({
      valid: true,
      options: null,
    });
  });

  it.each([true, {}, { initialNumToRender: undefined, windowSize: undefined }])(
    'enables FlatList defaults for %p',
    value => {
      expect(resolveListVirtualization(value)).toEqual({
        valid: true,
        options: defaults,
      });
    },
  );

  it('fills unspecified limits without replacing explicit zero batch delay', () => {
    expect(
      resolveListVirtualization({
        initialNumToRender: 6,
        updateCellsBatchingPeriod: 0,
      }),
    ).toEqual({
      valid: true,
      options: {
        ...defaults,
        initialNumToRender: 6,
        updateCellsBatchingPeriod: 0,
      },
    });
  });

  it('accepts fractional viewport windows and fractional batch delays', () => {
    const options: ListVirtualizationOptions = {
      initialNumToRender: 1,
      maxToRenderPerBatch: 3,
      windowSize: 1.5,
      updateCellsBatchingPeriod: 2.5,
    };
    expect(resolveListVirtualization(options)).toEqual({
      valid: true,
      options,
    });
  });

  it('accepts count boundaries without silently rounding or capping limits', () => {
    const options = {
      initialNumToRender: Number.MAX_SAFE_INTEGER,
      maxToRenderPerBatch: 1,
      windowSize: Number.MAX_VALUE,
      updateCellsBatchingPeriod: Number.MAX_VALUE,
    };
    expect(resolveListVirtualization(options)).toEqual({
      valid: true,
      options,
    });
  });

  it('copies options and defaults so callers cannot modify future resolutions', () => {
    const input = Object.freeze({ windowSize: 3 });
    const resolved = resolveListVirtualization(input);
    const enabled = resolveListVirtualization(true);
    if (
      !resolved.valid ||
      !resolved.options ||
      !enabled.valid ||
      !enabled.options
    )
      throw new Error('Expected enabled virtualization');
    resolved.options.windowSize = 99;
    enabled.options.initialNumToRender = 1;
    expect(input.windowSize).toBe(3);
    expect(resolveListVirtualization(true)).toEqual({
      valid: true,
      options: defaults,
    });
  });

  it.each([null, [], [12], 0, 1, '', 'true', () => true])(
    'rejects malformed enablement %p',
    value => {
      expect(resolveListVirtualization(value)).toMatchObject({
        valid: false,
        issues: [{ code: 'invalid-configuration' }],
      });
    },
  );

  it('rejects unknown options instead of silently ignoring tuning typos', () => {
    expect(resolveListVirtualization({ windowSizes: 7 })).toMatchObject({
      valid: false,
      issues: [
        {
          code: 'invalid-configuration',
          message: expect.stringContaining('supports only'),
        },
      ],
    });
  });

  it.each(['initialNumToRender', 'maxToRenderPerBatch'])(
    'requires positive safe integers for %s',
    name => {
      for (const value of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        '12',
        null,
        false,
      ]) {
        expect(resolveListVirtualization({ [name]: value })).toEqual({
          valid: false,
          issues: [
            {
              code: 'invalid-configuration',
              message: `virtualization.${name} must be a positive safe integer.`,
            },
          ],
        });
      }
    },
  );

  it.each([0, -1, 1, NaN, Infinity, '7', null, false])(
    'rejects window size %p',
    windowSize => {
      expect(resolveListVirtualization({ windowSize })).toMatchObject({
        valid: false,
        issues: [
          {
            code: 'invalid-configuration',
            message: expect.stringContaining('windowSize'),
          },
        ],
      });
    },
  );

  it.each([-1, NaN, Infinity, '50', null, false])(
    'rejects batch delay %p',
    updateCellsBatchingPeriod => {
      expect(
        resolveListVirtualization({ updateCellsBatchingPeriod }),
      ).toMatchObject({
        valid: false,
        issues: [
          {
            code: 'invalid-configuration',
            message: expect.stringContaining('updateCellsBatchingPeriod'),
          },
        ],
      });
    },
  );
});
