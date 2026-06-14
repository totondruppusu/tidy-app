import { useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type {
  DensityMode,
  ExtensionFilterMode,
  GroupMode,
  SortMode,
  ThemeMode,
  TrashBehavior,
  ViewMode,
} from "../types";
import { DUPLICATE_MIN_SIZE_OPTIONS, LARGE_PREVIEW_SIZE_BYTES } from "../constants/appConstants";
import { formatBytes } from "../lib/format";

type SettingsModalProps = {
  isOpen: boolean;
  isLoading: boolean;
  layout: {
    viewMode: ViewMode;
    setViewMode: Dispatch<SetStateAction<ViewMode>>;
    sortMode: SortMode;
    setSortMode: Dispatch<SetStateAction<SortMode>>;
    displayGroupMode: GroupMode;
    handleGroupModeChange: (value: GroupMode) => void;
    shouldGroupDuplicates: boolean;
    extensionFilterMode: ExtensionFilterMode;
    setExtensionFilterMode: Dispatch<SetStateAction<ExtensionFilterMode>>;
    listDensity: DensityMode;
    setListDensity: Dispatch<SetStateAction<DensityMode>>;
  };
  scanning: {
    autoScanOnPick: boolean;
    setAutoScanOnPick: Dispatch<SetStateAction<boolean>>;
    rememberLastFolder: boolean;
    setRememberLastFolder: Dispatch<SetStateAction<boolean>>;
    includeSubfolders: boolean;
    setIncludeSubfolders: Dispatch<SetStateAction<boolean>>;
    includeHidden: boolean;
    setIncludeHidden: Dispatch<SetStateAction<boolean>>;
  };
  cleanup: {
    useHashForDuplicates: boolean;
    setUseHashForDuplicates: Dispatch<SetStateAction<boolean>>;
    duplicateMinSizeBytes: number;
    setDuplicateMinSizeBytes: Dispatch<SetStateAction<number>>;
    trashBehavior: TrashBehavior;
    setTrashBehavior: Dispatch<SetStateAction<TrashBehavior>>;
    confirmTrash: boolean;
    setConfirmTrash: Dispatch<SetStateAction<boolean>>;
  };
  preview: {
    autoPlayMedia: boolean;
    setAutoPlayMedia: Dispatch<SetStateAction<boolean>>;
    skipLargePreviews: boolean;
    setSkipLargePreviews: Dispatch<SetStateAction<boolean>>;
  };
  appearance: {
    theme: ThemeMode;
    setTheme: Dispatch<SetStateAction<ThemeMode>>;
  };
  onClose: () => void;
  onOpenHelp: () => void;
  settingsFrameRef: RefObject<HTMLDivElement>;
  settingsBodyRef: RefObject<HTMLDivElement>;
};

export const SettingsModal = ({
  isOpen,
  isLoading,
  layout,
  scanning,
  cleanup,
  preview,
  appearance,
  onClose,
  onOpenHelp,
  settingsFrameRef,
  settingsBodyRef,
}: SettingsModalProps) => {
  if (!isOpen) {
    return null;
  }

  const [openSections, setOpenSections] = useState({
    layout: false,
    scanning: false,
    cleanup: false,
    playback: false,
  });

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  };

  const renderSection = (
    section: keyof typeof openSections,
    title: string,
    subtitle: string,
    children: ReactNode,
  ) => {
    const contentId = `settings-section-${section}`;
    const isExpanded = openSections[section];

    return (
      <section className={`settings-section${isExpanded ? " is-expanded" : ""}`}>
        <button
          type="button"
          className="settings-section-header"
          onClick={() => toggleSection(section)}
          aria-expanded={isExpanded}
          aria-controls={contentId}
        >
          <div>
            <h3 className="settings-section-title">{title}</h3>
            <p className="settings-section-subtitle">{subtitle}</p>
          </div>
          <span className="settings-section-chevron" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path d="M7.2 4.8a1 1 0 0 1 1.4 0l4.5 4.5a1 1 0 0 1 0 1.4l-4.5 4.5a1 1 0 1 1-1.4-1.4L11 10 7.2 6.2a1 1 0 0 1 0-1.4Z" />
            </svg>
          </span>
        </button>
        {isExpanded ? (
          <div id={contentId} className="settings-section-content">
            {children}
          </div>
        ) : null}
      </section>
    );
  };

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
        className="modal-panel settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-header">
          <h2 id="settings-title" className="modal-title">
            Settings
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
            </svg>
          </button>
        </div>
        <div className="settings-scroll-frame scroll-hints" ref={settingsFrameRef}>
          <div className="modal-body" ref={settingsBodyRef}>
            <div className="settings-grid">
              {renderSection(
                "layout",
                "Layout and defaults",
                "Define how the list starts and appears.",
                <>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Start view</div>
                    <div className="setting-subtitle">Choose the default file list layout.</div>
                  </div>
                  <select
                    value={layout.viewMode}
                    onChange={(event) =>
                      layout.setViewMode(event.target.value as ViewMode)
                    }
                    disabled={isLoading}
                  >
                    <option value="tree">Tree</option>
                    <option value="list">List</option>
                  </select>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Default sort</div>
                    <div className="setting-subtitle">Set the initial sort order.</div>
                  </div>
                  <select
                    value={layout.sortMode}
                    onChange={(event) =>
                      layout.setSortMode(event.target.value as SortMode)
                    }
                    disabled={isLoading}
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
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Default grouping</div>
                    <div className="setting-subtitle">Choose how files are grouped on load.</div>
                  </div>
                  <select
                    value={layout.displayGroupMode}
                    onChange={(event) =>
                      layout.handleGroupModeChange(event.target.value as GroupMode)
                    }
                    disabled={isLoading || layout.shouldGroupDuplicates}
                  >
                    <option value="none">None</option>
                    <option value="type">Type</option>
                    <option value="extension">Extension</option>
                    {layout.shouldGroupDuplicates && (
                      <option value="duplicates">Duplicates</option>
                    )}
                  </select>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Extension defaults</div>
                    <div className="setting-subtitle">Set the initial extension filter selection.</div>
                  </div>
                  <select
                    value={layout.extensionFilterMode}
                    onChange={(event) =>
                      layout.setExtensionFilterMode(
                        event.target.value as ExtensionFilterMode,
                      )
                    }
                    disabled={isLoading}
                  >
                    <option value="all">All extensions</option>
                    <option value="remember">Remember last selection</option>
                    <option value="common">Common types</option>
                  </select>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">List density</div>
                    <div className="setting-subtitle">Control how compact the file list appears.</div>
                  </div>
                  <select
                    value={layout.listDensity}
                    onChange={(event) =>
                      layout.setListDensity(event.target.value as DensityMode)
                    }
                    disabled={isLoading}
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </div>
                </>,
              )}
              {renderSection(
                "scanning",
                "Scanning",
                "Control what gets picked up on import.",
                <>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Auto-scan on pick</div>
                    <div className="setting-subtitle">Start scanning as soon as a folder is chosen.</div>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={scanning.autoScanOnPick}
                      onChange={(event) =>
                        scanning.setAutoScanOnPick(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{scanning.autoScanOnPick ? "On" : "Off"}</span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Remember last folder</div>
                    <div className="setting-subtitle">Reopen the most recent folder at launch.</div>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={scanning.rememberLastFolder}
                      onChange={(event) =>
                        scanning.setRememberLastFolder(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{scanning.rememberLastFolder ? "On" : "Off"}</span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Include subfolders</div>
                    <div className="setting-subtitle">Scan nested directories when choosing a folder.</div>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={scanning.includeSubfolders}
                      onChange={(event) =>
                        scanning.setIncludeSubfolders(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{scanning.includeSubfolders ? "On" : "Off"}</span>
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
                      checked={scanning.includeHidden}
                      onChange={(event) =>
                        scanning.setIncludeHidden(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{scanning.includeHidden ? "On" : "Off"}</span>
                  </label>
                </div>
                </>,
              )}
              {renderSection(
                "cleanup",
                "Duplicates and cleanup",
                "Tune accuracy and deletion behavior.",
                <>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Duplicate matching</div>
                    <div className="setting-subtitle">Use hashes for accurate duplicate detection.</div>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={cleanup.useHashForDuplicates}
                      onChange={(event) =>
                        cleanup.setUseHashForDuplicates(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{cleanup.useHashForDuplicates ? "On" : "Off"}</span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Duplicate size threshold</div>
                    <div className="setting-subtitle">Ignore files smaller than this size.</div>
                  </div>
                  <select
                    value={cleanup.duplicateMinSizeBytes}
                    onChange={(event) =>
                      cleanup.setDuplicateMinSizeBytes(
                        Number(event.target.value),
                      )
                    }
                    disabled={isLoading}
                  >
                    {DUPLICATE_MIN_SIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Trash behavior</div>
                    <div className="setting-subtitle">System trash supports up to 20 undo actions.</div>
                  </div>
                  <select
                    value={cleanup.trashBehavior}
                    onChange={(event) =>
                      cleanup.setTrashBehavior(
                        event.target.value as TrashBehavior,
                      )
                    }
                    disabled={isLoading}
                  >
                    <option value="system">System trash (undoable)</option>
                    <option value="permanent">Permanent delete</option>
                  </select>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Trash alert</div>
                    <div className="setting-subtitle">
                      {cleanup.trashBehavior === "permanent"
                        ? "Permanent delete always asks for confirmation."
                        : "Show a confirmation dialog before deleting."}
                    </div>
                  </div>
                  <label
                    className={`setting-toggle${
                      cleanup.confirmTrash ? "" : " is-warning"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={cleanup.confirmTrash}
                      onChange={(event) =>
                        cleanup.setConfirmTrash(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{cleanup.confirmTrash ? "On" : "Off"}</span>
                  </label>
                </div>
                </>,
              )}
              {renderSection(
                "playback",
                "Playback and appearance",
                "Media behavior and theme preferences.",
                <>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Auto-play media</div>
                    <div className="setting-subtitle">Start videos and audio automatically.</div>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={preview.autoPlayMedia}
                      onChange={(event) =>
                        preview.setAutoPlayMedia(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{preview.autoPlayMedia ? "On" : "Off"}</span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Skip large previews</div>
                    <div className="setting-subtitle">
                      Disable previews over {formatBytes(LARGE_PREVIEW_SIZE_BYTES)}.
                    </div>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={preview.skipLargePreviews}
                      onChange={(event) =>
                        preview.setSkipLargePreviews(event.target.checked)
                      }
                      disabled={isLoading}
                    />
                    <span>{preview.skipLargePreviews ? "On" : "Off"}</span>
                  </label>
                </div>
                <div className="settings-row">
                  <div className="setting-info">
                    <div className="setting-title">Dark mode</div>
                    <div className="setting-subtitle">Switch to a darker color palette.</div>
                  </div>
                  <label className="setting-toggle">
                    <input
                      type="checkbox"
                      checked={appearance.theme === "dark"}
                      onChange={(event) =>
                        appearance.setTheme(
                          event.target.checked ? "dark" : "light",
                        )
                      }
                      disabled={isLoading}
                    />
                    <span>{appearance.theme === "dark" ? "On" : "Off"}</span>
                  </label>
                </div>
                </>,
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer modal-footer-settings">
          <button type="button" className="help-button" onClick={onOpenHelp}>
            Help & Shortcuts
          </button>
        </div>
      </div>
    </div>
  );
};
