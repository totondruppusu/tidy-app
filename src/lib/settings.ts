import {
  EXTENSION_FILTER_MODES,
  FILTER_MODES,
  GROUP_MODES,
  SETTINGS_KEY,
  SORT_MODES,
  TRASH_BEHAVIORS,
  VIEW_MODES,
  DENSITY_MODES,
} from "../constants/appConstants";
import type {
  DensityMode,
  ExtensionFilterMode,
  FilterMode,
  GroupMode,
  SortMode,
  StoredSettings,
  ThemeMode,
  TrashBehavior,
  ViewMode,
} from "../types";

export const getInitialTheme = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "light";
  }
  const stored = window.localStorage.getItem("tidy-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
};

export const isFilterMode = (value: unknown): value is FilterMode =>
  typeof value === "string" && FILTER_MODES.includes(value as FilterMode);

export const isSortMode = (value: unknown): value is SortMode =>
  typeof value === "string" && SORT_MODES.includes(value as SortMode);

export const isGroupMode = (value: unknown): value is GroupMode =>
  typeof value === "string" && GROUP_MODES.includes(value as GroupMode);

export const isDensityMode = (value: unknown): value is DensityMode =>
  typeof value === "string" && DENSITY_MODES.includes(value as DensityMode);

export const isViewMode = (value: unknown): value is ViewMode =>
  typeof value === "string" && VIEW_MODES.includes(value as ViewMode);

export const isExtensionFilterMode = (value: unknown): value is ExtensionFilterMode =>
  typeof value === "string" && EXTENSION_FILTER_MODES.includes(value as ExtensionFilterMode);

export const isTrashBehavior = (value: unknown): value is TrashBehavior =>
  typeof value === "string" && TRASH_BEHAVIORS.includes(value as TrashBehavior);

export const normalizeDestinationSlots = (value: unknown): (string | null)[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => (typeof entry === "string" ? entry : null));
};

export const getStoredSettings = (): StoredSettings => {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const settings: StoredSettings = {};
    if (isFilterMode(parsed.filterMode)) {
      settings.filterMode = parsed.filterMode;
    }
    if (typeof parsed.autoScanOnPick === "boolean") {
      settings.autoScanOnPick = parsed.autoScanOnPick;
    }
    if (typeof parsed.rememberLastFolder === "boolean") {
      settings.rememberLastFolder = parsed.rememberLastFolder;
    }
    if (typeof parsed.lastFolder === "string") {
      settings.lastFolder = parsed.lastFolder;
    }
    if (typeof parsed.includeSubfolders === "boolean") {
      settings.includeSubfolders = parsed.includeSubfolders;
    }
    if (typeof parsed.includeHidden === "boolean") {
      settings.includeHidden = parsed.includeHidden;
    }
    if (typeof parsed.autoPlayMedia === "boolean") {
      settings.autoPlayMedia = parsed.autoPlayMedia;
    }
    if (typeof parsed.skipLargePreviews === "boolean") {
      settings.skipLargePreviews = parsed.skipLargePreviews;
    }
    if (typeof parsed.useHashForDuplicates === "boolean") {
      settings.useHashForDuplicates = parsed.useHashForDuplicates;
    }
    if (typeof parsed.duplicateMinSizeBytes === "number" && Number.isFinite(parsed.duplicateMinSizeBytes)) {
      settings.duplicateMinSizeBytes = parsed.duplicateMinSizeBytes;
    }
    if (typeof parsed.confirmTrash === "boolean") {
      settings.confirmTrash = parsed.confirmTrash;
    }
    if (isTrashBehavior(parsed.trashBehavior)) {
      settings.trashBehavior = parsed.trashBehavior;
    } else if (parsed.trashBehavior === "app") {
      settings.trashBehavior = "system";
    }
    if (isSortMode(parsed.sortMode)) {
      settings.sortMode = parsed.sortMode;
    }
    if (isGroupMode(parsed.groupMode)) {
      settings.groupMode = parsed.groupMode;
    }
    if (isDensityMode(parsed.listDensity)) {
      settings.listDensity = parsed.listDensity;
    }
    if (isViewMode(parsed.viewMode)) {
      settings.viewMode = parsed.viewMode;
    }
    if (isExtensionFilterMode(parsed.extensionFilterMode)) {
      settings.extensionFilterMode = parsed.extensionFilterMode;
    }
    if (
      Array.isArray(parsed.extensionSelection) &&
      parsed.extensionSelection.every((entry) => typeof entry === "string")
    ) {
      settings.extensionSelection = parsed.extensionSelection;
    }
    const storedSlots = normalizeDestinationSlots(parsed.destinationSlots);
    if (storedSlots) {
      settings.destinationSlots = storedSlots;
    }
    return settings;
  } catch (error) {
    console.warn("Failed to read stored settings.", error);
    return {};
  }
};
