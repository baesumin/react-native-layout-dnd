import { act, createElement } from 'react';

import { GridController } from '../../src/components/GridController';
import type { DndProviderProps } from '../../src/components/dndTypes';
import type { DndDragEndEvent } from '../../src/controller/dndSession';
import type { GridValue } from '../../src/types';
import { createFabricTestRoot } from '../helpers/fabricTestRoot';

// The provider is replaced to observe what the adapter wires to it; the
// provider's own settlement timing is covered by its tests.
const mockProviderProps: DndProviderProps<string>[] = [];
jest.mock('../../src/components/DndProvider', () => ({
  DndProvider: (props: DndProviderProps<string>) => {
    mockProviderProps.push(props);
    return props.children;
  },
}));

function value(): GridValue<string> {
  return {
    revision: 3,
    zones: [
      {
        id: 'page',
        strategy: 'spatial',
        rows: 1,
        columns: 2,
        items: [
          {
            id: 'p1',
            data: 'p1',
            span: { rows: 1, cols: 1 },
            position: { row: 0, col: 0 },
          },
        ],
      },
    ],
  };
}

let root: ReturnType<typeof createFabricTestRoot>;

beforeEach(() => {
  mockProviderProps.length = 0;
  root = createFabricTestRoot();
});
afterEach(async () => {
  await root.unmount();
});

it('delivers the grid API onDragEnd at the provider’s settled timing, not at session end', async () => {
  const onDragEnd = jest.fn();
  await root.render(
    createElement(GridController<string>, {
      value: value(),
      onChange: () => {},
      renderItem: () => null,
      onDragEnd,
      children: null,
    }),
  );
  const props = mockProviderProps[mockProviderProps.length - 1];
  expect(props.onDragEnd).toBeUndefined();
  expect(typeof props.onDragSettled).toBe('function');
  const ended: DndDragEndEvent<string> = {
    sessionId: 's1',
    itemId: 'p1',
    sourceZoneId: 'page',
    outcome: 'cancelled',
    reason: 'geometry-changed',
  };
  await act(async () => {
    props.onDragSettled!(ended);
  });
  expect(onDragEnd).toHaveBeenCalledTimes(1);
  expect(onDragEnd).toHaveBeenCalledWith({
    sessionId: 's1',
    itemId: 'p1',
    sourceZoneId: 'page',
    outcome: 'cancelled',
    reason: 'geometry-changed',
  });
});
