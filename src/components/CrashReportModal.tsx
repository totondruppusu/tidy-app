import { Modal } from "./Modal";
import { CRASH_REPORT_EMAIL } from "../constants/appConstants";
import { formatActivitySummary, formatTimestamp } from "../lib/format";
import type { CrashReport } from "../types";

type CrashReportModalProps = {
  isOpen: boolean;
  crashReport: CrashReport | null;
  crashReportText: string;
  onDismiss: () => void;
  onReveal: () => void;
  onCopy: () => void;
  onSend: () => void;
};

export const CrashReportModal = ({
  isOpen,
  crashReport,
  crashReportText,
  onDismiss,
  onReveal,
  onCopy,
  onSend,
}: CrashReportModalProps) => {
  if (!isOpen || !crashReport) {
    return null;
  }

  return (
    <Modal className="crash-modal" labelledBy="crash-title" onClose={onDismiss}>
      <div className="modal-header">
        <h2 id="crash-title" className="modal-title">
          We recovered from a crash
        </h2>
      </div>
      <div className="modal-body crash-body">
        <p className="crash-intro">
          A crash report was saved. You can send it to {CRASH_REPORT_EMAIL} to
          help us improve stability.
        </p>
        <div className="crash-meta">
          <div>
            <span className="meta-label">Time</span>
            <span className="meta-value">
              {formatTimestamp(crashReport.createdMs)}
            </span>
          </div>
          <div>
            <span className="meta-label">Last heartbeat</span>
            <span className="meta-value">
              {formatTimestamp(crashReport.lastHeartbeatMs ?? null)}
            </span>
          </div>
          <div>
            <span className="meta-label">Message</span>
            <span className="meta-value">{crashReport.message}</span>
          </div>
          <div>
            <span className="meta-label">Last activity</span>
            <span className="meta-value">
              {formatActivitySummary(crashReport.lastActivity)}
            </span>
          </div>
          <div>
            <span className="meta-label">Report file</span>
            <span className="meta-value mono">{crashReport.reportPath}</span>
          </div>
        </div>
        <pre className="crash-report">{crashReportText}</pre>
      </div>
      <div className="modal-footer crash-footer">
        <button type="button" className="help-button" onClick={onReveal}>
          Show file
        </button>
        <button type="button" className="help-button" onClick={onCopy}>
          Copy report
        </button>
        <button type="button" onClick={onSend}>
          Send report
        </button>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </Modal>
  );
};
