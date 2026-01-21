import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

type FilterMode = "all" | "images" | "videos" | "images_videos";
type SortMode = "name" | "size" | "date";
type DensityMode = "comfortable" | "compact";
type GroupMode = "none" | "type" | "extension";
type ThemeMode = "light" | "dark";

type FileEntry = {
  id: string;
  name: string;
  kind: "image" | "video" | "other";
  path: string;
  sizeBytes: number;
  modifiedMs: number | null;
  mime: string;
};

type ScanResult = {
  files: FileEntry[];
  total: number;
};

type ScanProgress = {
  scanId: string;
  scanned: number;
  matched: number;
  total: number;
  phase: "indexing" | "scanning";
};

type ScanBatch = {
  scanId: string;
  files: FileEntry[];
};

type MoveResult = {
  newName: string;
  targetPath: string;
};

type TrashResult = {
  trashPath: string;
};

type UndoAction =
  | {
      kind: "move";
      file: FileEntry;
      fromPath: string;
      toPath: string;
    }
  | {
      kind: "trash";
      file: FileEntry;
      fromPath: string;
      trashPath: string;
    };

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
};

const shouldOpenOnEnter = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return true;
  }
  if (target === document.body || target === document.documentElement) {
    return true;
  }
  return Boolean(target.closest(".file-list"));
};

