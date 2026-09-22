import { useCallback, useEffect, useRef, useState } from "react";
import { DESTINATION_SLOT_COUNT } from "../constants/appConstants";
import { getInitialTheme, getStoredSettings } from "../lib/settings";
import type {
  DensityMode,
  ExtensionFilterMode,
  FilterMode,
  GroupMode,
  SortMode,
  ThemeMode,
  TrashBehavior,
  ViewMode,
} from "../types";

const createEmptyDestinationSlots = () =>
  Array.from({ length: DESTINATION_SLOT_COUNT }, () => null);

type UseAppSettingsOptions = {
  isAndroidApp: boolean;
};

export function useAppSettings({ isAndroidApp }: UseAppSettingsOptions) {
  const [storedSettings] = useState(() => getStoredSettings());
  const [filterMode, setFilterMode] = useState<FilterMode>(
    storedSettings.filterMode ?? "all",
  );
  const [autoScanOnPick, setAutoScanOnPick] = useState(
    storedSettings.autoScanOnPick ?? false,
  );
  const [rememberLastFolder, setRememberLastFolder] = useState(
    storedSettings.rememberLastFolder ?? false,
  );
  const [includeSubfolders, setIncludeSubfolders] = useState(
    storedSettings.includeSubfolders ?? false,
  );
  const [includeHidden, setIncludeHidden] = useState(
    storedSettings.includeHidden ?? false,
  );
  const [autoPlayMedia, setAutoPlayMedia] = useState(
    storedSettings.autoPlayMedia ?? false,
  );
  const [skipLargePreviews, setSkipLargePreviews] = useState(
    storedSettings.skipLargePreviews ?? false,
  );
  const [useHashForDuplicates, setUseHashForDuplicates] = useState(
    storedSettings.useHashForDuplicates ?? true,
  );
  const [duplicateMinSizeBytes, setDuplicateMinSizeBytes] = useState(
    storedSettings.duplicateMinSizeBytes ?? 0,
  );
  const [destinationSlots, setDestinationSlots] = useState<(string | null)[]>(
    () => {
      if (isAndroidApp) {
        return createEmptyDestinationSlots();
      }
      const storedSlots = storedSettings.destinationSlots;
      if (!storedSlots) {
        return createEmptyDestinationSlots();
      }
      return Array.from(
        { length: DESTINATION_SLOT_COUNT },
        (_, index) => storedSlots[index] ?? null,
      );
    },
  );
  const [destinationSlotTokens, setDestinationSlotTokens] = useState<
    (string | null)[]
  >(() => {
    if (isAndroidApp) {
      return createEmptyDestinationSlots();
    }
    const storedSlots = storedSettings.destinationSlots;
    if (!storedSlots) {
      return createEmptyDestinationSlots();
    }
    return Array.from(
      { length: DESTINATION_SLOT_COUNT },
      (_, index) => storedSlots[index] ?? null,
    );
  });
  const [confirmTrash, setConfirmTrash] = useState(
    storedSettings.confirmTrash ?? true,
  );
  const [trashBehavior, setTrashBehavior] = useState<TrashBehavior>(
    storedSettings.trashBehavior ?? "system",
  );
  const [sortMode, setSortMode] = useState<SortMode>(
    storedSettings.sortMode ?? "name_asc",
  );
  const initialGroupMode = storedSettings.groupMode ?? "none";
  const [groupMode, setGroupMode] = useState<GroupMode>(initialGroupMode);
  const lastNonDuplicateGroupModeRef = useRef<GroupMode>(
    initialGroupMode === "duplicates" ? "none" : initialGroupMode,
  );
  const [listDensity, setListDensity] = useState<DensityMode>(
    storedSettings.listDensity ?? "comfortable",
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    storedSettings.viewMode ?? "tree",
  );
  const initialExtensionFilterMode =
    storedSettings.extensionFilterMode ?? "all";
  const [extensionFilterMode, setExtensionFilterMode] =
    useState<ExtensionFilterMode>(initialExtensionFilterMode);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>(
    initialExtensionFilterMode === "remember"
      ? (storedSettings.extensionSelection ?? [])
      : [],
  );
  const [lastFolder, setLastFolder] = useState<string | null>(
    isAndroidApp ? null : (storedSettings.lastFolder ?? null),
  );
  const initialFolder =
    !isAndroidApp && storedSettings.rememberLastFolder
      ? (storedSettings.lastFolder ?? null)
      : null;
  const [currentFolder, setCurrentFolder] = useState<string | null>(
    initialFolder,
  );
  const [currentFolderToken, setCurrentFolderToken] = useState<string | null>(
    initialFolder,
  );
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    if (!isAndroidApp && currentFolderToken) {
      setLastFolder(currentFolderToken);
    }
  }, [currentFolderToken, isAndroidApp]);

  const updateDestinationSlot = useCallback(
    (slotIndex: number, destination: { token: string; label: string }) => {
      setDestinationSlots((prev) => {
        const next = [...prev];
        next[slotIndex] = destination.label;
        return next;
      });
      setDestinationSlotTokens((prev) => {
        const next = [...prev];
        next[slotIndex] = destination.token;
        return next;
      });
    },
    [],
  );

  return {
    storedSettings,
    filterMode,
    setFilterMode,
    autoScanOnPick,
    setAutoScanOnPick,
    rememberLastFolder,
    setRememberLastFolder,
    includeSubfolders,
    setIncludeSubfolders,
    includeHidden,
    setIncludeHidden,
    autoPlayMedia,
    setAutoPlayMedia,
    skipLargePreviews,
    setSkipLargePreviews,
    useHashForDuplicates,
    setUseHashForDuplicates,
    duplicateMinSizeBytes,
    setDuplicateMinSizeBytes,
    destinationSlots,
    setDestinationSlots,
    destinationSlotTokens,
    setDestinationSlotTokens,
    confirmTrash,
    setConfirmTrash,
    trashBehavior,
    setTrashBehavior,
    sortMode,
    setSortMode,
    groupMode,
    setGroupMode,
    initialGroupMode,
    lastNonDuplicateGroupModeRef,
    listDensity,
    setListDensity,
    viewMode,
    setViewMode,
    extensionFilterMode,
    setExtensionFilterMode,
    selectedExtensions,
    setSelectedExtensions,
    lastFolder,
    setLastFolder,
    initialFolder,
    currentFolder,
    setCurrentFolder,
    currentFolderToken,
    setCurrentFolderToken,
    theme,
    setTheme,
    updateDestinationSlot,
  };
}
