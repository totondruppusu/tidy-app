import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { COMMON_EXTENSIONS } from "../constants/appConstants";
import { getExtension } from "../lib/files";
import type { ExtensionFilterMode, FileEntry } from "../types";

type UseExtensionFilterOptions = {
  files: FileEntry[];
  extensionFilterMode: ExtensionFilterMode;
  selectedExtensions: string[];
  setSelectedExtensions: Dispatch<SetStateAction<string[]>>;
};

export function useExtensionFilter({
  files,
  extensionFilterMode,
  selectedExtensions,
  setSelectedExtensions,
}: UseExtensionFilterOptions) {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const previousExtensionsRef = useRef<string[]>([]);
  const hasUserAdjustedExtensionsRef = useRef(false);

  const allExtensions = useMemo(() => {
    const set = new Set<string>();
    files.forEach((file) => {
      set.add(getExtension(file.name));
    });
    const list = Array.from(set);
    list.sort((a, b) => {
      if (a === "none") {
        return 1;
      }
      if (b === "none") {
        return -1;
      }
      return a.localeCompare(b);
    });
    return list;
  }, [files]);

  const selectedExtensionsSet = useMemo(
    () => new Set(selectedExtensions),
    [selectedExtensions],
  );

  useEffect(() => {
    hasUserAdjustedExtensionsRef.current = false;
  }, [extensionFilterMode]);

  useEffect(() => {
    setSelectedExtensions((current) => {
      if (allExtensions.length === 0) {
        hasUserAdjustedExtensionsRef.current = false;
        return [];
      }
      if (extensionFilterMode === "remember") {
        const filtered = current.filter((extension) =>
          allExtensions.includes(extension),
        );
        return filtered.length > 0 ? filtered : allExtensions;
      }
      if (!hasUserAdjustedExtensionsRef.current) {
        const commonExtensions = allExtensions.filter((extension) =>
          COMMON_EXTENSIONS.has(extension),
        );
        return extensionFilterMode === "common" && commonExtensions.length > 0
          ? commonExtensions
          : allExtensions;
      }
      const prev = previousExtensionsRef.current;
      const hadAllSelected =
        prev.length > 0 &&
        prev.every((extension) => current.includes(extension)) &&
        current.length >= prev.length;
      if (current.length === 0 || hadAllSelected) {
        const commonExtensions = allExtensions.filter((extension) =>
          COMMON_EXTENSIONS.has(extension),
        );
        return extensionFilterMode === "common" && commonExtensions.length > 0
          ? commonExtensions
          : allExtensions;
      }
      return current.filter((extension) => allExtensions.includes(extension));
    });
    previousExtensionsRef.current = allExtensions;
  }, [allExtensions, extensionFilterMode]);

  const allExtensionsSelected =
    allExtensions.length > 0 &&
    selectedExtensions.length === allExtensions.length;
  const someExtensionsSelected =
    selectedExtensions.length > 0 &&
    selectedExtensions.length < allExtensions.length;

  useEffect(() => {
    if (!selectAllRef.current) {
      return;
    }
    selectAllRef.current.indeterminate = someExtensionsSelected;
  }, [someExtensionsSelected]);

  const filteredFiles = useMemo(() => {
    if (selectedExtensionsSet.size === 0) {
      return [];
    }
    // When every known extension is selected the filter is a no-op, so avoid
    // re-scanning the whole file array on every streaming batch.
    if (allExtensionsSelected) {
      return files;
    }
    return files.filter((file) =>
      selectedExtensionsSet.has(getExtension(file.name)),
    );
  }, [allExtensionsSelected, files, selectedExtensionsSet]);

  const handleToggleAllExtensions = useCallback(
    (checked: boolean) => {
      hasUserAdjustedExtensionsRef.current = true;
      startTransition(() =>
        setSelectedExtensions(checked ? allExtensions : []),
      );
    },
    [allExtensions, startTransition],
  );

  const handleToggleExtension = useCallback(
    (extension: string) => {
      hasUserAdjustedExtensionsRef.current = true;
      startTransition(() =>
        setSelectedExtensions((current) =>
          current.includes(extension)
            ? current.filter((value) => value !== extension)
            : [...current, extension],
        ),
      );
    },
    [startTransition],
  );

  return {
    allExtensions,
    selectedExtensionsSet,
    allExtensionsSelected,
    someExtensionsSelected,
    selectAllRef,
    filteredFiles,
    handleToggleAllExtensions,
    handleToggleExtension,
  };
}
