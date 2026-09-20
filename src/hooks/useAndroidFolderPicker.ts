import { useCallback, useRef, useState } from "react";
import {
  listLocalDirectories,
  pickManagedDirectory,
} from "../services/directoryService";
import type { LocalDirectoryEntry, PickedDirectory } from "../types";

type UseAndroidFolderPickerResult = {
  isAndroidFolderBrowserOpen: boolean;
  androidFolderBrowserPath: string;
  androidFolderBrowserParentPath: string | null;
  androidFolderBrowserDirectories: LocalDirectoryEntry[];
  isAndroidFolderBrowserLoading: boolean;
  androidFolderBrowserError: string | null;
  resolveAndroidFolderBrowser: (selection: PickedDirectory | null) => void;
  loadAndroidFolderBrowserPath: (path: string) => Promise<void>;
  openAndroidFolderBrowser: (
    initialPath?: string,
  ) => Promise<PickedDirectory | null>;
};

export function useAndroidFolderPicker(): UseAndroidFolderPickerResult {
  const [isAndroidFolderBrowserOpen, setIsAndroidFolderBrowserOpen] =
    useState(false);
  const [androidFolderBrowserPath, setAndroidFolderBrowserPath] =
    useState("");
  const [androidFolderBrowserParentPath, setAndroidFolderBrowserParentPath] =
    useState<string | null>(null);
  const [androidFolderBrowserDirectories, setAndroidFolderBrowserDirectories] =
    useState<LocalDirectoryEntry[]>([]);
  const [isAndroidFolderBrowserLoading, setIsAndroidFolderBrowserLoading] =
    useState(false);
  const [androidFolderBrowserError, setAndroidFolderBrowserError] = useState<
    string | null
  >(null);
  const androidFolderBrowserResolverRef = useRef<
    ((selection: PickedDirectory | null) => void) | null
  >(null);

  const resolveAndroidFolderBrowser = useCallback(
    (selection: PickedDirectory | null) => {
      setIsAndroidFolderBrowserOpen(false);
      setIsAndroidFolderBrowserLoading(false);
      setAndroidFolderBrowserError(null);
      setAndroidFolderBrowserDirectories([]);
      setAndroidFolderBrowserParentPath(null);
      const resolve = androidFolderBrowserResolverRef.current;
      androidFolderBrowserResolverRef.current = null;
      resolve?.(selection);
    },
    [],
  );

  const loadAndroidFolderBrowserPath = useCallback(async (path: string) => {
    setIsAndroidFolderBrowserLoading(true);
    setAndroidFolderBrowserError(null);
    try {
      const listing = await listLocalDirectories(path);
      setAndroidFolderBrowserPath(listing.currentPath);
      setAndroidFolderBrowserParentPath(listing.parentPath);
      setAndroidFolderBrowserDirectories(listing.directories);
    } catch (error) {
      setAndroidFolderBrowserError(String(error));
    } finally {
      setIsAndroidFolderBrowserLoading(false);
    }
  }, []);

  const openAndroidFolderBrowser = useCallback(
    async (initialPath?: string): Promise<PickedDirectory | null> => {
      const root = await pickManagedDirectory();
      if (!root) {
        return null;
      }

      const startPath = initialPath ?? root.token;
      setAndroidFolderBrowserPath(startPath);
      setAndroidFolderBrowserParentPath(null);
      setAndroidFolderBrowserDirectories([]);
      setAndroidFolderBrowserError(null);
      setIsAndroidFolderBrowserOpen(true);
      void loadAndroidFolderBrowserPath(startPath);

      return new Promise((resolve) => {
        androidFolderBrowserResolverRef.current = resolve;
      });
    },
    [loadAndroidFolderBrowserPath],
  );

  return {
    isAndroidFolderBrowserOpen,
    androidFolderBrowserPath,
    androidFolderBrowserParentPath,
    androidFolderBrowserDirectories,
    isAndroidFolderBrowserLoading,
    androidFolderBrowserError,
    resolveAndroidFolderBrowser,
    loadAndroidFolderBrowserPath,
    openAndroidFolderBrowser,
  };
}
