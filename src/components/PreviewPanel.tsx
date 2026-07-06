import {
  useEffect,
  useState,
  type PointerEventHandler,
  type Ref,
  type WheelEventHandler,
} from "react";
import { LARGE_PREVIEW_SIZE_BYTES } from "../constants/appConstants";
import type { FileEntry } from "../types";
import { buildMediaUrl } from "../lib/media";
import { extractFolder } from "../lib/path";
import { formatBytes, formatKindLabel, formatTimestamp } from "../lib/format";
import type { PreviewController } from "../hooks/usePreviewController";
import type { SwipeGestureController } from "../hooks/useSwipeGestureController";
import { MarkdownPreview } from "./MarkdownPreview";
import { TextPreview } from "./TextPreview";

type PreviewPanelProps = {
  frameRef: Ref<HTMLDivElement>;
  scrollRef: Ref<HTMLElement>;
  preview: PreviewController;
  folderSizeBytes: number;
  filteredCount: number;
  autoPlayMedia: boolean;
  videoRef: Ref<HTMLVideoElement>;
  audioRef: Ref<HTMLAudioElement>;
  gesture: SwipeGestureController;
  isAndroidApp: boolean;
  isSettingsOpen: boolean;
  canOpenFile: boolean;
  onOpenSettings: () => void;
  onOpenFile: (file: FileEntry) => void | Promise<void>;
};

export const PreviewGestureLegend = ({
  gesture,
}: {
  gesture: SwipeGestureController;
}) => {
  if (!gesture.enabled) {
    return null;
  }
  return (
    <div className="preview-gesture-shell" aria-live="polite">
      <div id="preview-gesture-map" className="preview-gesture-map">
        <span className={!gesture.canPrev ? "is-disabled" : ""}>← Previous</span>
        <span className={!gesture.canNext ? "is-disabled" : ""}>→ Next</span>
        <span className={!gesture.canTrash ? "is-disabled" : ""}>↑ Trash</span>
        <span className={!gesture.canUndo ? "is-disabled" : ""}>↓ Undo</span>
      </div>
    </div>
  );
};

