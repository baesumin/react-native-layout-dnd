import type { LayoutState } from '../../src/contracts';
import { DndSessionCoordinator } from '../../src/controller/dndSession';
import type { GridDiagnosticEvent } from '../../src/types';

function layout(): LayoutState<string> {
  return {
    revision: 0,
    items: ['a', 'b', 'c'].map(id => ({ id, data: id })),
    zones: [
      {
        id: 'grid',
        kind: 'grid',
        rows: 1,
        columns: 3,
        placements: ['a', 'b', 'c'].map((itemId, col) => ({
          itemId,
          position: { row: 0, col },
          span: { rows: 1, cols: 1 },
          placement: 'insert',
        })),
      },
    ],
  };
}

const at = (col: number) => ({
  kind: 'grid' as const,
  zoneId: 'grid',
  position: { row: 0, col },
});

describe('DndSessionCoordinator diagnostics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reports lifecycle and timing events per session, after subscribers, and survives observer errors', () => {
    const events: GridDiagnosticEvent[] = [];
    const listener = jest.fn(() => {
      // Subscribers see the snapshot before any diagnostic of the same batch.
      events.push({
        type: 'lifecycle',
        name: 'settling',
        timestampMs: -1,
        sessionId: 'listener',
      });
    });
    const onDiagnostic = jest.fn((event: GridDiagnosticEvent) => {
      events.push(event);
      if (event.type === 'lifecycle' && event.name === 'end')
        throw new Error('observer failure');
    });
    const canDrop = jest.fn(() => ({ allowed: true }));
    const session = new DndSessionCoordinator<string>({
      value: layout(),
      onChange: jest.fn(),
      canDrop,
      onDiagnostic,
    });
    session.subscribe(listener);
    const id = session.start('a');
    if (!id) throw new Error('Expected a session');
    session.requestTarget(id, 1, at(2));
    session.requestTarget(id, 2, at(2), { refresh: false });
    session.release(id, 3, at(2));

    const own = events.filter(event => event.sessionId !== 'listener');
    expect(
      own.map(event => (event.type === 'lifecycle' ? event.name : event.name)),
    ).toEqual([
      'request',
      'compute-move',
      'policy',
      // The second request stays inside the same cell and is only reported.
      'request-coalesced',
      'release',
      // The release restores the previewed step, so only the policy runs again.
      'policy',
      'proposal',
    ]);
    for (const event of own) expect(event.sessionId).toBe(id);
    const timings = own.filter(event => event.type === 'timing');
    expect(timings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'compute-move',
          status: 'ok',
          attempts: expect.any(Number),
        }),
        expect.objectContaining({ name: 'policy', status: 'allowed' }),
      ]),
    );
    // The listener that ran in the same batch precedes that batch's diagnostics.
    const firstListener = events.findIndex(
      event => event.sessionId === 'listener',
    );
    const firstDiagnostic = events.findIndex(event => event.sessionId === id);
    expect(firstListener).toBeGreaterThanOrEqual(0);
    expect(firstListener).toBeLessThan(firstDiagnostic);

    session.cancel('gesture-interrupted');
    expect(own.length).toBe(7);
    const tail = events
      .filter(event => event.sessionId === id)
      .slice(7)
      .map(event => (event.type === 'lifecycle' ? event.name : event.name));
    expect(tail).toEqual(['response', 'end']);
    expect(session.getSnapshot().phase).toBe('idle');
    // A failing observer neither breaks the session nor prevents a new drag.
    expect(session.start('b')).not.toBeNull();
  });

  it('separates a coalesced request from one that never arrived', () => {
    const events: GridDiagnosticEvent[] = [];
    const session = new DndSessionCoordinator<string>({
      value: layout(),
      onChange: jest.fn(),
      onDiagnostic: event => events.push(event),
    });
    const id = session.start('a')!;
    session.requestTarget(id, 1, at(2));
    const names = () =>
      events
        .filter(event => event.type === 'lifecycle')
        .map(event => event.name);
    expect(names()).toEqual(['request']);
    // Pointer movement inside the same cell, certified by the adapter.
    session.requestTarget(id, 2, at(2), { refresh: false });
    expect(names()).toEqual(['request', 'request-coalesced']);
    // A different cell computes again.
    session.requestTarget(id, 3, at(1), { refresh: false });
    expect(names()).toEqual(['request', 'request-coalesced', 'request']);
  });

  it('records a rejected policy and a failed engine step', () => {
    const onDiagnostic = jest.fn();
    const session = new DndSessionCoordinator<string>({
      value: layout(),
      onChange: jest.fn(),
      canDrop: () => ({ allowed: false, reason: 'locked' }),
      onDiagnostic,
    });
    const id = session.start('a')!;
    session.requestTarget(id, 1, at(2));
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'policy', status: 'rejected' }),
    );
    onDiagnostic.mockClear();
    session.requestTarget(id, 2, {
      kind: 'grid',
      zoneId: 'grid',
      position: { row: 5, col: 0 },
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'compute-move', status: 'impossible' }),
    );
    expect(onDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'policy' }),
    );
  });
});
