import { useCallback, useEffect, useMemo, useState } from "react";
import { isDesktopRuntime } from "../lib/desktopBridge";
import { formatBytes } from "../lib/format";
import { getRelativeSegments, splitPathSegments } from "../lib/path";
import {
  buildCleanupSuggestions,
  runActionBatch,
} from "../services/suggestionsService";
import { useAsyncWorkflow } from "./useAsyncWorkflow";
import type {
  ActionBatchItem,
  ActionBatchResult,
  SafetyLevel,
  StoredSettings,
  Suggestion,
  SuggestionActionFilter,
  SuggestionPreset,
  SuggestionSortMode,
  SuggestionsMode,
} from "../types";

const SUGGESTION_DEFAULT_STALE_DAYS = 30;
const SUGGESTION_DEFAULT_MIN_LARGE_FILE_BYTES = 250 * 1024 * 1024;
const SUGGESTION_DEFAULT_MAX_RESULTS = 200;

const SUGGESTION_SAFETY_RANK: Record<SafetyLevel, number> = {
  safe: 0,
  review: 1,
  manual: 2,
};

type UseSuggestionsControllerOptions = {
  storedSettings: StoredSettings;
  currentFolder: string | null;
  includeSubfolders: boolean;
  includeHidden: boolean;
  updateStatus: (message: string) => void;
};

