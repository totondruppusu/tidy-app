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
  SafetyLevel,
  SuggestionPreset,
  SuggestionActionFilter,
  SuggestionSortMode,
  SuggestionsMode,
  SortMode,
  StoredSettings,
  ThemeMode,
  TrashBehavior,
  ViewMode,
} from "../types";

export const DEFAULT_SETTINGS: StoredSettings = {
  autoScanOnPick: false,
  rememberLastFolder: true,
  includeSubfolders: true,
  includeHidden: false,
  autoPlayMedia: true,
  skipLargePreviews: false,
  useHashForDuplicates: true,
  duplicateMinSizeBytes: 0,
  confirmTrash: false,
  trashBehavior: "system",
  sortMode: "name_asc",
  groupMode: "none",
  listDensity: "compact",
  viewMode: "list",
  extensionFilterMode: "all",
};

export const getInitialTheme = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "dark";
  }
  const stored = window.localStorage.getItem("tidy-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "dark";
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

const SUGGESTION_SORT_MODES: SuggestionSortMode[] = ["largest_first", "safest_first", "path_asc"];
const SUGGESTION_ACTION_FILTERS: SuggestionActionFilter[] = [
  "all",
  "trash",
  "remove-empty-folder",
  "move",
  "delete",
];
const SUGGESTIONS_MODES: SuggestionsMode[] = ["review", "advanced"];
const SUGGESTION_SAFETY_LEVELS: SafetyLevel[] = ["safe", "review", "manual"];

export const isSuggestionSortMode = (value: unknown): value is SuggestionSortMode =>
  typeof value === "string" && SUGGESTION_SORT_MODES.includes(value as SuggestionSortMode);

export const isSuggestionActionFilter = (value: unknown): value is SuggestionActionFilter =>
  typeof value === "string" && SUGGESTION_ACTION_FILTERS.includes(value as SuggestionActionFilter);

export const isSuggestionsMode = (value: unknown): value is SuggestionsMode =>
  typeof value === "string" && SUGGESTIONS_MODES.includes(value as SuggestionsMode);

const isSuggestionSafetyLevel = (value: unknown): value is SafetyLevel =>
  typeof value === "string" && SUGGESTION_SAFETY_LEVELS.includes(value as SafetyLevel);

const normalizeSuggestionPreset = (value: unknown): SuggestionPreset | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const preset = value as Record<string, unknown>;
  if (typeof preset.id !== "string" || preset.id.trim().length === 0) {
    return null;
  }
  if (typeof preset.name !== "string" || preset.name.trim().length === 0) {
    return null;
  }
  if (
    typeof preset.staleDays !== "number" ||
    !Number.isFinite(preset.staleDays) ||
    typeof preset.minLargeFileBytes !== "number" ||
    !Number.isFinite(preset.minLargeFileBytes) ||
    typeof preset.maxResults !== "number" ||
    !Number.isFinite(preset.maxResults)
  ) {
    return null;
  }
  if (!isSuggestionSafetyLevel(preset.safetyFilter)) {
    return null;
  }
  if (!isSuggestionActionFilter(preset.actionFilter)) {
    return null;
  }
  if (!isSuggestionSortMode(preset.sortMode)) {
    return null;
  }
  if (preset.searchQuery != null && typeof preset.searchQuery !== "string") {
    return null;
  }
  return {
    id: preset.id,
    name: preset.name,
    staleDays: preset.staleDays,
    minLargeFileBytes: preset.minLargeFileBytes,
    maxResults: preset.maxResults,
    safetyFilter: preset.safetyFilter,
    actionFilter: preset.actionFilter,
    sortMode: preset.sortMode,
    searchQuery: typeof preset.searchQuery === "string" ? preset.searchQuery : undefined,
  };
};

export const normalizeDestinationSlots = (value: unknown): (string | null)[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => (typeof entry === "string" ? entry : null));
};

export const getStoredSettings = (): StoredSettings => {
  if (typeof window === "undefined") {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const settings: StoredSettings = { ...DEFAULT_SETTINGS };
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
    if (
      typeof parsed.suggestionStaleDays === "number" &&
      Number.isFinite(parsed.suggestionStaleDays)
    ) {
      settings.suggestionStaleDays = parsed.suggestionStaleDays;
    }
    if (
      typeof parsed.suggestionMinLargeFileBytes === "number" &&
      Number.isFinite(parsed.suggestionMinLargeFileBytes)
    ) {
      settings.suggestionMinLargeFileBytes = parsed.suggestionMinLargeFileBytes;
    }
    if (
      typeof parsed.suggestionMaxResults === "number" &&
      Number.isFinite(parsed.suggestionMaxResults)
    ) {
      settings.suggestionMaxResults = parsed.suggestionMaxResults;
    }
    if (isSuggestionSortMode(parsed.suggestionSortMode)) {
      settings.suggestionSortMode = parsed.suggestionSortMode;
    }
    if (isSuggestionActionFilter(parsed.suggestionActionFilter)) {
      settings.suggestionActionFilter = parsed.suggestionActionFilter;
    }
    if (isSuggestionsMode(parsed.suggestionsMode)) {
      settings.suggestionsMode = parsed.suggestionsMode;
    }
    if (typeof parsed.suggestionPresetId === "string") {
      settings.suggestionPresetId = parsed.suggestionPresetId;
    }
    if (Array.isArray(parsed.suggestionPresets)) {
      settings.suggestionPresets = parsed.suggestionPresets
        .map((entry) => normalizeSuggestionPreset(entry))
        .filter((entry): entry is SuggestionPreset => Boolean(entry));
    }
    return settings;
  } catch (error) {
    console.warn("Failed to read stored settings.", error);
    return {};
  }
};
