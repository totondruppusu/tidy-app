import { describeScanProgress } from "../lib/scanProgress";
import { Modal } from "../components/Modal";
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
  ViewMode,
  PickedDirectory,
  LocalDirectoryEntry,
} from "../types";
import {
  COMMON_EXTENSIONS,
  CRASH_REPORT_EMAIL,
  DESTINATION_SLOT_COUNT,
  EVENT_LOOP_LAG_WARN_MS,
  EVENT_LOOP_POLL_MS,
  HEARTBEAT_INTERVAL_MS,
  SETTINGS_KEY,
} from "../constants/appConstants";
import {
  updateScrollHint,
  isEditableTarget,
  shouldOpenOnEnter,
} from "../lib/dom";
import {
  buildCrashEmailBody,
  formatCrashReport,
  formatPathLabel,
} from "../lib/format";
import { dedupeFileEntries, getExtension } from "../lib/files";
import { getGroupIdForFile, groupFilesByMode } from "../lib/grouping";
import { buildFileTree, getFolderCollapseKey } from "../lib/tree";
import { getRelativeSegments, splitPathSegments } from "../lib/path";
import {
  getDesktopWindow,
  invokeCommand,
  isDesktopRuntime,
  listenEvent,
} from "../lib/desktopBridge";
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
import { getInitialTheme, getStoredSettings } from "../lib/settings";
import { revealInFileManager } from "../services/fileManagerService";
import { runActionBatch } from "../services/suggestionsService";
import {
  isAndroidRuntime,
  listLocalDirectories,
  pickManagedDirectory,
} from "../services/directoryService";
import { DestinationSlots } from "../components/DestinationSlots";
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

const createEmptyDestinationSlots = () =>
  Array.from({ length: DESTINATION_SLOT_COUNT }, () => null);

