import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

type FilterMode = "all" | "images" | "videos" | "images_videos";

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

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
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

const extractFolder = (path: string) => {
  const match = path.match(/^(.*)[\\/][^\\/]+$/);
  return match ? match[1] : path;
};

export default function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState("Select a folder to begin.");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(true);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [renderCount, setRenderCount] = useState(0);
  const activeScanId = useRef<string | null>(null);
  const listItemRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  const currentFile = files[currentIndex];
  const hasFiles = files.length > 0;

  const updateStatus = useCallback((message: string) => {
    setStatus(message);
  }, []);

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
        updateStatus(includeSubfolders ? "Scanning folders and subfolders..." : "Scanning folder...");
        const result = await invoke<ScanResult>("scan_folder", {
          folderPath,
          filterMode,
          includeSubfolders,
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
    [filterMode, includeSubfolders, updateStatus]
  );

  const pickFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await handleScan(selected);
      } else {
        updateStatus("No folder selected.");
      }
    } catch (error) {
      updateStatus(`Folder picker failed: ${String(error)}`);
    }
  }, [handleScan, updateStatus]);

  const pickDestination = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setDestination(selected);
        await invoke("set_destination", { destination: selected });
        updateStatus(`Move destination set to ${selected}.`);
      } else {
        updateStatus("No destination selected.");
      }
    } catch (error) {
      updateStatus(`Destination picker failed: ${String(error)}`);
    }
  }, [updateStatus]);

  const adjustIndexAfterRemoval = useCallback(
    (removedIndex: number) => {
      setFiles((prev) => {
        const next = prev.filter((_, index) => index !== removedIndex);
        setCurrentIndex((current) => {
          if (current > removedIndex) {
            return current - 1;
          }
          if (current === removedIndex) {
            return current >= next.length ? Math.max(next.length - 1, 0) : current;
          }
          return current;
        });
        return next;
      });
    },
    []
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
      await invoke("trash_file", { id: currentFile.id });
      adjustIndexAfterRemoval(currentIndex);
      updateStatus(`Moved ${currentFile.name} to trash.`);
    } catch (error) {
      updateStatus(`Trash failed: ${String(error)}`);
    }
  }, [adjustIndexAfterRemoval, confirmTrash, currentFile, currentIndex, updateStatus]);

  const moveCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    let destinationPath = destination;
    if (!destinationPath) {
      try {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === "string") {
          destinationPath = selected;
          setDestination(selected);
          await invoke("set_destination", { destination: selected });
        }
      } catch (error) {
        updateStatus(`Destination picker failed: ${String(error)}`);
        return;
      }
    }
    if (!destinationPath) {
      updateStatus("Move destination not set.");
      return;
    }
    try {
      const newName = await invoke<string>("move_file", { id: currentFile.id });
      adjustIndexAfterRemoval(currentIndex);
      updateStatus(`Moved to ${destinationPath}/${newName}.`);
    } catch (error) {
      updateStatus(`Move failed: ${String(error)}`);
    }
  }, [adjustIndexAfterRemoval, currentFile, currentIndex, destination, updateStatus]);

  const goNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < files.length - 1 ? prev + 1 : prev));
  }, [files.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : prev));
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
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
          void moveCurrent();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goNext, goPrev, moveCurrent, trashCurrent]);

  useEffect(() => {
    if (currentFolder) {
      void handleScan(currentFolder);
    }
  }, [currentFolder, filterMode, handleScan, includeSubfolders]);

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
    if (files.length === 0) {
      setRenderCount(0);
      return;
    }
    setRenderCount((prev) => Math.min(prev, files.length));
    let cancelled = false;
    const step = () => {
      if (cancelled) {
        return;
      }
      setRenderCount((prev) => {
        if (prev >= files.length) {
          return prev;
        }
        const next = Math.min(prev + 200, files.length);
        if (next < files.length) {
          requestAnimationFrame(step);
        }
        return next;
      });
    };
    requestAnimationFrame(step);
    return () => {
      cancelled = true;
    };
  }, [files.length]);

  useEffect(() => {
    if (currentIndex + 1 > renderCount) {
      setRenderCount(Math.min(currentIndex + 1, files.length));
    }
  }, [currentIndex, renderCount, files.length]);

  const visibleFiles = useMemo(() => files.slice(0, renderCount), [files, renderCount]);

  const listItems = useMemo(() => {
    return visibleFiles.map((file, index) => (
      <button
        key={file.id}
        className={`file-item ${index === currentIndex ? "active" : ""}`}
        onClick={() => setCurrentIndex(index)}
        ref={(node) => listItemRefs.current.set(file.id, node)}
        type="button"
        disabled={isLoading}
      >
        <span className={`badge badge-${file.kind}`}>{file.kind}</span>
        <span className="filename">{file.name}</span>
      </button>
    ));
  }, [visibleFiles, currentIndex, isLoading]);

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

  const isRenderingList = renderCount < files.length;
  const progressPercent =
    isLoading && scanProgress && scanProgress.total
      ? Math.min(100, Math.round((scanProgress.scanned / scanProgress.total) * 100))
      : null;

  return (
    <div className={`app-shell ${isLoading ? "is-loading" : ""}`}>
      <header className="toolbar">
        <button type="button" onClick={pickFolder} disabled={isLoading}>
          Select folder…
        </button>
        <div className="filters">
          <label>
            <span>Filter</span>
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
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={includeSubfolders}
              onChange={(event) => setIncludeSubfolders(event.target.checked)}
              disabled={isLoading}
            />
            Include subfolders
          </label>
        </div>
        <button type="button" onClick={pickDestination} disabled={isLoading}>
          Set move destination…
        </button>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmTrash}
            onChange={(event) => setConfirmTrash(event.target.checked)}
            disabled={isLoading}
          />
          Confirm before trash
        </label>
        <div className="spacer" />
        <div className="status">{status}</div>
      </header>

      <main className="content">
        <aside className="list-panel">
          <div className="list-header">
            <span>Files ({files.length})</span>
            <div className="list-header-actions">
              <button
                type="button"
                className="icon-button"
                onClick={() => currentFolder && handleScan(currentFolder)}
                disabled={isLoading || !currentFolder}
                aria-label="Refresh file list"
                title="Refresh"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M4 12a8 8 0 0 1 13.66-5.66l1.59-1.59V9h-4.25l1.47-1.47A6 6 0 1 0 18 12h2a8 8 0 0 1-16 0z" />
                </svg>
              </button>
              {isRenderingList && <span className="rendering">Rendering list...</span>}
            </div>
          </div>
          <div className={`file-list ${isLoading ? "loading" : ""}`}>
            {hasFiles ? (
              listItems
            ) : isLoading ? (
              <div className="skeleton-list" aria-hidden="true">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div key={`skeleton-${index}`} className="skeleton-item" />
                ))}
              </div>
            ) : (
              <div className="empty">No files loaded.</div>
            )}
            {isRenderingList && <div className="list-progress">Showing {renderCount} of {files.length}</div>}
          </div>
        </aside>
        <section className="preview-panel">
          {isLoading ? (
            <div className="loading-state">
              <div className="spinner" />
              <div className="loading-title">Scanning files</div>
              <div className="loading-subtitle">{loadingMessage ?? "Collecting file list..."}</div>
              <div
                className={`loading-meter ${progressPercent === null ? "indeterminate" : "determinate"}`}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent ?? undefined}
              >
                <span style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} />
              </div>
              <div className="loading-percent">
                {progressPercent === null ? "Preparing scan..." : `${progressPercent}%`}
              </div>
            </div>
          ) : currentFile ? (
            <div className="preview-content">
              <div className="preview-layout">
                <div className="preview-media">
                  {currentFile.kind === "image" && (
                    <img src={buildMediaUrl(currentFile.id)} alt={currentFile.name} />
                  )}
                  {currentFile.kind === "video" && (
                    <video controls src={buildMediaUrl(currentFile.id)} />
                  )}
                  {currentFile.kind === "other" && (
                    <div className="placeholder">No preview available for this file type.</div>
                  )}
                  <div className="caption">
                    {currentFile.name} ({currentIndex + 1}/{files.length})
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
                      <span className="meta-label">Full path</span>
                      <span className="meta-value mono">{currentFile.path}</span>
                    </div>
                    <div>
                      <span className="meta-label">Position</span>
                      <span className="meta-value">
                        {currentIndex + 1} of {files.length}
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

      <footer className="actions">
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
          disabled={!hasFiles || currentIndex >= files.length - 1 || isLoading}
        >
          Next (→)
        </button>
        <button type="button" onClick={trashCurrent} disabled={!hasFiles || isLoading}>
          Trash (↑)
        </button>
        <button type="button" onClick={moveCurrent} disabled={!hasFiles || isLoading}>
          Move (↓)
        </button>
      </footer>
    </div>
  );
}
