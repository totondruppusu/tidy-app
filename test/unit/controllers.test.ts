import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useUndoHistory,
  useUndoAction,
} from "../../src/hooks/useUndoController";
import { useMutationController } from "../../src/hooks/useMutationController";
import { useScanController } from "../../src/hooks/useScanController";
import { createMockBridge } from "../mocks/bridge";
import { createFile } from "../mocks/files";
import type { ScanResult, UndoAction } from "../../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const undo: UndoAction = {
  kind: "trash",
  file: createFile({ id: "saved" }),
  fromPath: "/original",
  trashPath: "/backup",
};

describe("desktop workflow controllers", () => {
  it("hydrates undo before writing and serializes subsequent saves", async () => {
    const bridge = createMockBridge();
    window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    const loaded = deferred<UndoAction[]>();
    const firstSave = deferred<void>();
    bridge.onInvoke("get_recent_undo_actions", () => loaded.promise);
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined);
    bridge.onInvoke("store_recent_undo_actions", save);
    const { result } = renderHook(() => useUndoHistory());
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      loaded.resolve([undo]);
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ actions: [undo] });
    act(() => result.current.setUndoStack([]));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => firstSave.resolve());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toEqual({ actions: [] });
  });

  it("publishes folder undo results in one batch instead of sorting once per file", async () => {
    const bridge = createMockBridge();
    window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    bridge.onInvoke("restore_folder", () => null);
    const files = Array.from({ length: 1000 }, (_, i) => createFile({ id: String(i) }));
    const restoreFileEntries = vi.fn();
    const restoreFileEntry = vi.fn();
    const { result } = renderHook(() => useUndoAction({
      undoStack: [{ kind: "trash-folder", folderPath: "/Volumes/NAS/folder", trashPath: "/backup/folder", items: files.map((file) => ({ file, relativePath: file.name })) }],
      setUndoStack: vi.fn(), restoreFileEntry, restoreFileEntries, updateStatus: vi.fn(),
      runMutationWithSpinner: async (_label, operation) => operation(),
    }));
    await act(async () => result.current());
    expect(restoreFileEntries).toHaveBeenCalledExactlyOnceWith(files);
    expect(restoreFileEntry).not.toHaveBeenCalled();
  });

  it("keeps failed undo actions for retry", async () => {
    const bridge = createMockBridge();
    window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    bridge.onInvoke("restore_file", () => {
      throw new Error("Restore target exists");
    });
    const setUndoStack = vi.fn();
    const restoreFileEntry = vi.fn();
    const updateStatus = vi.fn();
    const { result } = renderHook(() =>
      useUndoAction({
        undoStack: [undo],
        setUndoStack,
        restoreFileEntry,
        updateStatus,
        runMutationWithSpinner: async (_label, operation) => operation(),
      }),
    );
    await act(async () => result.current());
    expect(setUndoStack).not.toHaveBeenCalled();
    expect(restoreFileEntry).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(
      expect.stringContaining("Restore target exists"),
    );
  });

  it("prevents overlapping mutations and clears state after failure", async () => {
    const overlay = vi.fn();
    const pending = deferred<void>();
    const { result } = renderHook(() => useMutationController(overlay));
    const operation = vi.fn(() => pending.promise);
    let first!: Promise<void>;
    act(() => {
      first = result.current.runMutationWithSpinner("Moving…", operation);
    });
    await act(async () =>
      result.current.runMutationWithSpinner("Moving…", operation),
    );
    expect(operation).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
      await first;
    });
    await act(async () => {
      await expect(
        result.current.runMutationWithSpinner("Moving…", async () => {
          throw new Error("disk full");
        }),
      ).rejects.toThrow("disk full");
    });
    expect(result.current.isMutating).toBe(false);
    expect(overlay).toHaveBeenLastCalledWith(null);
  });

  it("delegates caching to the native scan and ignores superseded results", async () => {
    const bridge = createMockBridge();
    window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    const first = deferred<ScanResult>();
    const second = deferred<ScanResult>();
    const invokeScan = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    bridge.onInvoke("scan_folder", invokeScan);
    bridge.onInvoke("cancel_scan", () => undefined);
    const save = vi.fn();
    bridge.onInvoke("store_cached_scan_result", save);
    const { result } = renderHook(() => useScanController());
    const callbacks = {
      reset: vi.fn(),
      apply: vi.fn(),
      updateStatus: vi.fn(),
      cache: true,
    };
    const request = {
      folderPath: "/root",
      filterMode: "all" as const,
      includeSubfolders: true,
      includeHidden: false,
      useHashForDuplicates: false,
      duplicateMinSizeBytes: 0,
    };
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.scan(request, "first", callbacks);
    });
    await act(async () => {
      b = result.current.scan(request, "second", callbacks);
    });
    await act(async () => {
      first.resolve({ files: [], total: 0 });
      await a;
    });
    expect(callbacks.apply).not.toHaveBeenCalled();
    expect(invokeScan).toHaveBeenLastCalledWith(
      expect.objectContaining({ cacheResult: true }),
    );
    const incomplete: ScanResult = {
      files: [],
      total: 0,
      indexed: 1,
      issues: [{ code: "unreadable-entry", message: "Permission denied" }],
    };
    await act(async () => {
      second.resolve(incomplete);
      await b;
    });
    expect(callbacks.apply).toHaveBeenCalledWith("second", "/root", incomplete);
    expect(save).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });
  it("never uploads complete scan files to cache and honors disabled caching", async () => {
    const bridge = createMockBridge();
    window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    const complete = { files: [createFile()], total: 1 };
    const invokeScan = vi.fn(() => complete);
    const save = vi.fn();
    bridge.onInvoke("scan_folder", invokeScan);
    bridge.onInvoke("store_cached_scan_result", save);
    const { result } = renderHook(() => useScanController());
    const callbacks = {
      reset: vi.fn(),
      apply: vi.fn(),
      updateStatus: vi.fn(),
      cache: false,
    };
    const request = {
      folderPath: "/root",
      filterMode: "all" as const,
      includeSubfolders: true,
      includeHidden: false,
      useHashForDuplicates: false,
      duplicateMinSizeBytes: 0,
    };
    await act(async () => result.current.scan(request, "root", callbacks));
    expect(invokeScan).toHaveBeenCalledWith(
      expect.objectContaining({ cacheResult: false }),
    );
    expect(callbacks.apply).toHaveBeenCalledWith("root", "/root", complete);
    expect(save).not.toHaveBeenCalled();
    callbacks.cache = true;
    await act(async () => result.current.scan(request, "root", callbacks));
    expect(invokeScan).toHaveBeenLastCalledWith(
      expect.objectContaining({ cacheResult: true }),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("clears uncommitted streamed entries when a scan is cancelled", async () => {
    const bridge = createMockBridge();
    window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    bridge.onInvoke("scan_folder", () => {
      throw new Error("Scan cancelled");
    });
    const { result } = renderHook(() => useScanController());
    const callbacks = {
      reset: vi.fn(),
      apply: vi.fn(),
      updateStatus: vi.fn(),
      cache: true,
    };
    const request = {
      folderPath: "/root",
      filterMode: "all" as const,
      includeSubfolders: true,
      includeHidden: false,
      useHashForDuplicates: false,
      duplicateMinSizeBytes: 0,
    };
    await act(async () => result.current.scan(request, "root", callbacks));
    expect(callbacks.reset).toHaveBeenCalledTimes(2);
    expect(callbacks.apply).not.toHaveBeenCalled();
    expect(callbacks.updateStatus).toHaveBeenLastCalledWith("Scan cancelled.");
    expect(result.current.isLoading).toBe(false);
  });
});
