import { act, type ReactNode } from 'react';

// Use the installed RN reconciler for real memo/context/effect semantics without
// installing a second renderer. These tests render components returning null;
// only the Fabric host boundary is stubbed.
jest.mock(
  'react-native/Libraries/ReactPrivate/ReactNativePrivateInitializeCore',
  () => ({}),
);
jest.mock(
  'react-native/Libraries/ReactPrivate/ReactNativePrivateInterface',
  () => ({
    ReactNativeViewConfigRegistry: {
      customBubblingEventTypes: {},
      customDirectEventTypes: {},
      get: jest.fn(),
    },
    ReactFiberErrorDialog: { showErrorDialog: () => false },
    createPublicRootInstance: () => ({}),
  }),
);

Object.assign(
  (
    globalThis as typeof globalThis & {
      nativeFabricUIManager: Record<string, unknown>;
    }
  ).nativeFabricUIManager,
  {
    createChildSet: () => [],
    completeRoot: () => {},
  },
);

// RN exposes no public test renderer; use the installed reconciler intentionally.
const renderer =
  // eslint-disable-next-line @react-native/no-deep-imports
  require('react-native/Libraries/Renderer/implementations/ReactFabric-dev') as {
    render(
      element: ReactNode,
      root: number,
      callback: undefined,
      concurrent: boolean,
      options: { onUncaughtError(error: Error): void },
    ): void;
    stopSurface(root: number): void;
  };

let nextRoot = 1;
export function createFabricTestRoot() {
  const root = nextRoot++;
  return {
    async render(element: ReactNode) {
      await act(() => {
        renderer.render(element, root, undefined, true, {
          onUncaughtError(error) {
            throw error;
          },
        });
      });
    },
    async unmount() {
      await act(() => renderer.stopSurface(root));
    },
  };
}
