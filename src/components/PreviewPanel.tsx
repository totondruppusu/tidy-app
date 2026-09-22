import { Modal } from "./Modal";
import {
  type PointerEventHandler,
  type Ref,
  type WheelEventHandler,
} from "react";
import { LARGE_PREVIEW_SIZE_BYTES } from "../constants/appConstants";
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
  isInfoOpen: boolean;
  onCloseInfo: () => void;
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
        <span className={!gesture.canPrev ? "is-disabled" : ""}>
          ← Previous
        </span>
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
  isInfoOpen,
  onCloseInfo,
}: PreviewPanelProps) => {
  const previewFile = preview.previewFile;

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
            }${gesture.isDragging ? " is-dragging" : ""}${
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
          {!isAndroidApp && !gesture.enabled && (
            <PreviewGestureLegend gesture={gesture} />
          )}
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
              }${gesture.isDragging ? " is-dragging" : ""}${
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
              onWheel={
                preview.handlePreviewWheel as WheelEventHandler<HTMLDivElement>
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
                  className={`preview-zoom${previewFile.kind === "image" || preview.previewExtension === "svg" ? " is-draggable" : ""}${
                    preview.isPreviewPanning ? " is-panning" : ""
                  }`}
                  style={{
                    transform:
                      previewFile.kind === "image" || preview.previewExtension === "svg"
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
                      {(previewFile.kind === "image" || preview.previewExtension === "svg") && (
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
                  <MarkdownPreview
                    fileId={previewFile.id}
                    fileName={previewFile.name}
                  />
                </div>
              )}
              {preview.isTextPreview && (
                <div className="preview-text-shell">
                  <TextPreview
                    fileId={previewFile.id}
                    fileName={previewFile.name}
                  />
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
                      <div className="preview-office-status">
                        Generating preview...
                      </div>
                    )}
                    {preview.officePreviewStatus === "error" && (
                      <div className="preview-office-status">
                        Preview unavailable.
                        {preview.previewCapabilities &&
                          !preview.previewCapabilities.officeRichPreview && (
                            <>
                              {" "}
                              Rich Office rendering is not available on this
                              platform.
                            </>
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
                    <div className="preview-archive-title">
                      Archive contents
                    </div>
                    {preview.archiveStatus === "loading" && (
                      <div className="preview-archive-status">Loading...</div>
                    )}
                  </div>
                  {preview.archiveStatus === "error" && (
                    <div className="preview-archive-status">
                      {preview.archiveError ??
                        "Preview unavailable for this archive."}
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
                        <div className="preview-archive-empty">
                          No entries found.
                        </div>
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
                  <div className="preview-fallback-hint">
                    No rich preview available.
                  </div>
                </div>
              )}
              {!isAndroidApp && !gesture.enabled && (
                <PreviewGestureLegend gesture={gesture} />
              )}
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
        <Modal
          className="preview-info-modal"
          labelledBy="preview-info-title"
          onClose={onCloseInfo}
        >
          <div
            id="preview-details-sheet"
            className="preview-details-sheet-header"
          >
            <div
              id="preview-info-title"
              className="preview-details-sheet-title"
            >
              File details
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={onCloseInfo}
              aria-label="Close file details"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
              </svg>
            </button>
          </div>
          <div className="preview-info-modal-body">{detailsContent}</div>
        </Modal>
      )}
    </div>
  );
};
