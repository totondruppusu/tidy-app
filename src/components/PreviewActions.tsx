import type { FileEntry } from "../types";
import type { PreviewController } from "../hooks/usePreviewController";
import { MATERIAL_ICONS } from "../lib/materialIcons";

type PreviewActionsProps = {
  previewFile: FileEntry | null;
  canOpenFile: boolean;
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  isInfoOpen: boolean;
  shouldUseAndroidFloatingInfo: boolean;
  preview: PreviewController;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onOpenFile: (file: FileEntry) => void | Promise<void>;
  onToggleInfo: () => void;
};

export const PreviewActions = ({
  previewFile,
  canOpenFile,
  isSidebarCollapsed,
  isSettingsOpen,
  isInfoOpen,
  shouldUseAndroidFloatingInfo,
  preview,
  onToggleSidebar,
  onOpenSettings,
  onOpenFile,
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
        className="preview-action-button"
        disabled={!canOpenFile}
        onClick={() => void onOpenFile(previewFile)}
        title={
          canOpenFile
            ? "Open file in the system default app"
            : "Opening files in external apps is not available on Android yet"
        }
      >
        Open file
      </button>
      {shouldUseAndroidFloatingInfo && (
        <button
          type="button"
          className="icon-button preview-bar-button"
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
      )}
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
