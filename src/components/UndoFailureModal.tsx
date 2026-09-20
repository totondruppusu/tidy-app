import { Modal } from "./Modal";
import type { UndoFailure } from "../hooks/useUndoController";

type UndoFailureModalProps = {
  failure: UndoFailure | null;
  onClose: () => void;
  onRetry: () => void;
};

export const UndoFailureModal = ({
  failure,
  onClose,
  onRetry,
}: UndoFailureModalProps) => {
  if (!failure) {
    return null;
  }
  return (
    <Modal
      labelledBy="undo-error-title"
      describedBy="undo-error-message"
      className="confirmation-modal"
      backdropClassName="confirmation-backdrop"
      alert
      onClose={onClose}
    >
      <div className="modal-header">
        <h2 id="undo-error-title" className="modal-title">
          Couldn’t complete undo
        </h2>
      </div>
      <div className="modal-body">
        <p id="undo-error-message" className="dialog-message">
          {failure.message}
        </p>
        <p className="dialog-message">
          The undo action is saved for retry. Check that the original folder
          is available and the NAS is connected. Existing files will not be
          overwritten.
        </p>
        <p className="dialog-path">
          Restore to: {failure.destinationPath}
        </p>
        <p className="dialog-path">
          Recovery source: {failure.sourcePath}
        </p>
      </div>
      <div className="modal-footer">
        <button
          type="button"
          data-dialog-initial-focus
          onClick={onClose}
        >
          Close
        </button>
        <button
          type="button"
          className="dialog-primary"
          onClick={() => onRetry()}
        >
          Retry undo
        </button>
      </div>
    </Modal>
  );
};
