import type { LayoutLocation, LayoutState } from '../../src/contracts';
import type { GridItemLayout } from '../../src/engine/layoutMove';
import * as layoutMove from '../../src/engine/layoutMove';
import * as layoutState from '../../src/engine/layoutState';
import type { GridMovementPolicy } from '../../src/engine/movementPolicy';
import {
  DndSessionCoordinator,
  type DndSessionOptions,
} from '../../src/controller/dndSession';
import {
  createDndStateStore,
  type DndProposal,
  type DndValue,
} from '../../src/controller/dndState';
import type { DropDecision } from '../../src/types';

function initial(): LayoutState<string> {
  return {
    revision: 0,
    items: ['a', 'b', 'c'].map(id => ({ id, data: id })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['a', 'b', 'c'],
      },
      {
        id: 'destination',
        kind: 'list',
        orientation: 'horizontal',
        itemIds: [],
      },
    ],
  };
}
const target = (index = 2): LayoutLocation => ({
  kind: 'list',
  zoneId: 'source',
  index,
});

function harness(overrides: Partial<DndSessionOptions<string>> = {}) {
  const onChange = jest.fn<void, [DndValue<string>, DndProposal<string>]>(
    overrides.onChange,
  );
  const onDragStart = jest.fn(overrides.onDragStart);
  const onDragEnd = jest.fn(overrides.onDragEnd);
  const onValidationError = jest.fn(overrides.onValidationError);
  let options: DndSessionOptions<string> = {
    value: initial(),
    ...overrides,
    onChange,
    onDragStart,
    onDragEnd,
    onValidationError,
  };
  const session = new DndSessionCoordinator(options);
  return {
    session,
    onChange,
    onDragStart,
    onDragEnd,
    onValidationError,
    get options() {
      return options;
    },
    commit(patch: Partial<DndSessionOptions<string>> = {}) {
      options = { ...options, ...patch };
      session.commit(options);
    },
    start() {
      const id = session.start('a');
      if (!id) throw new Error('Expected session');
      return id;
    },
    drop(to: LayoutLocation | null = target()) {
      const id = this.start();
      session.release(id, 1, to);
      return id;
    },
    proposal() {
      return onChange.mock.calls[onChange.mock.calls.length - 1][1];
    },
  };
}

