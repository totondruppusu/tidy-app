import { invokeCommand, openDialog } from "../lib/desktopBridge";
import { isAndroidRuntime } from "./platform";
import type {
  LocalDirectoryListing,
  PickedDirectory,
} from "../types";

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

export const listLocalDirectories = (path?: string) =>
  invokeCommand<LocalDirectoryListing>(
    "list_local_directories",
    path ? { path } : {},
  );
