import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invokeCommand, isDesktopRuntime } from "../lib/desktopBridge";
import { MAX_UNDO_STACK } from "../constants/appConstants";
import type { FileEntry, UndoAction } from "../types";

export function useUndoHistory() {
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let active = true;
    invokeCommand<UndoAction[]>("get_recent_undo_actions")
      .then((actions) => {
        if (active) {
          setUndoStack((previous) =>
            [...previous, ...(Array.isArray(actions) ? actions : [])].slice(
              0,
              MAX_UNDO_STACK,
            ),
          );
          setHydrated(true);
        }
      })
      .catch((error) =>
        console.warn(
          "Unable to load undo history; preserving saved records.",
          error,
        ),
      );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!hydrated || !isDesktopRuntime()) return;
    writes.current = writes.current
      .then(() =>
        invokeCommand<void>("store_recent_undo_actions", {
          actions: undoStack,
        }),
      )
      .catch((error) => console.warn("Unable to save undo history.", error));
  }, [hydrated, undoStack]);
  const pushUndo = useCallback(
    (action: UndoAction) =>
      setUndoStack((previous) =>
        [action, ...previous].slice(0, MAX_UNDO_STACK),
      ),
    [],
  );
  return { undoStack, setUndoStack, pushUndo };
}

export type UndoFailure = {
  message: string;
  sourcePath: string;
  destinationPath: string;
};

type UndoOptions = {
  onFailure?: (failure: UndoFailure) => void;
  undoStack: UndoAction[];
  setUndoStack: Dispatch<SetStateAction<UndoAction[]>>;
  restoreFileEntry: (file: FileEntry) => void;
  restoreFileEntries?: (files: FileEntry[]) => void;
  updateStatus: (message: string) => void;
  runMutationWithSpinner: (
    label: string,
    operation: () => Promise<void>,
  ) => Promise<void>;
};
export function useUndoAction({
  undoStack,
  setUndoStack,
  restoreFileEntry,
  restoreFileEntries,
  updateStatus,
  runMutationWithSpinner,
  onFailure,
}: UndoOptions) {
  const undoLastAction = useCallback(async () => {
    const lastAction = undoStack[0];
    if (!lastAction) {
      updateStatus("Nothing to undo.");
      return;
    }
    if (lastAction.kind === "trash-folder") {
      await runMutationWithSpinner("Restoring…", async () => {
        try {
          await invokeCommand("restore_folder", {
            source: lastAction.trashPath,
            destination: lastAction.folderPath,
            allowUnsafe: lastAction.allowUnsafe ?? false,
            files: lastAction.items.map((item) => ({
              id: item.file.id,
              relativePath: item.relativePath,
            })),
          });
          const restored = lastAction.items.map((item) => item.file);
          if (restoreFileEntries) restoreFileEntries(restored);
          else restored.forEach(restoreFileEntry);
          setUndoStack((prev) => prev.slice(1));
          updateStatus(`Restored ${lastAction.items.length} items.`);
        } catch (error) {
          updateStatus(`Undo failed: ${String(error)}`);
          onFailure?.({
            message: String(error),
            sourcePath: lastAction.trashPath,
            destinationPath: lastAction.folderPath,
          });
        }
      });
      return;
    }
    const sourcePath =
      lastAction.sourceToken ??
      (lastAction.kind === "move" ? lastAction.toPath : lastAction.trashPath);
    const destinationPath = lastAction.destinationToken ?? lastAction.fromPath;
    await runMutationWithSpinner("Restoring…", async () => {
      try {
        await invokeCommand("restore_file", {
          id: lastAction.file.id,
          source: sourcePath,
          destination: destinationPath,
          fileName: lastAction.file.name,
          mimeType: lastAction.file.mime,
          displayPath: lastAction.file.path,
          allowUnsafe: lastAction.allowUnsafe ?? false,
          sizeBytes: lastAction.file.sizeBytes,
          modifiedMs: lastAction.file.modifiedMs,
        });
        restoreFileEntry(lastAction.file);
        setUndoStack((prev) => prev.slice(1));
        updateStatus(`Undid ${lastAction.kind}.`);
      } catch (error) {
        updateStatus(`Undo failed: ${String(error)}`);
        onFailure?.({ message: String(error), sourcePath, destinationPath });
      }
    });
  }, [
    undoStack,
    setUndoStack,
    restoreFileEntry,
    restoreFileEntries,
    updateStatus,
    runMutationWithSpinner,
    onFailure,
  ]);

  return undoLastAction;
}
