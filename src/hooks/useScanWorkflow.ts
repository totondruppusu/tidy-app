import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invokeCommand } from "../lib/desktopBridge";
import { dedupeFileEntries } from "../lib/files";
import { groupFilesByMode } from "../lib/grouping";
import { buildFileTree, getFolderCollapseKey } from "../lib/tree";
import { pickManagedDirectory } from "../services/directoryService";
import { ANDROID_FOLDER_PICKER_HINT } from "../services/platform";
import type {
  CachedScan,
  FileEntry,
  FilterMode,
  GroupMode,
  PickedDirectory,
  ScanProgress,
  ScanResult,
  TreeNode,
  ViewMode,
} from "../types";

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

type ScanCallbacks = {
  reset: () => void;
  apply: (label: string, token: string, result: ScanResult) => void;
  updateStatus: (message: string) => void;
  cache: boolean;
};

type UseScanWorkflowOptions = {
  isAndroidApp: boolean;
  filterMode: FilterMode;
  includeSubfolders: boolean;
  includeHidden: boolean;
  useHashForDuplicates: boolean;
  duplicateMinSizeBytes: number;
  autoScanOnPick: boolean;
  viewMode: ViewMode;
  effectiveGroupMode: GroupMode;
  currentFolderToken: string | null;
  initialFolder: string | null;
  updateStatus: (message: string) => void;
  setFiles: Dispatch<SetStateAction<FileEntry[]>>;
  setCurrentFolder: (value: string) => void;
  setCurrentFolderToken: (value: string) => void;
  setCollapsedGroups: Dispatch<SetStateAction<Record<string, boolean>>>;
  setCollapsedFolders: Dispatch<SetStateAction<Record<string, boolean>>>;
  setCurrentIndex: Dispatch<SetStateAction<number>>;
  setLastScanFilterMode: Dispatch<SetStateAction<FilterMode | null>>;
  resetSelectionToFirstRef: MutableRefObject<boolean>;
  currentFileIdRef: MutableRefObject<string | null>;
  skipAutoExpandCurrentFileRef: MutableRefObject<boolean>;
  streamedBatchesRef: MutableRefObject<boolean>;
  cancelPendingScanBatchFlush: () => void;
  resetSuggestionsState: () => void;
  scan: (
    request: ScanCacheRequest,
    folderLabel: string,
    callbacks: ScanCallbacks,
  ) => Promise<void>;
  cancel: (updateStatus: (message: string) => void) => Promise<void>;
  runScanWorkflow: <Result>(
    operation: () => Promise<Result>,
    callbacks?: { onError?: (message: string) => void },
  ) => Promise<Result | null>;
  activeScanId: MutableRefObject<string | null>;
  setScanProgress: Dispatch<SetStateAction<ScanProgress | null>>;
  resetCancelScanWorkflow: () => void;
  openAndroidFolderBrowser: (
    initialPath?: string,
  ) => Promise<PickedDirectory | null>;
};

export function useScanWorkflow({
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
}: UseScanWorkflowOptions) {
  const [scanCachePrompt, setScanCachePrompt] =
    useState<ScanCachePromptState | null>(null);
  const hasAutoLoadedFolderRef = useRef(false);

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
    streamedBatchesRef.current = false;
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
      // A scan is complete here (batched or single-shot, including cached
      // loads), so the final list may be sorted again on the next render.
      // Reset the streaming flag so a later cached-scan load doesn't briefly
      // show an unsorted list while isLoading is still true.
      streamedBatchesRef.current = false;
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

  return {
    scanCachePrompt,
    runFreshScan,
    loadCachedScan,
    handleScan,
    dismissScanCachePrompt,
    cancelActiveScan,
    pickFolder,
    buildInitialCollapsedGroups,
  };
}
