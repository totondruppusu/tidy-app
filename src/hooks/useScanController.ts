import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCommand } from "../lib/desktopBridge";
import { useAsyncWorkflow } from "./useAsyncWorkflow";
import type { ScanProgress, ScanResult, FilterMode } from "../types";

type Request = {
  folderPath: string;
  filterMode: FilterMode;
  includeSubfolders: boolean;
  includeHidden: boolean;
  useHashForDuplicates: boolean;
  duplicateMinSizeBytes: number;
};
type Callbacks = {
  reset: () => void;
  apply: (label: string, token: string, result: ScanResult) => void;
  updateStatus: (message: string) => void;
  cache: boolean;
};

export function useScanController() {
  const {
    isLoading,
    start: startScanWorkflow,
    succeed: succeedScanWorkflow,
    fail: failScanWorkflow,
    reset: resetScanWorkflow,
    run: runScanWorkflow,
  } = useAsyncWorkflow();
  const {
    isLoading: isCancellingScan,
    start: startCancelScanWorkflow,
    fail: failCancelScanWorkflow,
    reset: resetCancelScanWorkflow,
  } = useAsyncWorkflow();
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);

  const activeScanId = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      const scanId = activeScanId.current;
      activeScanId.current = null;
      if (scanId) void invokeCommand("cancel_scan", { scanId }).catch(() => {});
    },
    [],
  );
  const scan = useCallback(
    async (request: Request, folderLabel: string, callbacks: Callbacks) => {
      // Cancel the previous generation before launching another one.
      const previousScanId = activeScanId.current;
      const scanId = `${crypto.randomUUID()}-${++generation.current}`;
      activeScanId.current = scanId;
      if (previousScanId)
        await invokeCommand("cancel_scan", { scanId: previousScanId }).catch(
          () => {},
        );
      if (activeScanId.current !== scanId) return;
      resetCancelScanWorkflow();
      startScanWorkflow();
      setScanProgress({
        scanId,
        scanned: 0,
        matched: 0,
        total: 0,
        phase: "indexing",
      });
      callbacks.reset();
      callbacks.updateStatus(
        request.includeSubfolders
          ? "Scanning folders and subfolders..."
          : "Scanning folder...",
      );
      try {
        const result = await invokeCommand<ScanResult>("scan_folder", {
          ...request,
          folderLabel,
          scanId,
          cacheResult: callbacks.cache,
        });
        if (activeScanId.current !== scanId) return;
        callbacks.apply(folderLabel, request.folderPath, result);
        if (activeScanId.current === scanId) succeedScanWorkflow();
      } catch (error) {
        if (activeScanId.current !== scanId) return;
        const message = String(error);
        // Partial streamed IDs were never committed to the native index.
        callbacks.reset();
        if (message.toLowerCase().includes("scan cancelled")) {
          resetScanWorkflow();
          callbacks.updateStatus("Scan cancelled.");
        } else {
          failScanWorkflow(message);
          callbacks.updateStatus(`Scan failed: ${message}`);
        }
      } finally {
        if (activeScanId.current === scanId) {
          setScanProgress(null);
          activeScanId.current = null;
          resetCancelScanWorkflow();
        }
      }
    },
    [
      resetCancelScanWorkflow,
      startScanWorkflow,
      succeedScanWorkflow,
      resetScanWorkflow,
      failScanWorkflow,
    ],
  );
  const cancel = useCallback(
    async (updateStatus: (message: string) => void) => {
      const scanId = activeScanId.current;
      if (!scanId || isCancellingScan) return;
      startCancelScanWorkflow();
      updateStatus("Stopping scan...");
      try {
        await invokeCommand("cancel_scan", { scanId });
      } catch (error) {
        const message = String(error);
        failCancelScanWorkflow(message);
        updateStatus(`Failed to stop scan: ${message}`);
      }
    },
    [isCancellingScan, startCancelScanWorkflow, failCancelScanWorkflow],
  );
  return {
    isLoading,
    runScanWorkflow,
    activeScanId,
    scanProgress,
    setScanProgress,
    isCancellingScan,
    resetCancelScanWorkflow,
    scan,
    cancel,
  };
}
