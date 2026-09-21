import { Modal } from "./Modal";

type BlockingOverlayAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type BlockingOverlay =
  | {
      title: string;
      subtitle: string;
      showSpinner: boolean;
      showCancel: boolean;
      showClose?: boolean;
      onClose?: () => void;
      actions: BlockingOverlayAction[];
    }
  | null;

type BlockingOverlayModalProps = {
  overlay: BlockingOverlay;
  currentFolder: string | null;
  showFolderPath: boolean;
  isCancellingScan: boolean;
  cancelActiveScan: () => void;
};

export const BlockingOverlayModal = ({
  overlay,
  currentFolder,
  showFolderPath,
  isCancellingScan,
  cancelActiveScan,
}: BlockingOverlayModalProps) => {
  if (!overlay) {
    return null;
  }
  return (
    <Modal
      labelledBy="progress-title"
      describedBy="progress-description"
      className="progress-modal"
      backdropClassName="blocking-overlay"
      onClose={overlay.onClose}
   >
      {overlay.showSpinner && (
        <div className="spinner" aria-hidden="true" />
      )}
      <h2 id="progress-title" className="modal-title">
        {overlay.title}
      </h2>
      <div
        id="progress-description"
        className="dialog-message"
        role="status"
        aria-live="polite"
      >
        {overlay.subtitle}
      </div>
      {showFolderPath && (
        <p className="dialog-path" title={currentFolder ?? undefined}>
          {currentFolder}
        </p>
      )}
     <div className="modal-footer">
       {overlay.onClose && (
         <button
           type="button"
           aria-label="Close previous scan dialog"
           onClick={overlay.onClose}
         >
           Close
         </button>
       )}
        {overlay.actions.length > 0 && (
          <div className="modal-action-row">
            {overlay.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="preview-action-button"
                onClick={action.onClick}
                disabled={action.disabled}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
        {overlay.showCancel && (
          <button
            type="button"
            className="preview-action-button"
            onClick={() => void cancelActiveScan()}
            disabled={isCancellingScan}
          >
            {isCancellingScan ? "Stopping..." : "Stop scan"}
          </button>
        )}
      </div>
    </Modal>
  );
};
