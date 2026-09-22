import { describeScanProgress } from "../lib/scanProgress";
import { ActionBar } from "../components/ActionBar";
import { BlockingOverlayModal } from "../components/BlockingOverlayModal";
import { UndoFailureModal } from "../components/UndoFailureModal";
import { useConfirmation } from "../hooks/useConfirmation";
import { createScanBatchQueue } from "../lib/scanBatchQueue";
import { useScrollHints } from "../hooks/useScrollHints";
import { DeferredMount } from "../components/DeferredMount";
import { VirtualFileList } from "../components/VirtualFileList";
import { buildFileListModel } from "../lib/fileListModel";
import { sortFileEntries } from "../lib/sorting";
import {
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ActivitySnapshot,
  FileEntry,
  FilterMode,
  GroupMode,
  ScanBatch,
  ScanProgress,
  SortMode,
  StoredSettings,
  ViewMode,
} from "../types";
import {
  EVENT_LOOP_LAG_WARN_MS,
  EVENT_LOOP_POLL_MS,
  SETTINGS_KEY,
} from "../constants/appConstants";
import { updateScrollHint } from "../lib/dom";
import { formatPathLabel } from "../lib/format";
import { getExtension } from "../lib/files";
import { getGroupIdForFile } from "../lib/grouping";
import { getFolderCollapseKey } from "../lib/tree";
import { getRelativeSegments } from "../lib/path";
import {
  isDesktopRuntime,
  listenEvent,
} from "../lib/desktopBridge";
import { useFileOperations } from "../hooks/useFileOperations";
import { useScanController } from "../hooks/useScanController";
import { useMutationController } from "../hooks/useMutationController";
import {
  useUndoHistory,
  useUndoAction,
  type UndoFailure,
} from "../hooks/useUndoController";
import { usePreviewController } from "../hooks/usePreviewController";
import { useSuggestionsController } from "../hooks/useSuggestionsController";
import { useSwipeGestureController } from "../hooks/useSwipeGestureController";
import { useAndroidFolderPicker } from "../hooks/useAndroidFolderPicker";
import { useDesktopEnvironment } from "../hooks/useDesktopEnvironment";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useAppSettings } from "../hooks/useAppSettings";
import { useExtensionFilter } from "../hooks/useExtensionFilter";
import { useScanWorkflow } from "../hooks/useScanWorkflow";
import { runActionBatch } from "../services/suggestionsService";
import {
  isAndroidRuntime,
  isWindowsDesktop as isWindowsDesktopRuntime,
} from "../services/platform";
import {
  SUGGESTIONS_MODE_OPTIONS,
  SUGGESTION_ACTION_FILTER_OPTIONS,
  SUGGESTION_SORT_OPTIONS,
  SUGGESTION_MIN_LARGE_FILE_OPTIONS,
} from "../constants/suggestionOptions";
import { FileListPanel } from "../components/FileListPanel";
import { PreviewGestureLegend, PreviewPanel } from "../components/PreviewPanel";
import { Toolbar } from "../components/Toolbar";

const AndroidFolderBrowserModal = lazy(() =>
  import("../components/AndroidFolderBrowserModal").then((module) => ({
    default: module.AndroidFolderBrowserModal,
  })),
);
const HelpModal = lazy(() =>
  import("../components/HelpModal").then((module) => ({
    default: module.HelpModal,
  })),
);
const CrashReportModal = lazy(() =>
  import("../components/CrashReportModal").then((module) => ({
    default: module.CrashReportModal,
  })),
);
const SettingsModal = lazy(() =>
  import("../components/SettingsModal").then((module) => ({
    default: module.SettingsModal,
  })),
);
const SuggestionsModal = lazy(() =>
  import("../components/SuggestionsModal").then((module) => ({
    default: module.SuggestionsModal,
  })),
);

const EMPTY_SORTED_INDEX = new Map<string, number>();

type BlockingOverlayState = {
  title: string;
  subtitle: string;
};

