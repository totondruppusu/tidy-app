import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUndoHistory, useUndoAction } from "../../src/hooks/useUndoController";
import { useMutationController } from "../../src/hooks/useMutationController";
import { useScanController } from "../../src/hooks/useScanController";
import { createMockBridge } from "../mocks/bridge";
import { createFile } from "../mocks/files";
import type { ScanResult, UndoAction } from "../../src/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const undo: UndoAction = { kind: "trash", file: createFile({ id: "saved" }), fromPath: "/original", trashPath: "/backup" };

describe("desktop workflow controllers", () => {
  it("hydrates undo before writing and serializes subsequent saves", async () => {
    const bridge = createMockBridge(); window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    const loaded = deferred<UndoAction[]>(); const firstSave = deferred<void>();
    bridge.onInvoke("get_recent_undo_actions", () => loaded.promise);
    const save = vi.fn().mockImplementationOnce(() => firstSave.promise).mockResolvedValue(undefined);
    bridge.onInvoke("store_recent_undo_actions", save);
    const { result } = renderHook(() => useUndoHistory());
    expect(save).not.toHaveBeenCalled();
    await act(async () => { loaded.resolve([undo]); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ actions: [undo] });
    act(() => result.current.setUndoStack([]));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => firstSave.resolve());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toEqual({ actions: [] });
  });

  it("keeps failed undo actions for retry", async () => {
    const bridge = createMockBridge(); window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    bridge.onInvoke("restore_file", () => { throw new Error("Restore target exists"); });
    const setUndoStack = vi.fn(); const restoreFileEntry = vi.fn(); const updateStatus = vi.fn();
    const { result } = renderHook(() => useUndoAction({ undoStack: [undo], setUndoStack, restoreFileEntry, updateStatus, runMutationWithSpinner: async (_label, operation) => operation() }));
    await act(async () => result.current());
    expect(setUndoStack).not.toHaveBeenCalled(); expect(restoreFileEntry).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining("Restore target exists"));
  });

  it("prevents overlapping mutations and clears state after failure", async () => {
    const overlay = vi.fn(); const pending = deferred<void>();
    const { result } = renderHook(() => useMutationController(overlay));
    const operation = vi.fn(() => pending.promise);
    let first!: Promise<void>;
    act(() => { first = result.current.runMutationWithSpinner("Moving…", operation); });
    await act(async () => result.current.runMutationWithSpinner("Moving…", operation));
    expect(operation).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); await first; });
    await act(async () => {
      await expect(result.current.runMutationWithSpinner("Moving…", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    });
    expect(result.current.isMutating).toBe(false); expect(overlay).toHaveBeenLastCalledWith(null);
  });

  it("does not cache incomplete scans and ignores superseded results", async () => {
    const bridge = createMockBridge(); window.__TIDY_DESKTOP_BRIDGE__ = bridge.bridge;
    const first = deferred<ScanResult>(); const second = deferred<ScanResult>();
    const invokeScan = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    bridge.onInvoke("scan_folder", invokeScan); bridge.onInvoke("cancel_scan", () => undefined);
    const save = vi.fn(); bridge.onInvoke("store_cached_scan_result", save);
    const { result } = renderHook(() => useScanController());
    const callbacks = { reset: vi.fn(), apply: vi.fn(), updateStatus: vi.fn(), cache: true };
    const request = { folderPath: "/root", filterMode: "all" as const, includeSubfolders: true, includeHidden: false, useHashForDuplicates: false, duplicateMinSizeBytes: 0 };
    let a!: Promise<void>; let b!: Promise<void>;
    act(() => { a = result.current.scan(request, "first", callbacks); });
    await act(async () => { b = result.current.scan(request, "second", callbacks); });
    await act(async () => { first.resolve({ files: [], total: 0 }); await a; });
    expect(callbacks.apply).not.toHaveBeenCalled();
    const incomplete: ScanResult = { files: [], total: 0, indexed: 1, issues: [{ code: "unreadable-entry", message: "Permission denied" }] };
    await act(async () => { second.resolve(incomplete); await b; });
    expect(callbacks.apply).toHaveBeenCalledWith("second", "/root", incomplete);
    expect(save).not.toHaveBeenCalled(); expect(result.current.isLoading).toBe(false);
  });
});
