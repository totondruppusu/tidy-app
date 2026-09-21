type ToolbarProps = {
  isDrawerMode: boolean;
  isSidebarCollapsed: boolean;
  showWindowControls: boolean;
  isWindowMaximized: boolean;
  onToggleSidebar: () => void;
  onMinimizeWindow: () => void;
  onToggleMaximizeWindow: () => void;
  onCloseWindow: () => void;
};

export const Toolbar = ({
  isDrawerMode,
  isSidebarCollapsed,
  showWindowControls,
  isWindowMaximized,
  onToggleSidebar,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onCloseWindow,
}: ToolbarProps) =>
  showWindowControls ? (
    <div className="toolbar">
      <div className="toolbar-actions">
        <div className="window-controls" aria-label="Window controls">
          <button
            type="button"
            className="window-control-button"
            onClick={onMinimizeWindow}
            aria-label="Minimize window"
            title="Minimize"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M5 11.25h14v1.5H5z" />
            </svg>
          </button>
          <button
            type="button"
            className="window-control-button"
            onClick={onToggleMaximizeWindow}
            aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
            title={isWindowMaximized ? "Restore" : "Maximize"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {isWindowMaximized ? (
                <path d="M7 9.5h8.5V18H7V9.5Zm1.5 1.5V16.5H14V11H8.5ZM10 6h7v7H15.5V7.5H10V6Z" />
              ) : (
                <path d="M6 6h12v12H6V6Zm1.5 1.5v9h9v-9h-9Z" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="window-control-button window-control-button-close"
            onClick={onCloseWindow}
            aria-label="Close window"
            title="Close"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m7.05 8.11 1.06-1.06L12 10.94l3.89-3.89 1.06 1.06L13.06 12l3.89 3.89-1.06 1.06L12 13.06l-3.89 3.89-1.06-1.06L10.94 12 7.05 8.11Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  ) : isDrawerMode && !isSidebarCollapsed ? (
    <div
      className="drawer-backdrop"
      aria-hidden="true"
      onClick={onToggleSidebar}
    />
  ) : null;
