import { useEffect } from "react";
import { isEditableTarget, shouldOpenOnEnter } from "../lib/dom";
import type { FileEntry } from "../types";

export type KeyboardShortcutOptions = {
  isConfirming: boolean;
  undoFailure: unknown;
  isLoading: boolean;
  scanCachePrompt: unknown;
  isHelpOpen: boolean;
  isSuggestionsOpen: boolean;
  isSettingsOpen: boolean;
  isMutating: boolean;
  blockingOverlay: unknown;
  currentFile: FileEntry | undefined;
  goPrev: () => void;
  goNext: () => void;
  seekMediaBy: (offsetSeconds: number) => void;
  toggleVideoPlayback: () => void;
  moveCurrentToSlot: (slotIndex: number) => void | Promise<void>;
  permanentlyDeleteCurrent: () => void | Promise<void>;
  trashCurrent: () => void | Promise<void>;
  undoLastAction: () => void | Promise<void>;
  openCurrentInFinder: () => void | Promise<void>;
  onCloseHelp: () => void;
  onCloseSuggestions: () => void;
  onCloseSettings: () => void;
};

export function useKeyboardShortcuts({
  isConfirming,
  undoFailure,
  isLoading,
  scanCachePrompt,
  isHelpOpen,
  isSuggestionsOpen,
  isSettingsOpen,
  isMutating,
  blockingOverlay,
  currentFile,
  goPrev,
  goNext,
  seekMediaBy,
  toggleVideoPlayback,
  moveCurrentToSlot,
  permanentlyDeleteCurrent,
  trashCurrent,
  undoLastAction,
  openCurrentInFinder,
  onCloseHelp,
  onCloseSuggestions,
  onCloseSettings,
}: KeyboardShortcutOptions) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isConfirming || undoFailure || isLoading || scanCachePrompt) return;
      if (isHelpOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          onCloseHelp();
        }
        return;
      }
      if (isSuggestionsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          onCloseSuggestions();
        }
        return;
      }
      if (isSettingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          onCloseSettings();
        }
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      if (isMutating || blockingOverlay) {
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        (currentFile?.kind === "video" || currentFile?.kind === "audio")
      ) {
        event.preventDefault();
        seekMediaBy(event.key === "ArrowLeft" ? -10 : 10);
        return;
      }
      if (
        (event.code === "Space" || event.key === " ") &&
        currentFile?.kind === "video"
      ) {
        event.preventDefault();
        toggleVideoPlayback();
        return;
      }
      if (event.key >= "1" && event.key <= "5") {
        event.preventDefault();
        void moveCurrentToSlot(Number(event.key) - 1);
        return;
      }
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
          event.preventDefault();
          goNext();
          break;
        case "ArrowUp":
          event.preventDefault();
          if (event.shiftKey) {
            void permanentlyDeleteCurrent();
          } else {
            void trashCurrent();
          }
          break;
        case "ArrowDown":
          event.preventDefault();
          void undoLastAction();
          break;
        case "Enter":
          if (!shouldOpenOnEnter(event.target)) {
            return;
          }
          event.preventDefault();
          void openCurrentInFinder();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    currentFile,
    goNext,
    goPrev,
    blockingOverlay,
    isHelpOpen,
    isConfirming,
    undoFailure,
    isLoading,
    scanCachePrompt,
    isMutating,
    isSuggestionsOpen,
    isSettingsOpen,
    moveCurrentToSlot,
    openCurrentInFinder,
    permanentlyDeleteCurrent,
    seekMediaBy,
    toggleVideoPlayback,
    trashCurrent,
    undoLastAction,
    onCloseHelp,
    onCloseSuggestions,
    onCloseSettings,
  ]);
}
