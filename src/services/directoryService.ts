import { invokeCommand, isDesktopRuntime, openDialog } from "../lib/desktopBridge";
import type { PickedDirectory } from "../types";

export const isAndroidRuntime = () =>
  typeof navigator !== "undefined" &&
  isDesktopRuntime() &&
  /android/i.test(navigator.userAgent);

export const pickManagedDirectory = async (): Promise<PickedDirectory | null> => {
  if (isAndroidRuntime()) {
    return invokeCommand<PickedDirectory>("pick_android_directory");
  }

  const selected = await openDialog({ directory: true, multiple: false });
  if (typeof selected !== "string") {
    return null;
  }

  return {
    token: selected,
    label: selected,
  };
};
