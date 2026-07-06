import type { LocalDirectoryEntry } from "../types";

type AndroidFolderBrowserModalProps = {
  isOpen: boolean;
  title: string;
  currentPath: string;
  parentPath: string | null;
  directories: LocalDirectoryEntry[];
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onNavigateUp: () => void;
  onOpenDirectory: (path: string) => void;
  onConfirm: () => void;
};

export const AndroidFolderBrowserModal = ({
  isOpen,
  title,
  currentPath,
  parentPath,
  directories,
  isLoading,
  error,
  onClose,
  onNavigateUp,
  onOpenDirectory,
  onConfirm,
}: AndroidFolderBrowserModalProps) => {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="modal-panel android-folder-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="android-folder-browser-title"
      >
        <div className="modal-header">
          <h2 id="android-folder-browser-title" className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close folder browser"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
            </svg>
          </button>
        </div>
        <div className="modal-body android-folder-browser-body">
          <div className="android-folder-browser-toolbar">
            <button
              type="button"
              onClick={onNavigateUp}
              disabled={!parentPath || isLoading}
            >
              Up
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isLoading}
            >
              Use this folder
            </button>
          </div>
          <div className="android-folder-browser-path">{currentPath}</div>
          <div className="android-folder-browser-list">
            {error ? (
              <div className="android-folder-browser-state">{error}</div>
            ) : isLoading ? (
              <div className="android-folder-browser-state">Loading folders...</div>
            ) : directories.length === 0 ? (
              <div className="android-folder-browser-state">
                No subfolders here.
              </div>
            ) : (
              directories.map((directory) => (
                <button
                  key={directory.path}
                  type="button"
                  className="android-folder-entry"
                  onClick={() => onOpenDirectory(directory.path)}
                >
                  <span className="android-folder-entry-label">
                    {directory.label}
                  </span>
                  <span className="android-folder-entry-chevron" aria-hidden="true">
                    <svg viewBox="0 0 20 20" focusable="false">
                      <path d="M7.2 4.8a1 1 0 0 1 1.4 0l4.5 4.5a1 1 0 0 1 0 1.4l-4.5 4.5a1 1 0 1 1-1.4-1.4L11 10 7.2 6.2a1 1 0 0 1 0-1.4Z" />
                    </svg>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
