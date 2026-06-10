type ToolbarProps = {
  isSidebarCollapsed: boolean;
  isDrawerMode: boolean;
  isSettingsOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
};

export const Toolbar = ({
  isSidebarCollapsed,
  isDrawerMode,
  isSettingsOpen,
  onToggleSidebar,
  onOpenSettings,
}: ToolbarProps) => (
  <>
    {isSidebarCollapsed && (
      <button
        type="button"
        className="icon-button sidebar-toggle floating-toggle"
        onClick={onToggleSidebar}
        aria-label="Show sidebar"
        aria-controls="sidebar-panel"
        aria-pressed={isSidebarCollapsed}
        title="Show sidebar"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          width="24"
          height="24"
        >
          <path d="M9 5.5 16 12 9 18.5V5.5Z" />
        </svg>
      </button>
    )}
    <span className="icon-button-tooltip-anchor" title="Work in progress">
      <button
        type="button"
        className="icon-button settings-button app-suggestions-button"
        disabled
        aria-label="AI suggestions (work in progress)"
        aria-haspopup="dialog"
        aria-expanded={false}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          width="24"
          height="24"
        >
          <path d="M12 2.8 14.9 8.5 21.2 9.4l-4.6 4.4 1.1 6.3L12 17.1 6.3 20.1l1.1-6.3-4.6-4.4 6.3-.9L12 2.8Z" />
        </svg>
      </button>
    </span>
    <button
      type="button"
      className="icon-button settings-button app-settings-button"
      onClick={onOpenSettings}
      aria-label="Open settings"
      aria-haspopup="dialog"
      aria-expanded={isSettingsOpen}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        width="24"
        height="24"
      >
        <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.57.23-1.12.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.61 7.86a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.4 1.05.71 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.57-.23 1.12-.54 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
      </svg>
    </button>
    {isDrawerMode && !isSidebarCollapsed && (
      <div
        className="drawer-backdrop"
        aria-hidden="true"
        onClick={onToggleSidebar}
      />
    )}
  </>
);
