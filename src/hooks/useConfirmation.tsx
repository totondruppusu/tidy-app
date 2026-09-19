import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../components/Modal";

type Options = {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
  detail?: string;
};
export function useConfirmation() {
  const [request, setRequest] = useState<
    ({ message: string } & Options) | null
  >(null);
  const pending = useRef<((answer: boolean) => void) | null>(null);
  const settle = useCallback((answer: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(answer);
  }, []);
  useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    [],
  );
  const confirmDialog = useCallback(
    (message: string, options: Options = {}) => {
      // Ignore repeated shortcuts/clicks while a decision is pending.
      if (pending.current) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setRequest({ message, ...options });
      });
    },
    [],
  );
  const confirmation = request ? (
    <Modal
      labelledBy="confirmation-title"
      describedBy="confirmation-message"
      className="confirmation-modal"
      backdropClassName="confirmation-backdrop"
      alert
      onClose={() => settle(false)}
    >
      <div className="modal-header">
        <h2 id="confirmation-title" className="modal-title">
          {request.title ?? "Confirm action"}
        </h2>
      </div>
      <div className="modal-body">
        <p id="confirmation-message" className="dialog-message">
          {request.message}
        </p>
        {request.detail && <p className="dialog-path">{request.detail}</p>}
      </div>
      <div className="modal-footer">
        <button
          type="button"
          data-dialog-initial-focus
          onClick={() => settle(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className={request.danger ? "dialog-danger" : "dialog-primary"}
          onClick={() => settle(true)}
        >
          {request.confirmLabel ?? "Continue"}
        </button>
      </div>
    </Modal>
  ) : null;
  return { confirmDialog, confirmation, isConfirming: request !== null };
}
