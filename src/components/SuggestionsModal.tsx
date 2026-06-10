import type { MouseEvent } from "react";
import type { SuggestionsController } from "../hooks/useSuggestionsController";
import { formatBytes } from "../lib/format";
import type {
  SafetyLevel,
  SuggestionActionFilter,
  SuggestionSortMode,
  SuggestionsMode,
} from "../types";

type SuggestionsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onDeletePreset: () => void | Promise<void>;
  onApplySelectedSuggestions: () => void | Promise<void>;
  controller: SuggestionsController;
  modeOptions: { value: SuggestionsMode; label: string }[];
  actionFilterOptions: { value: SuggestionActionFilter; label: string }[];
  sortOptions: { value: SuggestionSortMode; label: string }[];
  minLargeFileOptions: { value: number; label: string }[];
};

export const SuggestionsModal = ({
  isOpen,
  onClose,
  onDeletePreset,
  onApplySelectedSuggestions,
  controller,
  modeOptions,
  actionFilterOptions,
  sortOptions,
  minLargeFileOptions,
}: SuggestionsModalProps) => {
  if (!isOpen) {
    return null;
  }

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="modal-backdrop suggestions-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      <div
        className="modal-panel suggestions-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="suggestions-title"
      >
        <div className="modal-header">
          <h2 id="suggestions-title" className="modal-title">
            AI Suggestions
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close suggestions"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
            </svg>
          </button>
        </div>
        <div className="suggestions-scroll-frame scroll-hints">
          <div className="modal-body suggestions-body">
            <div className="suggestions-shell">
              <div className="suggestions-main">
                <div className="suggestions-main-header">
                  <div>
                    <div className="footer-title">Suggestions</div>
                    <div className="suggestions-kicker">
                      {controller.visibleSuggestions.length} visible actions
                    </div>
                  </div>
                  <div className="suggestions-header-actions">
                    <div
                      className="suggestions-mode-toggle"
                      role="group"
                      aria-label="Suggestions mode"
                    >
                      {modeOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`suggestions-mode-button${
                            controller.suggestionsMode === option.value
                              ? " is-active"
                              : ""
                          }`}
                          aria-pressed={controller.suggestionsMode === option.value}
                          onClick={() => controller.setSuggestionsMode(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="suggestions-preset-row">
                  <label
                    className="suggestions-field suggestions-field-inline"
                    htmlFor="suggestion-preset-select"
                  >
                    <span className="control-label">Preset</span>
                    <select
                      id="suggestion-preset-select"
                      value={controller.suggestionPresetId ?? ""}
                      onChange={(event) => {
                        const nextId = event.target.value;
                        controller.setSuggestionPresetId(nextId || null);
                        if (nextId) {
                          controller.applySuggestionPresetById(nextId);
                        }
                      }}
                    >
                      <option value="">No preset</option>
                      {controller.suggestionPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {controller.activeSuggestionPreset && (
                    <button
                      type="button"
                      className="suggestions-quick-button suggestions-last-preset-button"
                      onClick={controller.applyLastSuggestionPreset}
                    >
                      Apply last: {controller.activeSuggestionPreset.name}
                    </button>
                  )}
                  <span
                    className="suggestions-tooltip-anchor"
                    title="Work in progress"
                  >
                    <button
                      type="button"
                      className="suggestions-quick-button is-work-in-progress"
                      disabled
                      aria-label="Save current rules (work in progress)"
                    >
                      Save current rules
                    </button>
                  </span>
                  <button
                    type="button"
                    className="suggestions-quick-button"
                    onClick={controller.renameSuggestionPreset}
                    disabled={!controller.activeSuggestionPreset}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="suggestions-quick-button"
                    onClick={() => void onDeletePreset()}
                    disabled={!controller.activeSuggestionPreset}
                  >
                    Delete
                  </button>
                </div>
                <div className="suggestions-controls suggestions-controls-actions">
                  <button
                    type="button"
                    className="preview-action-button"
                    onClick={() => void controller.buildSuggestions()}
                    disabled={controller.suggestionsStatus === "loading"}
                  >
                    {controller.suggestionsStatus === "loading"
                      ? "Building..."
                      : "Build suggestions"}
                  </button>
                  <button
                    type="button"
                    className="preview-action-button"
                    onClick={() => void controller.previewSelectedSuggestions()}
                    disabled={
                      controller.suggestionDryRunStatus === "loading" ||
                      controller.selectedSuggestions.length === 0
                    }
                  >
                    {controller.suggestionDryRunStatus === "loading"
                      ? "Previewing..."
                      : "Preview selected"}
                  </button>
                  <button
                    type="button"
                    className="preview-action-button"
                    onClick={() => void onApplySelectedSuggestions()}
                    disabled={controller.selectedSuggestions.length === 0}
                  >
                    Apply selected
                  </button>
                </div>
                <div className="suggestions-filter-row">
                  <label
                    className="suggestions-field"
                    htmlFor="suggestion-safety-filter-modal"
                  >
                    <span className="control-label">Safety</span>
                    <select
                      id="suggestion-safety-filter-modal"
                      value={controller.suggestionSafetyFilter}
                      onChange={(event) =>
                        controller.setSuggestionSafetyFilter(
                          event.target.value as SafetyLevel,
                        )
                      }
                    >
                      <option value="safe">Safe only</option>
                      <option value="review">Safe + Review</option>
                      <option value="manual">All</option>
                    </select>
                  </label>
                  <label
                    className="suggestions-field suggestions-search-field"
                    htmlFor="suggestion-search-modal"
                  >
                    <span className="control-label">Search</span>
                    <input
                      id="suggestion-search-modal"
                      type="search"
                      value={controller.suggestionSearchQuery}
                      onChange={(event) =>
                        controller.setSuggestionSearchQuery(event.target.value)
                      }
                      placeholder="Search path, reason, action..."
                    />
                  </label>
                </div>
                {controller.suggestionsMode === "advanced" && (
                  <div className="suggestions-advanced-panel">
                    <div className="suggestions-build-grid">
                      <label
                        className="suggestions-field"
                        htmlFor="suggestion-stale-days"
                      >
                        <span className="control-label">Stale after days</span>
                        <input
                          id="suggestion-stale-days"
                          type="number"
                          min={1}
                          max={3650}
                          value={controller.suggestionStaleDays}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            if (Number.isFinite(next)) {
                              controller.setSuggestionStaleDays(next);
                            }
                          }}
                        />
                      </label>
                      <label
                        className="suggestions-field"
                        htmlFor="suggestion-min-large-bytes"
                      >
                        <span className="control-label">Large file threshold</span>
                        <select
                          id="suggestion-min-large-bytes"
                          value={controller.suggestionMinLargeFileBytes}
                          onChange={(event) =>
                            controller.setSuggestionMinLargeFileBytes(
                              Number(event.target.value),
                            )
                          }
                        >
                          {minLargeFileOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label
                        className="suggestions-field"
                        htmlFor="suggestion-max-results"
                      >
                        <span className="control-label">Max results</span>
                        <input
                          id="suggestion-max-results"
                          type="number"
                          min={1}
                          max={2000}
                          value={controller.suggestionMaxResults}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            if (Number.isFinite(next)) {
                              controller.setSuggestionMaxResults(next);
                            }
                          }}
                        />
                      </label>
                    </div>
                    <div className="suggestions-filter-grid">
                      <label
                        className="suggestions-field"
                        htmlFor="suggestion-action-filter-modal"
                      >
                        <span className="control-label">Action</span>
                        <select
                          id="suggestion-action-filter-modal"
                          value={controller.suggestionActionFilter}
                          onChange={(event) =>
                            controller.setSuggestionActionFilter(
                              event.target.value as SuggestionActionFilter,
                            )
                          }
                        >
                          {actionFilterOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label
                        className="suggestions-field"
                        htmlFor="suggestion-sort-mode-modal"
                      >
                        <span className="control-label">Sort</span>
                        <select
                          id="suggestion-sort-mode-modal"
                          value={controller.suggestionSortMode}
                          onChange={(event) =>
                            controller.setSuggestionSortMode(
                              event.target.value as SuggestionSortMode,
                            )
                          }
                        >
                          {sortOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="suggestions-v2-placeholder" aria-live="polite">
                      <span className="footer-title">V2 slots</span>
                      <div className="suggestions-v2-actions">
                        <button
                          type="button"
                          disabled={!controller.suggestionExplainabilityEnabled}
                        >
                          Explainability panel (v2)
                        </button>
                        <button
                          type="button"
                          disabled={!controller.suggestionBatchToolbarEnabled}
                        >
                          Batch actions toolbar (v2)
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="suggestions-controls suggestions-controls-selection">
                  <button
                    type="button"
                    className="suggestions-quick-button"
                    onClick={() =>
                      controller.updateSuggestionSelection(() =>
                        controller.suggestions
                          .filter((suggestion) => suggestion.safetyLevel === "safe")
                          .map((suggestion) => suggestion.id),
                      )
                    }
                    disabled={controller.suggestions.length === 0}
                  >
                    Select safe
                  </button>
                  <button
                    type="button"
                    className="suggestions-quick-button"
                    onClick={() =>
                      controller.updateSuggestionSelection(() =>
                        controller.visibleSuggestions.map((suggestion) => suggestion.id),
                      )
                    }
                    disabled={controller.visibleSuggestions.length === 0}
                  >
                    Select visible
                  </button>
                  <button
                    type="button"
                    className="suggestions-quick-button"
                    onClick={() => controller.updateSuggestionSelection(() => [])}
                    disabled={controller.selectedSuggestionIds.length === 0}
                  >
                    Clear selection
                  </button>
                </div>
                <div className="suggestions-meta">
                  <span>
                    Total reclaimable:{" "}
                    {formatBytes(controller.suggestionTotalReclaimableBytes)}
                  </span>
                  <span>
                    Selected:{" "}
                    {formatBytes(controller.selectedSuggestionReclaimableBytes)}
                  </span>
                  <span>{controller.selectedSuggestions.length} selected actions</span>
                </div>
                {controller.suggestionsError && (
                  <div className="suggestions-error">
                    {controller.suggestionsError}
                  </div>
                )}
                {controller.visibleSuggestions.length === 0 ? (
                  <div className="suggestions-empty">
                    No suggestions match current filters.
                  </div>
                ) : (
                  <div className="suggestions-list">
                    {controller.visibleSuggestions.slice(0, 120).map((suggestion) => (
                      <label key={suggestion.id} className="suggestion-item">
                        <input
                          type="checkbox"
                          checked={controller.selectedSuggestionSet.has(suggestion.id)}
                          onChange={(event) => {
                            controller.updateSuggestionSelection((previous) =>
                              event.target.checked
                                ? previous.includes(suggestion.id)
                                  ? previous
                                  : [...previous, suggestion.id]
                                : previous.filter((id) => id !== suggestion.id),
                            );
                          }}
                        />
                        <span className="suggestion-main">
                          <span className="suggestion-title">
                            {suggestion.reason.message}
                          </span>
                          <span className="suggestion-subtitle">
                            {controller.getSuggestionActionLabel(suggestion.actionType)} ·{" "}
                            {formatBytes(suggestion.reclaimableBytes)} ·{" "}
                            {suggestion.safetyLevel}
                          </span>
                          <span className="suggestion-subtitle mono">
                            {controller.formatSuggestionPath(suggestion.sourcePath)} -&gt;{" "}
                            {controller.getSuggestionTargetLabel(suggestion)}
                          </span>
                          <span className="suggestion-change">
                            {controller.getSuggestionChangeSentence(suggestion)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <aside className="suggestions-preview-panel">
                <div className="suggestions-preview-header">
                  <div className="footer-title">Change Preview</div>
                  <span
                    className={`suggestion-status ${
                      controller.hasDryRunPreviewForSelection
                        ? "suggestion-status-planned"
                        : "suggestion-status-pending"
                    }`}
                  >
                    {controller.hasDryRunPreviewForSelection
                      ? "Preview ready"
                      : "Needs preview"}
                  </span>
                </div>
                <div className="suggestions-preview-summary">
                  <span>{controller.selectedSuggestions.length} selected actions</span>
                  <span>
                    {formatBytes(controller.selectedSuggestionReclaimableBytes)} reclaimable
                  </span>
                  <span>
                    Visible selected: {controller.selectedVisibleSuggestions.length}/
                    {controller.selectedSuggestions.length}
                  </span>
                </div>
                <div className="suggestions-preview-list">
                  {controller.selectedSuggestions.length === 0 ? (
                    <div className="suggestions-empty">No selected actions yet.</div>
                  ) : (
                    controller.selectedSuggestions.slice(0, 120).map((suggestion) => {
                      const dryRunResult = controller.suggestionDryRunResultsById.get(
                        suggestion.id,
                      );
                      const previewStatus = controller.hasDryRunPreviewForSelection
                        ? (dryRunResult?.status ?? "planned")
                        : "pending";
                      return (
                        <div
                          key={`preview-${suggestion.id}`}
                          className="suggestions-preview-item"
                        >
                          <div className="suggestions-preview-path mono">
                            {controller.formatSuggestionPath(suggestion.sourcePath)} -&gt;{" "}
                            {controller.getSuggestionTargetLabel(suggestion)}
                          </div>
                          <div className="suggestions-preview-meta">
                            <span
                              className={`suggestion-status suggestion-status-${
                                previewStatus === "pending" ? "pending" : previewStatus
                              }`}
                            >
                              {previewStatus}
                            </span>
                            <span>{formatBytes(suggestion.reclaimableBytes)}</span>
                          </div>
                          {dryRunResult?.message && (
                            <div className="suggestions-preview-message">
                              {dryRunResult.message}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
                <details className="suggestions-diagnostics">
                  <summary>Diagnostics</summary>
                  <div className="suggestions-preview-actions">
                    {Object.entries(controller.selectedSuggestionActionCounts).length === 0 ? (
                      <span className="suggestions-empty">
                        Select suggestions to preview changes.
                      </span>
                    ) : (
                      Object.entries(controller.selectedSuggestionActionCounts)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([actionType, count]) => (
                          <span key={actionType} className="suggestion-chip">
                            {controller.getSuggestionActionLabel(actionType)}: {count}
                          </span>
                        ))
                    )}
                  </div>
                  {controller.suggestionDryRunError && (
                    <div className="suggestions-error">
                      {controller.suggestionDryRunError}
                    </div>
                  )}
                  {controller.hasDryRunPreviewForSelection && (
                    <div className="suggestions-preview-dryrun">
                      <span className="suggestion-status suggestion-status-planned">
                        planned {controller.suggestionDryRunStatusCounts.planned}
                      </span>
                      <span className="suggestion-status suggestion-status-blocked">
                        blocked {controller.suggestionDryRunStatusCounts.blocked}
                      </span>
                      <span className="suggestion-status suggestion-status-error">
                        error {controller.suggestionDryRunStatusCounts.error}
                      </span>
                    </div>
                  )}
                </details>
              </aside>
            </div>
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
