import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type {
  ActivitySnapshot,
  ActionBatchResult,
  CachedScan,
  CrashReport,
  DensityMode,
  ExtensionFilterMode,
  FileEntry,
  FilterMode,
  FolderTrashEntry,
  FolderTrashItem,
  GroupMode,
  MoveResult,
  SuggestionPreset,
  SuggestionActionFilter,
  SuggestionSortMode,
  Suggestion,
  SuggestionSet,
  SuggestionsMode,
  SafetyLevel,
  ScanBatch,
  ScanProgress,
  ScanResult,
  SortMode,
  StoredSettings,
  ThemeMode,
  TrashBehavior,
  TrashResult,
  TreeNode,
  UndoAction,
  ViewMode,
} from "../types";
import {
  COMMON_EXTENSIONS,
  CRASH_REPORT_EMAIL,
  DESTINATION_SLOT_COUNT,
  EVENT_LOOP_LAG_WARN_MS,
  EVENT_LOOP_POLL_MS,
  FILTER_OPTIONS,
  HEARTBEAT_INTERVAL_MS,
  LARGE_PREVIEW_SIZE_BYTES,
  MAX_UNDO_STACK,
  SETTINGS_KEY,
  TREE_INDENT_PX,
} from "../constants/appConstants";
import {
  updateScrollHint,
  isEditableTarget,
  shouldOpenOnEnter,
} from "../lib/dom";
import { buildMediaUrl } from "../lib/media";
import {
  buildCrashEmailBody,
  formatBytes,
  formatActivitySummary,
  formatCrashReport,
  formatDuplicateGroupMeta,
  formatExtensionLabel,
  formatGroupTitle,
  formatKindLabel,
  formatPathLabel,
  formatTimestamp,
} from "../lib/format";
import { dedupeFileEntries, getExtension } from "../lib/files";
import { getGroupIdForFile, groupFilesByMode } from "../lib/grouping";
import {
  buildFileTree,
  getFolderCollapseKey,
  sortTreeNodesByIndex,
} from "../lib/tree";
import {
  extractFolder,
  formatRelativeFolder,
  getRelativeSegments,
  splitPathSegments,
} from "../lib/path";
import {
  confirmDialog,
  getDesktopWindow,
  invokeCommand,
  isDesktopRuntime,
  listenEvent,
  openDialog,
} from "../lib/desktopBridge";
import { usePreviewController } from "../hooks/usePreviewController";
import { getInitialTheme, getStoredSettings } from "../lib/settings";
import { revealInFileManager } from "../services/fileManagerService";
import { HelpModal } from "../components/HelpModal";
import { SettingsModal } from "../components/SettingsModal";

const SUGGESTION_DEFAULT_STALE_DAYS = 30;
const SUGGESTION_DEFAULT_MIN_LARGE_FILE_BYTES = 250 * 1024 * 1024;
const SUGGESTION_DEFAULT_MAX_RESULTS = 200;
const SUGGESTIONS_MODE_OPTIONS: { value: SuggestionsMode; label: string }[] = [
  { value: "review", label: "Review & Apply" },
  { value: "advanced", label: "Advanced" },
];

const SUGGESTION_SAFETY_RANK: Record<SafetyLevel, number> = {
  safe: 0,
  review: 1,
  manual: 2,
};

const SUGGESTION_ACTION_FILTER_OPTIONS: {
  value: SuggestionActionFilter;
  label: string;
}[] = [
  { value: "all", label: "All actions" },
  { value: "trash", label: "Move to trash" },
  { value: "remove-empty-folder", label: "Remove empty folder" },
  { value: "move", label: "Move file" },
  { value: "delete", label: "Delete permanently" },
];

const SUGGESTION_SORT_OPTIONS: { value: SuggestionSortMode; label: string }[] =
  [
    { value: "largest_first", label: "Largest first" },
    { value: "safest_first", label: "Safest first" },
    { value: "path_asc", label: "Path A-Z" },
  ];

const SUGGESTION_MIN_LARGE_FILE_OPTIONS = [
  { value: 100 * 1024 * 1024, label: "100 MB+" },
  { value: 250 * 1024 * 1024, label: "250 MB+" },
  { value: 500 * 1024 * 1024, label: "500 MB+" },
  { value: 1024 * 1024 * 1024, label: "1 GB+" },
  { value: 2 * 1024 * 1024 * 1024, label: "2 GB+" },
];

type BlockingOverlayState = {
  title: string;
  subtitle: string;
};

type ScanCacheRequest = {
  folderPath: string;
  filterMode: FilterMode;
  includeSubfolders: boolean;
  includeHidden: boolean;
  useHashForDuplicates: boolean;
  duplicateMinSizeBytes: number;
};

type ScanCachePromptState = {
  request: ScanCacheRequest;
  cachedScan: CachedScan;
};