describe('normalized list sessions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('previews increasing requests without changing owner state and recalculates the release', () => {
    const h = harness();
    const original = h.options.value;
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    h.session.requestTarget(id, 1, target(2));
    expect(h.session.getSnapshot().target).toEqual(target(1));
    h.commit(); // A render/scroll update with the same owner state keeps the drag.
    expect(h.session.getSnapshot().phase).toBe('dragging');
    h.session.release(id, 1, target(2));
    expect(h.proposal().to).toEqual(target(2));
    expect(h.proposal().value.zones[0]).toHaveProperty('itemIds', [
      'b',
      'c',
      'a',
    ]);
    expect(h.options.value).toBe(original);
    expect(h.session.getSnapshot().phase).toBe('awaiting-response');
  });

  it('keeps a 5000-item preview stable while the pointer stays in the same measured target', () => {
    const items = Array.from({ length: 5000 }, (_, index) => ({
      id: index === 0 ? 'a' : `item-${index}`,
      data: String(index),
    }));
    const canDrop = jest.fn(() => ({ allowed: true }));
    const h = harness({
      value: {
        revision: 0,
        items,
        zones: [
          {
            id: 'source',
            kind: 'list',
            orientation: 'vertical',
            itemIds: items.map(item => item.id),
          },
        ],
      },
      canDrop,
    });
    const compute = jest.spyOn(layoutMove, 'computeValidatedLayoutMove');
    const id = h.start();
    h.session.requestTarget(id, 1, target(10));
    const preview = h.session.getSnapshot();
    const listener = jest.fn();
    h.session.subscribe(listener);

    for (let seq = 2; seq <= 240; seq++) {
      h.session.requestTarget(id, seq, target(10), { refresh: false });
    }

    expect(compute).toHaveBeenCalledTimes(1);
    expect(canDrop).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(h.session.getSnapshot()).toBe(preview);
    expect(h.session.getSnapshot().candidate?.items).toBe(items);
    // The private sequence still advances even though there is no UI update.
    h.session.release(id, 239, target(10));
    expect(h.onChange).not.toHaveBeenCalled();
    h.session.release(id, 240, target(10));
    expect(compute).toHaveBeenCalledTimes(2);
    expect(canDrop).toHaveBeenCalledTimes(2);
    expect(h.proposal().to).toEqual(target(10));
  });

  it('rechecks changed targets and explicit measurement refreshes after coalesced pointer requests', () => {
    let allowed = true;
    const canDrop = jest.fn(() => ({ allowed }));
    const h = harness({ canDrop });
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    h.session.requestTarget(id, 2, target(1), { refresh: false });
    expect(canDrop).toHaveBeenCalledTimes(1);
    h.session.requestTarget(id, 3, target(2), { refresh: false });
    expect(canDrop).toHaveBeenCalledTimes(2);
    expect(h.session.getSnapshot().target).toEqual(target(2));

    allowed = false;
    h.session.requestTarget(id, 4, target(2), { refresh: true });
    expect(canDrop).toHaveBeenCalledTimes(3);
    expect(h.session.getSnapshot().validity).toBe('invalid');
    const denied = h.session.getSnapshot();
    h.session.requestTarget(id, 5, target(2), { refresh: false });
    expect(h.session.getSnapshot()).toBe(denied);

    // Omitting the optimization flag preserves the coordinator's default
    // behavior for adapters that cannot certify stable measurements.
    allowed = true;
    h.session.requestTarget(id, 6, target(2));
    expect(canDrop).toHaveBeenCalledTimes(4);
    expect(h.session.getSnapshot().validity).toBe('valid');
    h.session.requestTarget(id, 7, null, { refresh: false });
    expect(h.session.getSnapshot().failureReason).toBe('outside-zones');
    const outside = h.session.getSnapshot();
    h.session.requestTarget(id, 8, null, { refresh: false });
    expect(h.session.getSnapshot()).toBe(outside);
  });

  it('validates only the complete candidate per changed target and trusts the committed baseline', () => {
    const canDrop = jest.fn(() => ({ allowed: true }));
    const h = harness({ canDrop });
    const validate = jest.spyOn(layoutState, 'validateLayoutState');
    const id = h.start();
    const baseline = h.options.value;
    validate.mockClear();

    h.session.requestTarget(id, 1, target(1));

    // computeLayoutMove checks the candidate; the post-canDrop proposal check
    // validates that candidate again. The committed baseline is not revisited.
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.calls.map(([value]) => value === baseline)).toEqual([
      false,
      false,
    ]);
    expect(h.session.getSnapshot().candidate?.zones[0]).toHaveProperty(
      'itemIds',
      ['b', 'a', 'c'],
    );
    h.session.requestTarget(id, 2, target(2));
    expect(validate).toHaveBeenCalledTimes(4);

    h.commit({ canDrop: undefined });
    validate.mockClear();
    h.session.requestTarget(id, 3, target(1));
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0]![0]).not.toBe(baseline);
    expect(h.session.getSnapshot().phase).toBe('dragging');
  });

  it('revalidates every scroll refresh without publishing an unchanged preview', () => {
    const canDrop = jest.fn(() => ({ allowed: true }));
    const h = harness({ canDrop });
    const compute = jest.spyOn(layoutMove, 'computeValidatedLayoutMove');
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    const preview = h.session.getSnapshot();
    const listener = jest.fn();
    h.session.subscribe(listener);
    for (let seq = 2; seq <= 24; seq++) {
      h.session.requestTarget(id, seq, target(1), { refresh: true });
      expect(h.session.getSnapshot()).toBe(preview);
    }
    expect(canDrop).toHaveBeenCalledTimes(24);
    expect(compute).toHaveBeenCalledTimes(24);
    expect(listener).not.toHaveBeenCalled();
    h.session.release(id, 23, target(1));
    expect(h.onChange).not.toHaveBeenCalled();
    h.session.release(id, 24, target(1));
    expect(canDrop).toHaveBeenCalledTimes(25);
    expect(h.session.getSnapshot().phase).toBe('awaiting-response');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.proposal().to).toEqual(target(1));
  });

  it('keeps an equivalent preview when Worklets freezes its previously published target', () => {
    const canDrop = jest.fn(() => ({ allowed: true }));
    const h = harness({ canDrop });
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    const previous = h.session.getSnapshot();
    Object.freeze(previous.target);
    expect(Object.isFrozen(previous.target)).toBe(true);
    const listener = jest.fn();
    h.session.subscribe(listener);
    h.session.requestTarget(id, 2, target(1), { refresh: true });
    expect(h.session.getSnapshot()).toBe(previous);
    expect(listener).not.toHaveBeenCalled();
    expect(canDrop).toHaveBeenCalledTimes(2);
  });

  it('publishes changed visibility decisions and item data after a repeated target refresh', () => {
    let allowed = true;
    const h = harness({ canDrop: () => ({ allowed }) });
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    const listener = jest.fn();
    h.session.subscribe(listener);
    allowed = false;
    h.session.requestTarget(id, 2, target(1), { refresh: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.session.getSnapshot()).toMatchObject({
      validity: 'invalid',
      candidate: null,
      failureReason: 'policy-rejected',
    });
    const denied = h.session.getSnapshot();
    h.session.requestTarget(id, 3, target(1), { refresh: true });
    expect(h.session.getSnapshot()).toBe(denied);
    expect(listener).toHaveBeenCalledTimes(1);
    allowed = true;
    h.session.requestTarget(id, 4, target(1), { refresh: true });
    expect(listener).toHaveBeenCalledTimes(2);
    const value = {
      ...h.options.value,
      items: h.options.value.items.map(item => ({ ...item, data: 'fresh' })),
    };
    h.commit({ value });
    h.session.requestTarget(id, 5, target(1), { refresh: true });
    expect(h.session.getSnapshot().candidate?.items).toBe(value.items);
    expect(h.session.getSnapshot().candidate?.items[0].data).toBe('fresh');
  });

  it.each(['items', 'metadata', 'symbol', 'other-order'] as const)(
    'preserves a policy change to candidate %s during an otherwise equal refresh',
    change => {
      let mutate = false;
      const metadata = Symbol('candidate metadata');
      const h = harness({
        canDrop: proposal => {
          if (mutate) {
            if (change === 'items')
              proposal.value.items = [...proposal.value.items];
            else if (change === 'other-order') {
              const zone = proposal.value.zones[0];
              if (zone.kind === 'list') zone.itemIds = ['c', 'a', 'b'];
            } else
              Object.assign(proposal.value, {
                [change === 'symbol' ? metadata : 'metadata']: {
                  changed: true,
                },
              });
          }
          return { allowed: true };
        },
      });
      const id = h.start();
      h.session.requestTarget(id, 1, target(1));
      const previous = h.session.getSnapshot();
      const listener = jest.fn();
      h.session.subscribe(listener);
      mutate = true;
      h.session.requestTarget(id, 2, target(1), { refresh: true });
      const current = h.session.getSnapshot();
      expect(current).not.toBe(previous);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(current.validity).toBe('valid');
      if (change === 'items')
        expect(current.candidate?.items).not.toBe(previous.candidate?.items);
      else if (change === 'other-order')
        expect(current.candidate?.zones[0]).toHaveProperty('itemIds', [
          'c',
          'a',
          'b',
        ]);
      else
        expect(
          Reflect.get(
            current.candidate!,
            change === 'symbol' ? metadata : 'metadata',
          ),
        ).toEqual({ changed: true });
    },
  );

  it('does not invoke metadata accessors while comparing refreshed previews', () => {
    const getter = jest.fn(() => ({ opaque: true }));
    const h = harness({
      canDrop: proposal => {
        Object.defineProperty(proposal.value, 'metadata', {
          enumerable: true,
          get: getter,
        });
        return { allowed: true };
      },
    });
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    const previous = h.session.getSnapshot();
    // Candidate validation copies this metadata; equality must not read it again.
    getter.mockClear();
    h.session.requestTarget(id, 2, target(1), { refresh: true });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(h.session.getSnapshot()).not.toBe(previous);
  });

  it('does not suppress an equal refresh that reentrantly commits owner options', () => {
    let reenter = false;
    const h = harness({
      canDrop: () => {
        if (reenter) h.commit();
        return { allowed: true };
      },
    });
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    const previous = h.session.getSnapshot();
    const listener = jest.fn();
    h.session.subscribe(listener);
    reenter = true;
    h.session.requestTarget(id, 2, target(1), { refresh: true });
    expect(h.session.getSnapshot()).not.toBe(previous);
    expect(h.session.getSnapshot().seq).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(['request', 'release', 'cancel', 'value'] as const)(
    'preserves a reentrant %s while refreshing the same preview',
    operation => {
      let reenter = false;
      const h = harness({
        canDrop: proposal => {
          if (reenter) {
            reenter = false;
            if (operation === 'request')
              h.session.requestTarget(proposal.sessionId, 3, target(2), {
                refresh: true,
              });
            else if (operation === 'release')
              h.session.release(proposal.sessionId, 3, target(2));
            else if (operation === 'cancel') h.session.cancel('disabled');
            else h.commit({ value: { ...h.options.value, revision: 1 } });
          }
          return { allowed: true };
        },
      });
      const id = h.start();
      h.session.requestTarget(id, 1, target(1));
      const listener = jest.fn();
      h.session.subscribe(listener);
      reenter = true;
      h.session.requestTarget(id, 2, target(1), { refresh: true });
      expect(listener).toHaveBeenCalledTimes(1);
      if (operation === 'request')
        expect(h.session.getSnapshot()).toMatchObject({
          seq: 3,
          target: target(2),
        });
      else if (operation === 'release') {
        expect(h.session.getSnapshot().phase).toBe('awaiting-response');
        expect(h.proposal().to).toEqual(target(2));
      } else {
        expect(h.session.getSnapshot().phase).toBe('idle');
        expect(h.onDragEnd).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('revalidates policy mutations before considering a refresh unchanged', () => {
    let corrupt = false;
    const h = harness({
      canDrop: proposal => {
        if (corrupt) proposal.value.items = [];
        return { allowed: true };
      },
    });
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    const listener = jest.fn();
    h.session.subscribe(listener);
    corrupt = true;
    h.session.requestTarget(id, 2, target(1), { refresh: true });
    expect(h.session.getSnapshot()).toMatchObject({
      validity: 'invalid',
      candidate: null,
      failureReason: 'invalid-target',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('invalidates a reusable preview when the committed policy callback or item data changes', () => {
    const h = harness();
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    const canDrop = jest.fn(() => ({ allowed: false }));
    h.commit({ canDrop });
    h.session.requestTarget(id, 2, target(1), { refresh: false });
    expect(canDrop).toHaveBeenCalledTimes(1);
    expect(h.session.getSnapshot().validity).toBe('invalid');

    canDrop.mockReturnValue({ allowed: true });
    const value = {
      ...h.options.value,
      items: h.options.value.items.map(item => ({ ...item, data: 'updated' })),
    };
    h.commit({ value });
    h.session.requestTarget(id, 3, target(1), { refresh: false });
    expect(canDrop).toHaveBeenCalledTimes(2);
    expect(h.session.getSnapshot().candidate?.items).toBe(value.items);
  });

  it('does not coalesce a reentrant request until its earlier policy callback completes', () => {
    let reenter = true;
    const canDrop = jest.fn((proposal: DndProposal<string>) => {
      if (reenter) {
        reenter = false;
        h.session.requestTarget(proposal.sessionId, 2, target(1), {
          refresh: false,
        });
        return { allowed: false };
      }
      return { allowed: true };
    });
    const h = harness({ canDrop });
    const id = h.start();
    h.session.requestTarget(id, 1, target(1));
    expect(canDrop).toHaveBeenCalledTimes(2);
    expect(h.session.getSnapshot()).toEqual(
      expect.objectContaining({ seq: 2, validity: 'valid', target: target(1) }),
    );
    const preview = h.session.getSnapshot();
    h.session.requestTarget(id, 3, target(1), { refresh: false });
    expect(canDrop).toHaveBeenCalledTimes(2);
    expect(h.session.getSnapshot()).toBe(preview);
  });

  it('synchronously accepts the state helper response and delivers one terminal event', () => {
    const store = createDndStateStore(initial());
    const h = harness({ value: store.getSnapshot(), onChange: store.onChange });
    store.subscribe(() => h.commit({ value: store.getSnapshot() }));
    h.drop({ kind: 'list', zoneId: 'destination', index: 0 });
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().displayValue).toBe(store.getSnapshot());
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'proposed', response: 'accepted' }),
    );
    expect(store.getSnapshot().revision).toBe(1);
    jest.advanceTimersByTime(5000);
    expect(h.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('checks permission for preview and release and never emits a denied proposal', () => {
    const canDrop = jest
      .fn<DropDecision, [DndProposal<string>]>()
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValue({ allowed: false, reason: 'locked' });
    const h = harness({ canDrop });
    const id = h.start();
    h.session.requestTarget(id, 1, target());
    expect(h.session.getSnapshot().validity).toBe('valid');
    h.session.release(id, 1, target());
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'policy-rejected',
        policyReason: 'locked',
      }),
    );
  });

  it('rejects an invalid policy response and cleans up thrown callbacks', () => {
    const h = harness({ canDrop: () => undefined as unknown as DropDecision });
    h.drop();
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'policy-error' }),
    );
    expect(h.session.getSnapshot().phase).toBe('idle');
    const start = harness({
      onDragStart: () => {
        throw new Error('start');
      },
    });
    expect(start.session.start('a')).toBeNull();
    expect(start.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'start-handler-error' }),
    );
    const change = harness({
      onChange: () => {
        throw new Error('change');
      },
    });
    change.drop();
    expect(change.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        response: 'interrupted',
        reason: 'change-handler-error',
      }),
    );
  });

  it('preserves an external edit made reentrantly inside canDrop and suppresses the old proposal', () => {
    const fresh = { ...initial(), revision: 1 };
    const h = harness({
      canDrop: () => {
        h.commit({ value: fresh });
        return { allowed: true };
      },
    });
    h.drop();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.session.getSnapshot().displayValue).toBe(fresh);
    expect(h.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('does not let an older policy callback error cancel a newer target request', () => {
    let reenter = true;
    const h = harness({
      canDrop: proposal => {
        if (reenter) {
          reenter = false;
          h.session.requestTarget(proposal.sessionId, 2, target(1));
          throw new Error('obsolete policy callback');
        }
        return { allowed: true };
      },
    });
    const id = h.start();
    h.session.requestTarget(id, 1, target(2));
    expect(h.session.getSnapshot()).toEqual(
      expect.objectContaining({
        phase: 'dragging',
        seq: 2,
        validity: 'valid',
        target: target(1),
      }),
    );
    expect(h.onDragEnd).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it.each(['dragging', 'awaiting-response'] as const)(
    'preserves external revision edits during %s',
    phase => {
      const h = harness();
      const id = h.start();
      if (phase === 'awaiting-response') h.session.release(id, 1, target());
      const fresh = { ...initial(), revision: 1 };
      h.commit({ value: fresh });
      expect(h.session.getSnapshot().displayValue).toBe(fresh);
      expect(h.session.getSnapshot().phase).toBe('idle');
      expect(h.onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'input-changed' }),
      );
    },
  );

  it('detects in-place order edits at the same revision', () => {
    const h = harness();
    h.start();
    const zone = h.options.value.zones[0];
    if (zone.kind !== 'list') throw new Error('Expected list');
    zone.itemIds.reverse();
    h.commit();
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'input-changed' }),
    );
    expect(h.session.getSnapshot().displayValue?.zones[0]).toHaveProperty(
      'itemIds',
      ['c', 'b', 'a'],
    );
  });

  it('ignores wrong response revisions then handles explicit rejection', () => {
    const h = harness();
    const id = h.drop();
    h.commit({
      value: {
        ...h.options.value,
        proposalResponse: { sessionId: id, baseRevision: 99, accepted: false },
      },
    });
    expect(h.session.getSnapshot().phase).toBe('awaiting-response');
    h.commit({
      value: {
        ...h.options.value,
        proposalResponse: { sessionId: id, baseRevision: 0, accepted: false },
      },
    });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'rejected' }),
    );
    expect(h.session.getSnapshot().displayValue?.revision).toBe(0);
  });

  it.each(['revision', 'order'] as const)(
    'refuses acceptance with mismatched %s',
    mismatch => {
      const h = harness();
      const id = h.drop();
      const candidate = h.proposal().value;
      let value: DndValue<string> = {
        ...candidate,
        proposalResponse: { sessionId: id, baseRevision: 0, accepted: true },
      };
      if (mismatch === 'revision') value = { ...value, revision: 0 };
      if (mismatch === 'order') value = { ...value, zones: initial().zones };
      h.commit({ value });
      expect(h.onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'mismatch' }),
      );
      expect(h.session.getSnapshot().displayValue).toBe(value);
    },
  );

  it('accepts a response whose item objects were rebuilt when layout and revision match', () => {
    // An owner may derive new item data for the destination (a dock item is
    // not the page item); acceptance is judged by the layout key alone.
    const h = harness();
    const id = h.drop();
    const candidate = h.proposal().value;
    const value: DndValue<string> = {
      ...candidate,
      items: candidate.items.map(item => ({ ...item, data: `${item.data}!` })),
      proposalResponse: { sessionId: id, baseRevision: 0, accepted: true },
    };
    h.commit({ value });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'proposed', response: 'accepted' }),
    );
    expect(h.session.getSnapshot().phase).toBe('idle');
    expect(h.session.getSnapshot().displayValue).toBe(value);
  });

  it('requires explicit response even when the candidate itself has been committed', () => {
    const h = harness();
    h.drop();
    h.commit({ value: h.proposal().value });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        response: 'interrupted',
        reason: 'response-missing',
      }),
    );
  });

  it('expires once and ignores a delayed response during a newer session', () => {
    const h = harness({ responseTimeoutMs: 50 });
    const previous = h.drop();
    jest.advanceTimersByTime(50);
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'expired' }),
    );
    const current = h.start();
    h.session.release(current, 1, target(1));
    h.commit({
      value: {
        ...h.options.value,
        proposalResponse: {
          sessionId: previous,
          baseRevision: 0,
          accepted: false,
        },
      },
    });
    expect(h.session.getSnapshot().phase).toBe('awaiting-response');
    expect(h.session.getSnapshot().sessionId).toBe(current);
    expect(h.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('checks the deadline even before a queued timeout callback runs', () => {
    const h = harness({ responseTimeoutMs: 50 });
    const id = h.drop();
    const monotonic = (
      globalThis as typeof globalThis & { performance: { now(): number } }
    ).performance;
    jest.spyOn(monotonic, 'now').mockReturnValue(100);
    h.commit({
      value: {
        ...h.proposal().value,
        proposalResponse: { sessionId: id, baseRevision: 0, accepted: true },
      },
    });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'expired' }),
    );
  });

  it('allows a new session inside onDragEnd without clearing it afterward', () => {
    let replacement: string | null = null;
    const h = harness({
      onDragEnd: () => {
        replacement = h.session.start('b');
      },
    });
    h.drop(target(0));
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'unchanged' }),
    );
    expect(replacement).not.toBeNull();
    expect(h.session.getSnapshot().sessionId).toBe(replacement);
    expect(h.session.getSnapshot().itemId).toBe('b');
  });

  it('does not undo synchronous acceptance if the change callback throws afterward', () => {
    const store = createDndStateStore(initial());
    const h = harness({
      value: store.getSnapshot(),
      onChange: (value, proposal) => {
        store.onChange(value, proposal);
        throw new Error('after accepted');
      },
    });
    store.subscribe(() => h.commit({ value: store.getSnapshot() }));
    h.drop();
    expect(h.onDragEnd).toHaveBeenCalledTimes(1);
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'accepted' }),
    );
    expect(h.session.getSnapshot().displayValue?.revision).toBe(1);
  });

  it('disposes once, clears timeout and supports Strict Mode commit revival', () => {
    const h = harness();
    h.drop();
    h.session.dispose();
    h.session.dispose();
    jest.advanceTimersByTime(3000);
    expect(h.onDragEnd).toHaveBeenCalledTimes(1);
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unmounted' }),
    );
    expect(h.session.start('a')).toBeNull();
    h.commit();
    expect(h.session.start('a', 99)).toBeNull();
    expect(h.session.start('a', 0)).not.toBeNull();
  });

  it('invalidates timeout configuration changes and reports thrown end callbacks after cleanup', () => {
    const h = harness({
      onDragEnd: () => {
        throw new Error('end');
      },
    });
    h.drop();
    h.commit({ responseTimeoutMs: 20 });
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        response: 'interrupted',
        reason: 'input-changed',
      }),
    );
    expect(h.session.getSnapshot().phase).toBe('idle');
    jest.advanceTimersByTime(3000);
    expect(h.onDragEnd).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('ignores stale sessions, malformed sequences, invalid targets and disabled starts', () => {
    const h = harness();
    const id = h.start();
    h.session.requestTarget('old', 5, target());
    h.session.requestTarget(id, NaN, target());
    expect(h.session.getSnapshot().seq).toBe(-1);
    h.session.requestTarget(id, 1, null);
    expect(h.session.getSnapshot().validity).toBe('invalid');
    h.session.release(id, 0, target());
    expect(h.onChange).not.toHaveBeenCalled();
    h.session.release(id, 1, null);
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'outside-zones' }),
    );
    h.commit({ disabled: true });
    expect(h.session.start('a')).toBeNull();
  });

  it('disables invalid input, reports it once and recovers without notifying identical commits', () => {
    const h = harness();
    const listener = jest.fn();
    h.session.subscribe(listener);
    h.commit();
    expect(listener).not.toHaveBeenCalled();
    h.commit({ value: { ...h.options.value, revision: -1 } });
    h.commit();
    expect(h.onValidationError).toHaveBeenCalledTimes(1);
    expect(h.session.start('a')).toBeNull();
    h.commit({ value: initial() });
    expect(h.session.start('a')).not.toBeNull();
  });

  it('rejects an explicit null search budget and recovers when the option is omitted', () => {
    const h = harness({ searchBudget: null as unknown as number });
    h.commit();
    expect(h.session.getSnapshot().disabled).toBe(true);
    expect(h.session.start('a')).toBeNull();
    expect(h.onValidationError).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-budget' }),
      ]),
    );
    h.commit({ searchBudget: undefined });
    expect(h.session.start('a')).not.toBeNull();
  });
});

