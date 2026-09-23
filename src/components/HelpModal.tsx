import { Modal } from "./Modal";
import { CRASH_REPORT_ISSUES_URL } from "../constants/appConstants";

type HelpModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export const HelpModal = ({ isOpen, onClose }: HelpModalProps) => {
  if (!isOpen) {
    return null;
  }

  return (
    <Modal className="help-modal" labelledBy="help-title" onClose={onClose}>
      <div className="modal-header">
        <h2 id="help-title" className="modal-title">
          Help & Shortcuts
        </h2>
      </div>
      <div className="modal-body help-body">
        <div className="help-grid">
          <section className="help-section">
            <h3 className="help-section-title">Quick Start</h3>
            <ul className="help-list">
              <li>Select a folder, then click the search icon to scan it.</li>
              <li>
                Pick a filter mode to focus on images, docs, or other file
                types.
              </li>
              <li>
                Click a file to preview it; double-click to open it in its
                default app.
              </li>
              <li>
                Use the extensions list to narrow the scan to specific suffixes.
              </li>
              <li>
                On Android, grant all files access, then choose a folder from
                the in-app browser to scan shared phone storage.
              </li>
            </ul>
          </section>
          <section className="help-section">
            <h3 className="help-section-title">Views & Sorting</h3>
            <ul className="help-list">
              <li>Sort by name, size, date, type, or extension.</li>
              <li>
                Group the list by type or extension, then collapse sections as
                needed.
              </li>
              <li>Switch between list and tree views to browse folders.</li>
              <li>
                Use the expand-all toggle when browsing tree view folders.
              </li>
            </ul>
          </section>
          <section className="help-section">
            <h3 className="help-section-title">Preview & Details</h3>
            <ul className="help-list">
              <li>
                Images and videos support zoom controls and smooth zooming.
              </li>
              <li>Drag to pan images and use the zoom reset to snap back.</li>
              <li>
                Text, PDF, Office, and archive previews render when available.
              </li>
              <li>Double-click a file to open it in its default app.</li>
              <li>Use the folder button to open its containing folder.</li>
            </ul>
          </section>
          <section className="help-section">
            <h3 className="help-section-title">Move & Clean Up</h3>
            <ul className="help-list">
              <li>Set destination slots 1-6 to move files with one click.</li>
              <li>Use Prev and Next to step through the list quickly.</li>
              <li>
                Trash removes the current file; Undo restores the last action.
              </li>
              <li>
                In tree view, trash an entire folder from its trash button.
              </li>
            </ul>
          </section>
          <section className="help-section">
            <h3 className="help-section-title">Settings</h3>
            <ul className="help-list">
              <li>Include subfolders to scan nested directories.</li>
              <li>
                Include hidden items to scan dotfiles plus hidden/system-marked
                entries.
              </li>
              <li>
                Toggle trash confirmation and switch between light and dark
                mode.
              </li>
              <li>Adjust list density for a roomier or compact list.</li>
            </ul>
          </section>
          <section className="help-section">
            <h3 className="help-section-title">Support</h3>
            <ul className="help-list">
              <li>
                Found a problem or have a suggestion? Open an issue on{" "}
                <a
                  href={CRASH_REPORT_ISSUES_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub
                </a>
                .
              </li>
            </ul>
          </section>
          <section className="help-section help-section-wide">
            <h3 className="help-section-title">Shortcuts</h3>
            <div className="help-shortcuts">
              <div className="help-shortcut">
                <span className="help-key">Arrow Left</span>
                <span>Previous file</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Arrow Right</span>
                <span>Next file</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Arrow Up</span>
                <span>Trash current file</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Arrow Down</span>
                <span>Undo last action</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Enter</span>
                <span>Reveal in file manager</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">1-6</span>
                <span>Move to destination slot</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Space</span>
                <span>Play or pause video</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Ctrl + Scroll</span>
                <span>Zoom images and videos</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Ctrl/Cmd + Arrow Left/Right</span>
                <span>Skip 10 seconds in video/audio</span>
              </div>
              <div className="help-shortcut">
                <span className="help-key">Esc</span>
                <span>Close settings or help</span>
              </div>
            </div>
          </section>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
};
