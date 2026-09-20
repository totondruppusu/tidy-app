import { useCallback } from "react";
import { invokeCommand } from "../lib/desktopBridge";
import { getRelativeSegments, splitPathSegments } from "../lib/path";
import { pickManagedDirectory } from "../services/directoryService";
import { revealInFileManager } from "../services/fileManagerService";
import { ANDROID_FOLDER_PICKER_HINT } from "../services/platform";
import type {
  FileEntry,
  FolderTrashEntry,
  FolderTrashItem,
  MoveResult,
  PickedDirectory,
  TrashBehavior,
  TrashResult,
  UndoAction,
} from "../types";

type ConfirmOptions = {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
  detail?: string;
};

type UseFileOperationsOptions = {
  isAndroidApp: boolean;
  currentFile: FileEntry | undefined;
  currentFolder: string | null;
  files: FileEntry[];
  confirmDialog: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  confirmTrash: boolean;
  trashBehavior: TrashBehavior;
  destinationSlots: (string | null)[];
  destinationSlotTokens: (string | null)[];
  updateDestinationSlot: (
    slotIndex: number,
    destination: { token: string; label: string },
  ) => void;
  updateStatus: (message: string) => void;
  runMutationWithSpinner: (
    label: string,
    operation: () => Promise<void>,
  ) => Promise<void>;
  pushUndo: (action: UndoAction) => void;
  removeFileById: (id: string) => void;
  removeFilesByIds: (ids: string[]) => void;
  openAndroidFolderBrowser: (
    initialPath?: string,
  ) => Promise<PickedDirectory | null>;
};

