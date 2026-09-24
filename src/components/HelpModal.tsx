import { Modal } from "./Modal";
import { CRASH_REPORT_ISSUES_URL } from "../constants/appConstants";

type HelpModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

const Shortcut = ({
  keys,
  children,
}: {
  keys: string[];
  children: string;
}) => (
  <div className="help-shortcut">
    <span className="help-keys" aria-label={keys.join(" + ")}>
      {keys.map((key) => (
        <kbd className="help-key" key={key}>
          {key}
        </kbd>
      ))}
    </span>
    <span className="help-shortcut-label">{children}</span>
  </div>
);

export const HelpModal = ({ isOpen, onClose }: HelpModalProps) => {
  if (!isOpen) return null;

  return (
    <Modal
      className="help-modal"
      labelledBy="help-title"
      describedBy="help-intro"
      onClose={onClose}
    >
      <header className="help-header">
        <div>
          <p className="help-eyebrow">TIDY · QUICK GUIDE</p>
          <h2 id="help-title" className="modal-title">
            Help & shortcuts
          </h2>
          <p id="help-intro" className="help-intro">
            Scan a folder, review what’s inside, then sort files with a few
            quick actions.
          </p>
        </div>
        <div className="help-header-mark" aria-hidden="true">
          <span className="material-icon">{String.fromCodePoint(0xe8b8)}</span>
          <span className="help-header-spark">✦</span>
        </div>
      </header>

      <div className="modal-body help-body">
        <section className="help-start-card" aria-labelledby="help-start-title">
          <div className="help-start-heading">
            <span className="help-step-number">01</span>
            <div>
              <h3 id="help-start-title">Get started</h3>
              <p>Three steps to a cleaner folder.</p>
            </div>
          </div>
          <div className="help-steps">
            <div className="help-step">
              <span className="help-step-icon" aria-hidden="true">⌕</span>
              <div><strong>Choose a folder</strong><span>Select the folder you want to review.</span></div>
            </div>
            <div className="help-step">
              <span className="help-step-icon" aria-hidden="true">↻</span>
              <div><strong>Scan your files</strong><span>Use filters and extensions to narrow the results.</span></div>
            </div>
            <div className="help-step">
              <span className="help-step-icon" aria-hidden="true">✓</span>
              <div><strong>Review and tidy</strong><span>Preview files, move them, or send them to Trash.</span></div>
            </div>
          </div>
        </section>

        <section className="help-shortcuts-section" aria-labelledby="help-shortcuts-title">
          <div className="help-section-heading">
            <div>
              <p className="help-eyebrow">KEEP MOVING</p>
              <h3 id="help-shortcuts-title">Keyboard shortcuts</h3>
            </div>
            <span className="help-shortcut-hint">Available while browsing files</span>
          </div>
          <div className="help-shortcuts-grid">
            <div className="help-shortcut-group">
              <h4>Browse</h4>
              <Shortcut keys={["←"]}>Previous file</Shortcut>
              <Shortcut keys={["→"]}>Next file</Shortcut>
              <Shortcut keys={["Enter"]}>Open in file manager</Shortcut>
              <Shortcut keys={["Esc"]}>Close this guide</Shortcut>
            </div>
            <div className="help-shortcut-group">
              <h4>Organize</h4>
              <Shortcut keys={["↑"]}>Move current file to Trash</Shortcut>
              <Shortcut keys={["Shift", "↑"]}>Permanently delete current file</Shortcut>
              <Shortcut keys={["↓"]}>Undo last action</Shortcut>
              <Shortcut keys={["1–6"]}>Move to destination slot</Shortcut>
            </div>
            <div className="help-shortcut-group">
              <h4>Play & preview</h4>
              <Shortcut keys={["Space"]}>Play or pause video</Shortcut>
              <Shortcut keys={["Ctrl / ⌘", "← / →"]}>Skip 10 seconds in media</Shortcut>
              <Shortcut keys={["Ctrl", "Scroll"]}>Zoom images and videos</Shortcut>
            </div>
          </div>
          <p className="help-shortcut-note">Shortcuts pause while you type or when a dialog is open.</p>
        </section>

        <div className="help-details-grid">
          <section className="help-detail-card">
            <span className="help-detail-index">02</span>
            <h3>Browse your way</h3>
            <p>Switch between list and tree views. Sort by name, size, date, type, or extension; group files to make large scans easier to navigate.</p>
          </section>
          <section className="help-detail-card">
            <span className="help-detail-index">03</span>
            <h3>Preview with confidence</h3>
            <p>Images and videos support zoom and pan. Text, PDF, Office, and archive previews appear when available. Open a file or its containing folder from the preview.</p>
          </section>
          <section className="help-detail-card">
            <span className="help-detail-index">04</span>
            <h3>Make it yours</h3>
            <p>Settings control subfolders, hidden items, Trash confirmation, appearance, and list density. On Android, grant all-files access before choosing a folder.</p>
          </section>
        </div>

        <footer className="help-support">
          <span>Need a hand or found a problem?</span>
          <a href={CRASH_REPORT_ISSUES_URL} target="_blank" rel="noreferrer">
            Visit support on GitHub <span aria-hidden="true">↗</span>
          </a>
        </footer>
      </div>

      <div className="modal-footer">
        <button type="button" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
};