export const PreviewPanel = ({
  frameRef,
  scrollRef,
  preview,
  folderSizeBytes,
  filteredCount,
  autoPlayMedia,
  videoRef,
  audioRef,
  gesture,
  isAndroidApp,
  isSettingsOpen,
  canOpenFile,
  onOpenSettings,
  onOpenFile,
}: PreviewPanelProps) => {
  const previewFile = preview.previewFile;
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  useEffect(() => {
    setIsInfoOpen(false);
  }, [isAndroidApp, previewFile?.id]);

  const shouldUseAndroidFloatingInfo = isAndroidApp;

  const detailsContent = previewFile ? (
    <div className="file-meta">
      <div>
        <span className="meta-label">Name</span>
        <span className="meta-value">{previewFile.name}</span>
      </div>
      <div>
        <span className="meta-label">Type</span>
        <span className="meta-value">{formatKindLabel(previewFile.kind)}</span>
      </div>
      <div>
        <span className="meta-label">Extension</span>
        <span className="meta-value">
          {preview.previewExtension === "none"
            ? "None"
            : `.${preview.previewExtension}`}
        </span>
      </div>
      <div>
        <span className="meta-label">MIME</span>
        <span className="meta-value">{previewFile.mime}</span>
      </div>
      <div>
        <span className="meta-label">Size</span>
        <span className="meta-value">{formatBytes(previewFile.sizeBytes)}</span>
      </div>
      <div>
        <span className="meta-label">Modified</span>
        <span className="meta-value">
          {formatTimestamp(previewFile.modifiedMs)}
        </span>
      </div>
      <div>
        <span className="meta-label">Folder</span>
        <span className="meta-value">{extractFolder(previewFile.path)}</span>
      </div>
      <div>
        <span className="meta-label">Folder size</span>
        <span className="meta-value">{formatBytes(folderSizeBytes)}</span>
      </div>
      <div>
        <span className="meta-label">Full path</span>
        <span className="meta-value mono">{previewFile.path}</span>
      </div>
      <div>
        <span className="meta-label">Position</span>
        <span className="meta-value">
          {preview.previewIndex + 1} of {filteredCount}
        </span>
      </div>
      <div>
        <span className="meta-label">ID</span>
        <span className="meta-value mono">{previewFile.id}</span>
      </div>
    </div>
  ) : null;

  if (!previewFile) {
    return (
      <div className="preview-frame scroll-hints" ref={frameRef}>
        <section className="preview-panel" ref={scrollRef}>
          <div
            className={`preview-message${
              gesture.enabled ? " preview-media-swipeable" : ""
            }${
              gesture.isDragging ? " is-dragging" : ""
            }${
              gesture.activeAction && gesture.activeActionAvailable
                ? ` is-${gesture.activeAction}`
                : ""
            }${
              gesture.activeAction && !gesture.activeActionAvailable
                ? " is-unavailable"
                : ""
            }${gesture.isBlocked ? " is-disabled" : ""}`}
            aria-label={gesture.enabled ? gesture.surfaceLabel : undefined}
            data-active-action={gesture.activeAction ?? "idle"}
            style={
              gesture.enabled
                ? {
                    transform: `translate(${gesture.offsetX}px, ${gesture.offsetY}px)`,
                  }
                : undefined
            }
            onPointerDown={
              gesture.enabled
                ? (gesture.handlePointerDown as PointerEventHandler<HTMLDivElement>)
                : undefined
            }
            onPointerMove={
              gesture.enabled
                ? (gesture.handlePointerMove as PointerEventHandler<HTMLDivElement>)
                : undefined
            }
            onPointerUp={
              gesture.enabled
                ? (gesture.handlePointerUp as PointerEventHandler<HTMLDivElement>)
                : undefined
            }
            onPointerCancel={
              gesture.enabled
                ? (gesture.handlePointerCancel as PointerEventHandler<HTMLDivElement>)
                : undefined
            }
          >
            <div className="placeholder">Select a folder to preview files.</div>
          </div>
          {!isAndroidApp && <PreviewGestureLegend gesture={gesture} />}
        </section>
      </div>
    );
  }

  return (
    <div className="preview-frame scroll-hints" ref={frameRef}>
      <section className="preview-panel" ref={scrollRef}>
        <div className="preview-content">
          <div className="preview-layout">
            <div
              className={`preview-media${
                gesture.enabled ? " preview-media-swipeable" : ""
              }${
                gesture.isDragging ? " is-dragging" : ""
              }${
                gesture.activeAction && gesture.activeActionAvailable
                  ? ` is-${gesture.activeAction}`
                  : ""
              }${
                gesture.activeAction && !gesture.activeActionAvailable
                  ? " is-unavailable"
                  : ""
              }${gesture.isBlocked ? " is-disabled" : ""}`}
              aria-label={gesture.enabled ? gesture.surfaceLabel : undefined}
              data-active-action={gesture.activeAction ?? "idle"}
              style={
                gesture.enabled
                  ? {
                      transform: `translate(${gesture.offsetX}px, ${gesture.offsetY}px)`,
                    }
                  : undefined
              }
              onWheel={preview.handlePreviewWheel as WheelEventHandler<HTMLDivElement>}
              onPointerDown={
                gesture.enabled
                  ? (gesture.handlePointerDown as PointerEventHandler<HTMLDivElement>)
                  : undefined
              }
              onPointerMove={
                gesture.enabled
                  ? (gesture.handlePointerMove as PointerEventHandler<HTMLDivElement>)
                  : undefined
              }
              onPointerUp={
                gesture.enabled
                  ? (gesture.handlePointerUp as PointerEventHandler<HTMLDivElement>)
                  : undefined
              }
              onPointerCancel={
                gesture.enabled
                  ? (gesture.handlePointerCancel as PointerEventHandler<HTMLDivElement>)
                  : undefined
              }
            >
              {preview.isPreviewSuppressed && (
                <div className="preview-suppressed">
                  <div className="preview-suppressed-title">Preview paused</div>
                  <div className="preview-suppressed-subtitle">
                    This file is {formatBytes(previewFile.sizeBytes)}. Previews
                    over {formatBytes(LARGE_PREVIEW_SIZE_BYTES)} are disabled.
                  </div>
                  <button
                    type="button"
                    className="preview-action-button"
                    onClick={preview.enableLargePreview}
                  >
                    Load preview
                  </button>
                </div>
              )}
              {preview.isMediaPreview && (
                <div
                  className={`preview-zoom${previewFile.kind === "image" ? " is-draggable" : ""}${
                    preview.isPreviewPanning ? " is-panning" : ""
                  }`}
                  style={{
                    transform:
                      previewFile.kind === "image"
                        ? `translate(${preview.previewPan.x}px, ${preview.previewPan.y}px) scale(${preview.previewZoom})`
                        : `scale(${preview.previewZoom})`,
                  }}
                  onPointerDown={
                    gesture.enabled
                      ? undefined
                      : (preview.handlePreviewPanStart as PointerEventHandler<HTMLDivElement>)
                  }
                  onPointerMove={
                    gesture.enabled
                      ? undefined
                      : (preview.handlePreviewPanMove as PointerEventHandler<HTMLDivElement>)
                  }
                  onPointerUp={
                    gesture.enabled
                      ? undefined
                      : (preview.handlePreviewPanEnd as PointerEventHandler<HTMLDivElement>)
                  }
                  onPointerCancel={
                    gesture.enabled
                      ? undefined
                      : (preview.handlePreviewPanEnd as PointerEventHandler<HTMLDivElement>)
                  }
                >
                  {previewFile.kind === "image" && (
                    <img
                      src={buildMediaUrl(previewFile.id)}
                      alt={previewFile.name}
                      draggable={false}
                      onDragStart={(event) => event.preventDefault()}
                    />
                  )}
                  {previewFile.kind === "video" && (
                    <video
                      ref={videoRef}
                      src={buildMediaUrl(previewFile.id)}
                      controls
                      autoPlay={autoPlayMedia}
                    />
                  )}
                </div>
              )}
              {preview.isAudioPreview && (
                <audio
                  ref={audioRef}
                  src={buildMediaUrl(previewFile.id)}
                  controls
                  autoPlay={autoPlayMedia}
                />
              )}
              {preview.isMarkdownPreview && (
                <div className="preview-markdown-shell">
                  <MarkdownPreview fileId={previewFile.id} fileName={previewFile.name} />
                </div>
              )}
              {preview.isTextPreview && (
                <div className="preview-text-shell">
                  <TextPreview fileId={previewFile.id} fileName={previewFile.name} />
                </div>
              )}
              {preview.isDocumentPreview && (
                <div className="preview-document">
                  <iframe
                    title={`Preview of ${previewFile.name}`}
                    src={buildMediaUrl(previewFile.id)}
                  />
                </div>
              )}
              {preview.isOfficePreview && (
                <div className="preview-office">
                  <div className="preview-office-preview">
                    {preview.officePreviewStatus === "loading" && (
                      <div className="preview-office-status">Generating preview...</div>
                    )}
                    {preview.officePreviewStatus === "error" && (
                      <div className="preview-office-status">
                        Preview unavailable.
                        {preview.previewCapabilities &&
                          !preview.previewCapabilities.officeRichPreview && (
                            <> Rich Office rendering is not available on this platform.</>
                          )}
                      </div>
                    )}
                    {preview.officePreviewStatus === "idle" &&
                      preview.officePreviewId && (
                        <>
                          {preview.officePreviewExtension === "pdf" ? (
                            <iframe
                              title={`Preview of ${previewFile.name}`}
                              src={buildMediaUrl(preview.officePreviewId)}
                            />
                          ) : (
                            <img
                              src={buildMediaUrl(preview.officePreviewId)}
                              alt={`Preview of ${previewFile.name}`}
                            />
                          )}
                        </>
                      )}
                    {preview.officePreviewStatus === "idle" &&
                      !preview.officePreviewId &&
                      preview.officeFallbackPreview && (
                        <div className="preview-office-fallback">
                          <div className="preview-office-fallback-title">
                            {preview.officeFallbackPreview.title}
                          </div>
                          <pre className="preview-office-fallback-text">
                            {preview.officeFallbackPreview.excerpt}
                          </pre>
                        </div>
                      )}
                  </div>
                </div>
              )}
              {preview.isArchivePreview && (
                <div className="preview-archive">
                  <div className="preview-archive-header">
                    <div className="preview-archive-title">Archive contents</div>
                    {preview.archiveStatus === "loading" && (
                      <div className="preview-archive-status">Loading...</div>
                    )}
                  </div>
                  {preview.archiveStatus === "error" && (
                    <div className="preview-archive-status">
                      {preview.archiveError ?? "Preview unavailable for this archive."}
                    </div>
                  )}
                  {preview.archiveStatus === "idle" && (
                    <>
                      {preview.archiveEntries.length > 0 ? (
                        <ul className="preview-archive-list">
                          {preview.archiveEntries.map((entry, index) => (
                            <li
                              key={`${entry}-${index}`}
                              className="preview-archive-item"
                            >
                              {entry}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="preview-archive-empty">No entries found.</div>
                      )}
                      {preview.archiveTruncated && (
                        <div className="preview-archive-note">
                          Showing first {preview.archiveEntries.length} items.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {preview.isFallbackPreview && (
                <div className="preview-fallback">
                  <div className="preview-fallback-icon">
                    {preview.previewExtension === "none"
                      ? "FILE"
                      : preview.previewExtension.toUpperCase()}
                  </div>
                  <div className="preview-fallback-label">
                    {formatKindLabel(previewFile.kind)}
                  </div>
                  <div className="preview-fallback-hint">No rich preview available.</div>
                </div>
              )}
              {!isAndroidApp && <PreviewGestureLegend gesture={gesture} />}
            </div>
            <div className="preview-actions">
              <button
                type="button"
                className="preview-action-button"
                disabled={!canOpenFile}
                onClick={() => void onOpenFile(previewFile)}
                title={
                  canOpenFile
                    ? "Open file in the system default app"
                    : "Opening files in external apps is not available on Android yet"
                }
              >
                Open file
              </button>
              {shouldUseAndroidFloatingInfo && (
                <>
                  <button
                    type="button"
                    className="icon-button preview-bar-button"
                    aria-label={isInfoOpen ? "Hide file details" : "Show file details"}
                    aria-expanded={isInfoOpen}
                    aria-controls="preview-details-sheet"
                    onClick={() => setIsInfoOpen((current) => !current)}
                    title={isInfoOpen ? "Hide file details" : "Show file details"}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M12 2.75A9.25 9.25 0 1 0 21.25 12 9.26 9.26 0 0 0 12 2.75Zm0 3.5a1.2 1.2 0 1 1-1.2 1.2 1.2 1.2 0 0 1 1.2-1.2Zm1.5 11h-3v-1.5h.75v-4h-.75v-1.5H12.75v5.5h.75Z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="icon-button preview-bar-button"
                    onClick={onOpenSettings}
                    aria-label="Open settings"
                    aria-haspopup="dialog"
                    aria-expanded={isSettingsOpen}
                    title="Open settings"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.57.23-1.12.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.61 7.86a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.4 1.05.71 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.57-.23 1.12-.54 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
                    </svg>
                  </button>
                </>
              )}
              <div className="preview-zoom-controls">
                <button
                  type="button"
                  className="icon-button"
                  onClick={preview.handleZoomOut}
                  disabled={!preview.isZoomablePreview}
                  aria-label="Zoom out"
                  title="Zoom out"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M5 11h14v2H5z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="icon-button preview-zoom-reset"
                  onClick={preview.handleZoomReset}
                  disabled={!preview.isZoomablePreview}
                  aria-label="Reset zoom"
                  title="Reset zoom"
                >
                  <span className="preview-zoom-value">
                    {Math.round(preview.previewZoom * 100)}%
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={preview.handleZoomIn}
                  disabled={!preview.isZoomablePreview}
                  aria-label="Zoom in"
                  title="Zoom in"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="caption" aria-hidden="true" />
            {!shouldUseAndroidFloatingInfo && (
              <aside className="preview-details" aria-label="File details">
                {detailsContent}
              </aside>
            )}
          </div>
        </div>
      </section>
      {shouldUseAndroidFloatingInfo && isInfoOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsInfoOpen(false);
            }
          }}
        >
          <section
            id="preview-details-sheet"
            className="modal-panel preview-info-modal"
            role="dialog"
            aria-modal="true"
            aria-label="File details"
          >
            <div className="preview-details-sheet-header">
              <div className="preview-details-sheet-title">File details</div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsInfoOpen(false)}
                aria-label="Close file details"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
                </svg>
              </button>
            </div>
            <div className="preview-info-modal-body">{detailsContent}</div>
          </section>
        </div>
      )}
    </div>
  );
};