function mixed(): LayoutState<string> {
  return {
    revision: 0,
    items: ['a', 'b', 'g'].map(id => ({ id, data: id })),
    zones: [
      {
        id: 'source',
        kind: 'list',
        orientation: 'vertical',
        itemIds: ['a', 'b'],
      },
      {
        id: 'destination',
        kind: 'list',
        orientation: 'horizontal',
        itemIds: [],
      },
      {
        id: 'grid',
        kind: 'grid',
        rows: 2,
        columns: 3,
        placements: [
          {
            itemId: 'g',
            position: { row: 0, col: 0 },
            span: { rows: 1, cols: 2 },
            placement: 'exchange',
          },
        ],
      },
      { id: 'other', kind: 'grid', rows: 2, columns: 4, placements: [] },
    ],
  };
}
const gridTarget = (zoneId = 'grid', row = 1, col = 0): LayoutLocation => ({
  kind: 'grid',
  zoneId,
  position: { row, col },
});

describe('mixed grid/list sessions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('coalesces equivalent grid cells without hiding row, column or zone changes', () => {
    const h = harness({
      value: mixed(),
      getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
    });
    const compute = jest.spyOn(layoutMove, 'computeValidatedLayoutMove');
    const id = h.start();
    h.session.requestTarget(id, 1, gridTarget('other', 0, 0));
    const preview = h.session.getSnapshot();
    h.session.requestTarget(id, 2, gridTarget('other', 0, 0), {
      refresh: false,
    });
    expect(h.session.getSnapshot()).toBe(preview);
    expect(compute).toHaveBeenCalledTimes(1);
    h.session.requestTarget(id, 3, gridTarget('other', 0, 1), {
      refresh: false,
    });
    h.session.requestTarget(id, 4, gridTarget('other', 1, 1), {
      refresh: false,
    });
    h.session.requestTarget(id, 5, gridTarget('grid', 1, 1), {
      refresh: false,
    });
    expect(compute).toHaveBeenCalledTimes(4);
    expect(h.session.getSnapshot().target).toEqual(gridTarget('grid', 1, 1));
  });

  it('resolves and copies every target span once, sharing captured geometry with previews and release', () => {
    const descriptor: GridItemLayout = {
      span: { rows: 1, cols: 2 },
      placement: 'insert',
    };
    const getGridItemLayout = jest.fn(() => descriptor);
    const h = harness({ value: mixed(), getGridItemLayout });
    const id = h.start();
    expect(getGridItemLayout).toHaveBeenCalledTimes(2);
    expect(getGridItemLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        item: h.options.value.items[0],
        from: { kind: 'list', zoneId: 'source', index: 0 },
        value: h.options.value,
      }),
    );
    const captured = h.session.getSnapshot().gridItemLayouts.get('grid')!;
    expect(captured.span).toEqual({ rows: 1, cols: 2 });
    expect(captured).not.toBe(descriptor);
    descriptor.span.cols = 3;
    h.session.requestTarget(id, 1, gridTarget());
    h.session.requestTarget(id, 2, gridTarget('other', 0, 0));
    h.session.release(id, 2, gridTarget());
    expect(getGridItemLayout).toHaveBeenCalledTimes(2);
    expect(h.proposal().value.zones[2]).toHaveProperty(
      'placements',
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'a', span: { rows: 1, cols: 2 } }),
      ]),
    );
    expect(h.proposal().value.items).toBe(h.options.value.items);
  });

  it.each([undefined, null, { span: { rows: 0, cols: 1 } }])(
    'disables only grid destinations for invalid conversion %p',
    descriptor => {
      const h = harness({
        value: mixed(),
        getGridItemLayout:
          descriptor === undefined
            ? undefined
            : () => descriptor as GridItemLayout | null,
      });
      const id = h.start();
      expect(h.session.getSnapshot().disabled).toBe(false);
      expect(h.session.getSnapshot().gridItemLayouts.size).toBe(0);
      h.session.requestTarget(id, 1, gridTarget());
      expect(h.session.getSnapshot()).toEqual(
        expect.objectContaining({
          validity: 'invalid',
          failureReason:
            descriptor && 'span' in descriptor
              ? 'invalid-grid-item-layout'
              : 'missing-grid-item-layout',
        }),
      );
      h.session.requestTarget(id, 2, {
        kind: 'list',
        zoneId: 'destination',
        index: 0,
      });
      expect(h.session.getSnapshot().validity).toBe('valid');
      h.session.release(id, 2, {
        kind: 'list',
        zoneId: 'destination',
        index: 0,
      });
      expect(h.onChange).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves same-grid geometry and only asks for cross-grid overrides', () => {
    const getGridItemLayout = jest.fn(() => ({
      span: { rows: 2, cols: 1 },
      placement: 'insert' as const,
    }));
    const h = harness({ value: mixed(), getGridItemLayout });
    const id = h.session.start('g')!;
    expect(getGridItemLayout).toHaveBeenCalledTimes(1);
    expect(getGridItemLayout.mock.calls[0]).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ id: 'other' }),
      }),
    ]);
    expect(h.session.getSnapshot().gridItemLayouts.get('grid')).toEqual({
      span: { rows: 1, cols: 2 },
      placement: 'exchange',
    });
    expect(h.session.getSnapshot().gridItemLayouts.get('other')).toEqual({
      span: { rows: 2, cols: 1 },
      placement: 'insert',
    });
    h.session.release(id, 1, gridTarget('other', 0, 0));
    expect(h.proposal().value.zones[3]).toHaveProperty('placements', [
      expect.objectContaining({ itemId: 'g', span: { rows: 2, cols: 1 } }),
    ]);
  });

  it('defaults cross-grid moves to the source descriptor and needs no resolver for grid-to-list', () => {
    const h = harness({ value: mixed() });
    const id = h.session.start('g')!;
    expect(h.session.getSnapshot().gridItemLayouts.get('other')).toEqual({
      span: { rows: 1, cols: 2 },
      placement: 'exchange',
    });
    h.session.release(id, 1, { kind: 'list', zoneId: 'destination', index: 0 });
    expect(h.proposal().value.zones[2]).toHaveProperty('placements', []);
    expect(h.proposal().value.zones[1]).toHaveProperty('itemIds', ['g']);
  });

  it('terminates resolver errors and does not start a partially configured session', () => {
    const error = new Error('conversion');
    const h = harness({
      value: mixed(),
      getGridItemLayout: () => {
        throw error;
      },
    });
    expect(h.session.start('a')).toBeNull();
    expect(h.onDragStart).not.toHaveBeenCalled();
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'cancelled',
        reason: 'policy-error',
        error,
      }),
    );
    expect(h.session.getSnapshot().gridItemLayouts.size).toBe(0);
    expect(h.session.getSnapshot().phase).toBe('idle');
  });

  it('does not overwrite an external revision committed inside the conversion callback', () => {
    const fresh = { ...mixed(), revision: 1 };
    const h = harness({
      value: mixed(),
      getGridItemLayout: () => {
        h.commit({ value: fresh });
        return { span: { rows: 1, cols: 1 } };
      },
    });
    expect(h.session.start('a')).toBeNull();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.session.getSnapshot().displayValue).toBe(fresh);
    expect(h.session.getSnapshot().gridItemLayouts.size).toBe(0);
  });

  it('distinguishes insufficient grid capacity from an invalid conversion', () => {
    const value: LayoutState<string> = {
      revision: 0,
      items: ['a', 'b'].map(id => ({ id, data: id })),
      zones: [
        { id: 'source', kind: 'list', orientation: 'vertical', itemIds: ['a'] },
        {
          id: 'grid',
          kind: 'grid',
          rows: 1,
          columns: 1,
          placements: [
            {
              itemId: 'b',
              position: { row: 0, col: 0 },
              span: { rows: 1, cols: 1 },
            },
          ],
        },
      ],
    };
    const h = harness({
      value,
      getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
    });
    const id = h.start();
    h.session.requestTarget(id, 1, gridTarget('grid', 0, 0));
    expect(h.session.getSnapshot().failureReason).toBe('unresolvable');
    h.session.release(id, 1, gridTarget('grid', 0, 0));
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unresolvable' }),
    );
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.session.getSnapshot().value).toBe(value);
  });

  it('reports search exhaustion separately and retains the committed layout', () => {
    const value: LayoutState<string> = {
      revision: 0,
      items: ['a', 'Target', 'Crossing'].map(id => ({ id, data: id })),
      zones: [
        {
          id: 'grid',
          kind: 'grid',
          rows: 3,
          columns: 4,
          placements: [
            {
              itemId: 'a',
              position: { row: 2, col: 1 },
              span: { rows: 1, cols: 1 },
            },
            {
              itemId: 'Target',
              position: { row: 0, col: 0 },
              span: { rows: 1, cols: 2 },
            },
            {
              itemId: 'Crossing',
              position: { row: 2, col: 2 },
              span: { rows: 1, cols: 2 },
            },
          ],
        },
      ],
    };
    const h = harness({ value, searchBudget: 1 });
    const id = h.start();
    h.session.requestTarget(id, 1, gridTarget('grid', 0, 0));
    expect(h.session.getSnapshot().failureReason).toBe('search-budget');
    h.session.release(id, 1, gridTarget('grid', 0, 0));
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'search-budget' }),
    );
    expect(h.session.getSnapshot().displayValue).toBe(value);
  });

  it('copies policy contents and detects in-place settings edits on commit', () => {
    const movementPolicy: GridMovementPolicy = {
      pointer: { cellHysteresis: 0.12 },
      candidateOrder: ['exchange'],
    };
    const h = harness({ value: mixed(), movementPolicy });
    h.session.start('g');
    movementPolicy.pointer!.cellHysteresis = 0.3;
    h.commit();
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'input-changed' }),
    );
    expect(h.session.getSnapshot().phase).toBe('idle');
  });

  it.each(['budget', 'resolver', 'policy'] as const)(
    'invalidates pending proposals when %s configuration changes, even with an old matching response',
    setting => {
      const resolver = () => ({ span: { rows: 1, cols: 1 } });
      const h = harness({ value: mixed(), getGridItemLayout: resolver });
      const id = h.drop(gridTarget());
      const accepted: DndValue<string> = {
        ...h.proposal().value,
        proposalResponse: { sessionId: id, baseRevision: 0, accepted: true },
      };
      h.commit({
        value: accepted,
        ...(setting === 'budget'
          ? { searchBudget: 5 }
          : setting === 'resolver'
            ? { getGridItemLayout: () => null }
            : { movementPolicy: { rowRotation: 'full-width' } }),
      });
      expect(h.onDragEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          response: 'interrupted',
          reason: 'input-changed',
        }),
      );
      expect(h.session.getSnapshot().displayValue).toBe(accepted);
      h.commit({ value: accepted });
      expect(h.onDragEnd).toHaveBeenCalledTimes(1);
    },
  );

  it('revalidates the complete candidate after canDrop instead of publishing a corrupted layout', () => {
    const h = harness({
      value: mixed(),
      getGridItemLayout: () => ({ span: { rows: 1, cols: 1 } }),
      canDrop: proposal => {
        proposal.value.zones = proposal.value.zones.map(zone =>
          zone.kind === 'grid' ? { ...zone, placements: [] } : zone,
        );
        return { allowed: true };
      },
    });
    h.drop(gridTarget());
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'invalid-target' }),
    );
  });

  it('accepts a mixed-zone proposal atomically through the state helper', () => {
    const store = createDndStateStore(mixed());
    const h = harness({
      value: store.getSnapshot(),
      onChange: store.onChange,
      getGridItemLayout: () => ({ span: { rows: 1, cols: 2 } }),
    });
    store.subscribe(() => h.commit({ value: store.getSnapshot() }));
    h.drop(gridTarget());
    expect(h.onDragEnd).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'accepted' }),
    );
    expect(store.getSnapshot().revision).toBe(1);
    expect(store.getSnapshot().zones[0]).toHaveProperty('itemIds', ['b']);
    expect(store.getSnapshot().zones[2]).toHaveProperty(
      'placements',
      expect.arrayContaining([expect.objectContaining({ itemId: 'a' })]),
    );
  });
});
