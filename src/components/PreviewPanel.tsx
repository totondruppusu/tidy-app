import type {
  PointerEventHandler,
  Ref,
  WheelEventHandler,
} from "react";
import { LARGE_PREVIEW_SIZE_BYTES } from "../constants/appConstants";
import type { FileEntry } from "../types";
import { buildMediaUrl } from "../lib/media";
import { extractFolder } from "../lib/path";
import { formatBytes, formatKindLabel, formatTimestamp } from "../lib/format";
import type { PreviewController } from "../hooks/usePreviewController";

type PreviewPanelProps = {
  frameRef: Ref<HTMLDivElement>;
  scrollRef: Ref<HTMLElement>;
  preview: PreviewController;
  folderSizeBytes: number;
  filteredCount: number;
  autoPlayMedia: boolean;
  videoRef: Ref<HTMLVideoElement>;
  audioRef: Ref<HTMLAudioElement>;
  onOpenFile: (file: FileEntry) => void | Promise<void>;
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
  onOpenFile,
}: PreviewPanelProps) => {
  const previewFile = preview.previewFile;

  if (!previewFile) {
    return (
      <div className="preview-frame scroll-hints" ref={frameRef}>
        <section className="preview-panel" ref={scrollRef}>
          <div className="preview-message">
            <div className="placeholder">Select a folder to preview files.</div>
          </div>
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
              className="preview-media"
              onWheel={preview.handlePreviewWheel as WheelEventHandler<HTMLDivElement>}
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
                    preview.handlePreviewPanStart as PointerEventHandler<HTMLDivElement>
                  }
                  onPointerMove={
                    preview.handlePreviewPanMove as PointerEventHandler<HTMLDivElement>
                  }
                  onPointerUp={
                    preview.handlePreviewPanEnd as PointerEventHandler<HTMLDivElement>
                  }
                  onPointerCancel={
                    preview.handlePreviewPanEnd as PointerEventHandler<HTMLDivElement>
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
                        <img
                          src={buildMediaUrl(preview.officePreviewId)}
                          alt={`Preview of ${previewFile.name}`}
                        />
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
            </div>
            <div className="preview-actions">
              <button
                type="button"
                className="preview-action-button"
                onClick={() => void onOpenFile(previewFile)}
              >
                Open file
              </button>
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
            <aside className="preview-details" aria-label="File details">
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
                  <span className="meta-value">
                    {formatBytes(previewFile.sizeBytes)}
                  </span>
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
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
};
