import { DestinationSlots } from "./DestinationSlots";
import { PreviewActions } from "./PreviewActions";
import { PreviewGestureLegend } from "./PreviewPanel";
import { MATERIAL_ICONS } from "../lib/materialIcons";
import type { FileEntry } from "../types";
import type { PreviewController } from "../hooks/usePreviewController";
import type { SwipeGestureController } from "../hooks/useSwipeGestureController";

type ActionBarProps = {
  destinationSlots: (string | null)[];
  areControlsDisabled: boolean;
  isMutating: boolean;
  mutationSpinnerLabel: string | null;
  isGestureMode: boolean;
  canGoPrev: boolean;
  canGoNext: boolean;
  canUndoLastAction: boolean;
  canTrashCurrent: boolean;
  goPrev: () => void;
  goNext: () => void;
  undoLastAction: () => void | Promise<void>;
  trashCurrent: () => void | Promise<void>;
  pickDestinationForSlot: (slotIndex: number) => void | Promise<unknown>;
  previewFile: FileEntry | null;
  preview: PreviewController;
  canOpenFolder: boolean;
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  isInfoOpen: boolean;
  shouldUseAndroidFloatingInfo: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onOpenFolder: (file: FileEntry) => void | Promise<void>;
  onShareFile: (file: FileEntry) => void | Promise<void>;
  onToggleInfo: () => void;
  gesture: SwipeGestureController;
};

export const ActionBar = ({
  destinationSlots,
  areControlsDisabled,
  isMutating,
  mutationSpinnerLabel,
  isGestureMode,
  canGoPrev,
  canGoNext,
  canUndoLastAction,
  canTrashCurrent,
  goPrev,
  goNext,
  undoLastAction,
  trashCurrent,
  pickDestinationForSlot,
  previewFile,
  preview,
  canOpenFolder,
  isSidebarCollapsed,
  isSettingsOpen,
  isInfoOpen,
  shouldUseAndroidFloatingInfo,
  onToggleSidebar,
  onOpenSettings,
  onOpenFolder,
  onShareFile,
  onToggleInfo,
  gesture,
}: ActionBarProps) => (
  <footer className="actions">
    <div className="actions-row">
      <div className="actions-primary">
        <PreviewActions
          previewFile={previewFile}
          canOpenFolder={canOpenFolder}
          isSidebarCollapsed={isSidebarCollapsed}
          isSettingsOpen={isSettingsOpen}
          isInfoOpen={isInfoOpen}
          shouldUseAndroidFloatingInfo={shouldUseAndroidFloatingInfo}
          preview={preview}
          onToggleSidebar={onToggleSidebar}
          onOpenSettings={onOpenSettings}
          onOpenFolder={onOpenFolder}
          onShareFile={onShareFile}
          onToggleInfo={onToggleInfo}
        />
        <DestinationSlots
          destinationSlots={destinationSlots}
          disabled={areControlsDisabled || isMutating}
          onPickDestination={pickDestinationForSlot}
        />
      </div>
      <div className="actions-navigation">
        {isGestureMode && <PreviewGestureLegend gesture={gesture} />}
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
                  aria-label="Prev ←"
                  title="Previous file"
                >
                  <span className="material-icon" aria-hidden="true">
                    {MATERIAL_ICONS.keyboardArrowLeft}
                  </span>
                </button>
                <button
                  className="action-button action-undo"
                  type="button"
                  onClick={undoLastAction}
                  disabled={!canUndoLastAction}
                  aria-label="Undo ↓"
                  title="Undo last action"
                >
                  <span className="material-icon" aria-hidden="true">
                    {MATERIAL_ICONS.undo}
                  </span>
                </button>
                <button
                  className="action-button action-next"
                  type="button"
                  onClick={goNext}
                  disabled={!canGoNext}
                  aria-label="Next →"
                  title="Next file"
                >
                  <span className="material-icon" aria-hidden="true">
                    {MATERIAL_ICONS.keyboardArrowRight}
                  </span>
                </button>
                <button
                  className="action-button action-trash"
                  type="button"
                  onClick={trashCurrent}
                  disabled={!canTrashCurrent}
                  aria-label="Trash ↑"
                  title="Move current file to trash"
                >
                  <span className="material-icon" aria-hidden="true">
                    {MATERIAL_ICONS.delete}
                  </span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  </footer>
);