export const useSuggestionsController = ({
  storedSettings,
  currentFolder,
  includeSubfolders,
  includeHidden,
  updateStatus,
}: UseSuggestionsControllerOptions) => {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const {
    status: suggestionsStatus,
    error: suggestionsError,
    reset: resetSuggestionsWorkflow,
    run: runSuggestionsWorkflow,
  } = useAsyncWorkflow();
  const [suggestionsMode, setSuggestionsMode] = useState<SuggestionsMode>(
    storedSettings.suggestionsMode ?? "review",
  );
  const [suggestionPresets, setSuggestionPresets] = useState<SuggestionPreset[]>(
    storedSettings.suggestionPresets ?? [],
  );
  const [suggestionPresetId, setSuggestionPresetId] = useState<string | null>(
    storedSettings.suggestionPresetId ?? null,
  );
  const [suggestionSafetyFilter, setSuggestionSafetyFilter] =
    useState<SafetyLevel>("safe");
  const [suggestionActionFilter, setSuggestionActionFilter] =
    useState<SuggestionActionFilter>(
      storedSettings.suggestionActionFilter ?? "all",
    );
  const [suggestionSortMode, setSuggestionSortMode] =
    useState<SuggestionSortMode>(
      storedSettings.suggestionSortMode ?? "largest_first",
    );
  const [suggestionSearchQuery, setSuggestionSearchQuery] = useState("");
  const [suggestionStaleDays, setSuggestionStaleDays] = useState(
    storedSettings.suggestionStaleDays ?? SUGGESTION_DEFAULT_STALE_DAYS,
  );
  const [suggestionMinLargeFileBytes, setSuggestionMinLargeFileBytes] =
    useState(
      storedSettings.suggestionMinLargeFileBytes ??
        SUGGESTION_DEFAULT_MIN_LARGE_FILE_BYTES,
    );
  const [suggestionMaxResults, setSuggestionMaxResults] = useState(
    storedSettings.suggestionMaxResults ?? SUGGESTION_DEFAULT_MAX_RESULTS,
  );
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>(
    [],
  );
  const [suggestionTotalReclaimableBytes, setSuggestionTotalReclaimableBytes] =
    useState(0);
  const {
    status: suggestionDryRunStatus,
    error: suggestionDryRunError,
    reset: resetSuggestionDryRunWorkflow,
    run: runSuggestionDryRunWorkflow,
  } = useAsyncWorkflow();
  const [suggestionDryRunResult, setSuggestionDryRunResult] =
    useState<ActionBatchResult | null>(null);
  const [suggestionDryRunSelectionKey, setSuggestionDryRunSelectionKey] =
    useState<string | null>(null);
  const [suggestionExplainabilityEnabled] = useState(false);
  const [suggestionBatchToolbarEnabled] = useState(false);

  const clearSuggestionDryRunPreview = useCallback(() => {
    setSuggestionDryRunResult(null);
    setSuggestionDryRunSelectionKey(null);
    resetSuggestionDryRunWorkflow();
  }, [resetSuggestionDryRunWorkflow]);

  const resetSuggestionsState = useCallback(() => {
    setSuggestions([]);
    setSelectedSuggestionIds([]);
    setSuggestionTotalReclaimableBytes(0);
    resetSuggestionsWorkflow();
    clearSuggestionDryRunPreview();
  }, [clearSuggestionDryRunPreview, resetSuggestionsWorkflow]);

  const applySuggestionPreset = useCallback(
    (preset: SuggestionPreset) => {
      setSuggestionStaleDays(preset.staleDays);
      setSuggestionMinLargeFileBytes(preset.minLargeFileBytes);
      setSuggestionMaxResults(preset.maxResults);
      setSuggestionSafetyFilter(preset.safetyFilter);
      setSuggestionActionFilter(preset.actionFilter);
      setSuggestionSortMode(preset.sortMode);
      setSuggestionSearchQuery(preset.searchQuery ?? "");
      setSuggestionPresetId(preset.id);
      clearSuggestionDryRunPreview();
    },
    [clearSuggestionDryRunPreview],
  );

  const selectedSuggestionSet = useMemo(
    () => new Set(selectedSuggestionIds),
    [selectedSuggestionIds],
  );

  const activeSuggestionPreset = useMemo(
    () =>
      suggestionPresets.find((preset) => preset.id === suggestionPresetId) ??
      null,
    [suggestionPresetId, suggestionPresets],
  );

  const visibleSuggestions = useMemo(() => {
    const maxRank = SUGGESTION_SAFETY_RANK[suggestionSafetyFilter];
    const searchValue = suggestionSearchQuery.trim().toLowerCase();
    const next = suggestions.filter((suggestion) => {
      if (SUGGESTION_SAFETY_RANK[suggestion.safetyLevel] > maxRank) {
        return false;
      }
      if (
        suggestionActionFilter !== "all" &&
        suggestion.actionType !== suggestionActionFilter
      ) {
        return false;
      }
      if (!searchValue) {
        return true;
      }
      const haystack = [
        suggestion.reason.message,
        suggestion.sourcePath,
        suggestion.destinationPath ?? "",
        suggestion.actionType,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchValue);
    });
    const comparePath = (a: Suggestion, b: Suggestion) =>
      a.sourcePath.localeCompare(b.sourcePath, undefined, {
        sensitivity: "base",
      });
    next.sort((a, b) => {
      if (suggestionSortMode === "safest_first") {
        const bySafety =
          SUGGESTION_SAFETY_RANK[a.safetyLevel] -
          SUGGESTION_SAFETY_RANK[b.safetyLevel];
        if (bySafety !== 0) {
          return bySafety;
        }
        const bySize = b.reclaimableBytes - a.reclaimableBytes;
        return bySize !== 0 ? bySize : comparePath(a, b);
      }
      if (suggestionSortMode === "path_asc") {
        const byPath = comparePath(a, b);
        return byPath !== 0 ? byPath : b.reclaimableBytes - a.reclaimableBytes;
      }
      const bySize = b.reclaimableBytes - a.reclaimableBytes;
      return bySize !== 0 ? bySize : comparePath(a, b);
    });
    return next;
  }, [
    suggestions,
    suggestionSafetyFilter,
    suggestionActionFilter,
    suggestionSearchQuery,
    suggestionSortMode,
  ]);

  const selectedSuggestions = useMemo(
    () =>
      suggestions.filter((suggestion) =>
        selectedSuggestionSet.has(suggestion.id),
      ),
    [suggestions, selectedSuggestionSet],
  );

  const selectedVisibleSuggestions = useMemo(
    () =>
      visibleSuggestions.filter((suggestion) =>
        selectedSuggestionSet.has(suggestion.id),
      ),
    [visibleSuggestions, selectedSuggestionSet],
  );

  const selectedSuggestionReclaimableBytes = useMemo(
    () =>
      selectedSuggestions.reduce(
        (total, suggestion) => total + suggestion.reclaimableBytes,
        0,
      ),
    [selectedSuggestions],
  );

  const selectedSuggestionPlanKey = useMemo(
    () =>
      selectedSuggestions
        .map((suggestion) => suggestion.id)
        .sort((a, b) => a.localeCompare(b))
        .join("|"),
    [selectedSuggestions],
  );

  const selectedSuggestionActionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    selectedSuggestions.forEach((suggestion) => {
      counts[suggestion.actionType] = (counts[suggestion.actionType] ?? 0) + 1;
    });
    return counts;
  }, [selectedSuggestions]);

  const suggestionDryRunResultsById = useMemo(
    () =>
      new Map(
        (suggestionDryRunResult?.results ?? []).map(
          (result) => [result.id, result] as const,
        ),
      ),
    [suggestionDryRunResult],
  );

  const suggestionDryRunStatusCounts = useMemo(() => {
    const counts: Record<"planned" | "blocked" | "error", number> = {
      planned: 0,
      blocked: 0,
      error: 0,
    };
    for (const result of suggestionDryRunResult?.results ?? []) {
      if (result.status === "planned") {
        counts.planned += 1;
      } else if (result.status === "blocked") {
        counts.blocked += 1;
      } else if (result.status === "error") {
        counts.error += 1;
      }
    }
    return counts;
  }, [suggestionDryRunResult]);

  const formatSuggestionPath = useCallback(
    (path: string) => {
      const segments = getRelativeSegments(path, currentFolder);
      return segments.length > 0 ? segments.join("/") : path;
    },
    [currentFolder],
  );

  const getSuggestionActionLabel = useCallback((actionType: string) => {
    switch (actionType) {
      case "trash":
        return "Move to Trash";
      case "remove-empty-folder":
        return "Remove Empty Folder";
      case "move":
        return "Move";
      case "delete":
        return "Delete Permanently";
      default:
        return actionType;
    }
  }, []);

  const getSuggestionTargetLabel = useCallback(
    (suggestion: Suggestion) => {
      if (suggestion.actionType === "trash") {
        return "System Trash";
      }
      if (
        suggestion.actionType === "remove-empty-folder" ||
        suggestion.actionType === "delete"
      ) {
        return "Removed";
      }
      if (suggestion.destinationPath) {
        return formatSuggestionPath(suggestion.destinationPath);
      }
      return "No destination";
    },
    [formatSuggestionPath],
  );

  const getSuggestionChangeSentence = useCallback(
    (suggestion: Suggestion) => {
      const sourceSegments = splitPathSegments(suggestion.sourcePath);
      const fileName =
        sourceSegments[sourceSegments.length - 1] ?? suggestion.sourcePath;
      if (suggestion.actionType === "trash") {
        return `Move "${fileName}" to System Trash.`;
      }
      if (suggestion.actionType === "remove-empty-folder") {
        return `Remove the empty folder "${fileName}".`;
      }
      if (suggestion.actionType === "move") {
        return `Move "${fileName}" to ${getSuggestionTargetLabel(suggestion)}.`;
      }
      if (suggestion.actionType === "delete") {
        return `Permanently delete "${fileName}".`;
      }
      return `${getSuggestionActionLabel(suggestion.actionType)} "${fileName}".`;
    },
    [getSuggestionActionLabel, getSuggestionTargetLabel],
  );

  const updateSuggestionSelection = useCallback(
    (updater: (previous: string[]) => string[]) => {
      clearSuggestionDryRunPreview();
      setSelectedSuggestionIds(updater);
    },
    [clearSuggestionDryRunPreview],
  );

  const hasDryRunPreviewForSelection = Boolean(
    suggestionDryRunResult &&
      suggestionDryRunResult.dryRun &&
      suggestionDryRunSelectionKey === selectedSuggestionPlanKey,
  );

  useEffect(() => {
    if (
      suggestionPresetId &&
      !suggestionPresets.some((preset) => preset.id === suggestionPresetId)
    ) {
      setSuggestionPresetId(suggestionPresets[0]?.id ?? null);
    }
  }, [suggestionPresetId, suggestionPresets]);

  useEffect(() => {
    if (
      !suggestionDryRunResult &&
      suggestionDryRunStatus === "idle" &&
      !suggestionDryRunError
    ) {
      return;
    }
    clearSuggestionDryRunPreview();
  }, [
    clearSuggestionDryRunPreview,
    suggestionStaleDays,
    suggestionMinLargeFileBytes,
    suggestionMaxResults,
    suggestionSafetyFilter,
    suggestionActionFilter,
    suggestionSortMode,
    suggestionSearchQuery,
  ]);

  const applyLastSuggestionPreset = useCallback(() => {
    if (!activeSuggestionPreset) {
      updateStatus("No saved preset selected.");
      return;
    }
    applySuggestionPreset(activeSuggestionPreset);
    updateStatus(`Applied preset "${activeSuggestionPreset.name}".`);
  }, [activeSuggestionPreset, applySuggestionPreset, updateStatus]);

  const applySuggestionPresetById = useCallback(
    (presetId: string) => {
      const preset = suggestionPresets.find((entry) => entry.id === presetId);
      if (!preset) {
        updateStatus("Preset not found.");
        return;
      }
      applySuggestionPreset(preset);
      updateStatus(`Applied preset "${preset.name}".`);
    },
    [suggestionPresets, applySuggestionPreset, updateStatus],
  );

  const renameSuggestionPreset = useCallback(() => {
    if (!activeSuggestionPreset) {
      updateStatus("Select a preset to rename.");
      return;
    }
    const name = window.prompt("Rename preset", activeSuggestionPreset.name);
    if (!name) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      updateStatus("Preset name cannot be empty.");
      return;
    }
    setSuggestionPresets((previous) =>
      previous.map((preset) =>
        preset.id === activeSuggestionPreset.id
          ? { ...preset, name: trimmed }
          : preset,
      ),
    );
    updateStatus(`Preset renamed to "${trimmed}".`);
  }, [activeSuggestionPreset, updateStatus]);

  const getDeleteSuggestionPreset = useCallback(async () => {
    if (!activeSuggestionPreset) {
      updateStatus("Select a preset to delete.");
      return false;
    }
    return {
      activePresetId: activeSuggestionPreset.id,
      activePresetName: activeSuggestionPreset.name,
    };
  }, [activeSuggestionPreset, updateStatus]);

  const confirmDeleteSuggestionPreset = useCallback((presetId: string) => {
    setSuggestionPresets((previous) =>
      previous.filter((preset) => preset.id !== presetId),
    );
    setSuggestionPresetId((current) => (current === presetId ? null : current));
  }, []);

  const buildSuggestionActions = useCallback(
    (items: Suggestion[]): ActionBatchItem[] =>
      items.map((suggestion) => ({
        id: suggestion.id,
        actionType: suggestion.actionType,
        sourcePath: suggestion.sourcePath,
        destinationPath: suggestion.destinationPath ?? null,
        safetyLevel: suggestion.safetyLevel,
        reason: suggestion.reason.message,
      })),
    [],
  );

  const buildSuggestions = useCallback(async () => {
    if (!currentFolder) {
      updateStatus("Select a folder before building suggestions.");
      return;
    }
    if (!isDesktopRuntime()) {
      updateStatus("Suggestions are available in the desktop app.");
      return;
    }
    clearSuggestionDryRunPreview();
    const result = await runSuggestionsWorkflow(
      async () => {
        const clampedStaleDays = Math.max(
          1,
          Math.min(3650, Math.round(suggestionStaleDays)),
        );
        const clampedMaxResults = Math.max(
          1,
          Math.min(2000, Math.round(suggestionMaxResults)),
        );
        const clampedMinLargeBytes = Math.max(
          1024 * 1024,
          Math.min(
            20 * 1024 * 1024 * 1024,
            Math.round(suggestionMinLargeFileBytes),
          ),
        );
        return buildCleanupSuggestions({
          folderPath: currentFolder,
          includeSubfolders,
          includeHidden,
          staleDays: clampedStaleDays,
          maxResults: clampedMaxResults,
          minLargeFileBytes: clampedMinLargeBytes,
        });
      },
      {
        onError: (message) => {
          updateStatus(`Suggestion build failed: ${message}`);
        },
      },
    );
    if (!result) {
      return;
    }
    setSuggestions(result.suggestions);
    setSuggestionTotalReclaimableBytes(result.totalReclaimableBytes);
    setSelectedSuggestionIds(
      result.suggestions
        .filter((suggestion) => suggestion.safetyLevel === "safe")
        .map((suggestion) => suggestion.id),
    );
    updateStatus(
      `Built ${result.suggestions.length} suggestions (${formatBytes(result.totalReclaimableBytes)} reclaimable).`,
    );
  }, [
    clearSuggestionDryRunPreview,
    currentFolder,
    includeHidden,
    includeSubfolders,
    runSuggestionsWorkflow,
    suggestionMaxResults,
    suggestionMinLargeFileBytes,
    suggestionStaleDays,
    updateStatus,
  ]);

  const previewSelectedSuggestions = useCallback(async () => {
    if (!currentFolder) {
      updateStatus("No folder selected.");
      return null;
    }
    if (!isDesktopRuntime()) {
      updateStatus("Suggestions apply is available in the desktop app.");
      return null;
    }
    const actions = buildSuggestionActions(selectedSuggestions);
    if (actions.length === 0) {
      updateStatus("Select at least one suggestion to preview.");
      clearSuggestionDryRunPreview();
      return null;
    }
    const plan = await runSuggestionDryRunWorkflow(
      () =>
        runActionBatch({
          actions,
          dryRun: true,
          allowUnsafe: false,
          allowPermanentDelete: false,
        }),
      {
        onError: (message) => {
          setSuggestionDryRunResult(null);
          setSuggestionDryRunSelectionKey(null);
          updateStatus(`Suggestion preview failed: ${message}`);
        },
      },
    );
    if (!plan) {
      return null;
    }
    setSuggestionDryRunResult(plan);
    setSuggestionDryRunSelectionKey(selectedSuggestionPlanKey);
    updateStatus(
      `Preview ready: ${plan.applied} planned, ${plan.blocked} blocked, ${plan.failed} failed.`,
    );
    return plan;
  }, [
    buildSuggestionActions,
    clearSuggestionDryRunPreview,
    currentFolder,
    runSuggestionDryRunWorkflow,
    selectedSuggestionPlanKey,
    selectedSuggestions,
    updateStatus,
  ]);

  const removeAppliedSuggestions = useCallback(
    (appliedIds: Set<string>, sourceSuggestions: Suggestion[]) => {
      if (appliedIds.size === 0) {
        return;
      }
      setSuggestions((prev) =>
        prev.filter((suggestion) => !appliedIds.has(suggestion.id)),
      );
      setSelectedSuggestionIds((prev) =>
        prev.filter((id) => !appliedIds.has(id)),
      );
      setSuggestionTotalReclaimableBytes((prev) =>
        Math.max(
          0,
          prev -
            sourceSuggestions
              .filter((suggestion) => appliedIds.has(suggestion.id))
              .reduce(
                (total, suggestion) => total + suggestion.reclaimableBytes,
                0,
              ),
        ),
      );
    },
    [],
  );

  return {
    suggestions,
    setSuggestions,
    suggestionsStatus,
    suggestionsError,
    suggestionsMode,
    setSuggestionsMode,
    suggestionPresets,
    setSuggestionPresets,
    suggestionPresetId,
    setSuggestionPresetId,
    suggestionSafetyFilter,
    setSuggestionSafetyFilter,
    suggestionActionFilter,
    setSuggestionActionFilter,
    suggestionSortMode,
    setSuggestionSortMode,
    suggestionSearchQuery,
    setSuggestionSearchQuery,
    suggestionStaleDays,
    setSuggestionStaleDays,
    suggestionMinLargeFileBytes,
    setSuggestionMinLargeFileBytes,
    suggestionMaxResults,
    setSuggestionMaxResults,
    selectedSuggestionIds,
    setSelectedSuggestionIds,
    suggestionTotalReclaimableBytes,
    setSuggestionTotalReclaimableBytes,
    suggestionDryRunStatus,
    suggestionDryRunError,
    suggestionDryRunResult,
    setSuggestionDryRunResult,
    suggestionDryRunSelectionKey,
    setSuggestionDryRunSelectionKey,
    suggestionExplainabilityEnabled,
    suggestionBatchToolbarEnabled,
    selectedSuggestionSet,
    activeSuggestionPreset,
    visibleSuggestions,
    selectedSuggestions,
    selectedVisibleSuggestions,
    selectedSuggestionReclaimableBytes,
    selectedSuggestionPlanKey,
    selectedSuggestionActionCounts,
    suggestionDryRunResultsById,
    suggestionDryRunStatusCounts,
    hasDryRunPreviewForSelection,
    clearSuggestionDryRunPreview,
    resetSuggestionsState,
    applySuggestionPreset,
    applyLastSuggestionPreset,
    applySuggestionPresetById,
    renameSuggestionPreset,
    getDeleteSuggestionPreset,
    confirmDeleteSuggestionPreset,
    buildSuggestionActions,
    buildSuggestions,
    previewSelectedSuggestions,
    updateSuggestionSelection,
    formatSuggestionPath,
    getSuggestionActionLabel,
    getSuggestionTargetLabel,
    getSuggestionChangeSentence,
    removeAppliedSuggestions,
  };
};

export type SuggestionsController = ReturnType<typeof useSuggestionsController>;