export default function App() {
  const [storedSettings] = useState(() => getStoredSettings());
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [, setStatus] = useState("Select a folder to begin.");
  const [filterMode, setFilterMode] = useState<FilterMode>(
    storedSettings.filterMode ?? "all",
  );
  const [lastScanFilterMode, setLastScanFilterMode] =
    useState<FilterMode | null>(null);
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
      const storedSlots = storedSettings.destinationSlots;
      if (!storedSlots) {
        return Array.from({ length: DESTINATION_SLOT_COUNT }, () => null);
      }
      const normalized = storedSlots.slice(0, DESTINATION_SLOT_COUNT);
      while (normalized.length < DESTINATION_SLOT_COUNT) {
        normalized.push(null);
      }
      return normalized;
    },
  );
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
    storedSettings.lastFolder ?? null,
  );
  const initialFolder = storedSettings.rememberLastFolder
    ? (storedSettings.lastFolder ?? null)
    : null;
  const [currentFolder, setCurrentFolder] = useState<string | null>(
    initialFolder,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [scanCachePrompt, setScanCachePrompt] =
    useState<ScanCachePromptState | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [blockingOverlay, setBlockingOverlay] =
    useState<BlockingOverlayState | null>(null);
  const [mutationSpinnerLabel, setMutationSpinnerLabel] = useState<
    string | null
  >(null);
  const mutationSpinnerTimeoutRef = useRef<number | null>(null);
  const isMutatingRef = useRef(false);
  const resetSelectionToFirstRef = useRef(false);
  const blockingOverlayShowFrameRef = useRef<number | null>(null);
  const blockingOverlayHideFrameRef = useRef<number | null>(null);
  const [isCancellingScan, setIsCancellingScan] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [renderCount, setRenderCount] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsBodyRef = useRef<HTMLDivElement | null>(null);
  const settingsFrameRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }
    const scrollNode = settingsBodyRef.current;
    const frameNode = settingsFrameRef.current;
    if (!scrollNode || !frameNode) {
      return;
    }
    let raf = 0;
    const handle = () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() =>
        updateScrollHint(scrollNode, frameNode),
      );
    };
    handle();
    scrollNode.addEventListener("scroll", handle, { passive: true });
    const resizeObserver = new ResizeObserver(handle);
    resizeObserver.observe(scrollNode);
    return () => {
      scrollNode.removeEventListener("scroll", handle);
      resizeObserver.disconnect();
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [isSettingsOpen]);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [crashReport, setCrashReport] = useState<CrashReport | null>(null);
  const [isCrashReportOpen, setIsCrashReportOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDrawerMode, setIsDrawerMode] = useState(false);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const [isExtensionsCollapsed, setIsExtensionsCollapsed] = useState(true);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionsStatus, setSuggestionsStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [suggestionsMode, setSuggestionsMode] = useState<SuggestionsMode>(
    storedSettings.suggestionsMode ?? "review",
  );
  const [suggestionPresets, setSuggestionPresets] = useState<
    SuggestionPreset[]
  >(storedSettings.suggestionPresets ?? []);
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
  const [suggestionDryRunStatus, setSuggestionDryRunStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [suggestionDryRunError, setSuggestionDryRunError] = useState<
    string | null
  >(null);
  const [suggestionDryRunResult, setSuggestionDryRunResult] =
    useState<ActionBatchResult | null>(null);
  const [suggestionDryRunSelectionKey, setSuggestionDryRunSelectionKey] =
    useState<string | null>(null);
  const [suggestionExplainabilityEnabled] = useState(false);
  const [suggestionBatchToolbarEnabled] = useState(false);
  const activeScanId = useRef<string | null>(null);
  const scanBatchBufferRef = useRef<FileEntry[]>([]);
  const scanBatchRafRef = useRef<number | null>(null);
  const hasAutoLoadedFolderRef = useRef(false);
  const listItemRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const currentFileIdRef = useRef<string | null>(null);
  const previousActiveFileIdRef = useRef<string | null>(null);
  const visibleFileOrderRef = useRef<string[]>([]);
  const visibleIndexByIdRef = useRef<Map<string, number>>(new Map());
  const previousExtensionsRef = useRef<string[]>([]);
  const hasUserAdjustedExtensionsRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const fileListFrameRef = useRef<HTMLDivElement | null>(null);
  const fileListScrollRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLElement | null>(null);
  const lastStatusRef = useRef<string | null>(null);
  const lastEventLoopLagRef = useRef<number | null>(null);
  const cancelPendingScanBatchFlush = useCallback(() => {
    scanBatchBufferRef.current = [];
    if (scanBatchRafRef.current !== null) {
      window.cancelAnimationFrame(scanBatchRafRef.current);
      scanBatchRafRef.current = null;
    }
  }, []);
  const flushQueuedScanBatches = useCallback(() => {
    scanBatchRafRef.current = null;
    const pending = scanBatchBufferRef.current;
    if (pending.length === 0) {
      return;
    }
    scanBatchBufferRef.current = [];
    setFiles((prev) => dedupeFileEntries([...prev, ...pending]));
  }, []);
  const queueScanBatchFiles = useCallback(
    (batchFiles: FileEntry[]) => {
      if (batchFiles.length === 0) {
        return;
      }
      scanBatchBufferRef.current.push(...batchFiles);
      if (scanBatchRafRef.current !== null) {
        return;
      }
      scanBatchRafRef.current = window.requestAnimationFrame(
        flushQueuedScanBatches,
      );
    },
    [flushQueuedScanBatches],
  );
  const clearSuggestionDryRunPreview = useCallback(() => {
    setSuggestionDryRunResult(null);
    setSuggestionDryRunSelectionKey(null);
    setSuggestionDryRunStatus("idle");
    setSuggestionDryRunError(null);
  }, []);
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
  const crashReportText = useMemo(
    () => (crashReport ? formatCrashReport(crashReport) : ""),
    [crashReport],
  );
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
    if (currentFolder) {
      setLastFolder(currentFolder);
    }
  }, [currentFolder]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const handleChange = () => setIsDrawerMode(mediaQuery.matches);
    handleChange();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (isDrawerMode) {
      setIsSidebarCollapsed(true);
    }
  }, [isDrawerMode]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let isMounted = true;
    const appWindow = getDesktopWindow();
    let unlistenResize: (() => void) | null = null;
    const syncFullscreenState = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (isMounted) {
          setIsWindowFullscreen(fullscreen);
        }
      } catch {
        // Ignore unsupported window APIs in non-desktop runtimes.
      }
    };
    void syncFullscreenState();
    void appWindow
      .onResized(() => {
        void syncFullscreenState();
      })
      .then((unlisten) => {
        if (!isMounted) {
          unlisten();
          return;
        }
        unlistenResize = unlisten;
      })
      .catch(() => {});
    return () => {
      isMounted = false;
      if (unlistenResize) {
        unlistenResize();
      }
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let isMounted = true;
    invokeCommand<CrashReport | null>("get_crash_report")
      .then((report) => {
        if (!isMounted || !report) {
          return;
        }
        setCrashReport(report);
        setIsCrashReportOpen(true);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let isMounted = true;
    invokeCommand<UndoAction[]>("get_recent_undo_actions")
      .then((actions) => {
        if (!isMounted) {
          return;
        }
        setUndoStack(Array.isArray(actions) ? actions : []);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

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

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    const handleError = (event: ErrorEvent) => {
      void invokeCommand("log_client_error", {
        message: event.message || "Unhandled error",
        stack: event.error?.stack ?? null,
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason =
        event.reason instanceof Error
          ? event.reason.message
          : typeof event.reason === "string"
            ? event.reason
            : "Unhandled promise rejection";
      const stack = event.reason instanceof Error ? event.reason.stack : null;
      void invokeCommand("log_client_error", { message: reason, stack });
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let active = true;
    const tick = () => {
      if (!active) {
        return;
      }
      const activity = buildActivitySnapshot();
      void invokeCommand("update_heartbeat", { activity }).catch(() => {});
    };
    tick();
    const interval = window.setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [buildActivitySnapshot]);

  const handleDismissCrashReport = useCallback(() => {
    setIsCrashReportOpen(false);
    setCrashReport(null);
    if (isDesktopRuntime()) {
      void invokeCommand("clear_crash_report");
    }
  }, []);

  const handleSendCrashReport = useCallback(() => {
    if (!crashReport) {
      return;
    }
    const subject = `Tidy crash report (${new Date(crashReport.createdMs).toLocaleString()})`;
    const body = buildCrashEmailBody(crashReport);
    const mailto = `mailto:${CRASH_REPORT_EMAIL}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  }, [crashReport]);

  const handleRevealCrashReport = useCallback(() => {
    if (!crashReport || !isDesktopRuntime()) {
      return;
    }
    void invokeCommand("reveal_in_file_manager", {
      path: crashReport.reportPath,
      reveal: true,
    });
  }, [crashReport]);

  const handleCopyCrashReport = useCallback(() => {
    if (!crashReportText) {
      return;
    }
    void navigator.clipboard.writeText(crashReportText);
  }, [crashReportText]);

  const syncScrollHints = useCallback(
    (scrollNode: HTMLElement | null, frameNode: HTMLElement | null) => {
      if (!scrollNode || !frameNode) {
        return;
      }
      updateScrollHint(scrollNode, frameNode);
    },
    [],
  );

  useEffect(() => {
    const scrollNode = fileListScrollRef.current;
    const frameNode = fileListFrameRef.current;
    if (!scrollNode || !frameNode) {
      return;
    }
    let raf = 0;
    const handle = () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() =>
        updateScrollHint(scrollNode, frameNode),
      );
    };
    handle();
    scrollNode.addEventListener("scroll", handle, { passive: true });
    const resizeObserver = new ResizeObserver(handle);
    resizeObserver.observe(scrollNode);
    return () => {
      scrollNode.removeEventListener("scroll", handle);
      resizeObserver.disconnect();
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [isSidebarCollapsed]);

  useEffect(() => {
    const scrollNode = previewScrollRef.current;
    const frameNode = previewFrameRef.current;
    if (!scrollNode || !frameNode) {
      return;
    }
    let raf = 0;
    const handle = () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() =>
        updateScrollHint(scrollNode, frameNode),
      );
    };
    handle();
    scrollNode.addEventListener("scroll", handle, { passive: true });
    const resizeObserver = new ResizeObserver(handle);
    resizeObserver.observe(scrollNode);
    return () => {
      scrollNode.removeEventListener("scroll", handle);
      resizeObserver.disconnect();
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, []);

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
      destinationSlots,
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
    suggestionStaleDays,
    suggestionMinLargeFileBytes,
    suggestionMaxResults,
    suggestionSortMode,
    suggestionActionFilter,
    suggestionsMode,
    suggestionPresetId,
    suggestionPresets,
  ]);

  useEffect(() => {
    const applyWindowTheme = async () => {
      if (!isDesktopRuntime()) {
        return;
      }
      try {
        await getDesktopWindow().setTheme(theme === "dark" ? "dark" : "light");
      } catch (error) {
        console.warn("Failed to sync window theme.", error);
      }
    };
    void applyWindowTheme();
  }, [theme]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void invokeCommand("store_recent_undo_actions", {
      actions: undoStack,
    }).catch(() => {});
  }, [undoStack]);

  const updateStatus = useCallback((message: string) => {
    lastStatusRef.current = message;
    setStatus(message);
  }, []);

  const clearBlockingOverlayFrames = useCallback(() => {
    if (blockingOverlayShowFrameRef.current !== null) {
      window.cancelAnimationFrame(blockingOverlayShowFrameRef.current);
      blockingOverlayShowFrameRef.current = null;
    }
    if (blockingOverlayHideFrameRef.current !== null) {
      window.cancelAnimationFrame(blockingOverlayHideFrameRef.current);
      blockingOverlayHideFrameRef.current = null;
    }
  }, []);

  const runBlockingUiTransition = useCallback(
    (
      title: string,
      action: () => void,
      subtitle = "Updating the interface. Please wait...",
    ) => {
      clearBlockingOverlayFrames();
      setBlockingOverlay({ title, subtitle });
      blockingOverlayShowFrameRef.current = window.requestAnimationFrame(() => {
        blockingOverlayShowFrameRef.current = null;
        action();
        blockingOverlayHideFrameRef.current = window.requestAnimationFrame(
          () => {
            blockingOverlayHideFrameRef.current = window.requestAnimationFrame(
              () => {
                blockingOverlayHideFrameRef.current = null;
                setBlockingOverlay(null);
              },
            );
          },
        );
      });
    },
    [clearBlockingOverlayFrames],
  );

  const makeBlockingSetter = useCallback(
    <T,>(
      title: string,
      setter: (value: SetStateAction<T>) => void,
      subtitle: string,
    ) =>
      (value: SetStateAction<T>) => {
        runBlockingUiTransition(title, () => setter(value), subtitle);
      },
    [runBlockingUiTransition],
  );

  const runMutationWithSpinner = useCallback(
    async (spinnerLabel: string, operation: () => Promise<void>) => {
      if (isMutatingRef.current) {
        return;
      }
      isMutatingRef.current = true;
      setIsMutating(true);
      setBlockingOverlay({
        title: spinnerLabel.replace(/…$/, ""),
        subtitle: "This operation is in progress. Please wait...",
      });
      if (mutationSpinnerTimeoutRef.current) {
        window.clearTimeout(mutationSpinnerTimeoutRef.current);
      }
      mutationSpinnerTimeoutRef.current = window.setTimeout(() => {
        setMutationSpinnerLabel(spinnerLabel);
      }, 250);
      try {
        await operation();
      } finally {
        isMutatingRef.current = false;
        setIsMutating(false);
        if (mutationSpinnerTimeoutRef.current) {
          window.clearTimeout(mutationSpinnerTimeoutRef.current);
          mutationSpinnerTimeoutRef.current = null;
        }
        setMutationSpinnerLabel(null);
        setBlockingOverlay(null);
      }
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (mutationSpinnerTimeoutRef.current) {
        window.clearTimeout(mutationSpinnerTimeoutRef.current);
        mutationSpinnerTimeoutRef.current = null;
      }
      clearBlockingOverlayFrames();
    };
  }, [clearBlockingOverlayFrames]);

  const sortFiles = useCallback(
    (list: FileEntry[]) => {
      if (sortMode === "none") {
        return list;
      }
      const next = [...list];
      const compareName = (a: FileEntry, b: FileEntry) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      const compareExtension = (a: FileEntry, b: FileEntry) =>
        getExtension(a.name).localeCompare(getExtension(b.name), undefined, {
          sensitivity: "base",
        });
      const compareType = (a: FileEntry, b: FileEntry) =>
        a.kind.localeCompare(b.kind, undefined, { sensitivity: "base" });
      next.sort((a, b) => {
        switch (sortMode) {
          case "size_desc":
            return b.sizeBytes - a.sizeBytes || compareName(a, b);
          case "size_asc":
            return a.sizeBytes - b.sizeBytes || compareName(a, b);
          case "date_desc":
            return (
              (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) || compareName(a, b)
            );
          case "date_asc":
            return (
              (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0) || compareName(a, b)
            );
          case "type_asc":
            return compareType(a, b) || compareName(a, b);
          case "type_desc":
            return compareType(b, a) || compareName(a, b);
          case "extension_asc":
            return compareExtension(a, b) || compareName(a, b);
          case "extension_desc":
            return compareExtension(b, a) || compareName(a, b);
          case "name_desc":
            return compareName(b, a);
          case "name_asc":
          default:
            return compareName(a, b);
        }
      });
      return next;
    },
    [sortMode],
  );

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
    return files.filter((file) =>
      selectedExtensionsSet.has(getExtension(file.name)),
    );
  }, [files, selectedExtensionsSet]);

  const sortedFiles = useMemo(
    () => sortFiles(filteredFiles),
    [filteredFiles, sortFiles],
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
  const sortedIndexById = useMemo(() => {
    const map = new Map<string, number>();
    sortedFiles.forEach((file, index) => {
      map.set(file.id, index);
    });
    return map;
  }, [sortedFiles]);
  const {
    previewIndex,
    previewFile,
    previewExtension,
    previewZoom,
    previewPan,
    isPreviewPanning,
    previewCapabilities,
    officePreviewId,
    officeFallbackPreview,
    officePreviewStatus,
    archiveEntries,
    archiveTruncated,
    archiveStatus,
    archiveError,
    isPreviewSuppressed,
    isMediaPreview,
    isAudioPreview,
    isOfficePreview,
    isDocumentPreview,
    isArchivePreview,
    isFallbackPreview,
    isZoomablePreview,
    enableLargePreview,
    handlePreviewWheel,
    handleZoomOut,
    handleZoomIn,
    handleZoomReset,
    handlePreviewPanStart,
    handlePreviewPanMove,
    handlePreviewPanEnd,
  } = usePreviewController({
    sortedFiles,
    currentIndex,
    skipLargePreviews,
  });
  const currentFile = sortedFiles[currentIndex];
  const hasFiles = sortedFiles.length > 0;

  useEffect(() => {
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
  }, [sortedFiles, sortedIndexById, currentIndex]);

  const buildScanCacheRequest = useCallback(
    (folderPath: string): ScanCacheRequest => ({
      folderPath,
      filterMode,
      includeSubfolders,
      includeHidden,
      useHashForDuplicates,
      duplicateMinSizeBytes,
    }),
    [
      duplicateMinSizeBytes,
      filterMode,
      includeHidden,
      includeSubfolders,
      useHashForDuplicates,
    ],
  );

  const resetScanViewState = useCallback(() => {
    cancelPendingScanBatchFlush();
    setFiles([]);
    currentFileIdRef.current = null;
    setCurrentIndex(0);
    setRenderCount(0);
    setUndoStack([]);
    setSuggestions([]);
    setSelectedSuggestionIds([]);
    setSuggestionTotalReclaimableBytes(0);
    setSuggestionsError(null);
    setSuggestionsStatus("idle");
    setSuggestionDryRunResult(null);
    setSuggestionDryRunSelectionKey(null);
    setSuggestionDryRunStatus("idle");
    setSuggestionDryRunError(null);
    setCollapsedGroups({});
    setCollapsedFolders({});
  }, [cancelPendingScanBatchFlush]);

  const applyScanResult = useCallback(
    (folderPath: string, result: ScanResult) => {
      cancelPendingScanBatchFlush();
      resetSelectionToFirstRef.current = true;
      const uniqueFiles = dedupeFileEntries(result.files);
      setFiles(uniqueFiles);
      setCurrentFolder(folderPath);
      currentFileIdRef.current = null;
      setCurrentIndex(0);
      setRenderCount(0);
      setUndoStack([]);
      setSuggestions([]);
      setSelectedSuggestionIds([]);
      setSuggestionTotalReclaimableBytes(0);
      setSuggestionsError(null);
      setSuggestionsStatus("idle");
      setSuggestionDryRunResult(null);
      setSuggestionDryRunSelectionKey(null);
      setSuggestionDryRunStatus("idle");
      setSuggestionDryRunError(null);
      setCollapsedGroups({});
      setCollapsedFolders({});
      updateStatus(`Loaded ${uniqueFiles.length} items from ${folderPath}.`);
    },
    [cancelPendingScanBatchFlush, updateStatus],
  );

  const runFreshScan = useCallback(
    async (request: ScanCacheRequest) => {
      const { folderPath } = request;
      setLastScanFilterMode(request.filterMode);
      const scanId =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}`;
      activeScanId.current = scanId;
      setScanCachePrompt(null);
      setIsCancellingScan(false);
      setIsLoading(true);
      setScanProgress({
        scanId,
        scanned: 0,
        matched: 0,
        total: 0,
        phase: "indexing",
      });
      resetScanViewState();
      updateStatus(
        request.includeSubfolders
          ? "Scanning folders and subfolders..."
          : "Scanning folder...",
      );
      try {
        const result = await invokeCommand<ScanResult>("scan_folder", {
          ...request,
          scanId,
        });
        if (activeScanId.current !== scanId) {
          return;
        }
        applyScanResult(folderPath, result);
        try {
          await invokeCommand("store_cached_scan_result", { request, result });
        } catch (cacheError) {
          console.warn("Failed to store cached scan.", cacheError);
        }
      } catch (error) {
        if (activeScanId.current !== scanId) {
          return;
        }
        const message = String(error);
        if (message.toLowerCase().includes("scan cancelled")) {
          updateStatus("Scan cancelled.");
          return;
        }
        updateStatus(`Scan failed: ${message}`);
      } finally {
        if (activeScanId.current === scanId) {
          setIsLoading(false);
          setScanProgress(null);
          activeScanId.current = null;
          setIsCancellingScan(false);
        }
      }
    },
    [applyScanResult, resetScanViewState, updateStatus],
  );

  const loadCachedScan = useCallback(
    async (cachedScan: CachedScan) => {
      try {
        await invokeCommand("hydrate_cached_scan", {
          request: {
            folderPath: cachedScan.folderPath,
            files: cachedScan.files,
          },
        });
      } catch (error) {
        updateStatus(`Failed to load cached scan: ${String(error)}`);
        return;
      }
      setScanCachePrompt(null);
      setIsLoading(false);
      setScanProgress(null);
      activeScanId.current = null;
      setIsCancellingScan(false);
      setLastScanFilterMode(cachedScan.filterMode);
      applyScanResult(cachedScan.folderPath, {
        files: cachedScan.files,
        total: cachedScan.total,
      });
    },
    [applyScanResult, updateStatus],
  );

  const handleScan = useCallback(
    async (folderPath?: string) => {
      if (!folderPath) {
        updateStatus("No folder selected.");
        return;
      }
      const request = buildScanCacheRequest(folderPath);
      setScanCachePrompt(null);
      try {
        const cachedScan = await invokeCommand<CachedScan | null>(
          "get_cached_scan",
          { request },
        );
        if (cachedScan) {
          setScanCachePrompt({ request, cachedScan });
          updateStatus("Previous scan found. Choose how to continue.");
          return;
        }
      } catch (error) {
        console.warn("Failed to load cached scan.", error);
      }
      await runFreshScan(request);
    },
    [buildScanCacheRequest, runFreshScan, updateStatus],
  );

  const cancelActiveScan = useCallback(async () => {
    const scanId = activeScanId.current;
    if (!scanId || isCancellingScan) {
      return;
    }
    setIsCancellingScan(true);
    updateStatus("Stopping scan...");
    try {
      await invokeCommand("cancel_scan", { scanId });
    } catch (error) {
      setIsCancellingScan(false);
      updateStatus(`Failed to stop scan: ${String(error)}`);
    }
  }, [isCancellingScan, updateStatus]);

  const pickFolder = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setCurrentFolder(selected);
        if (autoScanOnPick) {
          void handleScan(selected);
        } else {
          updateStatus("Folder selected. Click search to scan.");
        }
      } else {
        updateStatus("No folder selected.");
      }
    } catch (error) {
      updateStatus(`Folder picker failed: ${String(error)}`);
    }
  }, [autoScanOnPick, handleScan, updateStatus]);

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

  const deleteSuggestionPreset = useCallback(async () => {
    if (!activeSuggestionPreset) {
      updateStatus("Select a preset to delete.");
      return;
    }
    const shouldDelete = await confirmDialog(
      `Delete preset "${activeSuggestionPreset.name}"?`,
      { title: "Delete suggestion preset" },
    );
    if (!shouldDelete) {
      return;
    }
    setSuggestionPresets((previous) =>
      previous.filter((preset) => preset.id !== activeSuggestionPreset.id),
    );
    setSuggestionPresetId((current) =>
      current === activeSuggestionPreset.id ? null : current,
    );
    updateStatus(`Preset "${activeSuggestionPreset.name}" deleted.`);
  }, [activeSuggestionPreset, updateStatus]);

  const buildSuggestionActions = useCallback(
    (items: Suggestion[]) =>
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
    setSuggestionsStatus("loading");
    setSuggestionsError(null);
    clearSuggestionDryRunPreview();
    try {
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
      const result = await invokeCommand<SuggestionSet>(
        "build_cleanup_suggestions",
        {
          request: {
            folderPath: currentFolder,
            includeSubfolders,
            includeHidden,
            staleDays: clampedStaleDays,
            maxResults: clampedMaxResults,
            minLargeFileBytes: clampedMinLargeBytes,
          },
        },
      );
      setSuggestions(result.suggestions);
      setSuggestionTotalReclaimableBytes(result.totalReclaimableBytes);
      setSelectedSuggestionIds(
        result.suggestions
          .filter((suggestion) => suggestion.safetyLevel === "safe")
          .map((suggestion) => suggestion.id),
      );
      setSuggestionsStatus("idle");
      updateStatus(
        `Built ${result.suggestions.length} suggestions (${formatBytes(result.totalReclaimableBytes)} reclaimable).`,
      );
    } catch (error) {
      const message = String(error);
      setSuggestionsStatus("error");
      setSuggestionsError(message);
      updateStatus(`Suggestion build failed: ${message}`);
    }
  }, [
    currentFolder,
    includeSubfolders,
    includeHidden,
    updateStatus,
    clearSuggestionDryRunPreview,
    suggestionStaleDays,
    suggestionMaxResults,
    suggestionMinLargeFileBytes,
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
    setSuggestionDryRunStatus("loading");
    setSuggestionDryRunError(null);
    try {
      const plan = await invokeCommand<ActionBatchResult>(
        "apply_action_batch",
        {
          request: {
            actions,
            dryRun: true,
            allowUnsafe: false,
            allowPermanentDelete: false,
          },
        },
      );
      setSuggestionDryRunResult(plan);
      setSuggestionDryRunSelectionKey(selectedSuggestionPlanKey);
      setSuggestionDryRunStatus("idle");
      updateStatus(
        `Preview ready: ${plan.applied} planned, ${plan.blocked} blocked, ${plan.failed} failed.`,
      );
      return plan;
    } catch (error) {
      const message = String(error);
      setSuggestionDryRunStatus("error");
      setSuggestionDryRunError(message);
      setSuggestionDryRunResult(null);
      setSuggestionDryRunSelectionKey(null);
      updateStatus(`Suggestion preview failed: ${message}`);
      return null;
    }
  }, [
    currentFolder,
    updateStatus,
    selectedSuggestions,
    buildSuggestionActions,
    selectedSuggestionPlanKey,
    clearSuggestionDryRunPreview,
  ]);

  const applySelectedSuggestions = useCallback(async () => {
    if (!currentFolder) {
      updateStatus("No folder selected.");
      return;
    }
    if (!isDesktopRuntime()) {
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
      { title: "Confirm cleanup suggestions" },
    );
    if (!shouldApply) {
      updateStatus("Suggestion apply canceled.");
      return;
    }
    await runMutationWithSpinner("Applying cleanup…", async () => {
      try {
        const applied = await invokeCommand<ActionBatchResult>(
          "apply_action_batch",
          {
            request: {
              actions,
              dryRun: false,
              allowUnsafe: false,
              allowPermanentDelete: false,
            },
          },
        );
        const appliedIds = new Set(
          applied.results
            .filter((result) => result.status === "applied")
            .map((result) => result.id),
        );
        if (appliedIds.size > 0) {
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
                selectedSuggestions
                  .filter((suggestion) => appliedIds.has(suggestion.id))
                  .reduce(
                    (total, suggestion) => total + suggestion.reclaimableBytes,
                    0,
                  ),
            ),
          );
        }
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
    suggestionDryRunResult,
    suggestionDryRunSelectionKey,
    selectedSuggestionPlanKey,
    suggestionDryRunStatus,
    previewSelectedSuggestions,
    clearSuggestionDryRunPreview,
  ]);

  useEffect(() => {
    if (hasAutoLoadedFolderRef.current) {
      return;
    }
    if (!initialFolder) {
      return;
    }
    hasAutoLoadedFolderRef.current = true;
    void handleScan(initialFolder);
  }, [handleScan, initialFolder]);

  const updateDestinationSlot = useCallback(
    (slotIndex: number, destination: string) => {
      setDestinationSlots((prev) => {
        const next = [...prev];
        next[slotIndex] = destination;
        return next;
      });
    },
    [],
  );

  const pickDestinationForSlot = useCallback(
    async (slotIndex: number) => {
      try {
        const selected = await openDialog({ directory: true, multiple: false });
        if (typeof selected === "string") {
          updateDestinationSlot(slotIndex, selected);
          updateStatus(`Destination ${slotIndex + 1} set to ${selected}.`);
          return selected;
        }
        updateStatus("No destination selected.");
      } catch (error) {
        updateStatus(`Destination picker failed: ${String(error)}`);
      }
      return null;
    },
    [updateDestinationSlot, updateStatus],
  );

  const removeFileById = useCallback(
    (removedId: string) => {
      setFiles((prev) => {
        const filterByExtension = (file: FileEntry) =>
          selectedExtensionsSet.has(getExtension(file.name));
        const sortedPrev = sortFiles(prev.filter(filterByExtension));
        const next = prev.filter((file) => file.id !== removedId);
        const sortedNext = sortFiles(next.filter(filterByExtension));
        const nextVisibleIds = new Set(sortedNext.map((file) => file.id));
        const sortedNextIndexById = new Map(
          sortedNext.map((file, index) => [file.id, index] as const),
        );
        const visibleOrder = visibleFileOrderRef.current;
        const removedIndexInVisible = visibleOrder.indexOf(removedId);

        setCurrentIndex((current) => {
          if (sortedPrev.length === 0) {
            currentFileIdRef.current = null;
            return 0;
          }

          if (removedIndexInVisible !== -1) {
            let nextVisibleId: string | null = null;
            for (
              let i = removedIndexInVisible + 1;
              i < visibleOrder.length;
              i++
            ) {
              const candidateId = visibleOrder[i];
              if (nextVisibleIds.has(candidateId)) {
                nextVisibleId = candidateId;
                break;
              }
            }

            if (!nextVisibleId) {
              for (let i = removedIndexInVisible - 1; i >= 0; i--) {
                const candidateId = visibleOrder[i];
                if (nextVisibleIds.has(candidateId)) {
                  nextVisibleId = candidateId;
                  break;
                }
              }
            }

            if (nextVisibleId) {
              const nextIndex = sortedNextIndexById.get(nextVisibleId);
              if (nextIndex !== undefined) {
                currentFileIdRef.current = nextVisibleId;
                return nextIndex;
              }
            }
          }

          const boundedCurrent = Math.min(current, sortedPrev.length - 1);
          const fallbackIndex =
            sortedNext.length === 0
              ? 0
              : Math.min(boundedCurrent, sortedNext.length - 1);
          currentFileIdRef.current = sortedNext[fallbackIndex]?.id ?? null;
          return fallbackIndex;
        });
        return next;
      });
    },
    [selectedExtensionsSet, sortFiles],
  );

  const removeFilesByIds = useCallback(
    (removedIds: string[]) => {
      const removedSet = new Set(removedIds);
      if (removedSet.size === 0) {
        return;
      }
      setFiles((prev) => {
        const filterByExtension = (file: FileEntry) =>
          selectedExtensionsSet.has(getExtension(file.name));
        const sortedPrev = sortFiles(prev.filter(filterByExtension));
        const next = prev.filter((file) => !removedSet.has(file.id));
        const sortedNext = sortFiles(next.filter(filterByExtension));
        const nextVisibleIds = new Set(sortedNext.map((file) => file.id));
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

        setCurrentIndex((current) => {
          if (sortedPrev.length === 0) {
            currentFileIdRef.current = null;
            return 0;
          }

          if (firstRemovedIndex !== -1) {
            let nextVisibleId: string | null = null;
            for (let i = firstRemovedIndex + 1; i < visibleOrder.length; i++) {
              const candidateId = visibleOrder[i];
              if (nextVisibleIds.has(candidateId)) {
                nextVisibleId = candidateId;
                break;
              }
            }

            if (!nextVisibleId) {
              for (let i = firstRemovedIndex - 1; i >= 0; i--) {
                const candidateId = visibleOrder[i];
                if (nextVisibleIds.has(candidateId)) {
                  nextVisibleId = candidateId;
                  break;
                }
              }
            }

            if (nextVisibleId) {
              const nextIndex = sortedNextIndexById.get(nextVisibleId);
              if (nextIndex !== undefined) {
                currentFileIdRef.current = nextVisibleId;
                return nextIndex;
              }
            }
          }

          const boundedCurrent = Math.min(current, sortedPrev.length - 1);
          const fallbackIndex =
            sortedNext.length === 0
              ? 0
              : Math.min(boundedCurrent, sortedNext.length - 1);
          currentFileIdRef.current = sortedNext[fallbackIndex]?.id ?? null;
          return fallbackIndex;
        });
        return next;
      });
    },
    [selectedExtensionsSet, sortFiles],
  );

  const restoreFileEntry = useCallback(
    (restored: FileEntry) => {
      setFiles((prev) => {
        if (prev.some((file) => file.id === restored.id)) {
          return prev;
        }
        const next = [...prev, restored];
        const filterByExtension = (file: FileEntry) =>
          selectedExtensionsSet.has(getExtension(file.name));
        const sortedNext = sortFiles(next.filter(filterByExtension));
        const restoredIndex = sortedNext.findIndex(
          (file) => file.id === restored.id,
        );
        if (restoredIndex !== -1) {
          currentFileIdRef.current = restored.id;
          setCurrentIndex(restoredIndex);
        }
        return next;
      });
    },
    [selectedExtensionsSet, sortFiles],
  );

  const pushUndo = useCallback((action: UndoAction) => {
    setUndoStack((prev) => {
      const next = [action, ...prev];
      return next.length > MAX_UNDO_STACK
        ? next.slice(0, MAX_UNDO_STACK)
        : next;
    });
  }, []);

  const trashCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const shouldConfirmTrash = confirmTrash || trashBehavior === "permanent";
    const confirmMessage =
      trashBehavior === "permanent"
        ? `Permanently delete ${currentFile.name}? This cannot be undone.`
        : `Move ${currentFile.name} to system trash?`;
    const confirmTitle =
      trashBehavior === "permanent" ? "Confirm delete" : "Confirm trash";
    const shouldTrash = shouldConfirmTrash
      ? await confirmDialog(confirmMessage, { title: confirmTitle })
      : true;
    if (!shouldTrash) {
      return;
    }
    await runMutationWithSpinner(
      trashBehavior === "permanent" ? "Deleting…" : "Trashing…",
      async () => {
        try {
          const result = await invokeCommand<TrashResult>("trash_file", {
            id: currentFile.id,
            trashMode: trashBehavior,
          });
          removeFileById(currentFile.id);
          if (result.trashPath) {
            pushUndo({
              kind: "trash",
              file: currentFile,
              fromPath: currentFile.path,
              trashPath: result.trashPath,
            });
          }
          const baseMessage =
            trashBehavior === "permanent"
              ? `Deleted ${currentFile.name}.`
              : `Moved ${currentFile.name} to system trash.`;
          updateStatus(
            result.trashPath ? baseMessage : `${baseMessage} Undo unavailable.`,
          );
        } catch (error) {
          updateStatus(`Trash failed: ${String(error)}`);
        }
      },
    );
  }, [
    confirmTrash,
    currentFile,
    removeFileById,
    updateStatus,
    pushUndo,
    trashBehavior,
    runMutationWithSpinner,
  ]);

  const permanentlyDeleteCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const confirmMessage = `Permanently delete ${currentFile.name}? This cannot be undone.`;
    const shouldDelete = confirmTrash
      ? await confirmDialog(confirmMessage, {
          title: "Confirm permanent delete",
        })
      : true;
    if (!shouldDelete) {
      return;
    }
    await runMutationWithSpinner("Deleting…", async () => {
      try {
        await invokeCommand<TrashResult>("trash_file", {
          id: currentFile.id,
          trashMode: "permanent",
        });
        removeFileById(currentFile.id);
        // Permanent delete doesn't create a trash path, so no undo
        updateStatus(`Permanently deleted ${currentFile.name}.`);
      } catch (error) {
        updateStatus(`Delete failed: ${String(error)}`);
      }
    });
  }, [
    confirmTrash,
    currentFile,
    removeFileById,
    updateStatus,
    runMutationWithSpinner,
  ]);

  const getFolderFiles = useCallback(
    (folderPath: string) => {
      const folderSegments = splitPathSegments(folderPath);
      if (folderSegments.length === 0) {
        return [];
      }
      return files.filter((file) => {
        const relativeSegments = getRelativeSegments(file.path, currentFolder);
        if (relativeSegments.length < folderSegments.length) {
          return false;
        }
        return folderSegments.every(
          (segment, index) => relativeSegments[index] === segment,
        );
      });
    },
    [files, currentFolder],
  );

  const trashFolder = useCallback(
    async (folderPath: string) => {
      if (!currentFolder) {
        updateStatus("No folder selected.");
        return;
      }
      const folderFiles = getFolderFiles(folderPath);
      if (folderFiles.length === 0) {
        updateStatus("Folder is empty.");
        return;
      }
      const folderSegments = splitPathSegments(folderPath);
      const folderLabel =
        folderSegments[folderSegments.length - 1] ?? folderPath;
      const shouldConfirmTrash = confirmTrash || trashBehavior === "permanent";
      const confirmMessage =
        trashBehavior === "permanent"
          ? `Permanently delete ${folderLabel} and all its contents (${folderFiles.length} item${
              folderFiles.length === 1 ? "" : "s"
            })? This cannot be undone.`
          : `Move ${folderLabel} and all its contents (${folderFiles.length} item${
              folderFiles.length === 1 ? "" : "s"
            }) to system trash?`;
      const confirmTitle =
        trashBehavior === "permanent"
          ? "Confirm delete"
          : "Confirm folder trash";
      const shouldTrash = shouldConfirmTrash
        ? await confirmDialog(confirmMessage, { title: confirmTitle })
        : true;
      if (!shouldTrash) {
        return;
      }
      const base = currentFolder.replace(/[\\/]+$/, "");
      const fullFolderPath = `${base}/${folderPath}`;
      const items: FolderTrashItem[] = folderFiles.map((file) => ({
        file,
        relativePath: getRelativeSegments(file.path, fullFolderPath).join("/"),
      }));
      const entries: FolderTrashEntry[] = items.map((item) => ({
        id: item.file.id,
        relativePath: item.relativePath,
      }));
      await runMutationWithSpinner(
        trashBehavior === "permanent" ? "Deleting…" : "Trashing…",
        async () => {
          try {
            const result = await invokeCommand<TrashResult>("trash_folder", {
              folderPath: fullFolderPath,
              files: entries,
              trashMode: trashBehavior,
            });
            removeFilesByIds(folderFiles.map((file) => file.id));
            if (result.trashPath) {
              pushUndo({
                kind: "trash-folder",
                folderPath: fullFolderPath,
                trashPath: result.trashPath,
                items,
              });
            }
            const baseMessage =
              trashBehavior === "permanent"
                ? `Deleted ${folderLabel}.`
                : `Moved ${folderLabel} to system trash.`;
            updateStatus(
              result.trashPath
                ? baseMessage
                : `${baseMessage} Undo unavailable.`,
            );
          } catch (error) {
            updateStatus(`Trash folder failed: ${String(error)}`);
          }
        },
      );
    },
    [
      confirmTrash,
      currentFolder,
      getFolderFiles,
      updateStatus,
      removeFilesByIds,
      pushUndo,
      trashBehavior,
      runMutationWithSpinner,
    ],
  );

  const moveCurrentToSlot = useCallback(
    async (slotIndex: number, allowPickIfMissing = false) => {
      if (!currentFile) {
        updateStatus("No file selected.");
        return;
      }
      let destinationPath = destinationSlots[slotIndex] ?? null;
      if (!destinationPath) {
        if (allowPickIfMissing) {
          destinationPath = await pickDestinationForSlot(slotIndex);
        } else {
          updateStatus(`Destination ${slotIndex + 1} not set.`);
          return;
        }
      }
      if (!destinationPath) {
        return;
      }
      await runMutationWithSpinner("Moving…", async () => {
        try {
          await invokeCommand("set_destination", {
            destination: destinationPath,
          });
          const result = await invokeCommand<MoveResult>("move_file", {
            id: currentFile.id,
          });
          removeFileById(currentFile.id);
          pushUndo({
            kind: "move",
            file: currentFile,
            fromPath: currentFile.path,
            toPath: result.targetPath,
          });
          updateStatus(`Moved to ${result.targetPath}.`);
        } catch (error) {
          updateStatus(`Move failed: ${String(error)}`);
        }
      });
    },
    [
      currentFile,
      destinationSlots,
      pickDestinationForSlot,
      removeFileById,
      updateStatus,
      pushUndo,
      runMutationWithSpinner,
    ],
  );

  const openFileInFinder = useCallback(
    async (file: FileEntry) => {
      try {
        await revealInFileManager({
          path: file.path,
          reveal: true,
        });
      } catch (error) {
        updateStatus(`Reveal in file manager failed: ${String(error)}`);
      }
    },
    [updateStatus],
  );

  const openFileInSystem = useCallback(
    async (file: FileEntry) => {
      try {
        await revealInFileManager({
          path: file.path,
          reveal: false,
        });
      } catch (error) {
        updateStatus(`Open file failed: ${String(error)}`);
      }
    },
    [updateStatus],
  );

  const openCurrentInFinder = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    await openFileInFinder(currentFile);
  }, [currentFile, openFileInFinder, updateStatus]);

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

  const undoLastAction = useCallback(async () => {
    const lastAction = undoStack[0];
    if (!lastAction) {
      updateStatus("Nothing to undo.");
      return;
    }
    if (lastAction.kind === "trash-folder") {
      await runMutationWithSpinner("Restoring…", async () => {
        try {
          await invokeCommand("restore_folder", {
            source: lastAction.trashPath,
            destination: lastAction.folderPath,
            files: lastAction.items.map((item) => ({
              id: item.file.id,
              relativePath: item.relativePath,
            })),
          });
          lastAction.items.forEach((item) => restoreFileEntry(item.file));
          setUndoStack((prev) => prev.slice(1));
          updateStatus(`Restored ${lastAction.items.length} items.`);
        } catch (error) {
          updateStatus(`Undo failed: ${String(error)}`);
        }
      });
      return;
    }
    const sourcePath =
      lastAction.kind === "move" ? lastAction.toPath : lastAction.trashPath;
    await runMutationWithSpinner("Restoring…", async () => {
      try {
        await invokeCommand("restore_file", {
          id: lastAction.file.id,
          source: sourcePath,
          destination: lastAction.fromPath,
        });
        restoreFileEntry(lastAction.file);
        setUndoStack((prev) => prev.slice(1));
        updateStatus(`Undid ${lastAction.kind}.`);
      } catch (error) {
        updateStatus(`Undo failed: ${String(error)}`);
      }
    });
  }, [undoStack, restoreFileEntry, updateStatus, runMutationWithSpinner]);

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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isHelpOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsHelpOpen(false);
        }
        return;
      }
      if (isSuggestionsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsSuggestionsOpen(false);
        }
        return;
      }
      if (isSettingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsSettingsOpen(false);
        }
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      if (isMutating || blockingOverlay) {
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        (currentFile?.kind === "video" || currentFile?.kind === "audio")
      ) {
        event.preventDefault();
        seekMediaBy(event.key === "ArrowLeft" ? -10 : 10);
        return;
      }
      if (
        (event.code === "Space" || event.key === " ") &&
        currentFile?.kind === "video"
      ) {
        event.preventDefault();
        toggleVideoPlayback();
        return;
      }
      if (event.key >= "1" && event.key <= "5") {
        event.preventDefault();
        void moveCurrentToSlot(Number(event.key) - 1);
        return;
      }
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
          event.preventDefault();
          goNext();
          break;
        case "ArrowUp":
          event.preventDefault();
          if (event.shiftKey) {
            void permanentlyDeleteCurrent();
          } else {
            void trashCurrent();
          }
          break;
        case "ArrowDown":
          event.preventDefault();
          void undoLastAction();
          break;
        case "Enter":
          if (!shouldOpenOnEnter(event.target)) {
            return;
          }
          event.preventDefault();
          void openCurrentInFinder();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    currentFile,
    goNext,
    goPrev,
    blockingOverlay,
    isHelpOpen,
    isMutating,
    isSuggestionsOpen,
    isSettingsOpen,
    moveCurrentToSlot,
    openCurrentInFinder,
    permanentlyDeleteCurrent,
    seekMediaBy,
    toggleVideoPlayback,
    trashCurrent,
    undoLastAction,
  ]);

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

  useEffect(() => {
    setRenderCount(sortedFiles.length);
  }, [sortedFiles.length]);

  const visibleFiles = useMemo(() => {
    // Render all current rows and rely on native browser scrolling.
    return sortedFiles.slice(0, renderCount);
  }, [sortedFiles, renderCount]);

  const folderKeys = useMemo(() => {
    const keys = new Set<string>();
    const addKey = (groupId: string | null, path: string) => {
      if (!path) {
        return;
      }
      keys.add(getFolderCollapseKey(groupId, path));
    };
    sortedFiles.forEach((file) => {
      const segments = getRelativeSegments(file.path, currentFolder);
      const folderSegments = segments.length > 1 ? segments.slice(0, -1) : [];
      if (folderSegments.length === 0) {
        return;
      }
      const groupId = getGroupIdForFile(effectiveGroupMode, file);
      let currentPath = "";
      folderSegments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        addKey(groupId, currentPath);
      });
    });
    return Array.from(keys);
  }, [sortedFiles, effectiveGroupMode, currentFolder]);

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

  const listRender = useMemo(() => {
    const showDuplicateLocation = shouldGroupDuplicates && viewMode === "list";
    const renderButton = (file: FileEntry, index: number, depth?: number) => (
      <button
        key={file.id}
        className={`file-item ${depth !== undefined ? "tree-item" : ""}`}
        onClick={() => {
          currentFileIdRef.current = file.id;
          setCurrentIndex(index);
        }}
        onDoubleClick={() => void openFileInFinder(file)}
        ref={(node) => listItemRefs.current.set(file.id, node)}
        type="button"
        disabled={isLoading || isMutating}
        style={
          depth !== undefined
            ? ({
                "--tree-indent": `${depth * TREE_INDENT_PX}px`,
              } as React.CSSProperties)
            : undefined
        }
      >
        <span className={`badge badge-${file.kind}`}>{file.kind}</span>
        <span className="file-content">
          <span className="filename">{file.name}</span>
          {showDuplicateLocation && (
            <span className="file-location">
              {formatRelativeFolder(file.path, currentFolder)}
            </span>
          )}
        </span>
      </button>
    );

    const indexMap = new Map<string, number>();
    visibleFiles.forEach((file, index) => {
      indexMap.set(file.id, index);
    });

    const isDuplicateGrouping = effectiveGroupMode === "duplicates";

    if (viewMode === "list") {
      if (effectiveGroupMode === "none") {
        return {
          items: visibleFiles.map((file, index) => renderButton(file, index)),
        };
      }

      const { groups, keys } = groupFilesByMode(
        effectiveGroupMode,
        visibleFiles,
      );

      const items: JSX.Element[] = [];
      keys.forEach((key) => {
        const groupFiles = groups.get(key);
        if (!groupFiles || groupFiles.length === 0) {
          return;
        }
        const groupId = `${effectiveGroupMode}:${key}`;
        const isGroupCollapsed = Boolean(collapsedGroups[groupId]);
        const groupTitle = formatGroupTitle(
          effectiveGroupMode,
          key,
          groupFiles,
        );
        const groupMeta = isDuplicateGrouping
          ? formatDuplicateGroupMeta(groupFiles)
          : null;
        const countLabel = isDuplicateGrouping
          ? `${groupFiles.length} copies`
          : `${groupFiles.length}`;
        items.push(
          <div
            key={`${effectiveGroupMode}-${key}`}
            className={`list-section${isDuplicateGrouping ? " list-section-duplicates" : ""}`}
          >
            <button
              type="button"
              className="list-section-toggle"
              onClick={() => toggleGroupCollapse(groupId)}
              aria-expanded={!isGroupCollapsed}
              aria-label={
                isGroupCollapsed
                  ? `Expand ${groupTitle}`
                  : `Collapse ${groupTitle}`
              }
              disabled={isLoading}
              data-prevent-open-on-enter
            >
              <span className="list-section-caret" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  {isGroupCollapsed ? (
                    <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                  ) : (
                    <path d="M6 9l6 6 6-6H6Z" />
                  )}
                </svg>
              </span>
              <span className="list-section-text">
                <span className="list-section-title">{groupTitle}</span>
                {groupMeta && (
                  <span className="list-section-meta">{groupMeta}</span>
                )}
              </span>
              <span className="list-section-count">{countLabel}</span>
            </button>
            {!isGroupCollapsed && (
              <div className="list-section-items">
                {groupFiles.map((file) =>
                  renderButton(file, indexMap.get(file.id) ?? 0),
                )}
              </div>
            )}
          </div>,
        );
      });
      return { items };
    }

    const renderTreeNodes = (
      nodes: TreeNode[],
      depth: number,
      groupId: string | null,
    ) => {
      const sortedNodes = sortTreeNodesByIndex(nodes, indexMap);
      return sortedNodes.map((node) => {
        if (node.type === "file") {
          const index = indexMap.get(node.file.id) ?? 0;
          return renderButton(node.file, index, depth);
        }
        const folderKey = getFolderCollapseKey(groupId, node.path);
        const isCollapsed = Boolean(collapsedFolders[folderKey]);
        return (
          <div key={`folder-${folderKey}`} className="tree-node">
            <div
              className="folder-item tree-item"
              style={
                {
                  "--tree-indent": `${depth * TREE_INDENT_PX}px`,
                } as React.CSSProperties
              }
            >
              <button
                type="button"
                className="folder-item-toggle"
                onClick={() => toggleFolderCollapse(folderKey)}
                aria-expanded={!isCollapsed}
                aria-label={
                  isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`
                }
                disabled={isLoading}
                data-prevent-open-on-enter
              >
                <span className="folder-caret" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    {isCollapsed ? (
                      <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                    ) : (
                      <path d="M6 9l6 6 6-6H6Z" />
                    )}
                  </svg>
                </span>
                <span className="folder-name">{node.name}</span>
                <span className="folder-count">{node.fileCount}</span>
              </button>
              <button
                type="button"
                className="folder-trash-button"
                onClick={(event) => {
                  event.stopPropagation();
                  void trashFolder(node.path);
                }}
                aria-label={`Trash ${node.name}`}
                title={`Trash ${node.name}`}
                disabled={isLoading || isMutating}
                data-prevent-open-on-enter
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M9 4h6l1 2h4v2H4V6h4l1-2Zm1 6h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 10h2v8H7v-8Z" />
                </svg>
              </button>
            </div>
            {!isCollapsed && (
              <div className="tree-children">
                {renderTreeNodes(node.children, depth + 1, groupId)}
              </div>
            )}
          </div>
        );
      });
    };

    const renderTreeForFiles = (
      entries: FileEntry[],
      groupId: string | null,
    ) => {
      const tree = buildFileTree(entries, currentFolder);
      return renderTreeNodes(tree.children, 0, groupId);
    };

    if (effectiveGroupMode === "none") {
      return { items: renderTreeForFiles(visibleFiles, null) };
    }

    const { groups, keys } = groupFilesByMode(effectiveGroupMode, visibleFiles);
    const items: JSX.Element[] = [];
    keys.forEach((key) => {
      const groupFiles = groups.get(key);
      if (!groupFiles || groupFiles.length === 0) {
        return;
      }
      const groupId = `${effectiveGroupMode}:${key}`;
      const isGroupCollapsed = Boolean(collapsedGroups[groupId]);
      const groupTitle = formatGroupTitle(effectiveGroupMode, key, groupFiles);
      const groupMeta = isDuplicateGrouping
        ? formatDuplicateGroupMeta(groupFiles)
        : null;
      const countLabel = isDuplicateGrouping
        ? `${groupFiles.length} copies`
        : `${groupFiles.length}`;
      items.push(
        <div
          key={`${effectiveGroupMode}-${key}`}
          className={`list-section${isDuplicateGrouping ? " list-section-duplicates" : ""}`}
        >
          <button
            type="button"
            className="list-section-toggle"
            onClick={() => toggleGroupCollapse(groupId)}
            aria-expanded={!isGroupCollapsed}
            aria-label={
              isGroupCollapsed
                ? `Expand ${groupTitle}`
                : `Collapse ${groupTitle}`
            }
            disabled={isLoading}
            data-prevent-open-on-enter
          >
            <span className="list-section-caret" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                {isGroupCollapsed ? (
                  <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                ) : (
                  <path d="M6 9l6 6 6-6H6Z" />
                )}
              </svg>
            </span>
            <span className="list-section-text">
              <span className="list-section-title">{groupTitle}</span>
              {groupMeta && (
                <span className="list-section-meta">{groupMeta}</span>
              )}
            </span>
            <span className="list-section-count">{countLabel}</span>
          </button>
          {!isGroupCollapsed && (
            <div className="list-section-items">
              {renderTreeForFiles(groupFiles, groupId)}
            </div>
          )}
        </div>,
      );
    });
    return { items };
  }, [
    visibleFiles,
    isLoading,
    isMutating,
    effectiveGroupMode,
    shouldGroupDuplicates,
    openFileInFinder,
    currentFolder,
    viewMode,
    collapsedGroups,
    collapsedFolders,
    toggleGroupCollapse,
    toggleFolderCollapse,
    trashFolder,
  ]);

  const listItems = listRender.items;

  const visibleFileOrder = useMemo(() => {
    const order: string[] = [];
    if (viewMode === "list") {
      if (effectiveGroupMode === "none") {
        return sortedFiles.map((file) => file.id);
      }
      const { groups, keys } = groupFilesByMode(
        effectiveGroupMode,
        sortedFiles,
      );
      keys.forEach((key) => {
        const groupFiles = groups.get(key);
        if (!groupFiles || groupFiles.length === 0) {
          return;
        }
        groupFiles.forEach((file) => order.push(file.id));
      });
      return order;
    }

    const indexMap = new Map<string, number>();
    sortedFiles.forEach((file, index) => {
      indexMap.set(file.id, index);
    });

    const collectTreeNodes = (nodes: TreeNode[], groupId: string | null) => {
      const sortedNodes = sortTreeNodesByIndex(nodes, indexMap);
      sortedNodes.forEach((node) => {
        if (node.type === "file") {
          order.push(node.file.id);
          return;
        }
        collectTreeNodes(node.children, groupId);
      });
    };

    const collectTreeForFiles = (
      entries: FileEntry[],
      groupId: string | null,
    ) => {
      const tree = buildFileTree(entries, currentFolder);
      collectTreeNodes(tree.children, groupId);
    };

    if (effectiveGroupMode === "none") {
      collectTreeForFiles(sortedFiles, null);
      return order;
    }

    const { groups, keys } = groupFilesByMode(effectiveGroupMode, sortedFiles);

    keys.forEach((key) => {
      const groupFiles = groups.get(key);
      if (!groupFiles || groupFiles.length === 0) {
        return;
      }
      const groupId = `${effectiveGroupMode}:${key}`;
      collectTreeForFiles(groupFiles, groupId);
    });

    return order;
  }, [sortedFiles, effectiveGroupMode, currentFolder, viewMode]);

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
    const previousId = previousActiveFileIdRef.current;
    if (previousId && previousId !== currentFile?.id) {
      const previousNode = listItemRefs.current.get(previousId);
      if (previousNode) {
        previousNode.classList.remove("active");
        previousNode.removeAttribute("aria-current");
      }
    }
    if (currentFile?.id) {
      const currentNode = listItemRefs.current.get(currentFile.id);
      if (currentNode) {
        currentNode.classList.add("active");
        currentNode.setAttribute("aria-current", "true");
      }
    }
    previousActiveFileIdRef.current = currentFile?.id ?? null;
  }, [
    currentFile?.id,
    renderCount,
    collapsedGroups,
    collapsedFolders,
    effectiveGroupMode,
    viewMode,
  ]);

  useEffect(() => {
    if (!currentFile) {
      return;
    }
    const node = listItemRefs.current.get(currentFile.id);
    if (!node) {
      return;
    }
    requestAnimationFrame(() => {
      node.scrollIntoView({
        block: "nearest",
        behavior: "auto",
      });
    });
  }, [
    currentFile,
    renderCount,
    collapsedGroups,
    collapsedFolders,
    viewMode,
    effectiveGroupMode,
  ]);

  const loadingMessage = useMemo(() => {
    if (!isLoading || !scanProgress) {
      return null;
    }
    if (scanProgress.phase === "indexing") {
      return scanProgress.total
        ? `Indexing ${scanProgress.scanned}/${scanProgress.total} files...`
        : `Indexing ${scanProgress.scanned} files...`;
    }
    if (!scanProgress.total) {
      return `Scanning ${scanProgress.scanned} files · ${scanProgress.matched} matched`;
    }
    const percent = scanProgress.total
      ? Math.min(
          100,
          Math.round((scanProgress.scanned / scanProgress.total) * 100),
        )
      : 0;
    return `Scanning ${percent}% · ${scanProgress.scanned}/${scanProgress.total} files · ${scanProgress.matched} matched`;
  }, [isLoading, scanProgress]);

  const activeBlockingOverlay = useMemo(() => {
    if (blockingOverlay) {
      return {
        title: blockingOverlay.title,
        subtitle: blockingOverlay.subtitle,
        showSpinner: true,
        showCancel: false,
        actions: [] as { label: string; onClick: () => void; disabled?: boolean }[],
      };
    }
    if (scanCachePrompt) {
      return {
        title: "Previous scan available",
        subtitle:
          "A cached scan matches this folder and these scan options. Load it now or run a fresh scan.",
        showSpinner: false,
        showCancel: false,
        actions: [
          {
            label: "Load previous scan",
            onClick: () => void loadCachedScan(scanCachePrompt.cachedScan),
          },
          {
            label: "Scan again",
            onClick: () => void runFreshScan(scanCachePrompt.request),
          },
        ],
      };
    }
    if (isLoading) {
      return {
        title: "Scanning files",
        subtitle: loadingMessage ?? "Collecting file list...",
        showSpinner: true,
        showCancel: true,
        actions: [] as { label: string; onClick: () => void; disabled?: boolean }[],
      };
    }
    return null;
  }, [blockingOverlay, isLoading, loadCachedScan, loadingMessage, runFreshScan, scanCachePrompt]);

  const isInteractionBlocked = Boolean(activeBlockingOverlay);
  const areControlsDisabled = isLoading || isInteractionBlocked;
  const isRenderingList = renderCount < sortedFiles.length;
  const totalFiles = files.length;
  const filteredCount = sortedFiles.length;

  useEffect(() => {
    syncScrollHints(fileListScrollRef.current, fileListFrameRef.current);
  }, [
    syncScrollHints,
    viewMode,
    effectiveGroupMode,
    listDensity,
    renderCount,
    filteredCount,
    collapsedGroups,
    collapsedFolders,
    isLoading,
    isExtensionsCollapsed,
  ]);

  useEffect(() => {
    syncScrollHints(previewScrollRef.current, previewFrameRef.current);
  }, [
    syncScrollHints,
    previewFile?.id,
    isLoading,
    archiveStatus,
    officePreviewStatus,
    archiveEntries.length,
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
    >
      <div className="titlebar-drag" data-tauri-drag-region />
      {isSidebarCollapsed && (
        <button
          type="button"
          className="icon-button sidebar-toggle floating-toggle"
          onClick={() => setIsSidebarCollapsed((prev) => !prev)}
          aria-label="Show sidebar"
          aria-controls="sidebar-panel"
          aria-pressed={isSidebarCollapsed}
          title="Show sidebar"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
            width="24"
            height="24"
          >
            <path d="M9 5.5 16 12 9 18.5V5.5Z" />
          </svg>
        </button>
      )}
      <span className="icon-button-tooltip-anchor" title="Work in progress">
        <button
          type="button"
          className="icon-button settings-button app-suggestions-button"
          disabled
          aria-label="AI suggestions (work in progress)"
          aria-haspopup="dialog"
          aria-expanded={false}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
            width="24"
            height="24"
          >
            <path d="M12 2.8 14.9 8.5 21.2 9.4l-4.6 4.4 1.1 6.3L12 17.1 6.3 20.1l1.1-6.3-4.6-4.4 6.3-.9L12 2.8Z" />
          </svg>
        </button>
      </span>
      <button
        type="button"
        className="icon-button settings-button app-settings-button"
        onClick={() => setIsSettingsOpen(true)}
        aria-label="Open settings"
        aria-haspopup="dialog"
        aria-expanded={isSettingsOpen}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          width="24"
          height="24"
        >
          <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.57.23-1.12.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.61 7.86a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.4 1.05.71 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.57-.23 1.12-.54 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
        </svg>
      </button>
      {isDrawerMode && !isSidebarCollapsed && (
        <div
          className="drawer-backdrop"
          aria-hidden="true"
          onClick={() => setIsSidebarCollapsed(true)}
        />
      )}
      <div className="app-grid">
        {!isSidebarCollapsed && (
          <aside className="list-panel" id="sidebar-panel">
            <div className="list-top-controls">
              <button
                type="button"
                className="icon-button sidebar-toggle"
                onClick={() => setIsSidebarCollapsed((prev) => !prev)}
                aria-label={
                  isSidebarCollapsed ? "Show sidebar" : "Hide sidebar"
                }
                aria-controls="sidebar-panel"
                aria-pressed={isSidebarCollapsed}
                title={isSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                  width="24"
                  height="24"
                >
                  {isSidebarCollapsed ? (
                    <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                  ) : (
                    <path d="M15 5.5 8 12l7 6.5V5.5Z" />
                  )}
                </svg>
              </button>
              <div
                className="searchbar-controls"
                role="group"
                aria-label="Folder search controls"
              >
                <button
                  type="button"
                  className="pill-button"
                  onClick={pickFolder}
                  disabled={areControlsDisabled}
                  title={currentFolder ?? "No folder selected"}
                >
                  <span className="pill-label">Folder</span>
                  <span className="pill-value">
                    {currentFolder ? folderLabel : "Select folder…"}
                  </span>
                </button>
                <div className="toolbar-control">
                  <select
                    value={filterMode}
                    onChange={(event) => {
                      const nextFilterMode = event.target.value as FilterMode;
                      runBlockingUiTransition(
                        "Updating filter",
                        () => setFilterMode(nextFilterMode),
                        "Refreshing the file selection...",
                      );
                    }}
                    disabled={areControlsDisabled}
                  >
                    {FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="icon-button search-button"
                  onClick={() => handleScan(currentFolder ?? undefined)}
                  disabled={areControlsDisabled || !currentFolder}
                  aria-label="Scan folder"
                  title="Scan folder"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M15.5 14h-.79l-.28-.27a6 6 0 1 0-.71.71l.27.28v.79L20 20.5 21.5 19l-6-5zM10 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="list-header">
              <div className="list-header-top">
                <div className="list-title">
                  <span>Files</span>
                  <span className="badge badge-text">{totalFiles}</span>
                </div>
                <div className="list-header-actions">
                  {viewMode === "tree" && (
                    <button
                      type="button"
                      className="list-expand-button"
                      onClick={toggleAllFolders}
                      disabled={!hasFolders || areControlsDisabled}
                      data-prevent-open-on-enter
                      title={
                        hasCollapsedFolders
                          ? "Unfold all folders"
                          : "Fold all folders"
                      }
                    >
                      {hasCollapsedFolders ? "Unfold all" : "Fold all"}
                    </button>
                  )}
                  {isRenderingList && (
                    <span className="rendering">Rendering list...</span>
                  )}
                </div>
              </div>
              <div className="list-header-controls">
                <div className="toolbar-control">
                  <span className="control-label">Sort</span>
                  <select
                    value={sortMode}
                    onChange={(event) => {
                      const nextSortMode = event.target.value as SortMode;
                      runBlockingUiTransition(
                        "Sorting files",
                        () => setSortMode(nextSortMode),
                        "Reordering the list...",
                      );
                    }}
                    disabled={areControlsDisabled}
                  >
                    <option value="none">None</option>
                    <option value="name_asc">Name (A-Z)</option>
                    <option value="name_desc">Name (Z-A)</option>
                    <option value="size_desc">Size (Largest)</option>
                    <option value="size_asc">Size (Smallest)</option>
                    <option value="date_desc">Date (Newest)</option>
                    <option value="date_asc">Date (Oldest)</option>
                    <option value="type_asc">Type (A-Z)</option>
                    <option value="type_desc">Type (Z-A)</option>
                    <option value="extension_asc">Extension (A-Z)</option>
                    <option value="extension_desc">Extension (Z-A)</option>
                  </select>
                </div>
                <div className="toolbar-control">
                  <span className="control-label">Group</span>
                  <select
                    value={displayGroupMode}
                    onChange={(event) => {
                      const nextGroupMode = event.target.value as GroupMode;
                      runBlockingUiTransition(
                        "Grouping files",
                        () => handleGroupModeChange(nextGroupMode),
                        "Rebuilding the file groups...",
                      );
                    }}
                    disabled={areControlsDisabled || shouldGroupDuplicates}
                  >
                    <option value="none">None</option>
                    <option value="type">Type</option>
                    <option value="extension">Extension</option>
                    {shouldGroupDuplicates && (
                      <option value="duplicates">Duplicates</option>
                    )}
                  </select>
                </div>
                <div className="toolbar-control view-control">
                  <span className="control-label">View</span>
                  <select
                    value={viewMode}
                    onChange={(event) => {
                      const nextViewMode = event.target.value as ViewMode;
                      runBlockingUiTransition(
                        "Changing view",
                        () => setViewMode(nextViewMode),
                        "Switching the file layout...",
                      );
                    }}
                    disabled={areControlsDisabled}
                  >
                    <option value="tree">Tree</option>
                    <option value="list">List</option>
                  </select>
                </div>
              </div>
            </div>
            <div
              className="file-list-frame scroll-hints"
              ref={fileListFrameRef}
            >
              <div
                ref={fileListScrollRef}
                className={`file-list ${isLoading ? "loading" : ""} ${
                  listDensity === "compact"
                    ? "density-compact"
                    : "density-comfortable"
                }`}
              >
                {hasFiles ? (
                  listItems
                ) : isLoading ? (
                  <div className="skeleton-list" aria-hidden="true">
                    {Array.from({ length: 8 }).map((_, index) => (
                      <div
                        key={`skeleton-${index}`}
                        className="skeleton-item"
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    {totalFiles === 0
                      ? "No files loaded."
                      : "No files match the selected extensions."}
                  </div>
                )}
                {isRenderingList && (
                  <div className="list-progress">
                    Showing {renderCount} of {filteredCount}
                  </div>
                )}
              </div>
            </div>
            <div className="list-footer">
              <div className="list-footer-header">
                <div className="footer-title">Extensions</div>
                <button
                  type="button"
                  className="icon-button extensions-toggle"
                  onClick={() => setIsExtensionsCollapsed((prev) => !prev)}
                  aria-label={
                    isExtensionsCollapsed
                      ? "Expand extensions"
                      : "Collapse extensions"
                  }
                  aria-pressed={isExtensionsCollapsed}
                  title={
                    isExtensionsCollapsed
                      ? "Expand extensions"
                      : "Collapse extensions"
                  }
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    {isExtensionsCollapsed ? (
                      <path d="M6 15l6-6 6 6H6Z" />
                    ) : (
                      <path d="M6 9l6 6 6-6H6Z" />
                    )}
                  </svg>
                </button>
              </div>
              {!isExtensionsCollapsed && (
                <>
                  {allExtensions.length === 0 ? (
                    <div className="extensions-empty">No extensions found.</div>
                  ) : (
                    <>
                      <div className="extensions-controls">
                        <label className="extension-filter extension-toggle">
                          <input
                            ref={selectAllRef}
                            type="checkbox"
                            checked={allExtensionsSelected}
                            onChange={(event) => {
                              const nextChecked = event.target.checked;
                              hasUserAdjustedExtensionsRef.current = true;
                              runBlockingUiTransition(
                                "Updating extensions",
                                () =>
                                  setSelectedExtensions(
                                    nextChecked ? allExtensions : [],
                                  ),
                                "Refreshing the visible files...",
                              );
                            }}
                            disabled={areControlsDisabled}
                          />
                          <span>All</span>
                        </label>
                      </div>
                      <div className="extension-filters">
                        {allExtensions.map((extension) => (
                          <label key={extension} className="extension-filter">
                            <input
                              type="checkbox"
                              checked={selectedExtensions.includes(extension)}
                              onChange={() => {
                                hasUserAdjustedExtensionsRef.current = true;
                                runBlockingUiTransition(
                                  "Updating extensions",
                                  () =>
                                    setSelectedExtensions((current) =>
                                      current.includes(extension)
                                        ? current.filter(
                                            (value) => value !== extension,
                                          )
                                        : [...current, extension],
                                    ),
                                  "Refreshing the visible files...",
                                );
                              }}
                              disabled={areControlsDisabled}
                            />
                            <span>{formatExtensionLabel(extension)}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </aside>
        )}

        <main className="content">
          <div className="preview-frame scroll-hints" ref={previewFrameRef}>
            <section className="preview-panel" ref={previewScrollRef}>
              {previewFile ? (
                <div className="preview-content">
                  <div className="preview-layout">
                    <div className="preview-media" onWheel={handlePreviewWheel}>
                      {isPreviewSuppressed && (
                        <div className="preview-suppressed">
                          <div className="preview-suppressed-title">
                            Preview paused
                          </div>
                          <div className="preview-suppressed-subtitle">
                            This file is {formatBytes(previewFile.sizeBytes)}.
                            Previews over{" "}
                            {formatBytes(LARGE_PREVIEW_SIZE_BYTES)} are
                            disabled.
                          </div>
                          <button
                            type="button"
                            className="preview-action-button"
                            onClick={enableLargePreview}
                          >
                            Load preview
                          </button>
                        </div>
                      )}
                      {isMediaPreview && (
                        <div
                          className={`preview-zoom${previewFile.kind === "image" ? " is-draggable" : ""}${
                            isPreviewPanning ? " is-panning" : ""
                          }`}
                          style={{
                            transform:
                              previewFile.kind === "image"
                                ? `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`
                                : `scale(${previewZoom})`,
                          }}
                          onPointerDown={handlePreviewPanStart}
                          onPointerMove={handlePreviewPanMove}
                          onPointerUp={handlePreviewPanEnd}
                          onPointerCancel={handlePreviewPanEnd}
                        >
                          {previewFile.kind === "image" && (
                            <img
                              src={buildMediaUrl(previewFile.id)}
                              alt={previewFile.name}
                              draggable={false}
                              onDragStart={(event) => event.preventDefault()}
                            />
                          )}
                          {previewFile.kind === "video" && (
                            <video
                              ref={videoRef}
                              controls
                              autoPlay={autoPlayMedia}
                              src={buildMediaUrl(previewFile.id)}
                            />
                          )}
                        </div>
                      )}
                      {isAudioPreview && (
                        <audio
                          ref={audioRef}
                          controls
                          autoPlay={autoPlayMedia}
                          src={buildMediaUrl(previewFile.id)}
                        />
                      )}
                      {isDocumentPreview && (
                        <div className="preview-document">
                          <iframe
                            title={`Preview of ${previewFile.name}`}
                            src={buildMediaUrl(previewFile.id)}
                          />
                        </div>
                      )}
                      {isOfficePreview && (
                        <div className="preview-office">
                          <div className="preview-office-preview">
                            {officePreviewStatus === "loading" && (
                              <div className="preview-office-status">
                                Generating preview...
                              </div>
                            )}
                            {officePreviewStatus === "error" && (
                              <div className="preview-office-status">
                                Preview unavailable.
                                {previewCapabilities &&
                                  !previewCapabilities.officeRichPreview && (
                                    <>
                                      {" "}
                                      Rich Office rendering is not available on
                                      this platform.
                                    </>
                                  )}
                              </div>
                            )}
                            {officePreviewStatus === "idle" &&
                              officePreviewId && (
                                <img
                                  src={buildMediaUrl(officePreviewId)}
                                  alt={`Preview of ${previewFile.name}`}
                                />
                              )}
                            {officePreviewStatus === "idle" &&
                              !officePreviewId &&
                              officeFallbackPreview && (
                                <div className="preview-office-fallback">
                                  <div className="preview-office-fallback-title">
                                    {officeFallbackPreview.title}
                                  </div>
                                  <pre className="preview-office-fallback-text">
                                    {officeFallbackPreview.excerpt}
                                  </pre>
                                </div>
                              )}
                          </div>
                        </div>
                      )}
                      {isArchivePreview && (
                        <div className="preview-archive">
                          <div className="preview-archive-header">
                            <div className="preview-archive-title">
                              Archive contents
                            </div>
                            {archiveStatus === "loading" && (
                              <div className="preview-archive-status">
                                Loading...
                              </div>
                            )}
                          </div>
                          {archiveStatus === "error" && (
                            <div className="preview-archive-status">
                              {archiveError ??
                                "Preview unavailable for this archive."}
                            </div>
                          )}
                          {archiveStatus === "idle" && (
                            <>
                              {archiveEntries.length > 0 ? (
                                <ul className="preview-archive-list">
                                  {archiveEntries.map((entry, index) => (
                                    <li
                                      key={`${entry}-${index}`}
                                      className="preview-archive-item"
                                    >
                                      {entry}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="preview-archive-empty">
                                  No entries found.
                                </div>
                              )}
                              {archiveTruncated && (
                                <div className="preview-archive-note">
                                  Showing first {archiveEntries.length} items.
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {isFallbackPreview && (
                        <div className="preview-fallback">
                          <div className="preview-fallback-icon">
                            {previewExtension === "none"
                              ? "FILE"
                              : previewExtension.toUpperCase()}
                          </div>
                          <div className="preview-fallback-label">
                            {formatKindLabel(previewFile.kind)}
                          </div>
                          <div className="preview-fallback-hint">
                            No rich preview available.
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="preview-actions">
                      <button
                        type="button"
                        className="preview-action-button"
                        onClick={() => void openFileInSystem(previewFile)}
                      >
                        Open file
                      </button>
                      <div className="preview-zoom-controls">
                        <button
                          type="button"
                          className="icon-button"
                          onClick={handleZoomOut}
                          disabled={!isZoomablePreview}
                          aria-label="Zoom out"
                          title="Zoom out"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path d="M5 11h14v2H5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="icon-button preview-zoom-reset"
                          onClick={handleZoomReset}
                          disabled={!isZoomablePreview}
                          aria-label="Reset zoom"
                          title="Reset zoom"
                        >
                          <span className="preview-zoom-value">
                            {Math.round(previewZoom * 100)}%
                          </span>
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={handleZoomIn}
                          disabled={!isZoomablePreview}
                          aria-label="Zoom in"
                          title="Zoom in"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className="caption" aria-hidden="true" />
                    <aside
                      className="preview-details"
                      aria-label="File details"
                    >
                      <div className="file-meta">
                        <div>
                          <span className="meta-label">Name</span>
                          <span className="meta-value">{previewFile.name}</span>
                        </div>
                        <div>
                          <span className="meta-label">Type</span>
                          <span className="meta-value">
                            {formatKindLabel(previewFile.kind)}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Extension</span>
                          <span className="meta-value">
                            {previewExtension === "none"
                              ? "None"
                              : `.${previewExtension}`}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">MIME</span>
                          <span className="meta-value">{previewFile.mime}</span>
                        </div>
                        <div>
                          <span className="meta-label">Size</span>
                          <span className="meta-value">
                            {formatBytes(previewFile.sizeBytes)}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Modified</span>
                          <span className="meta-value">
                            {formatTimestamp(previewFile.modifiedMs)}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Folder</span>
                          <span className="meta-value">
                            {extractFolder(previewFile.path)}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Folder size</span>
                          <span className="meta-value">
                            {formatBytes(folderSizeBytes)}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Full path</span>
                          <span className="meta-value mono">
                            {previewFile.path}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">Position</span>
                          <span className="meta-value">
                            {previewIndex + 1} of {filteredCount}
                          </span>
                        </div>
                        <div>
                          <span className="meta-label">ID</span>
                          <span className="meta-value mono">
                            {previewFile.id}
                          </span>
                        </div>
                      </div>
                    </aside>
                  </div>
                </div>
              ) : (
                <div className="preview-message">
                  <div className="placeholder">
                    Select a folder to preview files.
                  </div>
                </div>
              )}
            </section>
          </div>
        </main>

        <footer className="actions">
          <div className="actions-row">
            <div className="destination-row" aria-label="Move destinations">
              {destinationSlots.map((destinationPath, index) => (
              <button
                  key={`destination-${index}`}
                  type="button"
                  className={`destination-button ${destinationPath ? "is-set" : "is-empty"}`}
                  onClick={() => void pickDestinationForSlot(index)}
                  disabled={areControlsDisabled || isMutating}
                  title={destinationPath ?? `Set destination ${index + 1}`}
                  aria-label={`Set destination ${index + 1}`}
                >
                  <span className="destination-index">{index + 1}</span>
                  <span className="destination-label">
                    {destinationPath
                      ? formatPathLabel(destinationPath)
                      : "Set folder…"}
                  </span>
                </button>
              ))}
            </div>
            <div className="action-row">
              {mutationSpinnerLabel && (
                <div
                  className="action-progress"
                  role="status"
                  aria-live="polite"
                >
                  <div className="spinner" aria-hidden="true" />
                  <span className="action-progress-label">
                    {mutationSpinnerLabel}
                  </span>
                </div>
              )}
              <button
                className="action-button action-prev"
                type="button"
                onClick={goPrev}
                disabled={
                  !hasFiles ||
                  currentIndex === 0 ||
                  areControlsDisabled ||
                  isMutating
                }
              >
                Prev ←
              </button>
              <button
                className="action-button action-undo"
                type="button"
                onClick={undoLastAction}
                disabled={
                  undoStack.length === 0 || areControlsDisabled || isMutating
                }
              >
                Undo ↓
              </button>
              <button
                className="action-button action-next"
                type="button"
                onClick={goNext}
                disabled={
                  !hasFiles ||
                  currentIndex >= filteredCount - 1 ||
                  areControlsDisabled ||
                  isMutating
                }
              >
                Next →
              </button>
              <button
                className="action-button action-trash"
                type="button"
                onClick={trashCurrent}
                disabled={!hasFiles || areControlsDisabled || isMutating}
              >
                Trash ↑
              </button>
            </div>
          </div>
        </footer>
      </div>

      {activeBlockingOverlay && (
        <div className="blocking-overlay" role="alert" aria-live="assertive">
          <div className="loading-state blocking-overlay-card">
            {activeBlockingOverlay.showSpinner && (
              <div className="spinner" aria-hidden="true" />
            )}
            <div className="loading-title">{activeBlockingOverlay.title}</div>
            <div className="loading-subtitle">
              {activeBlockingOverlay.subtitle}
            </div>
            {activeBlockingOverlay.actions.length > 0 && (
              <div className="modal-action-row">
                {activeBlockingOverlay.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="preview-action-button"
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {activeBlockingOverlay.showCancel && (
              <button
                type="button"
                className="preview-action-button"
                onClick={() => void cancelActiveScan()}
                disabled={isCancellingScan}
              >
                {isCancellingScan ? "Stopping..." : "Stop scan"}
              </button>
            )}
          </div>
        </div>
      )}

      {isCrashReportOpen && crashReport && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              handleDismissCrashReport();
            }
          }}
        >
          <div
            className="modal-panel crash-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="crash-title"
          >
            <div className="modal-header">
              <h2 id="crash-title" className="modal-title">
                We recovered from a crash
              </h2>
              <button
                type="button"
                className="icon-button"
                onClick={handleDismissCrashReport}
                aria-label="Dismiss crash report"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
                </svg>
              </button>
            </div>
            <div className="modal-body crash-body">
              <p className="crash-intro">
                A crash report was saved. You can send it to{" "}
                {CRASH_REPORT_EMAIL} to help us improve stability.
              </p>
              <div className="crash-meta">
                <div>
                  <span className="meta-label">Time</span>
                  <span className="meta-value">
                    {formatTimestamp(crashReport.createdMs)}
                  </span>
                </div>
                <div>
                  <span className="meta-label">Last heartbeat</span>
                  <span className="meta-value">
                    {formatTimestamp(crashReport.lastHeartbeatMs ?? null)}
                  </span>
                </div>
                <div>
                  <span className="meta-label">Message</span>
                  <span className="meta-value">{crashReport.message}</span>
                </div>
                <div>
                  <span className="meta-label">Last activity</span>
                  <span className="meta-value">
                    {formatActivitySummary(crashReport.lastActivity)}
                  </span>
                </div>
                <div>
                  <span className="meta-label">Report file</span>
                  <span className="meta-value mono">
                    {crashReport.reportPath}
                  </span>
                </div>
              </div>
              <pre className="crash-report">{crashReportText}</pre>
            </div>
            <div className="modal-footer crash-footer">
              <button
                type="button"
                className="help-button"
                onClick={handleRevealCrashReport}
              >
                Show file
              </button>
              <button
                type="button"
                className="help-button"
                onClick={handleCopyCrashReport}
              >
                Copy report
              </button>
              <button type="button" onClick={handleSendCrashReport}>
                Send report
              </button>
              <button type="button" onClick={handleDismissCrashReport}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {isSuggestionsOpen && (
        <div
          className="modal-backdrop suggestions-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsSuggestionsOpen(false);
            }
          }}
        >
          <div
            className="modal-panel suggestions-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="suggestions-title"
          >
            <div className="modal-header">
              <h2 id="suggestions-title" className="modal-title">
                AI Suggestions
              </h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsSuggestionsOpen(false)}
                aria-label="Close suggestions"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
                </svg>
              </button>
            </div>
            <div className="suggestions-scroll-frame scroll-hints">
              <div className="modal-body suggestions-body">
                <div className="suggestions-shell">
                  <div className="suggestions-main">
                    <div className="suggestions-main-header">
                      <div>
                        <div className="footer-title">Suggestions</div>
                        <div className="suggestions-kicker">
                          {visibleSuggestions.length} visible actions
                        </div>
                      </div>
                      <div className="suggestions-header-actions">
                        <div
                          className="suggestions-mode-toggle"
                          role="group"
                          aria-label="Suggestions mode"
                        >
                          {SUGGESTIONS_MODE_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={`suggestions-mode-button${suggestionsMode === option.value ? " is-active" : ""}`}
                              onClick={() => setSuggestionsMode(option.value)}
                              aria-pressed={suggestionsMode === option.value}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="suggestions-preset-row">
                      <label
                        className="suggestions-field suggestions-field-inline"
                        htmlFor="suggestion-preset-select"
                      >
                        <span className="control-label">Preset</span>
                        <select
                          id="suggestion-preset-select"
                          value={suggestionPresetId ?? ""}
                          onChange={(event) => {
                            const nextId = event.target.value;
                            setSuggestionPresetId(nextId || null);
                            if (nextId) {
                              applySuggestionPresetById(nextId);
                            }
                          }}
                        >
                          <option value="">No preset</option>
                          {suggestionPresets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {activeSuggestionPreset && (
                        <button
                          type="button"
                          className="suggestions-quick-button suggestions-last-preset-button"
                          onClick={applyLastSuggestionPreset}
                        >
                          Apply last: {activeSuggestionPreset.name}
                        </button>
                      )}
                      <span
                        className="suggestions-tooltip-anchor"
                        title="Work in progress"
                      >
                        <button
                          type="button"
                          className="suggestions-quick-button is-work-in-progress"
                          disabled
                          aria-label="Save current rules (work in progress)"
                        >
                          Save current rules
                        </button>
                      </span>
                      <button
                        type="button"
                        className="suggestions-quick-button"
                        onClick={renameSuggestionPreset}
                        disabled={!activeSuggestionPreset}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="suggestions-quick-button"
                        onClick={() => void deleteSuggestionPreset()}
                        disabled={!activeSuggestionPreset}
                      >
                        Delete
                      </button>
                    </div>
                    <div className="suggestions-controls suggestions-controls-actions">
                      <button
                        type="button"
                        className="preview-action-button"
                        onClick={() => void buildSuggestions()}
                        disabled={
                          !currentFolder ||
                          isLoading ||
                          isMutating ||
                          suggestionsStatus === "loading"
                        }
                      >
                        {suggestionsStatus === "loading"
                          ? "Building..."
                          : "Build suggestions"}
                      </button>
                      <button
                        type="button"
                        className="preview-action-button"
                        onClick={() => void previewSelectedSuggestions()}
                        disabled={
                          !currentFolder ||
                          isLoading ||
                          isMutating ||
                          selectedSuggestions.length === 0 ||
                          suggestionDryRunStatus === "loading"
                        }
                      >
                        {suggestionDryRunStatus === "loading"
                          ? "Previewing..."
                          : "Preview selected"}
                      </button>
                      <button
                        type="button"
                        className="preview-action-button"
                        onClick={() => void applySelectedSuggestions()}
                        disabled={
                          !currentFolder ||
                          isLoading ||
                          isMutating ||
                          selectedSuggestions.length === 0
                        }
                      >
                        Apply selected
                      </button>
                    </div>
                    <div className="suggestions-filter-row">
                      <label
                        className="suggestions-field"
                        htmlFor="suggestion-safety-filter-modal"
                      >
                        <span className="control-label">Safety</span>
                        <select
                          id="suggestion-safety-filter-modal"
                          value={suggestionSafetyFilter}
                          onChange={(event) =>
                            setSuggestionSafetyFilter(
                              event.target.value as SafetyLevel,
                            )
                          }
                        >
                          <option value="safe">Safe</option>
                          <option value="review">Review</option>
                          <option value="manual">Manual</option>
                        </select>
                      </label>
                      <label
                        className="suggestions-field suggestions-search-field"
                        htmlFor="suggestion-search-modal"
                      >
                        <span className="control-label">Search</span>
                        <input
                          id="suggestion-search-modal"
                          type="text"
                          value={suggestionSearchQuery}
                          onChange={(event) =>
                            setSuggestionSearchQuery(event.target.value)
                          }
                          placeholder="Search reason or path"
                        />
                      </label>
                    </div>
                    {suggestionsMode === "advanced" && (
                      <div className="suggestions-advanced-panel">
                        <div className="suggestions-build-grid">
                          <label
                            className="suggestions-field"
                            htmlFor="suggestion-stale-days"
                          >
                            <span className="control-label">Stale days</span>
                            <input
                              id="suggestion-stale-days"
                              type="number"
                              min={1}
                              max={3650}
                              value={suggestionStaleDays}
                              onChange={(event) => {
                                const next = Number(event.target.value);
                                if (Number.isFinite(next)) {
                                  setSuggestionStaleDays(next);
                                }
                              }}
                            />
                          </label>
                          <label
                            className="suggestions-field"
                            htmlFor="suggestion-min-large-bytes"
                          >
                            <span className="control-label">
                              Large file threshold
                            </span>
                            <select
                              id="suggestion-min-large-bytes"
                              value={suggestionMinLargeFileBytes}
                              onChange={(event) =>
                                setSuggestionMinLargeFileBytes(
                                  Number(event.target.value),
                                )
                              }
                            >
                              {SUGGESTION_MIN_LARGE_FILE_OPTIONS.map(
                                (option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <label
                            className="suggestions-field"
                            htmlFor="suggestion-max-results"
                          >
                            <span className="control-label">Max results</span>
                            <input
                              id="suggestion-max-results"
                              type="number"
                              min={1}
                              max={2000}
                              value={suggestionMaxResults}
                              onChange={(event) => {
                                const next = Number(event.target.value);
                                if (Number.isFinite(next)) {
                                  setSuggestionMaxResults(next);
                                }
                              }}
                            />
                          </label>
                        </div>
                        <div className="suggestions-filter-grid">
                          <label
                            className="suggestions-field"
                            htmlFor="suggestion-action-filter-modal"
                          >
                            <span className="control-label">Action</span>
                            <select
                              id="suggestion-action-filter-modal"
                              value={suggestionActionFilter}
                              onChange={(event) =>
                                setSuggestionActionFilter(
                                  event.target.value as SuggestionActionFilter,
                                )
                              }
                            >
                              {SUGGESTION_ACTION_FILTER_OPTIONS.map(
                                (option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <label
                            className="suggestions-field"
                            htmlFor="suggestion-sort-mode-modal"
                          >
                            <span className="control-label">Sort</span>
                            <select
                              id="suggestion-sort-mode-modal"
                              value={suggestionSortMode}
                              onChange={(event) =>
                                setSuggestionSortMode(
                                  event.target.value as SuggestionSortMode,
                                )
                              }
                            >
                              {SUGGESTION_SORT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div
                          className="suggestions-v2-placeholder"
                          aria-live="polite"
                        >
                          <span className="footer-title">V2 slots</span>
                          <div className="suggestions-v2-actions">
                            <button
                              type="button"
                              disabled={!suggestionExplainabilityEnabled}
                            >
                              Explainability panel (v2)
                            </button>
                            <button
                              type="button"
                              disabled={!suggestionBatchToolbarEnabled}
                            >
                              Batch actions toolbar (v2)
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="suggestions-controls suggestions-controls-selection">
                      <button
                        type="button"
                        className="suggestions-quick-button"
                        onClick={() =>
                          updateSuggestionSelection(() =>
                            suggestions
                              .filter(
                                (suggestion) =>
                                  suggestion.safetyLevel === "safe",
                              )
                              .map((suggestion) => suggestion.id),
                          )
                        }
                        disabled={suggestions.length === 0}
                      >
                        Select safe
                      </button>
                      <button
                        type="button"
                        className="suggestions-quick-button"
                        onClick={() =>
                          updateSuggestionSelection(() =>
                            visibleSuggestions.map(
                              (suggestion) => suggestion.id,
                            ),
                          )
                        }
                        disabled={visibleSuggestions.length === 0}
                      >
                        Select visible
                      </button>
                      <button
                        type="button"
                        className="suggestions-quick-button"
                        onClick={() => updateSuggestionSelection(() => [])}
                        disabled={selectedSuggestionIds.length === 0}
                      >
                        Clear selection
                      </button>
                    </div>
                    <div className="suggestions-meta">
                      <span>
                        Total reclaimable:{" "}
                        {formatBytes(suggestionTotalReclaimableBytes)}
                      </span>
                      <span>
                        Selected:{" "}
                        {formatBytes(selectedSuggestionReclaimableBytes)}
                      </span>
                      <span>{selectedSuggestions.length} selected actions</span>
                    </div>
                    {suggestionsError && (
                      <div className="suggestions-error">
                        {suggestionsError}
                      </div>
                    )}
                    {visibleSuggestions.length === 0 ? (
                      <div className="suggestions-empty">
                        No suggestions match current filters.
                      </div>
                    ) : (
                      <div className="suggestions-list">
                        {visibleSuggestions.slice(0, 120).map((suggestion) => (
                          <label
                            key={suggestion.id}
                            className="suggestion-item"
                          >
                            <input
                              type="checkbox"
                              checked={selectedSuggestionSet.has(suggestion.id)}
                              onChange={(event) => {
                                updateSuggestionSelection((previous) =>
                                  event.target.checked
                                    ? previous.includes(suggestion.id)
                                      ? previous
                                      : [...previous, suggestion.id]
                                    : previous.filter(
                                        (id) => id !== suggestion.id,
                                      ),
                                );
                              }}
                            />
                            <span className="suggestion-main">
                              <span className="suggestion-title">
                                {suggestion.reason.message}
                              </span>
                              <span className="suggestion-subtitle">
                                {getSuggestionActionLabel(
                                  suggestion.actionType,
                                )}{" "}
                                · {formatBytes(suggestion.reclaimableBytes)} ·{" "}
                                {suggestion.safetyLevel}
                              </span>
                              <span className="suggestion-subtitle mono">
                                {formatSuggestionPath(suggestion.sourcePath)}{" "}
                                -&gt; {getSuggestionTargetLabel(suggestion)}
                              </span>
                              <span className="suggestion-change">
                                {getSuggestionChangeSentence(suggestion)}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  <aside className="suggestions-preview-panel">
                    <div className="suggestions-preview-header">
                      <div className="footer-title">Change Preview</div>
                      <span
                        className={`suggestion-status ${
                          hasDryRunPreviewForSelection
                            ? "suggestion-status-planned"
                            : "suggestion-status-pending"
                        }`}
                      >
                        {hasDryRunPreviewForSelection
                          ? "Preview ready"
                          : "Needs preview"}
                      </span>
                    </div>
                    <div className="suggestions-preview-summary">
                      <span>{selectedSuggestions.length} selected actions</span>
                      <span>
                        {formatBytes(selectedSuggestionReclaimableBytes)}{" "}
                        reclaimable
                      </span>
                      <span>
                        Visible selected: {selectedVisibleSuggestions.length}/
                        {selectedSuggestions.length}
                      </span>
                    </div>
                    <div className="suggestions-preview-list">
                      {selectedSuggestions.length === 0 ? (
                        <div className="suggestions-empty">
                          No selected actions yet.
                        </div>
                      ) : (
                        selectedSuggestions.slice(0, 120).map((suggestion) => {
                          const dryRunResult = suggestionDryRunResultsById.get(
                            suggestion.id,
                          );
                          const previewStatus = hasDryRunPreviewForSelection
                            ? (dryRunResult?.status ?? "planned")
                            : "pending";
                          return (
                            <div
                              key={`preview-${suggestion.id}`}
                              className="suggestions-preview-item"
                            >
                              <div className="suggestions-preview-path mono">
                                {formatSuggestionPath(suggestion.sourcePath)}{" "}
                                -&gt; {getSuggestionTargetLabel(suggestion)}
                              </div>
                              <div className="suggestions-preview-meta">
                                <span
                                  className={`suggestion-status suggestion-status-${
                                    previewStatus === "pending"
                                      ? "pending"
                                      : previewStatus
                                  }`}
                                >
                                  {previewStatus}
                                </span>
                                <span>
                                  {formatBytes(suggestion.reclaimableBytes)}
                                </span>
                              </div>
                              {dryRunResult?.message && (
                                <div className="suggestions-preview-message">
                                  {dryRunResult.message}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                    <details className="suggestions-diagnostics">
                      <summary>Diagnostics</summary>
                      <div className="suggestions-preview-actions">
                        {Object.entries(selectedSuggestionActionCounts)
                          .length === 0 ? (
                          <span className="suggestions-empty">
                            Select suggestions to preview changes.
                          </span>
                        ) : (
                          Object.entries(selectedSuggestionActionCounts)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([actionType, count]) => (
                              <span
                                key={actionType}
                                className="suggestion-chip"
                              >
                                {getSuggestionActionLabel(actionType)}: {count}
                              </span>
                            ))
                        )}
                      </div>
                      {suggestionDryRunError && (
                        <div className="suggestions-error">
                          {suggestionDryRunError}
                        </div>
                      )}
                      {hasDryRunPreviewForSelection && (
                        <div className="suggestions-preview-dryrun">
                          <span className="suggestion-status suggestion-status-planned">
                            planned {suggestionDryRunStatusCounts.planned}
                          </span>
                          <span className="suggestion-status suggestion-status-blocked">
                            blocked {suggestionDryRunStatusCounts.blocked}
                          </span>
                          <span className="suggestion-status suggestion-status-error">
                            error {suggestionDryRunStatusCounts.error}
                          </span>
                        </div>
                      )}
                    </details>
                  </aside>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setIsSuggestionsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        isLoading={areControlsDisabled}
        viewMode={viewMode}
        setViewMode={makeBlockingSetter(
          "Changing default view",
          setViewMode,
          "Switching the default layout...",
        )}
        sortMode={sortMode}
        setSortMode={makeBlockingSetter(
          "Changing default sort",
          setSortMode,
          "Updating how files are ordered...",
        )}
        displayGroupMode={displayGroupMode}
        handleGroupModeChange={(value) =>
          runBlockingUiTransition(
            "Changing default grouping",
            () => handleGroupModeChange(value),
            "Updating how files are grouped...",
          )
        }
        shouldGroupDuplicates={shouldGroupDuplicates}
        extensionFilterMode={extensionFilterMode}
        setExtensionFilterMode={makeBlockingSetter(
          "Changing extension defaults",
          setExtensionFilterMode,
          "Refreshing extension preferences...",
        )}
        autoScanOnPick={autoScanOnPick}
        setAutoScanOnPick={setAutoScanOnPick}
        rememberLastFolder={rememberLastFolder}
        setRememberLastFolder={setRememberLastFolder}
        includeSubfolders={includeSubfolders}
        setIncludeSubfolders={setIncludeSubfolders}
        includeHidden={includeHidden}
        setIncludeHidden={setIncludeHidden}
        useHashForDuplicates={useHashForDuplicates}
        setUseHashForDuplicates={setUseHashForDuplicates}
        duplicateMinSizeBytes={duplicateMinSizeBytes}
        setDuplicateMinSizeBytes={setDuplicateMinSizeBytes}
        autoPlayMedia={autoPlayMedia}
        setAutoPlayMedia={setAutoPlayMedia}
        skipLargePreviews={skipLargePreviews}
        setSkipLargePreviews={setSkipLargePreviews}
        trashBehavior={trashBehavior}
        setTrashBehavior={setTrashBehavior}
        confirmTrash={confirmTrash}
        setConfirmTrash={setConfirmTrash}
        listDensity={listDensity}
        setListDensity={makeBlockingSetter(
          "Changing list density",
          setListDensity,
          "Refreshing the list spacing...",
        )}
        theme={theme}
        setTheme={makeBlockingSetter(
          "Changing theme",
          setTheme,
          "Applying the updated appearance...",
        )}
        onClose={() => setIsSettingsOpen(false)}
        onOpenHelp={() => setIsHelpOpen(true)}
        settingsFrameRef={settingsFrameRef}
        settingsBodyRef={settingsBodyRef}
      />
      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </div>
  );
}
