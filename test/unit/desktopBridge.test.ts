import { describe, expect, it } from "vitest";
import {
  confirmDialog,
  invokeCommand,
  isDesktopRuntime,
  openDialog,
  setDesktopBridgeForTests,
} from "../../src/lib/desktopBridge";

describe("desktopBridge override", () => {
  it("uses default when no override and allows override behavior", async () => {
    setDesktopBridgeForTests({
      isTauri: () => true,
      invoke: async (command) => ({ command }),
      open: async () => "/tmp/folder",
      confirm: async () => true,
    });

    expect(isDesktopRuntime()).toBe(true);
    await expect(invokeCommand<{ command: string }>("scan_folder")).resolves.toEqual({
      command: "scan_folder",
    });
    await expect(openDialog({ directory: true, multiple: false })).resolves.toBe("/tmp/folder");
    await expect(confirmDialog("x")).resolves.toBe(true);

    setDesktopBridgeForTests(null);
    expect(window.__TIDY_DESKTOP_BRIDGE__).toBeUndefined();
  });
});