export function useFileOperations({
  isAndroidApp,
  currentFile,
  currentFolder,
  files,
  confirmDialog,
  confirmTrash,
  trashBehavior,
  destinationSlots,
  destinationSlotTokens,
  updateDestinationSlot,
  updateStatus,
  runMutationWithSpinner,
  pushUndo,
  removeFileById,
  removeFilesByIds,
  openAndroidFolderBrowser,
}: UseFileOperationsOptions) {
  const pickDestinationForSlot = useCallback(
    async (slotIndex: number) => {
      try {
        if (isAndroidApp) {
          updateStatus(ANDROID_FOLDER_PICKER_HINT);
          const selected = await openAndroidFolderBrowser(
            destinationSlotTokens[slotIndex] ?? undefined,
          );
          if (selected) {
            updateDestinationSlot(slotIndex, selected);
            updateStatus(
              `Destination ${slotIndex + 1} set to ${selected.label}.`,
            );
            return selected;
          }
          updateStatus(
            `No destination selected. ${ANDROID_FOLDER_PICKER_HINT}`,
          );
          return null;
        }
        const selected = await pickManagedDirectory();
        if (selected) {
          updateDestinationSlot(slotIndex, selected);
          updateStatus(
            `Destination ${slotIndex + 1} set to ${selected.label}.`,
          );
          return selected;
        }
        updateStatus(
          isAndroidApp
            ? `No destination selected. ${ANDROID_FOLDER_PICKER_HINT}`
            : "No destination selected.",
        );
      } catch (error) {
        updateStatus(
          isAndroidApp
            ? `Destination picker failed: ${String(error)} ${ANDROID_FOLDER_PICKER_HINT}`
            : `Destination picker failed: ${String(error)}`,
        );
      }
      return null;
    },
    [
      destinationSlotTokens,
      isAndroidApp,
      openAndroidFolderBrowser,
      updateDestinationSlot,
      updateStatus,
    ],
  );

  const requestDeletion = useCallback(
    async (
      message: string,
      path: string,
      permanent: boolean,
      target: { id?: string; folderPath?: string },
    ) => {
      let reason: string | null;
      try {
        reason = await invokeCommand<string | null>(
          "deletion_path_warning",
          target,
        );
      } catch (error) {
        updateStatus(`Unable to check deletion safety: ${String(error)}`);
        return null;
      }
      const needsConfirmation = Boolean(reason) || confirmTrash || permanent;
      if (
        needsConfirmation &&
        !(await confirmDialog(
          reason
            ? `${message}\n\nThis location may contain system or application files. Removing it could stop your system or an app from working.\n\n${reason}`
            : message,
          {
            title: reason
              ? "Delete from a protected location?"
              : permanent
                ? "Permanently delete?"
                : "Move to trash?",
            confirmLabel: permanent ? "Delete permanently" : "Move to trash",
            danger: true,
            detail: path,
          },
        ))
      )
        return null;
      return Boolean(reason);
    },
    [confirmDialog, confirmTrash, updateStatus],
  );

  const trashCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const allowUnsafe = await requestDeletion(
      trashBehavior === "permanent"
        ? `Permanently delete ${currentFile.name}? This cannot be undone.`
        : `Move ${currentFile.name} to system trash?`,
      currentFile.path,
      trashBehavior === "permanent",
      { id: currentFile.id },
    );
    if (allowUnsafe === null) return;
    await runMutationWithSpinner(
      trashBehavior === "permanent" ? "Deleting…" : "Trashing…",
      async () => {
        try {
          const result = await invokeCommand<TrashResult>("trash_file", {
            id: currentFile.id,
            trashMode: trashBehavior,
            allowPermanentDelete: trashBehavior === "permanent",
            allowUnsafe,
          });
          removeFileById(currentFile.id);
          if (result.trashPath) {
            pushUndo({
              kind: "trash",
              allowUnsafe,
              file: currentFile,
              fromPath: currentFile.path,
              trashPath: result.trashPath,
              destinationToken: result.restoreDestination ?? null,
            });
          }
          const baseMessage =
            trashBehavior === "permanent"
              ? `Deleted ${currentFile.name}.`
              : isAndroidApp
                ? `Removed ${currentFile.name}.`
                : `Moved ${currentFile.name} to system trash.`;
          updateStatus(
            result.trashPath ? baseMessage : `${baseMessage} Undo unavailable.`,
          );
        } catch (error) {
          updateStatus(`Trash failed: ${String(error)}`);
        }
      },
    );
  }, [
    requestDeletion,
    currentFile,
    removeFileById,
    updateStatus,
    pushUndo,
    trashBehavior,
    runMutationWithSpinner,
    isAndroidApp,
  ]);

  const permanentlyDeleteCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const allowUnsafe = await requestDeletion(
      `Permanently delete ${currentFile.name}? This cannot be undone.`,
      currentFile.path,
      true,
      { id: currentFile.id },
    );
    if (allowUnsafe === null) return;
    await runMutationWithSpinner("Deleting…", async () => {
      try {
        await invokeCommand<TrashResult>("trash_file", {
          id: currentFile.id,
          trashMode: "permanent",
          allowPermanentDelete: true,
          allowUnsafe,
        });
        removeFileById(currentFile.id);
        // Permanent delete doesn't create a trash path, so no undo
        updateStatus(`Permanently deleted ${currentFile.name}.`);
      } catch (error) {
        updateStatus(`Delete failed: ${String(error)}`);
      }
    });
  }, [
    requestDeletion,
    currentFile,
    removeFileById,
    updateStatus,
    runMutationWithSpinner,
  ]);

  const getFolderFiles = useCallback(
    (folderPath: string) => {
      const folderSegments = splitPathSegments(folderPath);
      if (folderSegments.length === 0) {
        return [];
      }
      return files.filter((file) => {
        const relativeSegments = getRelativeSegments(file.path, currentFolder);
        if (relativeSegments.length < folderSegments.length) {
          return false;
        }
        return folderSegments.every(
          (segment, index) => relativeSegments[index] === segment,
        );
      });
    },
    [files, currentFolder],
  );

  const trashFolder = useCallback(
    async (folderPath: string) => {
      if (!currentFolder) {
        updateStatus("No folder selected.");
        return;
      }
      if (isAndroidApp) {
        updateStatus("Folder trash is not available on Android yet.");
        return;
      }
      const folderFiles = getFolderFiles(folderPath);
      if (folderFiles.length === 0) {
        updateStatus("Folder is empty.");
        return;
      }
      const folderSegments = splitPathSegments(folderPath);
      const folderLabel =
        folderSegments[folderSegments.length - 1] ?? folderPath;
      const base = currentFolder.replace(/[\\/]+$/, "");
      const fullFolderPath = `${base}/${folderPath}`;
      const allowUnsafe = await requestDeletion(
        `${trashBehavior === "permanent" ? "Permanently delete" : "Move to trash"} ${folderLabel} and all its contents? This includes files hidden by the current filters.${trashBehavior === "permanent" ? " This cannot be undone." : ""}`,
        fullFolderPath,
        trashBehavior === "permanent",
        { folderPath: fullFolderPath },
      );
      if (allowUnsafe === null) return;
      const items: FolderTrashItem[] = folderFiles.map((file) => ({
        file,
        relativePath: getRelativeSegments(file.path, fullFolderPath).join("/"),
      }));
      const entries: FolderTrashEntry[] = items.map((item) => ({
        id: item.file.id,
        relativePath: item.relativePath,
      }));
      await runMutationWithSpinner(
        trashBehavior === "permanent" ? "Deleting…" : "Trashing…",
        async () => {
          try {
            const result = await invokeCommand<TrashResult>("trash_folder", {
              folderPath: fullFolderPath,
              files: entries,
              trashMode: trashBehavior,
              allowPermanentDelete: trashBehavior === "permanent",
              allowUnsafe,
            });
            removeFilesByIds(folderFiles.map((file) => file.id));
            if (result.trashPath) {
              pushUndo({
                kind: "trash-folder",
                allowUnsafe,
                folderPath: fullFolderPath,
                trashPath: result.trashPath,
                items,
              });
            }
            const baseMessage =
              trashBehavior === "permanent"
                ? `Deleted ${folderLabel}.`
                : `Moved ${folderLabel} to system trash.`;
            updateStatus(
              result.trashPath
                ? baseMessage
                : `${baseMessage} Undo unavailable.`,
            );
          } catch (error) {
            updateStatus(`Trash folder failed: ${String(error)}`);
          }
        },
      );
    },
    [
      requestDeletion,
      currentFolder,
      getFolderFiles,
      isAndroidApp,
      updateStatus,
      removeFilesByIds,
      pushUndo,
      trashBehavior,
      runMutationWithSpinner,
    ],
  );

  const moveCurrentToSlot = useCallback(
    async (slotIndex: number, allowPickIfMissing = false) => {
      if (!currentFile) {
        updateStatus("No file selected.");
        return;
      }
      let destinationToken = destinationSlotTokens[slotIndex] ?? null;
      let destinationLabel = destinationSlots[slotIndex] ?? null;
      if (!destinationToken || !destinationLabel) {
        if (allowPickIfMissing) {
          const selected = await pickDestinationForSlot(slotIndex);
          destinationToken = selected?.token ?? null;
          destinationLabel = selected?.label ?? null;
        } else {
          updateStatus(`Destination ${slotIndex + 1} not set.`);
          return;
        }
      }
      if (!destinationToken || !destinationLabel) {
        return;
      }
      await runMutationWithSpinner("Moving…", async () => {
        try {
          await invokeCommand("set_destination", {
            destination: destinationToken,
            label: destinationLabel,
          });
          const result = await invokeCommand<MoveResult>("move_file", {
            id: currentFile.id,
          });
          removeFileById(currentFile.id);
          pushUndo({
            kind: "move",
            file: currentFile,
            fromPath: currentFile.path,
            toPath: result.targetPath,
            sourceToken: result.restoreSource ?? null,
            destinationToken: result.restoreDestination ?? null,
          });
          updateStatus(`Moved to ${result.targetPath}.`);
        } catch (error) {
          updateStatus(`Move failed: ${String(error)}`);
        }
      });
    },
    [
      currentFile,
      destinationSlots,
      destinationSlotTokens,
      pickDestinationForSlot,
      removeFileById,
      updateStatus,
      pushUndo,
      runMutationWithSpinner,
    ],
  );

  const openFileInFinder = useCallback(
    async (file: FileEntry) => {
      if (isAndroidApp) {
        updateStatus("Reveal in file manager is not available on Android yet.");
        return;
      }
      try {
        await revealInFileManager({
          path: file.path,
          reveal: true,
        });
      } catch (error) {
        updateStatus(`Reveal in file manager failed: ${String(error)}`);
      }
    },
    [isAndroidApp, updateStatus],
  );

  const openFileInSystem = useCallback(
    async (file: FileEntry) => {
      if (isAndroidApp) {
        updateStatus("Open in another app is not available on Android yet.");
        return;
      }
      try {
        await revealInFileManager({
          path: file.path,
          reveal: false,
        });
      } catch (error) {
        updateStatus(`Open file failed: ${String(error)}`);
      }
    },
    [isAndroidApp, updateStatus],
  );

  const openCurrentInFinder = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    await openFileInFinder(currentFile);
  }, [currentFile, openFileInFinder, updateStatus]);

  return {
    trashCurrent,
    permanentlyDeleteCurrent,
    trashFolder,
    moveCurrentToSlot,
    openFileInFinder,
    openFileInSystem,
    openCurrentInFinder,
    pickDestinationForSlot,
  };
}
