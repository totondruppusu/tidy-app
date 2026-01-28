import type { MouseEvent } from "react";

type HelpModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export const HelpModal = ({ isOpen, onClose }: HelpModalProps) => {
  if (!isOpen) {
    return null;
  }

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={handleBackdropClick}>
      <div className="modal-panel help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div className="modal-header">
          <h2 id="help-title" className="modal-title">
            Help & Shortcuts
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close help">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
            </svg>
          </button>
        </div>
        <div className="modal-body help-body">
          <div className="help-grid">
            <section className="help-section">
              <h3 className="help-section-title">Quick Start</h3>
              <ul className="help-list">
                <li>Select a folder, then click the search icon to scan it.</li>
                <li>Pick a filter mode to focus on images, docs, or other file types.</li>
                <li>Click a file to preview it; double-click to reveal it in your file manager.</li>
                <li>Use the extensions list to narrow the scan to specific suffixes.</li>
              </ul>
            </section>
            <section className="help-section">
              <h3 className="help-section-title">Views & Sorting</h3>
              <ul className="help-list">
                <li>Sort by name, size, date, type, or extension.</li>
                <li>Group the list by type or extension, then collapse sections as needed.</li>
                <li>Switch between list and tree views to browse folders.</li>
                <li>Use the expand-all toggle when browsing tree view folders.</li>
              </ul>
            </section>
            <section className="help-section">
              <h3 className="help-section-title">Preview & Details</h3>
              <ul className="help-list">
                <li>Images and videos support zoom controls and smooth zooming.</li>
                <li>Drag to pan images and use the zoom reset to snap back.</li>
                <li>Text, PDF, Office, and archive previews render when available.</li>
                <li>Use Open file to launch the file in its default app.</li>
              </ul>
            </section>
            <section className="help-section">
              <h3 className="help-section-title">Move & Clean Up</h3>
              <ul className="help-list">
                <li>Set destination slots 1-5 to move files with one click.</li>
                <li>Use Prev and Next to step through the list quickly.</li>
                <li>Trash removes the current file; Undo restores the last action.</li>
                <li>In tree view, trash an entire folder from its trash button.</li>
              </ul>
            </section>
            <section className="help-section">
              <h3 className="help-section-title">Settings</h3>
              <ul className="help-list">
                <li>Include subfolders to scan nested directories.</li>
                <li>Include hidden items to scan dotfiles and hidden folders.</li>
                <li>Toggle trash confirmation and switch between light and dark mode.</li>
                <li>Adjust list density for a roomier or compact list.</li>
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
                  <span className="help-key">1-5</span>
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
      </div>
    </div>
  );
};
