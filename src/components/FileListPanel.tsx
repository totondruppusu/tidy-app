import { useState } from "react";
import type { ReactNode, Ref } from "react";
import { Modal } from "./Modal";
import { FILTER_OPTIONS } from "../constants/appConstants";
import { formatExtensionLabel } from "../lib/format";
import { MATERIAL_ICONS } from "../lib/materialIcons";
import type {
  DensityMode,
  FilterMode,
  GroupMode,
  SortMode,
  ViewMode,
} from "../types";

type SearchControls = {
  currentFolder: string | null;
  folderLabel: string;
  emptyFolderLabel: string;
  filterMode: FilterMode;
  onPickFolder: () => void | Promise<void>;
  onFilterModeChange: (value: FilterMode) => void;
  onScan: () => void;
  onToggleSidebar: () => void;
};

type ListControls = {
  areControlsDisabled: boolean;
  totalFiles: number;
  viewMode: ViewMode;
  hasFolders: boolean;
  hasCollapsedFolders: boolean;
  onToggleAllFolders: () => void;
  sortMode: SortMode;
  onSortModeChange: (value: SortMode) => void;
  displayGroupMode: GroupMode;
  shouldGroupDuplicates: boolean;
  onGroupModeChange: (value: GroupMode) => void;
  onViewModeChange: (value: ViewMode) => void;
  isLoading: boolean;
  listDensity: DensityMode;
  hasFiles: boolean;
  listItems: ReactNode;
};

type ExtensionControls = {
  allExtensions: string[];
  selectedExtensions: string[];
  allExtensionsSelected: boolean;
  selectAllRef: Ref<HTMLInputElement>;
  onToggleAll: (checked: boolean) => void;
  onToggleExtension: (extension: string) => void;
};

type FileListPanelProps = {
  frameRef: Ref<HTMLDivElement>;
  scrollRef: Ref<HTMLDivElement>;
  search: SearchControls;
  list: ListControls;
  extensions: ExtensionControls;
};

