import { DestinationSlots } from "./DestinationSlots";

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
}: ActionBarProps) => (
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
);
