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
  SuggestionActionFilter,
  SuggestionSortMode,
  SuggestionsMode,
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
  HEARTBEAT_INTERVAL_MS,
  MAX_UNDO_STACK,
  SETTINGS_KEY,
  TREE_INDENT_PX,
} from "../constants/appConstants";
import {
  updateScrollHint,
  isEditableTarget,
  shouldOpenOnEnter,
} from "../lib/dom";
import {
  buildCrashEmailBody,
  formatBytes,
  formatCrashReport,
  formatDuplicateGroupMeta,
  formatGroupTitle,
  formatPathLabel,
} from "../lib/format";
import { dedupeFileEntries, getExtension } from "../lib/files";
import { getGroupIdForFile, groupFilesByMode } from "../lib/grouping";
import {
  buildFileTree,
  getFolderCollapseKey,
} from "../lib/tree";
import {
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
import { useAsyncWorkflow } from "../hooks/useAsyncWorkflow";
import { useSuggestionsController } from "../hooks/useSuggestionsController";
import { getInitialTheme, getStoredSettings } from "../lib/settings";
import { revealInFileManager } from "../services/fileManagerService";
import { runActionBatch } from "../services/suggestionsService";
import { HelpModal } from "../components/HelpModal";
import { CrashReportModal } from "../components/CrashReportModal";
import { DestinationSlots } from "../components/DestinationSlots";
import { FileListPanel } from "../components/FileListPanel";
import { PreviewPanel } from "../components/PreviewPanel";
import { SettingsModal } from "../components/SettingsModal";
import { SuggestionsModal } from "../components/SuggestionsModal";
import { Toolbar } from "../components/Toolbar";

const SUGGESTIONS_MODE_OPTIONS: { value: SuggestionsMode; label: string }[] = [
  { value: "review", label: "Review & Apply" },
  { value: "advanced", label: "Advanced" },
];

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
  const isWindowsDesktop =
    typeof navigator !== "undefined" &&
    isDesktopRuntime() &&
    /windows/i.test(navigator.userAgent);
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
  const {
    isLoading,
    start: startScanWorkflow,
    succeed: succeedScanWorkflow,
    fail: failScanWorkflow,
    reset: resetScanWorkflow,
    run: runScanWorkflow,
  } = useAsyncWorkflow();
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
  const {
    isLoading: isCancellingScan,
    start: startCancelScanWorkflow,
    fail: failCancelScanWorkflow,
    reset: resetCancelScanWorkflow,
  } = useAsyncWorkflow();
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
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [isExtensionsCollapsed, setIsExtensionsCollapsed] = useState(true);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const activeScanId = useRef<string | null>(null);
  const scanBatchBufferRef = useRef<FileEntry[]>([]);
  const scanBatchRafRef = useRef<number | null>(null);
  const hasAutoLoadedFolderRef = useRef(false);
  const listItemRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const currentFileIdRef = useRef<string | null>(null);
  const skipAutoExpandCurrentFileRef = useRef(false);
  const suppressAutoExpandForSortRef = useRef(false);
  const suppressAutoExpandForGroupModeRef = useRef(false);
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
    const syncWindowState = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (isMounted) {
          setIsWindowFullscreen(fullscreen);
        }
      } catch {
        // Ignore unsupported window APIs in non-desktop runtimes.
      }
      try {
        const maximized = await appWindow.isMaximized();
        if (isMounted) {
          setIsWindowMaximized(maximized);
        }
      } catch {
        // Ignore unsupported window APIs in non-desktop runtimes.
      }
    };
    void syncWindowState();
    void appWindow
      .onResized(() => {
        void syncWindowState();
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

  const handleMinimizeWindow = useCallback(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void getDesktopWindow().minimize().catch(() => {});
  }, []);

  const handleToggleMaximizeWindow = useCallback(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void getDesktopWindow()
      .toggleMaximize()
      .then(async () => {
        try {
          const maximized = await getDesktopWindow().isMaximized();
          setIsWindowMaximized(maximized);
        } catch {
          // Ignore unsupported window APIs in non-desktop runtimes.
        }
      })
      .catch(() => {});
  }, []);

  const handleCloseWindow = useCallback(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void getDesktopWindow().close().catch(() => {});
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
  const sortedIndexById = useMemo(() => {
    const map = new Map<string, number>();
    sortedFiles.forEach((file, index) => {
      map.set(file.id, index);
    });
    return map;
  }, [sortedFiles]);
  const preview = usePreviewController({
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

  const buildInitialCollapsedFolders = useCallback(
    (entries: FileEntry[], folderPath: string): Record<string, boolean> => {
      if (viewMode !== "tree") {
        return {};
      }

      const next: Record<string, boolean> = {};

      const collectFolderKeys = (nodes: TreeNode[], groupId: string | null) => {
        nodes.forEach((node) => {
          if (node.type !== "folder") {
            return;
          }
          next[getFolderCollapseKey(groupId, node.path)] = true;
          collectFolderKeys(node.children, groupId);
        });
      };

      const collectTreeForFiles = (
        treeFiles: FileEntry[],
        groupId: string | null,
      ) => {
        const tree = buildFileTree(treeFiles, folderPath);
        collectFolderKeys(tree.children, groupId);
      };

      if (effectiveGroupMode === "none") {
        collectTreeForFiles(entries, null);
        return next;
      }

      const { groups, keys } = groupFilesByMode(effectiveGroupMode, entries);
      keys.forEach((key) => {
        const groupFiles = groups.get(key);
        if (!groupFiles || groupFiles.length === 0) {
          return;
        }
        collectTreeForFiles(groupFiles, `${effectiveGroupMode}:${key}`);
      });

      return next;
    },
    [effectiveGroupMode, viewMode],
  );

  const buildInitialCollapsedGroups = useCallback(
    (entries: FileEntry[], mode: GroupMode): Record<string, boolean> => {
      if (mode !== "type" && mode !== "extension") {
        return {};
      }

      const next: Record<string, boolean> = {};
      const { keys } = groupFilesByMode(mode, entries);
      keys.forEach((key) => {
        next[`${mode}:${key}`] = true;
      });
      return next;
    },
    [],
  );

  const resetScanViewState = useCallback(() => {
    cancelPendingScanBatchFlush();
    setFiles([]);
    currentFileIdRef.current = null;
    setCurrentIndex(0);
    setRenderCount(0);
    setUndoStack([]);
    resetSuggestionsState();
    setCollapsedGroups({});
    setCollapsedFolders({});
  }, [cancelPendingScanBatchFlush, resetSuggestionsState]);

  const applyScanResult = useCallback(
    (folderPath: string, result: ScanResult) => {
      cancelPendingScanBatchFlush();
      resetSelectionToFirstRef.current = true;
      const uniqueFiles = dedupeFileEntries(result.files);
      const nextCollapsedGroups = buildInitialCollapsedGroups(
        uniqueFiles,
        effectiveGroupMode,
      );
      const nextCollapsedFolders = buildInitialCollapsedFolders(
        uniqueFiles,
        folderPath,
      );
      setFiles(uniqueFiles);
      setCurrentFolder(folderPath);
      currentFileIdRef.current = null;
      skipAutoExpandCurrentFileRef.current =
        viewMode === "tree" && Object.keys(nextCollapsedFolders).length > 0;
      setCurrentIndex(0);
      setRenderCount(0);
      setUndoStack([]);
      resetSuggestionsState();
      setCollapsedGroups(nextCollapsedGroups);
      setCollapsedFolders(nextCollapsedFolders);
      updateStatus(`Loaded ${uniqueFiles.length} items from ${folderPath}.`);
    },
    [
      buildInitialCollapsedGroups,
      buildInitialCollapsedFolders,
      cancelPendingScanBatchFlush,
      effectiveGroupMode,
      resetSuggestionsState,
      updateStatus,
      viewMode,
    ],
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
      resetCancelScanWorkflow();
      startScanWorkflow();
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
        succeedScanWorkflow();
      } catch (error) {
        if (activeScanId.current !== scanId) {
          return;
        }
        const message = String(error);
        if (message.toLowerCase().includes("scan cancelled")) {
          resetScanWorkflow();
          updateStatus("Scan cancelled.");
          return;
        }
        failScanWorkflow(message);
        updateStatus(`Scan failed: ${message}`);
      } finally {
        if (activeScanId.current === scanId) {
          setScanProgress(null);
          activeScanId.current = null;
          resetCancelScanWorkflow();
        }
      }
    },
    [
      applyScanResult,
      failScanWorkflow,
      resetCancelScanWorkflow,
      resetScanViewState,
      resetScanWorkflow,
      startScanWorkflow,
      succeedScanWorkflow,
      updateStatus,
    ],
  );

  const loadCachedScan = useCallback(
    async (cachedScan: CachedScan) => {
      const hydrated = await runScanWorkflow(
        async () => {
          await invokeCommand("hydrate_cached_scan", {
            request: {
              folderPath: cachedScan.folderPath,
              files: cachedScan.files,
            },
          });
          return true;
        },
        {
          onError: (message) => {
            updateStatus(`Failed to load cached scan: ${message}`);
          },
        },
      );
      if (hydrated === null) {
        return;
      }
      setScanCachePrompt(null);
      setScanProgress(null);
      activeScanId.current = null;
      resetCancelScanWorkflow();
      setLastScanFilterMode(cachedScan.filterMode);
      applyScanResult(cachedScan.folderPath, {
        files: cachedScan.files,
        total: cachedScan.total,
      });
    },
    [applyScanResult, resetCancelScanWorkflow, runScanWorkflow, updateStatus],
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
    startCancelScanWorkflow();
    updateStatus("Stopping scan...");
    try {
      await invokeCommand("cancel_scan", { scanId });
    } catch (error) {
      const message = String(error);
      failCancelScanWorkflow(message);
      updateStatus(`Failed to stop scan: ${message}`);
    }
  }, [
    failCancelScanWorkflow,
    isCancellingScan,
    startCancelScanWorkflow,
    updateStatus,
  ]);

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

  const handleDeleteSuggestionPreset = useCallback(async () => {
    const preset = await getDeleteSuggestionPreset();
    if (!preset) {
      return;
    }
    const shouldDelete = await confirmDialog(
      `Delete preset "${preset.activePresetName}"?`,
      { title: "Delete suggestion preset" },
    );
    if (!shouldDelete) {
      return;
    }
    confirmDeleteSuggestionPreset(preset.activePresetId);
    updateStatus(`Preset "${preset.activePresetName}" deleted.`);
  }, [confirmDeleteSuggestionPreset, getDeleteSuggestionPreset, updateStatus]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  const handleCurrentFolderScan = useCallback(() => {
    void handleScan(currentFolder ?? undefined);
  }, [currentFolder, handleScan]);

  const handleFilterModeChange = useCallback(
    (value: FilterMode) => {
      runBlockingUiTransition(
        "Updating filter",
        () => setFilterMode(value),
        "Refreshing the file selection...",
      );
    },
    [runBlockingUiTransition],
  );

  const handleSortModeChange = useCallback(
    (value: SortMode) => {
      suppressAutoExpandForSortRef.current = true;
      runBlockingUiTransition(
        "Sorting files",
        () => setSortMode(value),
        "Reordering the list...",
      );
    },
    [runBlockingUiTransition],
  );

  const handleSidebarGroupModeChange = useCallback(
    (value: GroupMode) => {
      suppressAutoExpandForGroupModeRef.current = true;
      runBlockingUiTransition(
        "Grouping files",
        () => {
          handleGroupModeChange(value);
          setCollapsedGroups(buildInitialCollapsedGroups(sortedFiles, value));
        },
        "Rebuilding the file groups...",
      );
    },
    [
      buildInitialCollapsedGroups,
      handleGroupModeChange,
      runBlockingUiTransition,
      sortedFiles,
    ],
  );

  const handleViewModeChange = useCallback(
    (value: ViewMode) => {
      runBlockingUiTransition(
        "Changing view",
        () => setViewMode(value),
        "Switching the file layout...",
      );
    },
    [runBlockingUiTransition],
  );

  const handleToggleAllExtensions = useCallback(
    (checked: boolean) => {
      hasUserAdjustedExtensionsRef.current = true;
      runBlockingUiTransition(
        "Updating extensions",
        () => setSelectedExtensions(checked ? allExtensions : []),
        "Refreshing the visible files...",
      );
    },
    [allExtensions, runBlockingUiTransition],
  );

  const handleToggleExtension = useCallback(
    (extension: string) => {
      hasUserAdjustedExtensionsRef.current = true;
      runBlockingUiTransition(
        "Updating extensions",
        () =>
          setSelectedExtensions((current) =>
            current.includes(extension)
              ? current.filter((value) => value !== extension)
              : [...current, extension],
          ),
        "Refreshing the visible files...",
      );
    },
    [runBlockingUiTransition],
  );

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
    suggestionDryRunResult,
    suggestionDryRunSelectionKey,
    selectedSuggestionPlanKey,
    suggestionDryRunStatus,
    previewSelectedSuggestions,
    clearSuggestionDryRunPreview,
    removeAppliedSuggestions,
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
        className={`file-item ${index === currentIndex ? "active " : ""}${
          depth !== undefined ? "tree-item" : ""
        }`}
        onClick={() => {
          currentFileIdRef.current = file.id;
          setCurrentIndex(index);
        }}
        onDoubleClick={() => void openFileInFinder(file)}
        ref={(node) => listItemRefs.current.set(file.id, node)}
        type="button"
        aria-current={index === currentIndex ? "true" : undefined}
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
    ) =>
      nodes.map((node) => {
        if (node.type === "file") {
          const index = indexMap.get(node.file.id) ?? 0;
          return renderButton(node.file, index, Math.max(depth - 1, 0));
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
                <span className="folder-label">
                  <span className="folder-name">{node.name}</span>
                  <span className="folder-size">{formatBytes(node.totalBytes)}</span>
                </span>
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
      nodes.forEach((node) => {
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
      <div className="titlebar-drag" data-tauri-drag-region />
      <Toolbar
        isSidebarCollapsed={isSidebarCollapsed}
        isDrawerMode={isDrawerMode}
        isSettingsOpen={isSettingsOpen}
        showWindowControls={isWindowsDesktop}
        isWindowMaximized={isWindowMaximized}
        onToggleSidebar={toggleSidebar}
        onOpenSettings={() => setIsSettingsOpen(true)}
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
              isRenderingList,
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
              renderCount,
              filteredCount,
            }}
            extensions={{
              isCollapsed: isExtensionsCollapsed,
              allExtensions,
              selectedExtensions,
              allExtensionsSelected,
              selectAllRef,
              onToggleCollapsed: () =>
                setIsExtensionsCollapsed((prev) => !prev),
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
            onOpenFile={openFileInSystem}
          />
        </main>

        <footer className="actions">
          <div className="actions-row">
            <DestinationSlots
              destinationSlots={destinationSlots}
              disabled={areControlsDisabled || isMutating}
              onPickDestination={pickDestinationForSlot}
            />
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

      <CrashReportModal
        isOpen={isCrashReportOpen}
        crashReport={crashReport}
        crashReportText={crashReportText}
        onDismiss={handleDismissCrashReport}
        onReveal={handleRevealCrashReport}
        onCopy={handleCopyCrashReport}
        onSend={handleSendCrashReport}
      />

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

      <SettingsModal
        isOpen={isSettingsOpen}
        isLoading={areControlsDisabled}
        layout={{
          viewMode,
          setViewMode: makeBlockingSetter(
            "Changing default view",
            setViewMode,
            "Switching the default layout...",
          ),
          sortMode,
          setSortMode: makeBlockingSetter(
            "Changing default sort",
            setSortMode,
            "Updating how files are ordered...",
          ),
          displayGroupMode,
          handleGroupModeChange: (value) =>
            runBlockingUiTransition(
              "Changing default grouping",
              () => handleGroupModeChange(value),
              "Updating how files are grouped...",
            ),
          shouldGroupDuplicates,
          extensionFilterMode,
          setExtensionFilterMode: makeBlockingSetter(
            "Changing extension defaults",
            setExtensionFilterMode,
            "Refreshing extension preferences...",
          ),
          listDensity,
          setListDensity: makeBlockingSetter(
            "Changing list density",
            setListDensity,
            "Refreshing the list spacing...",
          ),
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
          setTheme: makeBlockingSetter(
            "Changing theme",
            setTheme,
            "Applying the updated appearance...",
          ),
        }}
        onClose={() => setIsSettingsOpen(false)}
        onOpenHelp={() => setIsHelpOpen(true)}
        settingsFrameRef={settingsFrameRef}
        settingsBodyRef={settingsBodyRef}
      />
      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </div>
  );
}