export default function App() {
  const isWindowsDesktop = isWindowsDesktopRuntime();
  const isAndroidApp = isAndroidRuntime();
  const { confirmDialog, confirmation, isConfirming } = useConfirmation();
  const [undoFailure, setUndoFailure] = useState<UndoFailure | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const filesRef = useRef<FileEntry[]>(files);
  filesRef.current = files;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [, setStatus] = useState("Select a folder to begin.");
  const [lastScanFilterMode, setLastScanFilterMode] =
    useState<FilterMode | null>(null);
  const {
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
    destinationSlotTokens,
    confirmTrash,
    setConfirmTrash,
    trashBehavior,
    setTrashBehavior,
    sortMode,
    setSortMode,
    groupMode,
    setGroupMode,
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
    initialFolder,
    currentFolder,
    setCurrentFolder,
    currentFolderToken,
    setCurrentFolderToken,
    theme,
    setTheme,
    updateDestinationSlot,
  } = useAppSettings({ isAndroidApp });
  const isDuplicateFilter = filterMode === "duplicates";
  const isDuplicateScan = lastScanFilterMode === "duplicates";
  const shouldGroupDuplicates = isDuplicateFilter && isDuplicateScan;
  const effectiveGroupMode: GroupMode = shouldGroupDuplicates
    ? "duplicates"
    : groupMode;
  const displayGroupMode: GroupMode = shouldGroupDuplicates
    ? "duplicates"
    : groupMode === "duplicates"
      ? lastNonDuplicateGroupModeRef.current
      : groupMode;
  const {
    isLoading,
    runScanWorkflow,
    activeScanId,
    scanProgress,
    setScanProgress,
    isCancellingScan,
    resetCancelScanWorkflow,
    scan,
    cancel,
  } = useScanController();
  const [blockingOverlay, setBlockingOverlay] =
    useState<BlockingOverlayState | null>(null);
  const { isMutating, mutationSpinnerLabel, runMutationWithSpinner } =
    useMutationController(setBlockingOverlay);
  const resetSelectionToFirstRef = useRef(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const androidFolderPicker = useAndroidFolderPicker();
  const {
    isAndroidFolderBrowserOpen,
    androidFolderBrowserPath,
    androidFolderBrowserParentPath,
    androidFolderBrowserDirectories,
    isAndroidFolderBrowserLoading,
    androidFolderBrowserError,
    resolveAndroidFolderBrowser,
    loadAndroidFolderBrowserPath,
    openAndroidFolderBrowser,
  } = androidFolderPicker;
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const { undoStack, setUndoStack, pushUndo } = useUndoHistory();
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const currentFileIdRef = useRef<string | null>(null);
  const skipAutoExpandCurrentFileRef = useRef(false);
  const suppressAutoExpandForSortRef = useRef(false);
  const suppressAutoExpandForGroupModeRef = useRef(false);
  const visibleFileOrderRef = useRef<string[]>([]);
  const visibleIndexByIdRef = useRef<Map<string, number>>(new Map());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileListFrameRef = useRef<HTMLDivElement | null>(null);
  const fileListPositionRef = useRef<{ top: number; selectedId?: string }>({
    top: 0,
  });
  const fileListScrollRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLElement | null>(null);
  const lastStatusRef = useRef<string | null>(null);
  const lastEventLoopLagRef = useRef<number | null>(null);
  const streamedBatchesRef = useRef(false);
  const scanBatchQueue = useMemo(
    () =>
      createScanBatchQueue((batch) => {
        streamedBatchesRef.current = true;
        setFiles((previous) => previous.concat(batch));
      }),
    [],
  );
  const cancelPendingScanBatchFlush = scanBatchQueue.reset;
  const queueScanBatchFiles = scanBatchQueue.enqueue;
  useEffect(() => {
    if (!isLoading) cancelPendingScanBatchFlush();
  }, [isLoading, cancelPendingScanBatchFlush]);
  const buildActivitySnapshot = useCallback((): ActivitySnapshot => {
    const scanId = scanProgress?.scanId ?? activeScanId.current ?? null;
    return {
      timestampMs: Date.now(),
      status: lastStatusRef.current,
      currentFolder,
      isLoading,
      isMutating,
      isCancellingScan,
      scanId,
      scanPhase: scanProgress?.phase ?? null,
      scanScanned: scanProgress?.scanned ?? null,
      scanMatched: scanProgress?.matched ?? null,
      scanTotal: scanProgress?.total ?? null,
      mutationLabel: mutationSpinnerLabel ?? null,
      eventLoopLagMs: lastEventLoopLagRef.current ?? null,
    };
  }, [
    currentFolder,
    isLoading,
    isMutating,
    isCancellingScan,
    scanProgress,
    mutationSpinnerLabel,
  ]);
  const {
    isNarrowLayout,
    isWindowFullscreen,
    isWindowMaximized,
    handleMinimizeWindow,
    handleToggleMaximizeWindow,
    handleCloseWindow,
    crashReport,
    crashReportText,
    isCrashReportOpen,
    handleDismissCrashReport,
    handleSendCrashReport,
    handleRevealCrashReport,
    handleCopyCrashReport,
  } = useDesktopEnvironment({
    buildActivitySnapshot,
    theme,
    isAndroidApp,
    isWindowsDesktop,
  });
  const handleGroupModeChange = useCallback(
    (value: GroupMode) => {
      if (value === "duplicates" && !shouldGroupDuplicates) {
        return;
      }
      setGroupMode(value);
    },
    [shouldGroupDuplicates],
  );

  useEffect(() => {
    if (groupMode !== "duplicates") {
      lastNonDuplicateGroupModeRef.current = groupMode;
    }
  }, [groupMode]);

  useEffect(() => {
    if (!shouldGroupDuplicates && groupMode === "duplicates") {
      setGroupMode(lastNonDuplicateGroupModeRef.current);
    }
  }, [groupMode, shouldGroupDuplicates]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("tidy-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (isNarrowLayout) {
      setIsSidebarCollapsed(true);
    }
  }, [isNarrowLayout]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let lastTick = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now();
      const lag = now - lastTick - EVENT_LOOP_POLL_MS;
      if (lag > EVENT_LOOP_LAG_WARN_MS) {
        lastEventLoopLagRef.current = Math.round(lag);
      }
      lastTick = now;
    }, EVENT_LOOP_POLL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, []);


  const syncScrollHints = useCallback(
    (scrollNode: HTMLElement | null, frameNode: HTMLElement | null) => {
      if (!scrollNode || !frameNode) {
        return;
      }
      updateScrollHint(scrollNode, frameNode);
    },
    [],
  );

  useScrollHints(fileListScrollRef, fileListFrameRef, !isSidebarCollapsed);
  useScrollHints(previewScrollRef, previewFrameRef);

  const updateStatus = useCallback((message: string) => {
    lastStatusRef.current = message;
    setStatus(message);
  }, []);

  const suggestionsController = useSuggestionsController({
    storedSettings,
    currentFolder,
    includeSubfolders,
    includeHidden,
    updateStatus,
  });

  const {
    suggestionsMode,
    suggestionPresets,
    suggestionPresetId,
    suggestionActionFilter,
    suggestionSortMode,
    suggestionStaleDays,
    suggestionMinLargeFileBytes,
    suggestionMaxResults,
    suggestionDryRunStatus,
    suggestionDryRunResult,
    suggestionDryRunSelectionKey,
    selectedSuggestions,
    selectedSuggestionPlanKey,
    clearSuggestionDryRunPreview,
    resetSuggestionsState,
    getDeleteSuggestionPreset,
    confirmDeleteSuggestionPreset,
    buildSuggestionActions,
    previewSelectedSuggestions,
    removeAppliedSuggestions,
  } = suggestionsController;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const snapshot: StoredSettings = {
      filterMode,
      autoScanOnPick,
      rememberLastFolder,
      lastFolder: lastFolder ?? undefined,
      includeSubfolders,
      includeHidden,
      autoPlayMedia,
      skipLargePreviews,
      useHashForDuplicates,
      duplicateMinSizeBytes,
      confirmTrash,
      trashBehavior,
      sortMode,
      groupMode,
      listDensity,
      viewMode,
      extensionFilterMode,
      extensionSelection: selectedExtensions,
      destinationSlots: isAndroidApp ? undefined : destinationSlots,
      suggestionStaleDays,
      suggestionMinLargeFileBytes,
      suggestionMaxResults,
      suggestionSortMode,
      suggestionActionFilter,
      suggestionsMode,
      suggestionPresetId: suggestionPresetId ?? undefined,
      suggestionPresets,
    };
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("Failed to persist settings.", error);
    }
  }, [
    filterMode,
    autoScanOnPick,
    rememberLastFolder,
    lastFolder,
    includeSubfolders,
    includeHidden,
    autoPlayMedia,
    skipLargePreviews,
    useHashForDuplicates,
    duplicateMinSizeBytes,
    confirmTrash,
    trashBehavior,
    sortMode,
    groupMode,
    listDensity,
    viewMode,
    extensionFilterMode,
    selectedExtensions,
    destinationSlots,
    isAndroidApp,
    suggestionStaleDays,
    suggestionMinLargeFileBytes,
    suggestionMaxResults,
    suggestionSortMode,
    suggestionActionFilter,
    suggestionsMode,
    suggestionPresetId,
    suggestionPresets,
  ]);

  const sortFiles = useCallback(
    (list: FileEntry[]) => sortFileEntries(list, sortMode),
    [sortMode],
  );

  const {
    allExtensions,
    selectedExtensionsSet,
    allExtensionsSelected,
    selectAllRef,
    filteredFiles,
    handleToggleAllExtensions,
    handleToggleExtension,
  } = useExtensionFilter({
    files,
    extensionFilterMode,
    selectedExtensions,
    setSelectedExtensions,
  });

  const sortedFiles = useMemo(
    // During a scan the list is still streaming in, so re-sorting the whole
    // collection on every batch is wasted O(n log n) work on the UI thread.
    // Wait until the scan completes to sort the final set once. Single-shot
    // scans (one batch) still sort immediately on completion.
    () =>
      isLoading && streamedBatchesRef.current
        ? filteredFiles
        : sortFiles(filteredFiles),
    [filteredFiles, isLoading, sortFiles],
  );
  const sortedIndexById = useMemo(() => {
    if (isLoading && streamedBatchesRef.current) {
      return EMPTY_SORTED_INDEX;
    }
    const map = new Map<string, number>();
    sortedFiles.forEach((file, index) => {
      map.set(file.id, index);
    });
    return map;
  }, [sortedFiles, isLoading]);
  const preview = usePreviewController({
    sortedFiles,
    currentIndex,
    skipLargePreviews,
    enabled: !isLoading,
  });
  const currentFile = sortedFiles[currentIndex];
  const hasFiles = sortedFiles.length > 0;

  useEffect(() => {
    setIsInfoOpen(false);
  }, [isAndroidApp, preview.previewFile?.id]);

  useEffect(() => {
    // While a scan is still streaming in, keep the current selection stable and
    // skip the per-batch index maintenance. The final selection is reconciled
    // when the scan completes and loading flips to false.
    if (isLoading && streamedBatchesRef.current) {
      return;
    }
    if (sortedFiles.length === 0) {
      resetSelectionToFirstRef.current = false;
      currentFileIdRef.current = null;
      if (currentIndex !== 0) {
        setCurrentIndex(0);
      }
      return;
    }
    if (resetSelectionToFirstRef.current) {
      resetSelectionToFirstRef.current = false;
      currentFileIdRef.current = sortedFiles[0]?.id ?? null;
      if (currentIndex !== 0) {
        setCurrentIndex(0);
      }
      return;
    }
    const currentId = currentFileIdRef.current;
    if (currentId) {
      const nextIndex = sortedIndexById.get(currentId);
      if (nextIndex !== undefined) {
        if (nextIndex !== currentIndex) {
          setCurrentIndex(nextIndex);
        }
        return;
      }
    }
    const boundedIndex = Math.min(currentIndex, sortedFiles.length - 1);
    if (boundedIndex !== currentIndex) {
      setCurrentIndex(boundedIndex);
    }
    currentFileIdRef.current = sortedFiles[boundedIndex]?.id ?? null;
  }, [isLoading, sortedFiles, sortedIndexById, currentIndex]);

  const {
    scanCachePrompt,
    runFreshScan,
    loadCachedScan,
    handleScan,
    dismissScanCachePrompt,
    cancelActiveScan,
    pickFolder,
    buildInitialCollapsedGroups,
  } = useScanWorkflow({
    isAndroidApp,
    filterMode,
    includeSubfolders,
    includeHidden,
    useHashForDuplicates,
    duplicateMinSizeBytes,
    autoScanOnPick,
    viewMode,
    effectiveGroupMode,
    currentFolderToken,
    initialFolder,
    updateStatus,
    setFiles,
    setCurrentFolder,
    setCurrentFolderToken,
    setCollapsedGroups,
    setCollapsedFolders,
    setCurrentIndex,
    setLastScanFilterMode,
    resetSelectionToFirstRef,
    currentFileIdRef,
    skipAutoExpandCurrentFileRef,
    streamedBatchesRef,
    cancelPendingScanBatchFlush,
    resetSuggestionsState,
    scan,
    cancel,
    runScanWorkflow,
    activeScanId,
    setScanProgress,
    resetCancelScanWorkflow,
    openAndroidFolderBrowser,
  });
  const handleDeleteSuggestionPreset = useCallback(async () => {
    const preset = await getDeleteSuggestionPreset();
    if (!preset) {
      return;
    }
    const shouldDelete = await confirmDialog(
      `Delete preset "${preset.activePresetName}"?`,
      {
        title: "Delete suggestion preset",
        confirmLabel: "Delete preset",
        danger: true,
      },
    );
    if (!shouldDelete) {
      return;
    }
    confirmDeleteSuggestionPreset(preset.activePresetId);
    updateStatus(`Preset "${preset.activePresetName}" deleted.`);
  }, [
    confirmDialog,
    confirmDeleteSuggestionPreset,
    getDeleteSuggestionPreset,
    updateStatus,
  ]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  const handleCurrentFolderScan = useCallback(() => {
    if (!currentFolder || !currentFolderToken) {
      void handleScan(undefined);
      return;
    }
    void handleScan({ token: currentFolderToken, label: currentFolder });
  }, [currentFolder, currentFolderToken, handleScan]);

  const handleFilterModeChange = useCallback(
    (value: FilterMode) => {
      startTransition(() => setFilterMode(value));
    },
    [startTransition],
  );

  const handleSortModeChange = useCallback(
    (value: SortMode) => {
      suppressAutoExpandForSortRef.current = true;
      startTransition(() => setSortMode(value));
    },
    [startTransition],
  );

  const handleSidebarGroupModeChange = useCallback(
    (value: GroupMode) => {
      suppressAutoExpandForGroupModeRef.current = true;
      startTransition(() => {
        handleGroupModeChange(value);
        setCollapsedGroups(buildInitialCollapsedGroups(sortedFiles, value));
      });
    },
    [
      buildInitialCollapsedGroups,
      handleGroupModeChange,
      startTransition,
      sortedFiles,
    ],
  );

  const handleViewModeChange = useCallback(
    (value: ViewMode) => {
      startTransition(() => setViewMode(value));
    },
    [startTransition],
  );

  const applySelectedSuggestions = useCallback(async () => {
    if (!currentFolder) {
      updateStatus("No folder selected.");
      return;
    }
    if (!isDesktopRuntime() || isAndroidApp) {
      updateStatus("Suggestions apply is available in the desktop app.");
      return;
    }
    const actions = buildSuggestionActions(selectedSuggestions);
    if (actions.length === 0) {
      updateStatus("Select at least one suggestion to apply.");
      return;
    }
    let plan = suggestionDryRunResult;
    if (
      !plan ||
      !plan.dryRun ||
      suggestionDryRunSelectionKey !== selectedSuggestionPlanKey ||
      suggestionDryRunStatus === "error"
    ) {
      plan = await previewSelectedSuggestions();
      if (!plan) {
        return;
      }
      updateStatus(
        "Preview updated. Review the Change Preview panel, then click Apply selected.",
      );
      return;
    }
    const shouldApply = await confirmDialog(
      `Preview ready: ${plan.applied} planned, ${plan.blocked} blocked, ${plan.failed} failed.\n\nApply now?`,
      { title: "Apply cleanup suggestions?", confirmLabel: "Apply selected" },
    );
    if (!shouldApply) {
      updateStatus("Suggestion apply canceled.");
      return;
    }
    await runMutationWithSpinner("Applying cleanup…", async () => {
      try {
        const applied = await runActionBatch({
          actions,
          dryRun: false,
          allowUnsafe: false,
          allowPermanentDelete: false,
        });
        const appliedIds = new Set(
          applied.results
            .filter((result) => result.status === "applied")
            .map((result) => result.id),
        );
        removeAppliedSuggestions(appliedIds, selectedSuggestions);
        clearSuggestionDryRunPreview();
        updateStatus(
          `Applied ${applied.applied} suggestion(s), ${applied.blocked} blocked, ${applied.failed} failed.`,
        );
        if (applied.applied > 0) {
          await handleScan(currentFolder);
        }
      } catch (error) {
        updateStatus(`Suggestion apply failed: ${String(error)}`);
      }
    });
  }, [
    currentFolder,
    handleScan,
    runMutationWithSpinner,
    selectedSuggestions,
    updateStatus,
    buildSuggestionActions,
    confirmDialog,
    suggestionDryRunResult,
    suggestionDryRunSelectionKey,
    selectedSuggestionPlanKey,
    suggestionDryRunStatus,
    previewSelectedSuggestions,
    clearSuggestionDryRunPreview,
    removeAppliedSuggestions,
    isAndroidApp,
  ]);


  const removeFilesByIds = useCallback(
    (removedIds: string[]) => {
      const removedSet = new Set(removedIds);
      if (removedSet.size === 0) {
        return;
      }
      const prev = filesRef.current;
      const filterByExtension = (file: FileEntry) =>
        selectedExtensionsSet.has(getExtension(file.name));
      const sortedPrev = sortFiles(prev.filter(filterByExtension));
      const next = prev.filter((file) => !removedSet.has(file.id));
      // Removing entries preserves their existing sort order.
      const sortedNext = sortedPrev.filter((file) => !removedSet.has(file.id));
      const sortedNextIndexById = new Map(
        sortedNext.map((file, index) => [file.id, index] as const),
      );
      const visibleOrder = visibleFileOrderRef.current;
      let firstRemovedIndex = -1;
      for (let i = 0; i < visibleOrder.length; i++) {
        if (removedSet.has(visibleOrder[i])) {
          firstRemovedIndex = i;
          break;
        }
      }

      let nextVisibleId: string | null = null;
      if (firstRemovedIndex !== -1) {
        for (let i = firstRemovedIndex + 1; i < visibleOrder.length; i++) {
          const candidateId = visibleOrder[i];
          if (sortedNextIndexById.has(candidateId)) {
            nextVisibleId = candidateId;
            break;
          }
        }
        if (!nextVisibleId) {
          for (let i = firstRemovedIndex - 1; i >= 0; i--) {
            const candidateId = visibleOrder[i];
            if (sortedNextIndexById.has(candidateId)) {
              nextVisibleId = candidateId;
              break;
            }
          }
        }
      }

      filesRef.current = next;
      setFiles(next);
      // Use a functional update so the selection is computed from the latest
      // currentIndex, avoiding stale-closure issues when removals run before a
      // re-render.
      setCurrentIndex((current) => {
        if (sortedNext.length === 0) {
          currentFileIdRef.current = null;
          return 0;
        }
        if (nextVisibleId) {
          const nextIndex = sortedNextIndexById.get(nextVisibleId);
          if (nextIndex !== undefined) {
            currentFileIdRef.current = nextVisibleId;
            return nextIndex;
          }
        }
        const boundedCurrent = Math.min(current, sortedPrev.length - 1);
        const fallbackIndex = Math.min(boundedCurrent, sortedNext.length - 1);
        currentFileIdRef.current = sortedNext[fallbackIndex]?.id ?? null;
        return fallbackIndex;
      });
    },
    [selectedExtensionsSet, sortFiles],
  );

  const removeFileById = useCallback(
    (removedId: string) => removeFilesByIds([removedId]),
    [removeFilesByIds],
  );

  const restoreFileEntries = useCallback(
    (restored: FileEntry[]) => {
      // Compute the next list from the latest files (filesRef stays in sync
      // with `files`), avoiding side effects inside the setFiles updater.
      const prev = filesRef.current;
      const existingIds = new Set(prev.map((file) => file.id));
      const added = restored.filter((file) => {
        if (existingIds.has(file.id)) return false;
        existingIds.add(file.id);
        return true;
      });
      if (added.length === 0) {
        return;
      }
      const next = prev.concat(added);
      filesRef.current = next;
      setFiles(next);
      const matchesExtension = (file: FileEntry) =>
        selectedExtensionsSet.has(getExtension(file.name));
      const visibleAdded = added.filter(matchesExtension);
      const selected = visibleAdded[visibleAdded.length - 1];
      if (selected) {
        const sortedNext = sortFiles(next.filter(matchesExtension));
        currentFileIdRef.current = selected.id;
        setCurrentIndex(
          sortedNext.findIndex((file) => file.id === selected.id),
        );
      }
    },
    [selectedExtensionsSet, sortFiles],
  );
  const restoreFileEntry = useCallback(
    (file: FileEntry) => restoreFileEntries([file]),
    [restoreFileEntries],
  );

  const {
    trashCurrent,
    permanentlyDeleteCurrent,
    trashFolder,
    moveCurrentToSlot,
    openFileInFinder,
    openFileInSystem,
    openCurrentInFinder,
    pickDestinationForSlot,
  } = useFileOperations({
    isAndroidApp,
    currentFile,
    currentFolder,
    files,
    confirmDialog,
    confirmTrash,
    trashBehavior,
    destinationSlots,
    destinationSlotTokens,
    updateDestinationSlot,
    updateStatus,
    runMutationWithSpinner,
    pushUndo,
    removeFileById,
    removeFilesByIds,
    openAndroidFolderBrowser,
  });

  const goNext = useCallback(() => {
    const order = visibleFileOrderRef.current;
    const activeId = currentFileIdRef.current ?? currentFile?.id ?? null;
    if (!activeId || order.length === 0) {
      return;
    }
    const position = visibleIndexByIdRef.current.get(activeId);
    if (position === undefined || position >= order.length - 1) {
      return;
    }
    const nextId = order[position + 1];
    const nextIndex = sortedIndexById.get(nextId);
    if (nextIndex === undefined) {
      return;
    }
    currentFileIdRef.current = nextId;
    setCurrentIndex(nextIndex);
  }, [currentFile, sortedIndexById]);

  const goPrev = useCallback(() => {
    const order = visibleFileOrderRef.current;
    const activeId = currentFileIdRef.current ?? currentFile?.id ?? null;
    if (!activeId || order.length === 0) {
      return;
    }
    const position = visibleIndexByIdRef.current.get(activeId);
    if (position === undefined || position <= 0) {
      return;
    }
    const prevId = order[position - 1];
    const prevIndex = sortedIndexById.get(prevId);
    if (prevIndex === undefined) {
      return;
    }
    currentFileIdRef.current = prevId;
    setCurrentIndex(prevIndex);
  }, [currentFile, sortedIndexById]);

  const undoLastAction = useUndoAction({
    undoStack,
    setUndoStack,
    restoreFileEntry,
    restoreFileEntries,
    updateStatus,
    runMutationWithSpinner,
    onFailure: setUndoFailure,
  });

  const toggleVideoPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const seekMediaBy = useCallback(
    (offsetSeconds: number) => {
      const media =
        currentFile?.kind === "video"
          ? videoRef.current
          : currentFile?.kind === "audio"
            ? audioRef.current
            : null;
      if (!media) {
        return;
      }
      const duration = Number.isFinite(media.duration) ? media.duration : null;
      const nextTime = media.currentTime + offsetSeconds;
      media.currentTime =
        duration === null
          ? Math.max(0, nextTime)
          : Math.min(Math.max(0, nextTime), duration);
    },
    [currentFile?.kind],
  );

  useKeyboardShortcuts({
    isConfirming,
    undoFailure,
    isLoading,
    scanCachePrompt,
    isHelpOpen,
    isSuggestionsOpen,
    isSettingsOpen,
    isMutating,
    blockingOverlay,
    currentFile,
    goPrev,
    goNext,
    seekMediaBy,
    toggleVideoPlayback,
    moveCurrentToSlot,
    permanentlyDeleteCurrent,
    trashCurrent,
    undoLastAction,
    openCurrentInFinder,
    onCloseHelp: () => setIsHelpOpen(false),
    onCloseSuggestions: () => setIsSuggestionsOpen(false),
    onCloseSettings: () => setIsSettingsOpen(false),
  });

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let isMounted = true;
    const unlistenPromise = listenEvent<ScanProgress>(
      "scan_progress",
      (event) => {
        if (!isMounted) {
          return;
        }
        if (event.payload.scanId !== activeScanId.current) {
          return;
        }
        setScanProgress(event.payload);
      },
    );
    const unlistenBatchPromise = listenEvent<ScanBatch>(
      "scan_batch",
      (event) => {
        if (!isMounted) {
          return;
        }
        if (event.payload.scanId !== activeScanId.current) {
          return;
        }
        queueScanBatchFiles(event.payload.files);
      },
    );
    return () => {
      isMounted = false;
      cancelPendingScanBatchFlush();
      void unlistenPromise.then((unlisten) => unlisten());
      void unlistenBatchPromise.then((unlisten) => unlisten());
    };
  }, [cancelPendingScanBatchFlush, queueScanBatchFiles]);

  const listModel = useMemo(
    () =>
      buildFileListModel(
        sortedFiles,
        effectiveGroupMode,
        viewMode,
        currentFolder,
      ),
    [sortedFiles, effectiveGroupMode, viewMode, currentFolder],
  );
  const folderKeys = listModel.folderKeys;
  const visibleFileOrder = listModel.fileOrder;
  const selectListFile = useCallback(
    (file: FileEntry) => {
      currentFileIdRef.current = file.id;
      setCurrentIndex(sortedIndexById.get(file.id) ?? 0);
    },
    [sortedIndexById],
  );

  const hasFolders = folderKeys.length > 0;
  const hasCollapsedFolders = useMemo(
    () => folderKeys.some((key) => collapsedFolders[key]),
    [folderKeys, collapsedFolders],
  );

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);

  const toggleAllFolders = useCallback(() => {
    if (!hasFolders) {
      return;
    }
    if (hasCollapsedFolders) {
      setCollapsedFolders({});
      return;
    }
    const next: Record<string, boolean> = {};
    folderKeys.forEach((key) => {
      next[key] = true;
    });
    setCollapsedFolders(next);
  }, [folderKeys, hasCollapsedFolders, hasFolders]);

  const toggleFolderCollapse = useCallback((folderKey: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [folderKey]: !prev[folderKey] }));
  }, []);

  const listItems = (
    <VirtualFileList
      model={listModel}
      positionRef={fileListPositionRef}
      scrollRef={fileListScrollRef}
      currentId={currentFile?.id}
      collapsedFolders={collapsedFolders}
      collapsedGroups={collapsedGroups}
      onToggleFolder={toggleFolderCollapse}
      onToggleGroup={toggleGroupCollapse}
      onSelect={selectListFile}
      onOpen={openFileInFinder}
      onTrashFolder={trashFolder}
      isLoading={isLoading}
      isMutating={isMutating}
      isAndroid={isAndroidApp}
      density={listDensity}
      showLocation={shouldGroupDuplicates && viewMode === "list"}
      currentFolder={currentFolder}
    />
  );

  useEffect(() => {
    visibleFileOrderRef.current = visibleFileOrder;
    const indexMap = new Map<string, number>();
    visibleFileOrder.forEach((id, index) => {
      indexMap.set(id, index);
    });
    visibleIndexByIdRef.current = indexMap;
  }, [visibleFileOrder]);

  useEffect(() => {
    if (!currentFile) {
      return;
    }
    if (suppressAutoExpandForSortRef.current) {
      return;
    }
    if (suppressAutoExpandForGroupModeRef.current) {
      return;
    }
    if (skipAutoExpandCurrentFileRef.current) {
      skipAutoExpandCurrentFileRef.current = false;
      return;
    }
    const groupId = getGroupIdForFile(effectiveGroupMode, currentFile);
    if (groupId) {
      setCollapsedGroups((prev) => {
        if (!prev[groupId]) {
          return prev;
        }
        const next = { ...prev };
        next[groupId] = false;
        return next;
      });
    }
    const relativeSegments = getRelativeSegments(
      currentFile.path,
      currentFolder,
    );
    const folderSegments =
      relativeSegments.length > 1 ? relativeSegments.slice(0, -1) : [];
    if (folderSegments.length === 0) {
      return;
    }
    setCollapsedFolders((prev) => {
      let next = prev;
      let currentPath = "";
      folderSegments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const key = getFolderCollapseKey(groupId, currentPath);
        if (next[key]) {
          if (next === prev) {
            next = { ...prev };
          }
          delete next[key];
        }
      });
      return next;
    });
  }, [currentFile, currentFolder, effectiveGroupMode]);

  useEffect(() => {
    if (!suppressAutoExpandForSortRef.current) {
      return;
    }
    if (currentFile?.id !== currentFileIdRef.current) {
      return;
    }
    suppressAutoExpandForSortRef.current = false;
  }, [currentFile?.id, sortMode]);

  useEffect(() => {
    if (!suppressAutoExpandForGroupModeRef.current) {
      return;
    }
    if (currentFile?.id !== currentFileIdRef.current) {
      return;
    }
    suppressAutoExpandForGroupModeRef.current = false;
  }, [currentFile?.id, effectiveGroupMode]);

  const scanDescription = describeScanProgress(scanProgress, isCancellingScan);

  const activeBlockingOverlay = useMemo<{
    title: string;
    subtitle: string;
    showSpinner: boolean;
    showCancel: boolean;
    showClose?: boolean;
    onClose?: () => void;
    actions: { label: string; onClick: () => void; disabled?: boolean }[];
  } | null>(() => {
    if (blockingOverlay) {
      return {
        title: blockingOverlay.title,
        subtitle: blockingOverlay.subtitle,
        showSpinner: true,
        showCancel: false,
        actions: [] as {
          label: string;
          onClick: () => void;
          disabled?: boolean;
        }[],
      };
    }
    if (scanCachePrompt && isLoading) {
      return {
        title: "Loading previous scan",
        subtitle:
          "Restoring saved file details. To check for changes on disk, run a fresh scan afterward.",
        showSpinner: true,
        showCancel: false,
        actions: [],
      };
    }
    if (scanCachePrompt) {
      return {
        title: "Previous scan available",
        subtitle:
          "A cached scan matches this folder and these scan options. Load it now or run a fresh scan.",
        showSpinner: false,
        showCancel: false,
        showClose: true,
        onClose: dismissScanCachePrompt,
        actions: [
          {
            label: "Load previous scan",
            onClick: () => void loadCachedScan(scanCachePrompt.cachedScan),
          },
          {
            label: "Scan again",
            onClick: () =>
              void runFreshScan(
                scanCachePrompt.request,
                scanCachePrompt.cachedScan.folderPath,
              ),
          },
        ],
      };
    }
    if (isLoading) {
      return {
        title: scanDescription.title,
        subtitle: scanDescription.detail,
        showSpinner: true,
        showCancel: true,
        showClose: false,
        onClose: undefined,
        actions: [] as {
          label: string;
          onClick: () => void;
          disabled?: boolean;
        }[],
      };
    }
    return null;
  }, [
    blockingOverlay,
    dismissScanCachePrompt,
    isLoading,
    loadCachedScan,
    scanDescription.title,
    scanDescription.detail,
    runFreshScan,
    scanCachePrompt,
  ]);

  const isInteractionBlocked =
    Boolean(activeBlockingOverlay) || isConfirming || Boolean(undoFailure);
  const areControlsDisabled = isLoading || isInteractionBlocked;
  const totalFiles = files.length;
  const filteredCount = sortedFiles.length;
  const isDrawerMode = isNarrowLayout;
  const isGestureMode = isNarrowLayout;
  const canGoPrev =
    hasFiles && currentIndex > 0 && !areControlsDisabled && !isMutating;
  const canGoNext =
    hasFiles &&
    currentIndex < filteredCount - 1 &&
    !areControlsDisabled &&
    !isMutating;
  const canTrashCurrent = hasFiles && !areControlsDisabled && !isMutating;
  const canUndoLastAction =
    undoStack.length > 0 && !areControlsDisabled && !isMutating;
  const isGestureInteractionBlocked =
    isHelpOpen ||
    isSuggestionsOpen ||
    isSettingsOpen ||
    isCrashReportOpen ||
    isInteractionBlocked ||
    isMutating;
  const swipeGesture = useSwipeGestureController({
    enabled: isGestureMode,
    isBlocked: isGestureInteractionBlocked,
    actions: {
      prev: {
        enabled: canGoPrev,
        run: goPrev,
      },
      next: {
        enabled: canGoNext,
        run: goNext,
      },
      trash: {
        enabled: canTrashCurrent,
        run: trashCurrent,
      },
      undo: {
        enabled: canUndoLastAction,
        run: undoLastAction,
      },
    },
  });

  useEffect(() => {
    syncScrollHints(fileListScrollRef.current, fileListFrameRef.current);
  }, [
    syncScrollHints,
    viewMode,
    effectiveGroupMode,
    listDensity,
    filteredCount,
    collapsedGroups,
    collapsedFolders,
    isLoading,
  ]);

 useEffect(() => {
   syncScrollHints(previewScrollRef.current, previewFrameRef.current);
  }, [
    syncScrollHints,
    preview.previewFile?.id,
    isLoading,
    preview.archiveStatus,
    preview.officePreviewStatus,
    preview.archiveEntries.length,
  ]);
  const folderLabel = currentFolder
    ? formatPathLabel(currentFolder)
    : "No folder selected";
  const folderSizeBytes = useMemo(
    () => files.reduce((total, file) => total + file.sizeBytes, 0),
    [files],
  );

  return (
    <div
      className={`app-shell ${isLoading ? "is-loading" : ""} ${
        isInteractionBlocked ? "is-blocked" : ""
      } ${
        isSidebarCollapsed ? "sidebar-collapsed" : ""
      } ${isWindowFullscreen ? "is-fullscreen" : ""}`}
      aria-busy={isLoading || isInteractionBlocked}
      data-window-platform={isWindowsDesktop ? "windows" : "default"}
    >
      {!isAndroidApp && isDesktopRuntime() && (
        <div className="titlebar-drag" data-tauri-drag-region />
      )}
      <Toolbar
        isSidebarCollapsed={isSidebarCollapsed}
        isDrawerMode={isDrawerMode}
        showWindowControls={isWindowsDesktop}
        isWindowMaximized={isWindowMaximized}
        onToggleSidebar={toggleSidebar}
        onMinimizeWindow={handleMinimizeWindow}
        onToggleMaximizeWindow={handleToggleMaximizeWindow}
        onCloseWindow={handleCloseWindow}
      />
      <div className="app-grid">
        {!isSidebarCollapsed && (
          <FileListPanel
            frameRef={fileListFrameRef}
            scrollRef={fileListScrollRef}
            search={{
              currentFolder,
              folderLabel,
              emptyFolderLabel: "Select folder…",
              filterMode,
              onPickFolder: pickFolder,
              onFilterModeChange: handleFilterModeChange,
              onScan: handleCurrentFolderScan,
              onToggleSidebar: toggleSidebar,
            }}
            list={{
              areControlsDisabled,
              totalFiles,
              viewMode,
              hasFolders,
              hasCollapsedFolders,
              onToggleAllFolders: toggleAllFolders,
              sortMode,
              onSortModeChange: handleSortModeChange,
              displayGroupMode,
              shouldGroupDuplicates,
              onGroupModeChange: handleSidebarGroupModeChange,
              onViewModeChange: handleViewModeChange,
              isLoading,
              listDensity,
              hasFiles,
              listItems,
            }}
            extensions={{
              allExtensions,
              selectedExtensions,
              allExtensionsSelected,
              selectAllRef,
              onToggleAll: handleToggleAllExtensions,
              onToggleExtension: handleToggleExtension,
            }}
          />
        )}

        <main className="content">
          <PreviewPanel
            frameRef={previewFrameRef}
            scrollRef={previewScrollRef}
            preview={preview}
            folderSizeBytes={folderSizeBytes}
            filteredCount={filteredCount}
            autoPlayMedia={autoPlayMedia}
            videoRef={videoRef}
            audioRef={audioRef}
            gesture={swipeGesture}
            isAndroidApp={isAndroidApp}
            isInfoOpen={isInfoOpen}
            onCloseInfo={() => setIsInfoOpen(false)}
          />
        </main>

        <ActionBar
          destinationSlots={destinationSlots}
          areControlsDisabled={areControlsDisabled}
          isMutating={isMutating}
          mutationSpinnerLabel={mutationSpinnerLabel}
          isGestureMode={isGestureMode}
          canGoPrev={canGoPrev}
          canGoNext={canGoNext}
          canUndoLastAction={canUndoLastAction}
          canTrashCurrent={canTrashCurrent}
          goPrev={goPrev}
          goNext={goNext}
          undoLastAction={undoLastAction}
          trashCurrent={trashCurrent}
          pickDestinationForSlot={pickDestinationForSlot}
          previewFile={preview.previewFile ?? null}
          preview={preview}
          canOpenFile={!isAndroidApp}
          isSidebarCollapsed={isSidebarCollapsed}
          isSettingsOpen={isSettingsOpen}
          isInfoOpen={isInfoOpen}
          shouldUseAndroidFloatingInfo={isAndroidApp}
          onToggleSidebar={toggleSidebar}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenFile={openFileInSystem}
          onToggleInfo={() => setIsInfoOpen((current) => !current)}
          gesture={swipeGesture}
        />
        {isGestureMode && isAndroidApp && (
          <PreviewGestureLegend gesture={swipeGesture} />
        )}
      </div>

      <UndoFailureModal
        failure={undoFailure}
        onClose={() => setUndoFailure(null)}
        onRetry={() => {
          setUndoFailure(null);
          void undoLastAction();
        }}
      />
      {confirmation}
      <BlockingOverlayModal
        overlay={activeBlockingOverlay}
        currentFolder={currentFolder}
        showFolderPath={isLoading}
        isCancellingScan={isCancellingScan}
        cancelActiveScan={cancelActiveScan}
      />

      <DeferredMount active={isCrashReportOpen}>
        <CrashReportModal
          isOpen={isCrashReportOpen}
          crashReport={crashReport}
          crashReportText={crashReportText}
          onDismiss={handleDismissCrashReport}
          onReveal={handleRevealCrashReport}
          onCopy={handleCopyCrashReport}
          onSend={handleSendCrashReport}
        />
      </DeferredMount>

      <DeferredMount active={isAndroidFolderBrowserOpen}>
        <AndroidFolderBrowserModal
          isOpen={isAndroidFolderBrowserOpen}
          title="Choose folder"
          currentPath={androidFolderBrowserPath}
          parentPath={androidFolderBrowserParentPath}
          directories={androidFolderBrowserDirectories}
          isLoading={isAndroidFolderBrowserLoading}
          error={androidFolderBrowserError}
          onClose={() => resolveAndroidFolderBrowser(null)}
          onNavigateUp={() => {
            if (!androidFolderBrowserParentPath) {
              return;
            }
            void loadAndroidFolderBrowserPath(androidFolderBrowserParentPath);
          }}
          onOpenDirectory={(path) => {
            void loadAndroidFolderBrowserPath(path);
          }}
          onConfirm={() =>
            resolveAndroidFolderBrowser({
              token: androidFolderBrowserPath,
              label: androidFolderBrowserPath,
            })
          }
        />
      </DeferredMount>

      <DeferredMount active={isSuggestionsOpen}>
        <SuggestionsModal
          isOpen={isSuggestionsOpen}
          onClose={() => setIsSuggestionsOpen(false)}
          onDeletePreset={() => void handleDeleteSuggestionPreset()}
          onApplySelectedSuggestions={() => void applySelectedSuggestions()}
          controller={suggestionsController}
          modeOptions={SUGGESTIONS_MODE_OPTIONS}
          actionFilterOptions={SUGGESTION_ACTION_FILTER_OPTIONS}
          sortOptions={SUGGESTION_SORT_OPTIONS}
          minLargeFileOptions={SUGGESTION_MIN_LARGE_FILE_OPTIONS}
        />
      </DeferredMount>

      <DeferredMount active={isSettingsOpen}>
        <SettingsModal
          isOpen={isSettingsOpen}
          isLoading={areControlsDisabled}
          layout={{
            viewMode,
            setViewMode: setViewMode,
            sortMode,
            setSortMode: setSortMode,
            displayGroupMode,
            handleGroupModeChange: (value) =>
              startTransition(() => handleGroupModeChange(value)),
            shouldGroupDuplicates,
            extensionFilterMode,
            setExtensionFilterMode: setExtensionFilterMode,
            listDensity,
            setListDensity: setListDensity,
          }}
          scanning={{
            autoScanOnPick,
            setAutoScanOnPick,
            rememberLastFolder,
            setRememberLastFolder,
            includeSubfolders,
            setIncludeSubfolders,
            includeHidden,
            setIncludeHidden,
          }}
          cleanup={{
            useHashForDuplicates,
            setUseHashForDuplicates,
            duplicateMinSizeBytes,
            setDuplicateMinSizeBytes,
            trashBehavior,
            setTrashBehavior,
            confirmTrash,
            setConfirmTrash,
          }}
          preview={{
            autoPlayMedia,
            setAutoPlayMedia,
            skipLargePreviews,
            setSkipLargePreviews,
          }}
          appearance={{
            theme,
            setTheme: setTheme,
          }}
          onClose={() => setIsSettingsOpen(false)}
          onOpenHelp={() => setIsHelpOpen(true)}
        />
      </DeferredMount>
      <DeferredMount active={isHelpOpen}>
        <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
      </DeferredMount>
    </div>
  );
}
