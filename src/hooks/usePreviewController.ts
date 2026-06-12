import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  ARCHIVE_PREVIEW_DEBOUNCE_MS,
  LARGE_PREVIEW_SIZE_BYTES,
  OFFICE_PREVIEW_DEBOUNCE_MS,
  OFFICE_PREVIEW_EXTENSIONS,
  PREVIEW_DELAY_MS,
} from "../constants/appConstants";
import { isDesktopRuntime } from "../lib/desktopBridge";
import { getExtension } from "../lib/files";
import { clampNumber } from "../lib/number";
import {
  extractOfficeFallbackPreview,
  generateOfficePreview,
  getPreviewCapabilities,
  listArchiveEntries,
} from "../services/previewService";
import { useAsyncWorkflow } from "./useAsyncWorkflow";
import type {
  FileEntry,
  OfficeFallbackPreview,
  PreviewCapabilities,
} from "../types";

type UsePreviewControllerOptions = {
  sortedFiles: FileEntry[];
  currentIndex: number;
  skipLargePreviews: boolean;
};

export const usePreviewController = ({
  sortedFiles,
  currentIndex,
  skipLargePreviews,
}: UsePreviewControllerOptions) => {
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [isPreviewPanning, setIsPreviewPanning] = useState(false);
  const [allowLargePreview, setAllowLargePreview] = useState(false);
  const [officePreviewId, setOfficePreviewId] = useState<string | null>(null);
  const [officeFallbackPreview, setOfficeFallbackPreview] =
    useState<OfficeFallbackPreview | null>(null);
  const [previewCapabilities, setPreviewCapabilities] =
    useState<PreviewCapabilities | null>(null);
  const [archiveEntries, setArchiveEntries] = useState<string[]>([]);
  const [archiveTruncated, setArchiveTruncated] = useState(false);
  const {
    status: officePreviewStatus,
    reset: resetOfficePreview,
    start: startOfficePreview,
    succeed: succeedOfficePreview,
    fail: failOfficePreview,
  } = useAsyncWorkflow();
  const {
    status: archiveStatus,
    error: archiveError,
    reset: resetArchivePreview,
    start: startArchivePreview,
    succeed: succeedArchivePreview,
    fail: failArchivePreview,
  } = useAsyncWorkflow();
  const previewZoomTargetRef = useRef(1);
  const previewZoomRafRef = useRef<number | null>(null);
  const previewPanStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewPanPointerRef = useRef<{ x: number; y: number } | null>(null);
  const previewDelayTimeoutRef = useRef<number | null>(null);
  const officePreviewTimeoutRef = useRef<number | null>(null);
  const archivePreviewTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let isMounted = true;
    getPreviewCapabilities()
      .then((capabilities) => {
        if (isMounted) {
          setPreviewCapabilities(capabilities);
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  const previewFile = sortedFiles[previewIndex];
  const previewExtension = previewFile ? getExtension(previewFile.name) : "none";
  const officePreviewExtension = officePreviewId ? getExtension(officePreviewId) : "none";
  const isLargePreview =
    Boolean(previewFile) && previewFile.sizeBytes >= LARGE_PREVIEW_SIZE_BYTES;
  const isPreviewSuppressed =
    Boolean(previewFile) &&
    skipLargePreviews &&
    isLargePreview &&
    !allowLargePreview;
  const canRenderPreview = !isPreviewSuppressed;
  const isMediaPreview =
    canRenderPreview &&
    (previewFile?.kind === "image" || previewFile?.kind === "video");
  const isAudioPreview = canRenderPreview && previewFile?.kind === "audio";
  const isTextPreview = canRenderPreview && previewFile?.kind === "text";
  const isPdfPreview =
    canRenderPreview &&
    previewFile?.kind === "docs" &&
    previewExtension === "pdf";
  const isOfficePreview =
    canRenderPreview &&
    previewFile?.kind === "docs" &&
    OFFICE_PREVIEW_EXTENSIONS.includes(previewExtension);
  const isDocumentPreview = isTextPreview || isPdfPreview;
  const isArchivePreview =
    canRenderPreview && previewFile?.kind === "compressed";
  const isFallbackPreview =
    Boolean(previewFile) &&
    canRenderPreview &&
    !isMediaPreview &&
    !isAudioPreview &&
    !isDocumentPreview &&
    !isOfficePreview &&
    !isArchivePreview;
  const isZoomablePreview = isMediaPreview;

  useEffect(() => {
    if (officePreviewTimeoutRef.current !== null) {
      window.clearTimeout(officePreviewTimeoutRef.current);
      officePreviewTimeoutRef.current = null;
    }
    if (!previewFile || !isOfficePreview) {
      setOfficePreviewId(null);
      setOfficeFallbackPreview(null);
      resetOfficePreview();
      return;
    }
    if (!isDesktopRuntime()) {
      setOfficePreviewId(null);
      setOfficeFallbackPreview(null);
      failOfficePreview("Preview requires the desktop app.");
      return;
    }
    let isActive = true;
    setOfficePreviewId(null);
    setOfficeFallbackPreview(null);
    resetOfficePreview();
    officePreviewTimeoutRef.current = window.setTimeout(() => {
      if (!isActive) {
        return;
      }
      startOfficePreview();
      generateOfficePreview(previewFile.id)
        .then((nextPreviewId) => {
          if (!isActive) {
            return;
          }
          setOfficePreviewId(nextPreviewId);
          succeedOfficePreview();
        })
        .catch((error) => {
          if (!isActive) {
            return;
          }
          console.warn("Failed to generate office preview.", error);
          extractOfficeFallbackPreview(previewFile.id)
            .then((fallback) => {
              if (!isActive) {
                return;
              }
              setOfficePreviewId(null);
              setOfficeFallbackPreview(fallback);
              succeedOfficePreview();
            })
            .catch(() => {
              if (!isActive) {
                return;
              }
              setOfficePreviewId(null);
              setOfficeFallbackPreview(null);
              failOfficePreview("Preview unavailable.");
            });
        });
    }, OFFICE_PREVIEW_DEBOUNCE_MS);
    return () => {
      isActive = false;
      if (officePreviewTimeoutRef.current !== null) {
        window.clearTimeout(officePreviewTimeoutRef.current);
        officePreviewTimeoutRef.current = null;
      }
    };
  }, [
    failOfficePreview,
    isOfficePreview,
    previewFile,
    resetOfficePreview,
    startOfficePreview,
    succeedOfficePreview,
  ]);

  useEffect(() => {
    if (archivePreviewTimeoutRef.current !== null) {
      window.clearTimeout(archivePreviewTimeoutRef.current);
      archivePreviewTimeoutRef.current = null;
    }
    if (!previewFile || !isArchivePreview) {
      setArchiveEntries([]);
      setArchiveTruncated(false);
      resetArchivePreview();
      return;
    }
    if (!isDesktopRuntime()) {
      setArchiveEntries([]);
      setArchiveTruncated(false);
      failArchivePreview("Archive preview requires the desktop app.");
      return;
    }
    let isActive = true;
    setArchiveEntries([]);
    setArchiveTruncated(false);
    resetArchivePreview();
    archivePreviewTimeoutRef.current = window.setTimeout(() => {
      if (!isActive) {
        return;
      }
      startArchivePreview();
      listArchiveEntries(previewFile.id)
        .then((result) => {
          if (!isActive) {
            return;
          }
          setArchiveEntries(result.entries);
          setArchiveTruncated(result.truncated);
          succeedArchivePreview();
        })
        .catch((error) => {
          if (!isActive) {
            return;
          }
          console.warn("Failed to load archive preview.", error);
          setArchiveEntries([]);
          setArchiveTruncated(false);
          failArchivePreview("Preview unavailable for this archive.");
        });
    }, ARCHIVE_PREVIEW_DEBOUNCE_MS);
    return () => {
      isActive = false;
      if (archivePreviewTimeoutRef.current !== null) {
        window.clearTimeout(archivePreviewTimeoutRef.current);
        archivePreviewTimeoutRef.current = null;
      }
    };
  }, [
    failArchivePreview,
    isArchivePreview,
    previewFile,
    resetArchivePreview,
    startArchivePreview,
    succeedArchivePreview,
  ]);

  useEffect(() => {
    setPreviewZoom(1);
    previewZoomTargetRef.current = 1;
    setPreviewPan({ x: 0, y: 0 });
    if (previewZoomRafRef.current !== null) {
      cancelAnimationFrame(previewZoomRafRef.current);
      previewZoomRafRef.current = null;
    }
  }, [previewFile?.id]);

  useEffect(() => {
    setAllowLargePreview(false);
  }, [previewFile?.id, skipLargePreviews]);

  const handlePreviewWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey || !isMediaPreview) {
        return;
      }
      event.preventDefault();
      if (Math.abs(event.deltaY) < 0.6) {
        return;
      }
      const zoomFactor = Math.exp(-event.deltaY * 0.0045);
      previewZoomTargetRef.current = clampNumber(
        previewZoomTargetRef.current * zoomFactor,
        0.5,
        4,
      );
      if (previewZoomRafRef.current !== null) {
        return;
      }
      const tick = () => {
        setPreviewZoom((value) => {
          const target = previewZoomTargetRef.current;
          const diff = target - value;
          if (Math.abs(diff) < 0.001) {
            previewZoomRafRef.current = null;
            return target;
          }
          previewZoomRafRef.current = requestAnimationFrame(tick);
          return value + diff * 0.18;
        });
      };
      previewZoomRafRef.current = requestAnimationFrame(tick);
    },
    [isMediaPreview],
  );

  const setPreviewZoomValue = useCallback((value: number) => {
    const clamped = clampNumber(value, 0.5, 4);
    previewZoomTargetRef.current = clamped;
    if (previewZoomRafRef.current !== null) {
      cancelAnimationFrame(previewZoomRafRef.current);
      previewZoomRafRef.current = null;
    }
    setPreviewZoom(clamped);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (isZoomablePreview) {
      setPreviewZoomValue(previewZoomTargetRef.current / 1.15);
    }
  }, [isZoomablePreview, setPreviewZoomValue]);

  const handleZoomIn = useCallback(() => {
    if (isZoomablePreview) {
      setPreviewZoomValue(previewZoomTargetRef.current * 1.15);
    }
  }, [isZoomablePreview, setPreviewZoomValue]);

  const handleZoomReset = useCallback(() => {
    if (!isZoomablePreview) {
      return;
    }
    setPreviewZoomValue(1);
    setPreviewPan({ x: 0, y: 0 });
  }, [isZoomablePreview, setPreviewZoomValue]);

  const handlePreviewPanStart = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (previewFile?.kind !== "image" || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      previewPanStartRef.current = { x: previewPan.x, y: previewPan.y };
      previewPanPointerRef.current = { x: event.clientX, y: event.clientY };
      setIsPreviewPanning(true);
    },
    [previewFile?.kind, previewPan.x, previewPan.y],
  );

  const handlePreviewPanMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!previewPanStartRef.current || !previewPanPointerRef.current) {
        return;
      }
      const startPan = previewPanStartRef.current;
      const startPointer = previewPanPointerRef.current;
      setPreviewPan({
        x: startPan.x + (event.clientX - startPointer.x),
        y: startPan.y + (event.clientY - startPointer.y),
      });
    },
    [],
  );

  const handlePreviewPanEnd = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!previewPanStartRef.current) {
        return;
      }
      previewPanStartRef.current = null;
      previewPanPointerRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      setIsPreviewPanning(false);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (previewZoomRafRef.current !== null) {
        cancelAnimationFrame(previewZoomRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (sortedFiles.length === 0) {
      setPreviewIndex(0);
      return;
    }
    if (previewIndex >= sortedFiles.length) {
      setPreviewIndex(sortedFiles.length - 1);
    }
  }, [previewIndex, sortedFiles.length]);

  useEffect(() => {
    if (previewDelayTimeoutRef.current !== null) {
      window.clearTimeout(previewDelayTimeoutRef.current);
    }
    previewDelayTimeoutRef.current = window.setTimeout(() => {
      setPreviewIndex(currentIndex);
      previewDelayTimeoutRef.current = null;
    }, PREVIEW_DELAY_MS);
    return () => {
      if (previewDelayTimeoutRef.current !== null) {
        window.clearTimeout(previewDelayTimeoutRef.current);
        previewDelayTimeoutRef.current = null;
      }
    };
  }, [currentIndex]);

  const enableLargePreview = useCallback(() => {
    setAllowLargePreview(true);
  }, []);

  return useMemo(
    () => ({
      previewIndex,
      previewFile,
      previewExtension,
      previewZoom,
      previewPan,
      isPreviewPanning,
      previewCapabilities,
      officePreviewId,
      officePreviewExtension,
      officeFallbackPreview,
      officePreviewStatus,
      archiveEntries,
      archiveTruncated,
      archiveStatus,
      archiveError,
      isLargePreview,
      isPreviewSuppressed,
      canRenderPreview,
      isMediaPreview,
      isAudioPreview,
      isTextPreview,
      isPdfPreview,
      isOfficePreview,
      isDocumentPreview,
      isArchivePreview,
      isFallbackPreview,
      isZoomablePreview,
      enableLargePreview,
      handlePreviewWheel,
      handleZoomOut,
      handleZoomIn,
      handleZoomReset,
      handlePreviewPanStart,
      handlePreviewPanMove,
      handlePreviewPanEnd,
    }),
    [
      archiveEntries,
      archiveError,
      archiveStatus,
      archiveTruncated,
      canRenderPreview,
      enableLargePreview,
      handlePreviewPanEnd,
      handlePreviewPanMove,
      handlePreviewPanStart,
      handlePreviewWheel,
      handleZoomIn,
      handleZoomOut,
      handleZoomReset,
      isArchivePreview,
      isAudioPreview,
      isDocumentPreview,
      isFallbackPreview,
      isLargePreview,
      isMediaPreview,
      isOfficePreview,
      isPdfPreview,
      isPreviewPanning,
      isPreviewSuppressed,
      isTextPreview,
      isZoomablePreview,
      officeFallbackPreview,
      officePreviewExtension,
      officePreviewId,
      officePreviewStatus,
      previewCapabilities,
      previewExtension,
      previewFile,
      previewIndex,
      previewPan,
      previewZoom,
    ],
  );
};

export type PreviewController = ReturnType<typeof usePreviewController>;