const ANDROID_FOLDER_PICKER_HINT =
  "Android will ask for all files access first, then open an in-app folder browser so you can choose what to scan. Protected app-private folders may still be blocked by Android.";

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
  const isAndroidApp = isAndroidRuntime();
  const { confirmDialog, confirmation, isConfirming } = useConfirmation();
  const [undoFailure, setUndoFailure] = useState<UndoFailure | null>(null);
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
      if (isAndroidApp) {
        return createEmptyDestinationSlots();
      }
      const storedSlots = storedSettings.destinationSlots;
      if (!storedSlots) {
        return createEmptyDestinationSlots();
      }
      const normalized = storedSlots.slice(0, DESTINATION_SLOT_COUNT);
      while (normalized.length < DESTINATION_SLOT_COUNT) {
        normalized.push(null);
      }
      return normalized;
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
    const normalized = storedSlots.slice(0, DESTINATION_SLOT_COUNT);
    while (normalized.length < DESTINATION_SLOT_COUNT) {
      normalized.push(null);
    }
    return normalized;
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
  const [scanCachePrompt, setScanCachePrompt] =
    useState<ScanCachePromptState | null>(null);
  const [blockingOverlay, setBlockingOverlay] =
    useState<BlockingOverlayState | null>(null);
  const { isMutating, mutationSpinnerLabel, runMutationWithSpinner } =
    useMutationController(setBlockingOverlay);
  const resetSelectionToFirstRef = useRef(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isAndroidFolderBrowserOpen, setIsAndroidFolderBrowserOpen] =
    useState(false);
  const [androidFolderBrowserPath, setAndroidFolderBrowserPath] = useState("");
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
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [crashReport, setCrashReport] = useState<CrashReport | null>(null);
  const [isCrashReportOpen, setIsCrashReportOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isNarrowLayout, setIsNarrowLayout] = useState(false);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [isExtensionsCollapsed, setIsExtensionsCollapsed] = useState(true);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const { undoStack, setUndoStack, pushUndo } = useUndoHistory();
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const hasAutoLoadedFolderRef = useRef(false);
  const currentFileIdRef = useRef<string | null>(null);
  const skipAutoExpandCurrentFileRef = useRef(false);
  const suppressAutoExpandForSortRef = useRef(false);
  const suppressAutoExpandForGroupModeRef = useRef(false);
  const visibleFileOrderRef = useRef<string[]>([]);
  const visibleIndexByIdRef = useRef<Map<string, number>>(new Map());
  const previousExtensionsRef = useRef<string[]>([]);
  const hasUserAdjustedExtensionsRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const fileListFrameRef = useRef<HTMLDivElement | null>(null);
  const fileListPositionRef = useRef<{ top: number; selectedId?: string }>({
    top: 0,
  });
  const fileListScrollRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLElement | null>(null);
  const lastStatusRef = useRef<string | null>(null);
  const lastEventLoopLagRef = useRef<number | null>(null);
  const scanBatchQueue = useMemo(
    () =>
      createScanBatchQueue((batch) =>
        setFiles((previous) => previous.concat(batch)),
      ),
    [],
  );
  const cancelPendingScanBatchFlush = scanBatchQueue.reset;
  const queueScanBatchFiles = scanBatchQueue.enqueue;
  useEffect(() => {
    if (!isLoading) cancelPendingScanBatchFlush();
  }, [isLoading, cancelPendingScanBatchFlush]);
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
    if (!isAndroidApp && currentFolderToken) {
      setLastFolder(currentFolderToken);
    }
  }, [currentFolderToken, isAndroidApp]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const handleChange = () => setIsNarrowLayout(mediaQuery.matches);
    handleChange();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (isNarrowLayout) {
      setIsSidebarCollapsed(true);
    }
  }, [isNarrowLayout]);

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
    void getDesktopWindow()
      .minimize()
      .catch(() => {});
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
    void getDesktopWindow()
      .close()
      .catch(() => {});
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

  useScrollHints(fileListScrollRef, fileListFrameRef, !isSidebarCollapsed);
  useScrollHints(previewScrollRef, previewFrameRef);

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
    enabled: !isLoading,
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
    resetSuggestionsState();
    setCollapsedGroups({});
    setCollapsedFolders({});
  }, [cancelPendingScanBatchFlush, resetSuggestionsState]);

  const applyScanResult = useCallback(
    (folderLabel: string, folderToken: string, result: ScanResult) => {
      cancelPendingScanBatchFlush();
      resetSelectionToFirstRef.current = true;
      const uniqueFiles = dedupeFileEntries(result.files);
      const nextCollapsedGroups = buildInitialCollapsedGroups(
        uniqueFiles,
        effectiveGroupMode,
      );
      const nextCollapsedFolders = buildInitialCollapsedFolders(
        uniqueFiles,
        folderLabel,
      );
      setFiles(uniqueFiles);
      setCurrentFolder(folderLabel);
      setCurrentFolderToken(folderToken);
      currentFileIdRef.current = null;
      skipAutoExpandCurrentFileRef.current =
        viewMode === "tree" && Object.keys(nextCollapsedFolders).length > 0;
      setCurrentIndex(0);
      resetSuggestionsState();
      setCollapsedGroups(nextCollapsedGroups);
      setCollapsedFolders(nextCollapsedFolders);
      updateStatus(
        `Loaded ${uniqueFiles.length} items from ${folderLabel}.${result.issues?.length ? ` ${result.issues.length} scan issue(s): ${result.issues[0].message}` : ""}`,
      );
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
    (request: ScanCacheRequest, folderLabel: string) => {
      setLastScanFilterMode(request.filterMode);
      setScanCachePrompt(null);
      return scan(request, folderLabel, {
        reset: resetScanViewState,
        apply: applyScanResult,
        updateStatus,
        cache: !isAndroidApp,
      });
    },
    [scan, resetScanViewState, applyScanResult, updateStatus, isAndroidApp],
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
      applyScanResult(cachedScan.folderPath, cachedScan.folderPath, {
        files: cachedScan.files,
        total: cachedScan.total,
      });
    },
    [applyScanResult, resetCancelScanWorkflow, runScanWorkflow, updateStatus],
  );

  const handleScan = useCallback(
    async (target?: PickedDirectory | string) => {
      const resolvedTarget =
        typeof target === "string" ? { token: target, label: target } : target;
      if (!resolvedTarget) {
        updateStatus("No folder selected.");
        return;
      }
      const request = buildScanCacheRequest(resolvedTarget.token);
      setScanCachePrompt(null);
      if (!isAndroidApp) {
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
      }
      await runFreshScan(request, resolvedTarget.label);
    },
    [buildScanCacheRequest, isAndroidApp, runFreshScan, updateStatus],
  );

  const dismissScanCachePrompt = useCallback(() => {
    setScanCachePrompt(null);
    updateStatus("Scan cancelled.");
  }, [updateStatus]);

  const cancelActiveScan = useCallback(
    () => cancel(updateStatus),
    [cancel, updateStatus],
  );

  const pickFolder = useCallback(async () => {
    try {
      if (isAndroidApp) {
        updateStatus(ANDROID_FOLDER_PICKER_HINT);
        const selected = await openAndroidFolderBrowser(
          currentFolderToken ?? undefined,
        );
        if (selected) {
          setCurrentFolder(selected.label);
          setCurrentFolderToken(selected.token);
          if (autoScanOnPick) {
            void handleScan(selected);
          } else {
            updateStatus("Folder selected. Click search to scan.");
          }
        } else {
          updateStatus(`No folder selected. ${ANDROID_FOLDER_PICKER_HINT}`);
        }
        return;
      }
      const selected = await pickManagedDirectory();
      if (selected) {
        setCurrentFolder(selected.label);
        setCurrentFolderToken(selected.token);
        if (autoScanOnPick) {
          void handleScan(selected);
        } else {
          updateStatus("Folder selected. Click search to scan.");
        }
      } else {
        updateStatus("No folder selected.");
      }
    } catch (error) {
      updateStatus(
        isAndroidApp
          ? `Folder picker failed: ${String(error)} ${ANDROID_FOLDER_PICKER_HINT}`
          : `Folder picker failed: ${String(error)}`,
      );
    }
  }, [
    autoScanOnPick,
    currentFolderToken,
    handleScan,
    isAndroidApp,
    openAndroidFolderBrowser,
    updateStatus,
  ]);

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
    (slotIndex: number, destination: PickedDirectory) => {
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

  const pickDestinationForSlot = useCallback(
    async (slotIndex: number) => {
      try {
        if (isAndroidApp) {
          updateStatus(ANDROID_FOLDER_PICKER_HINT);
          const selected = await openAndroidFolderBrowser(
            destinationSlotTokens[slotIndex] ?? undefined,
          );
          if (selected) {
            updateDestinationSlot(slotIndex, selected);
            updateStatus(
              `Destination ${slotIndex + 1} set to ${selected.label}.`,
            );
            return selected;
          }
          updateStatus(
            `No destination selected. ${ANDROID_FOLDER_PICKER_HINT}`,
          );
          return null;
        }
        const selected = await pickManagedDirectory();
        if (selected) {
          updateDestinationSlot(slotIndex, selected);
          updateStatus(
            `Destination ${slotIndex + 1} set to ${selected.label}.`,
          );
          return selected;
        }
        updateStatus(
          isAndroidApp
            ? `No destination selected. ${ANDROID_FOLDER_PICKER_HINT}`
            : "No destination selected.",
        );
      } catch (error) {
        updateStatus(
          isAndroidApp
            ? `Destination picker failed: ${String(error)} ${ANDROID_FOLDER_PICKER_HINT}`
            : `Destination picker failed: ${String(error)}`,
        );
      }
      return null;
    },
    [
      destinationSlotTokens,
      isAndroidApp,
      openAndroidFolderBrowser,
      updateDestinationSlot,
      updateStatus,
    ],
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
        // Removing entries preserves their existing sort order.
        const sortedNext = sortedPrev.filter(
          (file) => !removedSet.has(file.id),
        );
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

  const removeFileById = useCallback(
    (removedId: string) => removeFilesByIds([removedId]),
    [removeFilesByIds],
  );

  const restoreFileEntries = useCallback(
    (restored: FileEntry[]) => {
      setFiles((prev) => {
        const existingIds = new Set(prev.map((file) => file.id));
        const added = restored.filter((file) => {
          if (existingIds.has(file.id)) return false;
          existingIds.add(file.id);
          return true;
        });
        if (!added.length) return prev;
        const next = prev.concat(added);
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
        return next;
      });
    },
    [selectedExtensionsSet, sortFiles],
  );
  const restoreFileEntry = useCallback(
    (file: FileEntry) => restoreFileEntries([file]),
    [restoreFileEntries],
  );

  const requestDeletion = useCallback(
    async (
      message: string,
      path: string,
      permanent: boolean,
      target: { id?: string; folderPath?: string },
    ) => {
      let reason: string | null;
      try {
        reason = await invokeCommand<string | null>(
          "deletion_path_warning",
          target,
        );
      } catch (error) {
        updateStatus(`Unable to check deletion safety: ${String(error)}`);
        return null;
      }
      const needsConfirmation = Boolean(reason) || confirmTrash || permanent;
      if (
        needsConfirmation &&
        !(await confirmDialog(
          reason
            ? `${message}\n\nThis location may contain system or application files. Removing it could stop your system or an app from working.\n\n${reason}`
            : message,
          {
            title: reason
              ? "Delete from a protected location?"
              : permanent
                ? "Permanently delete?"
                : "Move to trash?",
            confirmLabel: permanent ? "Delete permanently" : "Move to trash",
            danger: true,
            detail: path,
          },
        ))
      )
        return null;
      return Boolean(reason);
    },
    [confirmDialog, confirmTrash, updateStatus],
  );

  const trashCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const allowUnsafe = await requestDeletion(
      trashBehavior === "permanent"
        ? `Permanently delete ${currentFile.name}? This cannot be undone.`
        : `Move ${currentFile.name} to system trash?`,
      currentFile.path,
      trashBehavior === "permanent",
      { id: currentFile.id },
    );
    if (allowUnsafe === null) return;
    await runMutationWithSpinner(
      trashBehavior === "permanent" ? "Deleting…" : "Trashing…",
      async () => {
        try {
          const result = await invokeCommand<TrashResult>("trash_file", {
            id: currentFile.id,
            trashMode: trashBehavior,
            allowPermanentDelete: trashBehavior === "permanent",
            allowUnsafe,
          });
          removeFileById(currentFile.id);
          if (result.trashPath) {
            pushUndo({
              kind: "trash",
              allowUnsafe,
              file: currentFile,
              fromPath: currentFile.path,
              trashPath: result.trashPath,
              destinationToken: result.restoreDestination ?? null,
            });
          }
          const baseMessage =
            trashBehavior === "permanent"
              ? `Deleted ${currentFile.name}.`
              : isAndroidApp
                ? `Removed ${currentFile.name}.`
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
    requestDeletion,
    currentFile,
    removeFileById,
    updateStatus,
    pushUndo,
    trashBehavior,
    runMutationWithSpinner,
    isAndroidApp,
  ]);

  const permanentlyDeleteCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const allowUnsafe = await requestDeletion(
      `Permanently delete ${currentFile.name}? This cannot be undone.`,
      currentFile.path,
      true,
      { id: currentFile.id },
    );
    if (allowUnsafe === null) return;
    await runMutationWithSpinner("Deleting…", async () => {
      try {
        await invokeCommand<TrashResult>("trash_file", {
          id: currentFile.id,
          trashMode: "permanent",
          allowPermanentDelete: true,
          allowUnsafe,
        });
        removeFileById(currentFile.id);
        // Permanent delete doesn't create a trash path, so no undo
        updateStatus(`Permanently deleted ${currentFile.name}.`);
      } catch (error) {
        updateStatus(`Delete failed: ${String(error)}`);
      }
    });
  }, [
    requestDeletion,
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
      if (isAndroidApp) {
        updateStatus("Folder trash is not available on Android yet.");
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
      const base = currentFolder.replace(/[\\/]+$/, "");
      const fullFolderPath = `${base}/${folderPath}`;
      const allowUnsafe = await requestDeletion(
        `${trashBehavior === "permanent" ? "Permanently delete" : "Move to trash"} ${folderLabel} and all its contents? This includes files hidden by the current filters.${trashBehavior === "permanent" ? " This cannot be undone." : ""}`,
        fullFolderPath,
        trashBehavior === "permanent",
        { folderPath: fullFolderPath },
      );
      if (allowUnsafe === null) return;
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
              allowPermanentDelete: trashBehavior === "permanent",
              allowUnsafe,
            });
            removeFilesByIds(folderFiles.map((file) => file.id));
            if (result.trashPath) {
              pushUndo({
                kind: "trash-folder",
                allowUnsafe,
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
      requestDeletion,
      currentFolder,
      getFolderFiles,
      isAndroidApp,
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
      let destinationToken = destinationSlotTokens[slotIndex] ?? null;
      let destinationLabel = destinationSlots[slotIndex] ?? null;
      if (!destinationToken || !destinationLabel) {
        if (allowPickIfMissing) {
          const selected = await pickDestinationForSlot(slotIndex);
          destinationToken = selected?.token ?? null;
          destinationLabel = selected?.label ?? null;
        } else {
          updateStatus(`Destination ${slotIndex + 1} not set.`);
          return;
        }
      }
      if (!destinationToken || !destinationLabel) {
        return;
      }
      await runMutationWithSpinner("Moving…", async () => {
        try {
          await invokeCommand("set_destination", {
            destination: destinationToken,
            label: destinationLabel,
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
            sourceToken: result.restoreSource ?? null,
            destinationToken: result.restoreDestination ?? null,
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
      destinationSlotTokens,
      pickDestinationForSlot,
      removeFileById,
      updateStatus,
      pushUndo,
      runMutationWithSpinner,
    ],
  );

  const openFileInFinder = useCallback(
    async (file: FileEntry) => {
      if (isAndroidApp) {
        updateStatus("Reveal in file manager is not available on Android yet.");
        return;
      }
      try {
        await revealInFileManager({
          path: file.path,
          reveal: true,
        });
      } catch (error) {
        updateStatus(`Reveal in file manager failed: ${String(error)}`);
      }
    },
    [isAndroidApp, updateStatus],
  );

  const openFileInSystem = useCallback(
    async (file: FileEntry) => {
      if (isAndroidApp) {
        updateStatus("Open in another app is not available on Android yet.");
        return;
      }
      try {
        await revealInFileManager({
          path: file.path,
          reveal: false,
        });
      } catch (error) {
        updateStatus(`Open file failed: ${String(error)}`);
      }
    },
    [isAndroidApp, updateStatus],
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isConfirming || undoFailure || isLoading || scanCachePrompt) return;
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
    isConfirming,
    undoFailure,
    isLoading,
    scanCachePrompt,
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
      {isWindowsDesktop && (
        <div className="titlebar-drag" data-tauri-drag-region />
      )}
      <Toolbar
        isSidebarCollapsed={isSidebarCollapsed}
        isDrawerMode={isDrawerMode}
        isSettingsOpen={isSettingsOpen}
        showSettingsButton={!isAndroidApp}
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
            gesture={swipeGesture}
            isAndroidApp={isAndroidApp}
            isSettingsOpen={isSettingsOpen}
            canOpenFile={!isAndroidApp}
            onOpenSettings={() => setIsSettingsOpen(true)}
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
            {(mutationSpinnerLabel || !isGestureMode) && (
              <div
                className={`action-row${isGestureMode ? " gesture-mode" : ""}`}
              >
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
                {!isGestureMode && (
                  <>
                    <button
                      className="action-button action-prev"
                      type="button"
                      onClick={goPrev}
                      disabled={!canGoPrev}
                    >
                      Prev ←
                    </button>
                    <button
                      className="action-button action-undo"
                      type="button"
                      onClick={undoLastAction}
                      disabled={!canUndoLastAction}
                    >
                      Undo ↓
                    </button>
                    <button
                      className="action-button action-next"
                      type="button"
                      onClick={goNext}
                      disabled={!canGoNext}
                    >
                      Next →
                    </button>
                    <button
                      className="action-button action-trash"
                      type="button"
                      onClick={trashCurrent}
                      disabled={!canTrashCurrent}
                    >
                      Trash ↑
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </footer>
        {isGestureMode && isAndroidApp && (
          <PreviewGestureLegend gesture={swipeGesture} />
        )}
      </div>

      {undoFailure && (
        <Modal
          labelledBy="undo-error-title"
          describedBy="undo-error-message"
          className="confirmation-modal"
          backdropClassName="confirmation-backdrop"
          alert
          onClose={() => setUndoFailure(null)}
        >
          <div className="modal-header">
            <h2 id="undo-error-title" className="modal-title">
              Couldn’t complete undo
            </h2>
          </div>
          <div className="modal-body">
            <p id="undo-error-message" className="dialog-message">
              {undoFailure.message}
            </p>
            <p className="dialog-message">
              The undo action is saved for retry. Check that the original folder
              is available and the NAS is connected. Existing files will not be
              overwritten.
            </p>
            <p className="dialog-path">
              Restore to: {undoFailure.destinationPath}
            </p>
            <p className="dialog-path">
              Recovery source: {undoFailure.sourcePath}
            </p>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              data-dialog-initial-focus
              onClick={() => setUndoFailure(null)}
            >
              Close
            </button>
            <button
              type="button"
              className="dialog-primary"
              onClick={() => {
                setUndoFailure(null);
                void undoLastAction();
              }}
            >
              Retry undo
            </button>
          </div>
        </Modal>
      )}
      {confirmation}
      {activeBlockingOverlay && (
        <Modal
          labelledBy="progress-title"
          describedBy="progress-description"
          className="progress-modal"
          backdropClassName="blocking-overlay"
          onClose={activeBlockingOverlay.onClose}
        >
          {activeBlockingOverlay.showClose && activeBlockingOverlay.onClose && (
            <button
              type="button"
              className="icon-button blocking-overlay-close"
              onClick={activeBlockingOverlay.onClose}
              aria-label="Close previous scan dialog"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
              </svg>
            </button>
          )}
          {activeBlockingOverlay.showSpinner && (
            <div className="spinner" aria-hidden="true" />
          )}
          <h2 id="progress-title" className="modal-title">
            {activeBlockingOverlay.title}
          </h2>
          <div
            id="progress-description"
            className="dialog-message"
            role="status"
            aria-live="polite"
          >
            {activeBlockingOverlay.subtitle}
          </div>
          {isLoading && (
            <p className="dialog-path" title={currentFolder ?? undefined}>
              {currentFolder}
            </p>
          )}
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
        </Modal>
      )}

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
