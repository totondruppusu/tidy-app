import type {
  BridgeListenerEvent,
  BridgeOpenOptions,
  DesktopBridge,
} from "../../src/lib/desktopBridge";

type Listener = (event: BridgeListenerEvent<unknown>) => void;

export type MockBridgeController = {
  bridge: Partial<DesktopBridge>;
  onInvoke: (command: string, handler: (args: Record<string, unknown> | undefined) => unknown) => void;
  emit: <T>(event: string, payload: T) => void;
};

export const createMockBridge = (): MockBridgeController => {
  const listeners = new Map<string, Set<Listener>>();
  const handlers = new Map<string, (args: Record<string, unknown> | undefined) => unknown>();

  const bridge: Partial<DesktopBridge> = {
    isTauri: () => true,
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      const handler = handlers.get(command);
      if (!handler) {
        throw new Error(`No mock handler for command: ${command}`);
      }
      return handler(args) as T;
    },
    listen: async (event: string, handler: (event: BridgeListenerEvent<unknown>) => void) => {
      let bucket = listeners.get(event);
      if (!bucket) {
        bucket = new Set<Listener>();
        listeners.set(event, bucket);
      }
      bucket.add(handler as Listener);
      return () => {
        bucket?.delete(handler as Listener);
      };
    },
    getCurrentWindow: () => ({
      isFullscreen: async () => false,
      onResized: async () => () => {},
      setTheme: async () => {},
    }),
    open: async (_options: BridgeOpenOptions) => null,
    confirm: async () => true,
  };

  return {
    bridge,
    onInvoke: (command, handler) => {
      handlers.set(command, handler);
    },
    emit: (event, payload) => {
      const bucket = listeners.get(event);
      if (!bucket) {
        return;
      }
      for (const listener of bucket) {
        listener({ payload });
      }
    },
  };
};
