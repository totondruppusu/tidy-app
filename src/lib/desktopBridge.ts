import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";

export type BridgeListenerEvent<T> = { payload: T };
export type BridgeUnlisten = () => void;

export type BridgeWindow = {
  isFullscreen: () => Promise<boolean>;
  isMaximized: () => Promise<boolean>;
  onResized: (callback: () => void) => Promise<BridgeUnlisten>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  setTheme: (theme: "light" | "dark") => Promise<void>;
};

export type BridgeOpenOptions = {
  directory?: boolean;
  multiple?: boolean;
};

export type BridgeConfirmOptions = {
  title?: string;
};

export type DesktopBridge = {
  isTauri: () => boolean;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: (event: BridgeListenerEvent<T>) => void) => Promise<BridgeUnlisten>;
  getCurrentWindow: () => BridgeWindow;
  open: (options: BridgeOpenOptions) => Promise<string | string[] | null>;
  confirm: (message: string, options?: BridgeConfirmOptions) => Promise<boolean>;
};

const defaultBridge: DesktopBridge = {
  isTauri,
  invoke,
  listen,
  getCurrentWindow: () => getCurrentWindow(),
  open,
  confirm,
};

const getBridge = (): DesktopBridge => {
  const override = window.__TIDY_DESKTOP_BRIDGE__;
  if (!override) {
    return defaultBridge;
  }
  return {
    ...defaultBridge,
    ...override,
  };
};

export const isDesktopRuntime = () => getBridge().isTauri();
export const invokeCommand = <T>(command: string, args?: Record<string, unknown>) =>
  getBridge().invoke<T>(command, args);
export const listenEvent = <T>(event: string, handler: (event: BridgeListenerEvent<T>) => void) =>
  getBridge().listen<T>(event, handler);
export const getDesktopWindow = () => getBridge().getCurrentWindow();
export const openDialog = (options: BridgeOpenOptions) => getBridge().open(options);
export const confirmDialog = (message: string, options?: BridgeConfirmOptions) =>
  getBridge().confirm(message, options);

export const setDesktopBridgeForTests = (bridge: Partial<DesktopBridge> | null) => {
  if (bridge) {
    window.__TIDY_DESKTOP_BRIDGE__ = bridge;
    return;
  }
  delete window.__TIDY_DESKTOP_BRIDGE__;
};
