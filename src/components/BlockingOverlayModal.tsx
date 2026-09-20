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
      {overlay.showClose && overlay.onClose && (
        <button
          type="button"
          className="icon-button blocking-overlay-close"
          onClick={overlay.onClose}
          aria-label="Close previous scan dialog"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
          </svg>
        </button>
      )}
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
    </Modal>
  );
};