const buildMediaUrl = (id: string) => `media://localhost/${id}`;

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) {
    return "Unknown";
  }
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  const display = value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${display} ${units[index]}`;
};

const formatTimestamp = (timestamp: number | null) => {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return "Unknown";
  }
  return new Date(timestamp).toLocaleString();
};

const formatGroupLabel = (kind: FileEntry["kind"]) => {
  switch (kind) {
    case "image":
      return "Images";
    case "video":
      return "Videos";
    default:
      return "Other files";
  }
};

const formatPathLabel = (path: string | null) => {
  if (!path) {
    return "Not set";
  }
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

const getExtension = (name: string) => {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return "none";
  }
  return name.slice(lastDot + 1).toLowerCase();
};

const formatExtensionLabel = (extension: string) => {
  if (extension === "none") {
    return "No extension";
  }
  return `.${extension}`;
};

const formatGroupTitle = (mode: GroupMode, key: string) => {
  if (mode === "extension") {
    return formatExtensionLabel(key);
  }
  return formatGroupLabel(key as FileEntry["kind"]);
};

const DESTINATION_SLOT_COUNT = 5;

const extractFolder = (path: string) => {
  const match = path.match(/^(.*)[\\/][^\\/]+$/);
  return match ? match[1] : path;
};

const getInitialTheme = (): ThemeMode => {
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

export default function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [, setStatus] = useState("Select a folder to begin.");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [destinationSlots, setDestinationSlots] = useState<(string | null)[]>(() =>
    Array.from({ length: DESTINATION_SLOT_COUNT }, () => null)
  );
  const [confirmTrash, setConfirmTrash] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [groupMode, setGroupMode] = useState<GroupMode>("none");
  const [listDensity, setListDensity] = useState<DensityMode>("comfortable");
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [renderCount, setRenderCount] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [lastAction, setLastAction] = useState<UndoAction | null>(null);
  const activeScanId = useRef<string | null>(null);
  const listItemRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const previousExtensionsRef = useRef<string[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("tidy-theme", theme);
  }, [theme]);

  useEffect(() => {
    const applyWindowTheme = async () => {
      if (!isTauri()) {
        return;
      }
      try {
        await getCurrentWindow().setTheme(theme === "dark" ? "Dark" : "Light");
      } catch (error) {
        console.warn("Failed to sync window theme.", error);
      }
    };
    void applyWindowTheme();
  }, [theme]);

  const updateStatus = useCallback((message: string) => {
    setStatus(message);
  }, []);

  const sortFiles = useCallback(
    (list: FileEntry[]) => {
      const next = [...list];
      next.sort((a, b) => {
        if (sortMode === "size") {
          return b.sizeBytes - a.sizeBytes;
        }
        if (sortMode === "date") {
          return (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0);
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return next;
    },
    [sortMode]
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

  useEffect(() => {
    setSelectedExtensions((current) => {
      if (allExtensions.length === 0) {
        return [];
      }
      const prev = previousExtensionsRef.current;
      const hadAllSelected =
        prev.length > 0 && prev.every((extension) => current.includes(extension)) && current.length >= prev.length;
      if (current.length === 0 || hadAllSelected) {
        return allExtensions;
      }
      return current.filter((extension) => allExtensions.includes(extension));
    });
    previousExtensionsRef.current = allExtensions;
  }, [allExtensions]);

  const filteredFiles = useMemo(() => {
    if (selectedExtensions.length === 0) {
      return [];
    }
    const allowed = new Set(selectedExtensions);
    return files.filter((file) => allowed.has(getExtension(file.name)));
  }, [files, selectedExtensions]);

  const sortedFiles = useMemo(() => sortFiles(filteredFiles), [filteredFiles, sortFiles]);
  const currentFile = sortedFiles[currentIndex];
  const hasFiles = sortedFiles.length > 0;

  useEffect(() => {
    if (sortedFiles.length === 0) {
      if (currentIndex !== 0) {
        setCurrentIndex(0);
      }
      return;
    }
    if (currentIndex >= sortedFiles.length) {
      setCurrentIndex(sortedFiles.length - 1);
    }
  }, [currentIndex, sortedFiles.length]);

  const handleScan = useCallback(
    async (folderPath?: string) => {
      if (!folderPath) {
        updateStatus("No folder selected.");
        return;
      }
      try {
        const scanId = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
        activeScanId.current = scanId;
        setIsLoading(true);
        setScanProgress({ scanId, scanned: 0, matched: 0, total: 0, phase: "indexing" });
        setFiles([]);
        setCurrentIndex(0);
        setRenderCount(0);
        setLastAction(null);
        updateStatus(includeSubfolders ? "Scanning folders and subfolders..." : "Scanning folder...");
        const result = await invoke<ScanResult>("scan_folder", {
          folderPath,
          filterMode,
          includeSubfolders,
          includeHidden,
          scanId
        });
        setFiles(result.files);
        setCurrentFolder(folderPath);
        updateStatus(`Loaded ${result.files.length} items from ${folderPath}.`);
      } catch (error) {
        updateStatus(`Scan failed: ${String(error)}`);
      } finally {
        setIsLoading(false);
      }
    },
    [filterMode, includeSubfolders, includeHidden, updateStatus]
  );

  const pickFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setCurrentFolder(selected);
        updateStatus("Folder selected. Click search to scan.");
      } else {
        updateStatus("No folder selected.");
      }
    } catch (error) {
      updateStatus(`Folder picker failed: ${String(error)}`);
    }
  }, [handleScan, updateStatus]);

  const updateDestinationSlot = useCallback((slotIndex: number, destination: string) => {
    setDestinationSlots((prev) => {
      const next = [...prev];
      next[slotIndex] = destination;
      return next;
    });
  }, []);

  const pickDestinationForSlot = useCallback(
    async (slotIndex: number) => {
      try {
        const selected = await open({ directory: true, multiple: false });
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
    [updateDestinationSlot, updateStatus]
  );

  const removeFileById = useCallback(
    (removedId: string) => {
      setFiles((prev) => {
        const allowed = new Set(selectedExtensions);
        const filterByExtension = (file: FileEntry) => allowed.has(getExtension(file.name));
        const sortedPrev = sortFiles(prev.filter(filterByExtension));
        const removedIndex = sortedPrev.findIndex((file) => file.id === removedId);
        const next = prev.filter((file) => file.id !== removedId);
        const sortedNext = sortFiles(next.filter(filterByExtension));
        setCurrentIndex((current) => {
          if (removedIndex === -1) {
            return current;
          }
          if (current > removedIndex) {
            return current - 1;
          }
          if (current === removedIndex) {
            return current >= sortedNext.length ? Math.max(sortedNext.length - 1, 0) : current;
          }
          return current;
        });
        return next;
      });
    },
    [selectedExtensions, sortFiles]
  );

  const restoreFileEntry = useCallback(
    (restored: FileEntry) => {
      setFiles((prev) => {
        if (prev.some((file) => file.id === restored.id)) {
          return prev;
        }
        const next = [...prev, restored];
        const allowed = new Set(selectedExtensions);
        const filterByExtension = (file: FileEntry) => allowed.has(getExtension(file.name));
        const sortedNext = sortFiles(next.filter(filterByExtension));
        const restoredIndex = sortedNext.findIndex((file) => file.id === restored.id);
        if (restoredIndex !== -1) {
          setCurrentIndex(restoredIndex);
        }
        return next;
      });
    },
    [selectedExtensions, sortFiles]
  );

  const trashCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const shouldTrash = confirmTrash
      ? await confirm(`Move ${currentFile.name} to trash?`, { title: "Confirm trash" })
      : true;
    if (!shouldTrash) {
      return;
    }
    try {
      const result = await invoke<TrashResult>("trash_file", { id: currentFile.id });
      removeFileById(currentFile.id);
      setLastAction({
        kind: "trash",
        file: currentFile,
        fromPath: currentFile.path,
        trashPath: result.trashPath,
      });
      updateStatus(`Moved ${currentFile.name} to trash.`);
    } catch (error) {
      updateStatus(`Trash failed: ${String(error)}`);
    }
  }, [confirmTrash, currentFile, removeFileById, updateStatus, setLastAction]);

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
      try {
        await invoke("set_destination", { destination: destinationPath });
        const result = await invoke<MoveResult>("move_file", { id: currentFile.id });
        removeFileById(currentFile.id);
        setLastAction({
          kind: "move",
          file: currentFile,
          fromPath: currentFile.path,
          toPath: result.targetPath,
        });
        updateStatus(`Moved to ${result.targetPath}.`);
      } catch (error) {
        updateStatus(`Move failed: ${String(error)}`);
      }
    },
    [currentFile, destinationSlots, pickDestinationForSlot, removeFileById, updateStatus, setLastAction]
  );

  const moveCurrent = useCallback(async () => {
    await moveCurrentToSlot(0, true);
  }, [moveCurrentToSlot]);

  const openFileInFinder = useCallback(
    async (file: FileEntry) => {
      try {
        await invoke("reveal_in_file_manager", { path: file.path, reveal: true });
      } catch (error) {
        updateStatus(`Open in Finder failed: ${String(error)}`);
      }
    },
    [updateStatus]
  );

  const openCurrentInFinder = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    await openFileInFinder(currentFile);
  }, [currentFile, openFileInFinder, updateStatus]);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < sortedFiles.length - 1 ? prev + 1 : prev));
  }, [sortedFiles.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, []);

  const undoLastAction = useCallback(async () => {
    if (!lastAction) {
      updateStatus("Nothing to undo.");
      return;
    }
    const sourcePath = lastAction.kind === "move" ? lastAction.toPath : lastAction.trashPath;
    try {
      await invoke("restore_file", {
        id: lastAction.file.id,
        source: sourcePath,
        destination: lastAction.fromPath,
      });
      restoreFileEntry(lastAction.file);
      setLastAction(null);
      updateStatus(`Undid ${lastAction.kind}.`);
    } catch (error) {
      updateStatus(`Undo failed: ${String(error)}`);
    }
  }, [lastAction, restoreFileEntry, updateStatus, setLastAction]);

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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
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
      if ((event.code === "Space" || event.key === " ") && currentFile?.kind === "video") {
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
          void trashCurrent();
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
    isSettingsOpen,
    moveCurrentToSlot,
    openCurrentInFinder,
    toggleVideoPlayback,
    trashCurrent,
    undoLastAction,
  ]);

  useEffect(() => {
    let isMounted = true;
    const unlistenPromise = listen<ScanProgress>("scan_progress", (event) => {
      if (!isMounted) {
        return;
      }
      if (event.payload.scanId !== activeScanId.current) {
        return;
      }
      setScanProgress(event.payload);
    });
    const unlistenBatchPromise = listen<ScanBatch>("scan_batch", (event) => {
      if (!isMounted) {
        return;
      }
      if (event.payload.scanId !== activeScanId.current) {
        return;
      }
      setFiles((prev) => [...prev, ...event.payload.files]);
    });
    return () => {
      isMounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
      void unlistenBatchPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (sortedFiles.length === 0) {
      setRenderCount(0);
      return;
    }
    setRenderCount((prev) => Math.min(prev, sortedFiles.length));
    let cancelled = false;
    const step = () => {
      if (cancelled) {
        return;
      }
      setRenderCount((prev) => {
        if (prev >= sortedFiles.length) {
          return prev;
        }
        const next = Math.min(prev + 200, sortedFiles.length);
        if (next < sortedFiles.length) {
          requestAnimationFrame(step);
        }
        return next;
      });
    };
    requestAnimationFrame(step);
    return () => {
      cancelled = true;
    };
  }, [sortedFiles.length]);

  useEffect(() => {
    if (currentIndex + 1 > renderCount) {
      setRenderCount(Math.min(currentIndex + 1, sortedFiles.length));
    }
  }, [currentIndex, renderCount, sortedFiles.length]);

  const visibleFiles = useMemo(() => sortedFiles.slice(0, renderCount), [sortedFiles, renderCount]);

  const listItems = useMemo(() => {
    const renderButton = (file: FileEntry, index: number) => (
      <button
        key={file.id}
        className={`file-item ${index === currentIndex ? "active" : ""}`}
        onClick={() => setCurrentIndex(index)}
        onDoubleClick={() => void openFileInFinder(file)}
        ref={(node) => listItemRefs.current.set(file.id, node)}
        type="button"
        disabled={isLoading}
      >
        <span className={`badge badge-${file.kind}`}>{file.kind}</span>
        <span className="filename">{file.name}</span>
      </button>
    );

    if (groupMode === "none") {
      return visibleFiles.map((file, index) => renderButton(file, index));
    }

    const indexMap = new Map<string, number>();
    visibleFiles.forEach((file, index) => {
      indexMap.set(file.id, index);
    });

    const groups = new Map<string, FileEntry[]>();
    visibleFiles.forEach((file) => {
      const key = groupMode === "extension" ? getExtension(file.name) : file.kind;
      const bucket = groups.get(key) ?? [];
      bucket.push(file);
      groups.set(key, bucket);
    });

    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (groupMode === "type") {
        const order = ["image", "video", "other"];
        return order.indexOf(a) - order.indexOf(b);
      }
      if (a === "none") {
        return 1;
      }
      if (b === "none") {
        return -1;
      }
      return a.localeCompare(b);
    });
    const items: JSX.Element[] = [];
    keys.forEach((key) => {
      const groupFiles = groups.get(key);
      if (!groupFiles || groupFiles.length === 0) {
        return;
      }
      items.push(
        <div key={`${groupMode}-${key}`} className="list-section">
          <div className="list-section-title">{formatGroupTitle(groupMode, key)}</div>
          <div className="list-section-items">
            {groupFiles.map((file) => {
              const index = indexMap.get(file.id) ?? 0;
              return renderButton(file, index);
            })}
          </div>
        </div>
      );
    });
    return items;
  }, [visibleFiles, currentIndex, isLoading, groupMode, openFileInFinder]);

  useEffect(() => {
    if (!currentFile) {
      return;
    }
    const node = listItemRefs.current.get(currentFile.id);
    if (!node) {
      return;
    }
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: "nearest" });
    });
  }, [currentFile, renderCount]);

  const loadingMessage = useMemo(() => {
    if (!isLoading || !scanProgress) {
      return null;
    }
    if (scanProgress.phase === "indexing") {
      return `Indexing ${scanProgress.scanned} files...`;
    }
    const percent = scanProgress.total
      ? Math.min(100, Math.round((scanProgress.scanned / scanProgress.total) * 100))
      : 0;
    return `Scanning ${percent}% · ${scanProgress.scanned}/${scanProgress.total} files · ${scanProgress.matched} matched`;
  }, [isLoading, scanProgress]);

  const isRenderingList = renderCount < sortedFiles.length;
  const progressPercent =
    isLoading && scanProgress && scanProgress.total
      ? Math.min(100, Math.round((scanProgress.scanned / scanProgress.total) * 100))
      : null;
  const totalFiles = files.length;
  const filteredCount = sortedFiles.length;
  const folderLabel = currentFolder ? formatPathLabel(currentFolder) : "No folder selected";
  const folderSizeBytes = useMemo(
    () => files.reduce((total, file) => total + file.sizeBytes, 0),
    [files]
  );

  return (
    <div className={`app-shell ${isLoading ? "is-loading" : ""}`}>
      <div className="app-grid">
        <aside className="list-panel">
          <div className="list-top-controls">
            <button
              type="button"
              className="pill-button"
              onClick={pickFolder}
              disabled={isLoading}
              title={currentFolder ?? "No folder selected"}
            >
              <span className="pill-label">Folder</span>
              <span className="pill-value">{currentFolder ? folderLabel : "Select folder…"}</span>
            </button>
            <div className="toolbar-control">
              <span className="control-label">Filter</span>
              <select
                value={filterMode}
                onChange={(event) => setFilterMode(event.target.value as FilterMode)}
                disabled={isLoading}
              >
                <option value="all">All files</option>
                <option value="images">Images only</option>
                <option value="videos">Videos only</option>
                <option value="images_videos">Images + Videos</option>
              </select>
            </div>
            <button
              type="button"
              className="icon-button search-button"
              onClick={() => handleScan(currentFolder ?? undefined)}
              disabled={isLoading || !currentFolder}
              aria-label="Scan folder"
              title="Scan folder"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M15.5 14h-.79l-.28-.27a6 6 0 1 0-.71.71l.27.28v.79L20 20.5 21.5 19l-6-5zM10 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" />
              </svg>
            </button>
          </div>
          <div className="list-header">
            <span>
              Files ({filteredCount}
              {filteredCount !== totalFiles ? `/${totalFiles}` : ""})
            </span>
            <div className="list-header-actions">
              {isRenderingList && <span className="rendering">Rendering list...</span>}
            </div>
          </div>
          <div
            className={`file-list ${isLoading ? "loading" : ""} ${
              listDensity === "compact" ? "density-compact" : "density-comfortable"
            }`}
          >
            {hasFiles ? (
              listItems
            ) : isLoading ? (
              <div className="skeleton-list" aria-hidden="true">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div key={`skeleton-${index}`} className="skeleton-item" />
                ))}
              </div>
            ) : (
              <div className="empty">
                {totalFiles === 0 ? "No files loaded." : "No files match the selected extensions."}
              </div>
            )}
            {isRenderingList && <div className="list-progress">Showing {renderCount} of {filteredCount}</div>}
          </div>
          <div className="list-footer">
            <div className="footer-title">Extensions</div>
            {allExtensions.length === 0 ? (
              <div className="extensions-empty">No extensions found.</div>
            ) : (
              <div className="extension-filters">
                {allExtensions.map((extension) => (
                  <label key={extension} className="extension-filter">
                    <input
                      type="checkbox"
                      checked={selectedExtensions.includes(extension)}
                      onChange={() => {
                        setSelectedExtensions((current) =>
                          current.includes(extension)
                            ? current.filter((value) => value !== extension)
                            : [...current, extension]
                        );
                      }}
                      disabled={isLoading}
                    />
                    <span>{formatExtensionLabel(extension)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </aside>

        <header className="toolbar">
          <div className="toolbar-group toolbar-actions">
          <div className="toolbar-control">
            <span className="control-label">Sort</span>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              disabled={isLoading}
            >
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="date">Date</option>
            </select>
          </div>
          <div className="toolbar-control">
            <span className="control-label">Group</span>
            <select
              value={groupMode}
              onChange={(event) => setGroupMode(event.target.value as GroupMode)}
              disabled={isLoading}
            >
              <option value="none">None</option>
              <option value="type">Type</option>
              <option value="extension">Extension</option>
            </select>
          </div>
          <button
            type="button"
            className={`pill-button pill-toggle${confirmTrash ? "" : " is-warning"}`}
            onClick={() => setConfirmTrash((prev) => !prev)}
            aria-pressed={confirmTrash}
            disabled={isLoading}
          >
            <span className="pill-label">Trash alert</span>
            <span className="pill-value">{confirmTrash ? "On" : "Off"}</span>
          </button>
          <button
            type="button"
            className="icon-button settings-button"
            onClick={() => setIsSettingsOpen(true)}
            aria-label="Open settings"
            aria-haspopup="dialog"
            aria-expanded={isSettingsOpen}
          >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="24" height="24">
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.57.23-1.12.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.61 7.86a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.4 1.05.71 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.57-.23 1.12-.54 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
          </svg>
          </button>
        </div>
        </header>

        <main className="content">
          <section className="preview-panel">
          {isLoading ? (
            <div className="loading-state">
              <div className="spinner" />
              <div className="loading-title">Scanning files</div>
              <div className="loading-subtitle">{loadingMessage ?? "Collecting file list..."}</div>
            </div>
          ) : currentFile ? (
            <div className="preview-content">
              <div className="preview-layout">
                <div className="preview-media">
                  {currentFile.kind === "image" && (
                    <img src={buildMediaUrl(currentFile.id)} alt={currentFile.name} />
                  )}
                  {currentFile.kind === "video" && (
                    <video ref={videoRef} controls src={buildMediaUrl(currentFile.id)} />
                  )}
                  {currentFile.kind === "other" && (
                    <div className="placeholder">No preview available for this file type.</div>
                  )}
                  <div className="caption">
                    {currentFile.name} ({currentIndex + 1}/{filteredCount})
                  </div>
                </div>
                <aside className="preview-details" aria-label="File details">
                  <div className="file-meta">
                    <div>
                      <span className="meta-label">Name</span>
                      <span className="meta-value">{currentFile.name}</span>
                    </div>
                    <div>
                      <span className="meta-label">Type</span>
                      <span className="meta-value">{currentFile.kind}</span>
                    </div>
                    <div>
                      <span className="meta-label">Extension</span>
                      <span className="meta-value">
                        {currentFile.name.includes(".") ? `.${currentFile.name.split(".").pop()}` : "None"}
                      </span>
                    </div>
                    <div>
                      <span className="meta-label">MIME</span>
                      <span className="meta-value">{currentFile.mime}</span>
                    </div>
                    <div>
                      <span className="meta-label">Size</span>
                      <span className="meta-value">{formatBytes(currentFile.sizeBytes)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Modified</span>
                      <span className="meta-value">{formatTimestamp(currentFile.modifiedMs)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Folder</span>
                      <span className="meta-value">{extractFolder(currentFile.path)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Folder size</span>
                      <span className="meta-value">{formatBytes(folderSizeBytes)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Full path</span>
                      <span className="meta-value mono">{currentFile.path}</span>
                    </div>
                    <div>
                      <span className="meta-label">Position</span>
                      <span className="meta-value">
                        {currentIndex + 1} of {filteredCount}
                      </span>
                    </div>
                    <div>
                      <span className="meta-label">ID</span>
                      <span className="meta-value mono">{currentFile.id}</span>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          ) : (
            <div className="placeholder">Select a folder to preview files.</div>
          )}
          </section>
        </main>
      </div>

      <footer className="actions">
        <div className="actions-row">
          <div className="destination-row" aria-label="Move destinations">
            {destinationSlots.map((destinationPath, index) => (
              <button
                key={`destination-${index}`}
                type="button"
                className={`destination-button ${destinationPath ? "is-set" : "is-empty"}`}
                onClick={() => void pickDestinationForSlot(index)}
                disabled={isLoading}
                title={destinationPath ?? `Set destination ${index + 1}`}
                aria-label={`Set destination ${index + 1}`}
              >
                <span className="destination-index">{index + 1}</span>
                <span className="destination-label">
                  {destinationPath ? formatPathLabel(destinationPath) : "Set folder…"}
                </span>
              </button>
            ))}
          </div>
          <div className="action-row">
            <button
              type="button"
              onClick={goPrev}
              disabled={!hasFiles || currentIndex === 0 || isLoading}
            >
              Prev (←)
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={!hasFiles || currentIndex >= filteredCount - 1 || isLoading}
            >
              Next (→)
            </button>
            <button type="button" onClick={trashCurrent} disabled={!hasFiles || isLoading}>
              Trash (↑)
            </button>
            <button type="button" onClick={undoLastAction} disabled={!lastAction || isLoading}>
              Undo (↓)
            </button>
          </div>
        </div>
      </footer>

      {isSettingsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-header">
              <h2 id="settings-title" className="modal-title">
                Settings
              </h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Close settings"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Filter mode</div>
                  <div className="setting-subtitle">Choose which files appear in the list.</div>
                </div>
                <select
                  value={filterMode}
                  onChange={(event) => setFilterMode(event.target.value as FilterMode)}
                  disabled={isLoading}
                >
                  <option value="all">All files</option>
                  <option value="images">Images only</option>
                  <option value="videos">Videos only</option>
                  <option value="images_videos">Images + Videos</option>
                </select>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Include subfolders</div>
                  <div className="setting-subtitle">Scan nested directories when choosing a folder.</div>
                </div>
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={includeSubfolders}
                    onChange={(event) => setIncludeSubfolders(event.target.checked)}
                    disabled={isLoading}
                  />
                  <span>{includeSubfolders ? "On" : "Off"}</span>
                </label>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Include hidden items</div>
                  <div className="setting-subtitle">Show dotfiles and hidden folders in scans.</div>
                </div>
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={includeHidden}
                    onChange={(event) => setIncludeHidden(event.target.checked)}
                    disabled={isLoading}
                  />
                  <span>{includeHidden ? "On" : "Off"}</span>
                </label>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Trash alert</div>
                  <div className="setting-subtitle">Show a confirmation dialog before deleting.</div>
                </div>
                <label className={`setting-toggle${confirmTrash ? "" : " is-warning"}`}>
                  <input
                    type="checkbox"
                    checked={confirmTrash}
                    onChange={(event) => setConfirmTrash(event.target.checked)}
                    disabled={isLoading}
                  />
                  <span>{confirmTrash ? "On" : "Off"}</span>
                </label>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">List density</div>
                  <div className="setting-subtitle">Control how compact the file list appears.</div>
                </div>
                <select
                  value={listDensity}
                  onChange={(event) => setListDensity(event.target.value as DensityMode)}
                  disabled={isLoading}
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Dark mode</div>
                  <div className="setting-subtitle">Switch to a darker color palette.</div>
                </div>
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={theme === "dark"}
                    onChange={(event) => setTheme(event.target.checked ? "dark" : "light")}
                    disabled={isLoading}
                  />
                  <span>{theme === "dark" ? "On" : "Off"}</span>
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setIsSettingsOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