export const FileListPanel = ({
  frameRef,
  scrollRef,
  search,
  list,
  extensions,
}: FileListPanelProps) => {
  const [isExtensionsModalOpen, setIsExtensionsModalOpen] = useState(false);

  return (
    <aside className="list-panel" id="sidebar-panel">
      <div className="list-header">
        <div className="list-header-top">
          <div className="list-title">
            <span className="list-brand">
              <span className="list-brand-accent">Tidy</span>
              <span> App</span>
            </span>
          </div>
          <div className="list-header-actions">
            {list.viewMode === "tree" && (
              <button
                type="button"
                className="list-expand-button"
                onClick={list.onToggleAllFolders}
                disabled={!list.hasFolders || list.areControlsDisabled}
                data-prevent-open-on-enter
                title={
                  list.hasCollapsedFolders
                    ? "Unfold all folders"
                    : "Fold all folders"
                }
              >
                {list.hasCollapsedFolders ? "Unfold all" : "Fold all"}
              </button>
            )}
          </div>
        </div>
        <div className="list-header-controls">
          <div className="toolbar-control">
            <span className="control-label">Sort</span>
            <select
              value={list.sortMode}
              onChange={(event) =>
                list.onSortModeChange(event.target.value as SortMode)
              }
              disabled={list.areControlsDisabled}
            >
              <option value="none">None</option>
              <option value="name_asc">Name (A-Z)</option>
              <option value="name_desc">Name (Z-A)</option>
              <option value="size_desc">Size (Largest)</option>
              <option value="size_asc">Size (Smallest)</option>
              <option value="date_desc">Date (Newest)</option>
              <option value="date_asc">Date (Oldest)</option>
              <option value="type_asc">Type (A-Z)</option>
              <option value="type_desc">Type (Z-A)</option>
              <option value="extension_asc">Extension (A-Z)</option>
              <option value="extension_desc">Extension (Z-A)</option>
            </select>
          </div>
          <div className="toolbar-control">
            <span className="control-label">Group</span>
            <select
              value={list.displayGroupMode}
              onChange={(event) =>
                list.onGroupModeChange(event.target.value as GroupMode)
              }
              disabled={list.areControlsDisabled || list.shouldGroupDuplicates}
            >
              <option value="none">None</option>
              <option value="type">Type</option>
              <option value="extension">Extension</option>
              {list.shouldGroupDuplicates && (
                <option value="duplicates">Duplicates</option>
              )}
            </select>
          </div>
          <div className="toolbar-control view-control">
            <span className="control-label">View</span>
            <select
              value={list.viewMode}
              onChange={(event) =>
                list.onViewModeChange(event.target.value as ViewMode)
              }
              disabled={list.areControlsDisabled}
            >
              <option value="tree">Tree</option>
              <option value="list">List</option>
            </select>
          </div>
          <button
            type="button"
            className="icon-button extensions-modal-button"
            onClick={() => setIsExtensionsModalOpen(true)}
            aria-label="Extensions"
            title="Extensions"
          >
            <span className="material-icon" aria-hidden="true">
              {MATERIAL_ICONS.funnel}
            </span>
          </button>
        </div>
      </div>
      <div className="file-list-frame scroll-hints" ref={frameRef}>
        <div
          ref={scrollRef}
          className={`file-list ${list.isLoading ? "loading" : ""} ${
            list.listDensity === "compact"
              ? "density-compact"
              : "density-comfortable"
          }`}
        >
          {list.hasFiles ? (
            list.listItems
          ) : list.isLoading ? (
            <div className="skeleton-list" aria-hidden="true">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={`skeleton-${index}`} className="skeleton-item" />
              ))}
            </div>
          ) : (
            <div className="empty">
              {list.totalFiles === 0
                ? "No files loaded."
                : "No files match the selected extensions."}
            </div>
          )}
        </div>
      </div>
      <div className="list-top-controls list-top-controls-bottom">
        <button
          type="button"
          className="icon-button sidebar-toggle"
          onClick={search.onToggleSidebar}
          aria-label="Hide sidebar"
          aria-controls="sidebar-panel"
          aria-pressed={false}
          title="Hide sidebar"
        >
          <span className="material-icon" aria-hidden="true">
            {MATERIAL_ICONS.sidebarClose}
          </span>
        </button>
        <div
          className="searchbar-controls"
          role="group"
          aria-label="Folder search controls"
        >
          <button
            type="button"
            className="pill-button"
            onClick={search.onPickFolder}
            disabled={list.areControlsDisabled}
            title={search.currentFolder ?? "No folder selected"}
          >
            <span className="pill-label">Folder</span>
            <span className="pill-value">
              {search.currentFolder ? search.folderLabel : search.emptyFolderLabel}
            </span>
          </button>
          <div className="toolbar-control">
            <select
              value={search.filterMode}
              onChange={(event) =>
                search.onFilterModeChange(event.target.value as FilterMode)
              }
              disabled={list.areControlsDisabled}
            >
              {FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="icon-button search-button"
            onClick={search.onScan}
            disabled={list.areControlsDisabled || !search.currentFolder}
            aria-label="Scan folder"
            title="Scan folder"
          >
            <span className="material-icon" aria-hidden="true">
              {MATERIAL_ICONS.search}
            </span>
          </button>
        </div>
      </div>
      {isExtensionsModalOpen && (
        <Modal
          className="extensions-modal"
          labelledBy="extensions-modal-title"
          onClose={() => setIsExtensionsModalOpen(false)}
        >
        <div className="modal-header">
          <h2 id="extensions-modal-title" className="modal-title">
            Extensions
          </h2>
        </div>
        <div className="modal-body extensions-modal-body">
          {extensions.allExtensions.length === 0 ? (
            <div className="extensions-empty">No extensions found.</div>
          ) : (
            <>
              <div className="extensions-controls">
                <label className="extension-filter extension-toggle">
                  <input
                    ref={extensions.selectAllRef}
                    type="checkbox"
                    checked={extensions.allExtensionsSelected}
                    onChange={(event) =>
                      extensions.onToggleAll(event.target.checked)
                    }
                    disabled={list.areControlsDisabled}
                  />
                  <span>All</span>
                </label>
              </div>
              <div className="extension-filters">
                {extensions.allExtensions.map((extension) => (
                  <label key={extension} className="extension-filter">
                    <input
                      type="checkbox"
                      checked={extensions.selectedExtensions.includes(extension)}
                      onChange={() => extensions.onToggleExtension(extension)}
                      disabled={list.areControlsDisabled}
                    />
                    <span>{formatExtensionLabel(extension)}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="pill-button"
            onClick={() => setIsExtensionsModalOpen(false)}
          >
            Close
          </button>
        </div>
        </Modal>
        )}
    </aside>
  );
};
