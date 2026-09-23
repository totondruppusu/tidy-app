import type { FileEntry } from "../types";
import type { PreviewController } from "../hooks/usePreviewController";
import { MATERIAL_ICONS } from "../lib/materialIcons";

type PreviewActionsProps = {
  previewFile: FileEntry | null;
  canOpenFolder: boolean;
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  isInfoOpen: boolean;
  shouldUseAndroidFloatingInfo: boolean;
  preview: PreviewController;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onOpenFolder: (file: FileEntry) => void | Promise<void>;
  onShareFile: (file: FileEntry) => void | Promise<void>;
  onToggleInfo: () => void;
};

export const PreviewActions = ({
  previewFile,
  canOpenFolder,
  isSidebarCollapsed,
  isSettingsOpen,
  isInfoOpen,
  shouldUseAndroidFloatingInfo,
  preview,
  onToggleSidebar,
  onOpenSettings,
  onOpenFolder,
  onShareFile,
  onToggleInfo,
}: PreviewActionsProps) => {
  const sidebarButton = isSidebarCollapsed ? (
    <button
      type="button"
      className="icon-button preview-bar-button"
      onClick={onToggleSidebar}
      aria-label="Show sidebar"
      aria-controls="sidebar-panel"
      title="Show sidebar"
    >
      <span className="material-icon" aria-hidden="true">
        {MATERIAL_ICONS.search}
      </span>
    </button>
  ) : null;
  const settingsButton = (
    <button
      type="button"
      className="icon-button preview-bar-button"
      onClick={onOpenSettings}
      aria-label="Open settings"
      aria-haspopup="dialog"
      aria-expanded={isSettingsOpen}
      title="Open settings"
    >
      <span className="material-icon" aria-hidden="true">
        {MATERIAL_ICONS.settings}
      </span>
    </button>
  );

  if (!previewFile) {
    return (
      <div className="preview-actions" role="group" aria-label="Preview controls">
        {sidebarButton}
        {settingsButton}
      </div>
    );
  }

  return (
    <div className="preview-actions">
      {sidebarButton}
      {settingsButton}
      <button
        type="button"
        className={`icon-button preview-bar-button preview-info-button${
          shouldUseAndroidFloatingInfo ? " is-always-visible" : ""
        }`}
        aria-label={isInfoOpen ? "Hide file details" : "Show file details"}
        aria-expanded={isInfoOpen}
        aria-controls="preview-details-sheet"
        onClick={onToggleInfo}
        title={isInfoOpen ? "Hide file details" : "Show file details"}
      >
        <span className="material-icon" aria-hidden="true">
          {MATERIAL_ICONS.info}
        </span>
      </button>
      <button
        type="button"
        className="icon-button preview-bar-button"
        disabled={!canOpenFolder}
        onClick={() => void onOpenFolder(previewFile)}
        aria-label="Open containing folder"
        title={
          canOpenFolder
            ? "Open containing folder in the file manager"
            : "Opening a file's folder is not available on Android yet"
        }
      >
        <span className="material-icon" aria-hidden="true">
          {MATERIAL_ICONS.folderOpen}
        </span>
      </button>
      <button
        type="button"
        className="icon-button preview-bar-button"
        onClick={() => void onShareFile(previewFile)}
        aria-label="Share file"
        title="Share file"
      >
        <span className="material-icon" aria-hidden="true">
          {MATERIAL_ICONS.share}
        </span>
      </button>
      <div className="preview-zoom-controls">
        <button
          type="button"
          className="icon-button"
          onClick={preview.handleZoomOut}
          disabled={!preview.isZoomablePreview}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <span className="material-icon" aria-hidden="true">
            {MATERIAL_ICONS.zoomOut}
          </span>
        </button>
        <button
          type="button"
          className="icon-button preview-zoom-reset"
          onClick={preview.handleZoomReset}
          disabled={!preview.isZoomablePreview}
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          <span className="preview-zoom-value">
            {Math.round(preview.previewZoom * 100)}%
          </span>
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={preview.handleZoomIn}
          disabled={!preview.isZoomablePreview}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <span className="material-icon" aria-hidden="true">
            {MATERIAL_ICONS.zoomIn}
          </span>
        </button>
      </div>
    </div>
  );
};
