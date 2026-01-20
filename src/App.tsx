import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";

type FilterMode = "all" | "images" | "videos" | "images_videos";

type FileEntry = {
  id: string;
  name: string;
  kind: "image" | "video" | "other";
};

type ScanResult = {
  files: FileEntry[];
  total: number;
};

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
};

const buildMediaUrl = (id: string) => `media://localhost/${id}`;

export default function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState("Select a folder to begin.");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(true);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);

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
        const result = await invoke<ScanResult>("scan_folder", {
          folderPath,
          filterMode,
          includeSubfolders
        });
        setFiles(result.files);
        setCurrentIndex(0);
        setCurrentFolder(folderPath);
        updateStatus(`Loaded ${result.files.length} items from ${folderPath}.`);
      } catch (error) {
        updateStatus(`Scan failed: ${String(error)}`);
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
        return next;
      });
      setCurrentIndex((prev) => {
        if (prev > removedIndex) {
          return prev - 1;
        }
        if (prev === removedIndex && prev > 0) {
          return prev - 1;
        }
        return 0;
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

  const listItems = useMemo(() => {
    return files.map((file, index) => (
      <button
        key={file.id}
        className={`file-item ${index === currentIndex ? "active" : ""}`}
        onClick={() => setCurrentIndex(index)}
        type="button"
      >
        <span className={`badge badge-${file.kind}`}>{file.kind}</span>
        <span className="filename">{file.name}</span>
      </button>
    ));
  }, [files, currentIndex]);

  return (
    <div className="app-shell">
      <header className="toolbar">
        <button type="button" onClick={pickFolder}>
          Select folder…
        </button>
        <div className="filters">
          <label>
            <span>Filter</span>
            <select value={filterMode} onChange={(event) => setFilterMode(event.target.value as FilterMode)}>
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
            />
            Include subfolders
          </label>
        </div>
        <button type="button" onClick={pickDestination}>
          Set move destination…
        </button>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmTrash}
            onChange={(event) => setConfirmTrash(event.target.checked)}
          />
          Confirm before trash
        </label>
        <div className="spacer" />
        <div className="status">{status}</div>
      </header>

      <main className="content">
        <aside className="list-panel">
          <div className="list-header">Files ({files.length})</div>
          <div className="file-list">{hasFiles ? listItems : <div className="empty">No files loaded.</div>}</div>
        </aside>
        <section className="preview-panel">
          {currentFile ? (
            <div className="preview-content">
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
          ) : (
            <div className="placeholder">Select a folder to preview files.</div>
          )}
        </section>
      </main>

      <footer className="actions">
        <button type="button" onClick={goPrev} disabled={!hasFiles || currentIndex === 0}>
          Prev (←)
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={!hasFiles || currentIndex >= files.length - 1}
        >
          Next (→)
        </button>
        <button type="button" onClick={trashCurrent} disabled={!hasFiles}>
          Trash (↑)
        </button>
        <button type="button" onClick={moveCurrent} disabled={!hasFiles}>
          Move (↓)
        </button>
      </footer>
    </div>
  );
}
