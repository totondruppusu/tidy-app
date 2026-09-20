import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useExtensionFilter } from "../../src/hooks/useExtensionFilter";
import { useFileOperations } from "../../src/hooks/useFileOperations";
import { getExtension } from "../../src/lib/files";
import type { FileEntry } from "../../src/types";
import { createFile } from "../mocks/files";

function ExtensionHarness({
  mode,
  files,
}: {
  mode: "all" | "common" | "remember";
  files: FileEntry[];
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    files.map((file) => getExtension(file.name)),
  );
  const ext = useExtensionFilter({
    files,
    extensionFilterMode: mode,
    selectedExtensions: selected,
    setSelectedExtensions: setSelected,
  });
  return (
    <>
      <output data-testid="selected">{selected.join(",")}</output>
      <output data-testid="filtered">
        {ext.filteredFiles.map((file) => file.id).join(",")}
      </output>
      <button onClick={() => ext.handleToggleExtension("txt")}>
        toggle-txt
      </button>
      <button onClick={() => ext.handleToggleAllExtensions(true)}>all</button>
    </>
  );
}

describe("useExtensionFilter", () => {
  it("filters files when an extension is toggled off", () => {
    const files = [
      createFile({ id: "txt1", name: "a.txt", kind: "text" }),
      createFile({ id: "img1", name: "b.jpg", kind: "image" }),
    ];
    render(
      <ExtensionHarness mode="all" files={files} />,
    );
    expect(screen.getByTestId("filtered").textContent).toBe("txt1,img1");
    fireEvent.click(screen.getByText("toggle-txt"));
    expect(screen.getByTestId("selected").textContent).toBe("jpg");
    expect(screen.getByTestId("filtered").textContent).toBe("img1");
  });

  it("selects only common extensions when the filter switches to common", () => {
    const files = [
      createFile({ id: "txt1", name: "a.txt", kind: "text" }),
      createFile({ id: "img1", name: "b.jpg", kind: "image" }),
      createFile({ id: "rare", name: "c.log", kind: "text" }),
    ];
    render(
      <ExtensionHarness mode="common" files={files} />,
    );
    const selected = screen.getByTestId("selected").textContent?.split(",") ?? [];
    expect(selected).toContain("txt");
    expect(selected).toContain("jpg");
    expect(selected).not.toContain("log");
    expect(screen.getByTestId("filtered").textContent).toBe("txt1,img1");
  });
});

describe("useFileOperations", () => {
  it("keeps Android reveal/open actions guarded by a status message", async () => {
    const updateStatus = vi.fn();
    const currentFile = createFile({ id: "one", name: "one.txt" });
    const { result } = renderHook(() =>
      useFileOperations({
        isAndroidApp: true,
        currentFile,
        currentFolder: "/root",
        files: [],
        confirmDialog: vi.fn(async () => false),
        confirmTrash: true,
        trashBehavior: "system",
        destinationSlots: [null],
        destinationSlotTokens: [null],
        updateDestinationSlot: vi.fn(),
        updateStatus,
        runMutationWithSpinner: vi.fn(async (_label, operation) => operation()),
        pushUndo: vi.fn(),
        removeFileById: vi.fn(),
        removeFilesByIds: vi.fn(),
        openAndroidFolderBrowser: vi.fn(async () => null),
      }),
    );
    await result.current.openCurrentInFinder();
    expect(updateStatus).toHaveBeenCalledWith(
      "Reveal in file manager is not available on Android yet.",
    );
  });

  it("reports a missing destination without starting a mutation", async () => {
    const updateStatus = vi.fn();
    const runMutationWithSpinner = vi.fn();
    const currentFile = createFile({ id: "one", name: "one.txt" });
    const { result } = renderHook(() =>
      useFileOperations({
        isAndroidApp: false,
        currentFile,
        currentFolder: "/root",
        files: [],
        confirmDialog: vi.fn(async () => false),
        confirmTrash: false,
        trashBehavior: "system",
        destinationSlots: [null],
        destinationSlotTokens: [null],
        updateDestinationSlot: vi.fn(),
        updateStatus,
        runMutationWithSpinner,
        pushUndo: vi.fn(),
        removeFileById: vi.fn(),
        removeFilesByIds: vi.fn(),
        openAndroidFolderBrowser: vi.fn(async () => null),
      }),
    );
    await result.current.moveCurrentToSlot(0);
    expect(updateStatus).toHaveBeenCalledWith("Destination 1 not set.");
    expect(runMutationWithSpinner).not.toHaveBeenCalled();
  });
});
