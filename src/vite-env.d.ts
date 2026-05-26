/// <reference types="vite/client" />

import type { DesktopBridge } from "./lib/desktopBridge";

declare global {
  interface Window {
    __TIDY_DESKTOP_BRIDGE__?: Partial<DesktopBridge>;
  }
}
