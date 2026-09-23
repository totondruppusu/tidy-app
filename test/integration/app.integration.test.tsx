import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/app/App";
import { createMockBridge } from "../mocks/bridge";
import { createFile } from "../mocks/files";
import type { PreviewCapabilities, ScanResult, SuggestionSet } from "../../src/types";

const previewCapabilities: PreviewCapabilities = {
  platform: "test",
  textPreview: true,
  pdfPreview: true,
  mediaPreview: true,
  archivePreview: true,
  officeRichPreview: false,
  officeFallbackPreview: true,
  notes: [],
};

const installBaseHandlers = (controller: ReturnType<typeof createMockBridge>) => {
  controller.onInvoke("deletion_path_warning", () => null);
  controller.onInvoke("get_crash_report", () => null);
  controller.onInvoke("get_preview_capabilities", () => previewCapabilities);
  controller.onInvoke("get_cached_scan", () => null);
  controller.onInvoke("store_cached_scan_result", () => null);
  controller.onInvoke("hydrate_cached_scan", () => null);
  controller.onInvoke("get_recent_undo_actions", () => []);
  controller.onInvoke("store_recent_undo_actions", () => null);
  controller.onInvoke("update_heartbeat", () => null);
  controller.onInvoke("log_client_error", () => null);
  controller.onInvoke("reveal_in_file_manager", () => null);
  controller.onInvoke("generate_preview", () => "preview-id");
  controller.onInvoke("extract_office_fallback_preview", () => ({
    mode: "text",
    title: "fallback",
    excerpt: "preview",
  }));
  controller.onInvoke("list_archive_entries", () => ({ entries: [], truncated: false }));
  controller.onInvoke("read_text_preview", () => "");
};

const withAndroidUserAgent = async (run: () => Promise<void>) => {
  const originalUserAgent = window.navigator.userAgent;
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
  });
  try {
    await run();
  } finally {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: originalUserAgent,
    });
  }
};

describe("App integration", () => {
  const mockNarrowLayout = () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === "(max-width: 900px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  };

  const clickFolderPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    const revealSidebar = screen.queryByRole("button", { name: "Show sidebar" });
    if (revealSidebar) {
      await user.click(revealSidebar);
    }
    const picker = await screen.findByText("Select folder…").then((node) => node.closest("button"));
    expect(picker).not.toBeNull();
    await user.click(picker!);
  };

  const swipeSurface = async (
    target: HTMLElement,
    deltaX: number,
    deltaY: number,
  ) => {
    await act(async () => {
      fireEvent.pointerDown(target, {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(target, {
        pointerId: 1,
        clientX: 100 + deltaX,
        clientY: 100 + deltaY,
      });
      fireEvent.pointerUp(target, {
        pointerId: 1,
        clientX: 100 + deltaX,
        clientY: 100 + deltaY,
      });
    });
  };

  it("scans and renders files with list controls", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({ id: "f1", name: "small.txt", kind: "text", path: "/mock/small.txt", sizeBytes: 10 }),
      createFile({ id: "f2", name: "big.jpg", kind: "image", path: "/mock/big.jpg", sizeBytes: 2000 }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("small.txt")
    );
    expect(container.querySelector(".file-list")?.textContent).toContain("big.jpg");

    await user.selectOptions(screen.getByDisplayValue("List"), "list");
    await user.selectOptions(screen.getByDisplayValue("Name (A-Z)"), "size_desc");

    const fileNames = Array.from(container.querySelectorAll(".file-item .filename")).map((n) =>
      n.textContent?.trim()
    );
    expect(fileNames[0]).toBe("big.jpg");
  });

  it("opens a file on double click and reveals its folder from the toolbar", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const file = createFile({
      id: "f1",
      name: "notes.txt",
      kind: "text",
      path: "/mock/notes.txt",
    });
    const reveal = vi.fn();
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));
    controller.onInvoke("reveal_in_file_manager", reveal);

    const user = userEvent.setup();
    const { container } = render(<App />);
    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    const fileRow = await screen.findByRole("button", { name: /notes\.txt/ });
    await user.dblClick(fileRow);
    await waitFor(() =>
      expect(reveal).toHaveBeenLastCalledWith({
        path: "/mock/notes.txt",
        reveal: false,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Open containing folder" }));
    await waitFor(() =>
      expect(reveal).toHaveBeenLastCalledWith({
        path: "/mock/notes.txt",
        reveal: true,
      }),
    );
    expect(container.querySelector(".file-list")).toBeInTheDocument();
  });

  it("shares the file bytes without adding path or title text", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const file = createFile({
      id: "f1",
      name: "notes.txt",
      kind: "text",
      path: "/mock/notes.txt",
      mime: "text/plain",
    });
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));

    const originalFetch = globalThis.fetch;
    const originalShare = navigator.share;
    const originalCanShare = navigator.canShare;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["file contents"], { type: "text/plain" }),
    });
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const canShareMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
    Object.defineProperty(navigator, "share", { configurable: true, value: shareMock });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: canShareMock });

    try {
      const user = userEvent.setup();
      const { container } = render(<App />);
      await clickFolderPicker(user);
      await user.click(screen.getByRole("button", { name: "Scan folder" }));
      await waitFor(() =>
        expect(container.querySelector(".file-list")?.textContent).toContain("notes.txt"),
      );
      await user.click(screen.getByRole("button", { name: "Share file" }));

      await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
      const shareData = shareMock.mock.calls[0][0] as ShareData;
      expect(Object.keys(shareData)).toEqual(["files"]);
      expect(shareData.files).toHaveLength(1);
      expect(shareData.files?.[0].name).toBe("notes.txt");
      expect(await shareData.files?.[0].text()).toBe("file contents");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
      Object.defineProperty(navigator, "share", { configurable: true, value: originalShare });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: originalCanShare });
    }
  });

  it("defaults new tree scans to folded folders", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "f1",
        name: "nested.txt",
        kind: "text",
        path: "/mock/archive/nested.txt",
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    const { container } = render(<App />);

    const viewModeSelect = Array.from(container.querySelectorAll("select")).find(
      (element) => element instanceof HTMLSelectElement && ["tree", "list"].includes(element.value),
    );
    expect(viewModeSelect).toBeInstanceOf(HTMLSelectElement);
    await user.selectOptions(viewModeSelect as HTMLSelectElement, "tree");

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    const archiveToggle = await screen.findByRole("button", {
      name: "Expand archive",
    });
    expect(archiveToggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".file-item .filename")).toBeNull();
  });

  it("shows aggregated folder size under the folder name in tree view", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "f1",
        name: "first.txt",
        kind: "text",
        path: "/mock/archive/first.txt",
        sizeBytes: 1024,
      }),
      createFile({
        id: "f2",
        name: "second.txt",
        kind: "text",
        path: "/mock/archive/second.txt",
        sizeBytes: 2048,
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    const { container } = render(<App />);

    const viewModeSelect = Array.from(container.querySelectorAll("select")).find(
      (element) => element instanceof HTMLSelectElement && ["tree", "list"].includes(element.value),
    );
    expect(viewModeSelect).toBeInstanceOf(HTMLSelectElement);
    await user.selectOptions(viewModeSelect as HTMLSelectElement, "tree");

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    const archiveToggle = await screen.findByRole("button", {
      name: "Expand archive",
    });
    expect(archiveToggle).toHaveTextContent("archive");
    expect(archiveToggle).toHaveTextContent("3.0 KB");
  });

  it("keeps folders above files in tree view while preserving size sorting within folders", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "f1",
        name: "small.txt",
        kind: "text",
        path: "/mock/a-small/small.txt",
        sizeBytes: 10,
      }),
      createFile({
        id: "f2",
        name: "medium.txt",
        kind: "text",
        path: "/mock/medium.txt",
        sizeBytes: 50,
      }),
      createFile({
        id: "f3",
        name: "large.txt",
        kind: "text",
        path: "/mock/z-large/large.txt",
        sizeBytes: 100,
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    const { container } = render(<App />);

    const viewModeSelect = Array.from(container.querySelectorAll("select")).find(
      (element) => element instanceof HTMLSelectElement && ["tree", "list"].includes(element.value),
    );
    expect(viewModeSelect).toBeInstanceOf(HTMLSelectElement);
    await user.selectOptions(viewModeSelect as HTMLSelectElement, "tree");

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await user.selectOptions(screen.getByDisplayValue("Name (A-Z)"), "size_desc");

    const visibleRootLabels = Array.from(
      container.querySelectorAll(".folder-item, .file-item"),
    ).map((node) => {
      const labelNode = node.querySelector(".folder-name, .filename");
      return labelNode?.textContent?.trim() ?? "";
    });

    expect(visibleRootLabels.slice(0, 3)).toEqual(["z-large", "a-small", "medium.txt"]);
  });

  it("keeps folded tree folders folded when sort changes", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "f1",
        name: "small.txt",
        kind: "text",
        path: "/mock/alpha/small.txt",
        sizeBytes: 10,
      }),
      createFile({
        id: "f2",
        name: "large.txt",
        kind: "text",
        path: "/mock/beta/large.txt",
        sizeBytes: 100,
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    const { container } = render(<App />);

    const viewModeSelect = Array.from(container.querySelectorAll("select")).find(
      (element) => element instanceof HTMLSelectElement && ["tree", "list"].includes(element.value),
    );
    expect(viewModeSelect).toBeInstanceOf(HTMLSelectElement);
    await user.selectOptions(viewModeSelect as HTMLSelectElement, "tree");

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    expect(
      await screen.findByRole("button", { name: "Expand alpha" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Expand beta" }),
    ).toHaveAttribute("aria-expanded", "false");

    await user.selectOptions(screen.getByDisplayValue("Name (A-Z)"), "size_desc");

    expect(
      await screen.findByRole("button", { name: "Expand alpha" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Expand beta" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".file-item .filename")).toBeNull();
  });

  it("renders markdown files with a rich preview", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "md-1",
        name: "README.md",
        kind: "text",
        path: "/mock/README.md",
        mime: "text/markdown",
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));
    controller.onInvoke(
      "read_text_preview",
      () => "# Project title\n\nA **bold** intro with `code`.\n\n- First item\n- Second item\n",
    );

    const user = userEvent.setup();
    render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    expect(await screen.findByRole("heading", { name: "Project title" })).toBeVisible();
    expect(screen.getByText("bold")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText("First item")).toHaveProperty("tagName", "LI");
  });

  it("renders code files with a syntax-aware preview", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "py-1",
        name: "script.py",
        kind: "binary",
        path: "/mock/script.py",
        mime: "text/x-python",
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));
    controller.onInvoke(
      "read_text_preview",
      () => 'def tidy(value):\n    return "preview"\n',
    );

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    expect(await screen.findByText("Python")).toBeVisible();
    expect(screen.getByLabelText("Code preview of script.py")).toBeVisible();
    expect(container.querySelector(".token-keyword")?.textContent).toBe("def");
    expect(screen.queryByText("No rich preview available.")).toBeNull();
  });

  it("starts type groups folded when grouping changes", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "f1",
        name: "photo.jpg",
        kind: "image",
        path: "/mock/photo.jpg",
      }),
      createFile({
        id: "f2",
        name: "note.txt",
        kind: "text",
        path: "/mock/note.txt",
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await user.selectOptions(screen.getByDisplayValue("None"), "type");

    expect(
      await screen.findByRole("button", { name: "Expand Images" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Expand Text files" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("starts extension groups folded after a fresh scan", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({
        id: "f1",
        name: "photo.jpg",
        kind: "image",
        path: "/mock/photo.jpg",
      }),
      createFile({
        id: "f2",
        name: "note.txt",
        kind: "text",
        path: "/mock/note.txt",
      }),
    ];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(screen.getByDisplayValue("None"), "extension");
    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    expect(
      await screen.findByRole("button", { name: "Expand .jpg" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: "Expand .txt" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("requires a protected-path decision even with trash confirmations disabled", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;
    const file = createFile({ id: "protected", name: "config.txt", path: "C:\\Windows\\config.txt" });
    controller.bridge.open = async () => "C:\\Windows";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));
    controller.onInvoke("deletion_path_warning", () => "Windows system path is protected by safety policy");
    const remove = vi.fn(() => ({ trashPath: "/trash/config.txt" }));
    controller.onInvoke("trash_file", remove);
    const restore = vi.fn(() => null);
    controller.onInvoke("restore_file", restore);
    const user = userEvent.setup();
    render(<App />);
    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await user.click(await screen.findByRole("button", { name: "Trash ↑" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete from a protected location?" })).toHaveTextContent("C:\\Windows\\config.txt");
    expect(remove).not.toHaveBeenCalled();
    await user.keyboard("{ArrowUp}{Escape}");
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Trash ↑" }));
    await user.click(await screen.findByRole("button", { name: "Move to trash", exact: true }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: "protected", allowUnsafe: true, allowPermanentDelete: false })));
    await user.click(screen.getByRole("button", { name: "Undo ↓" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(expect.objectContaining({ allowUnsafe: true })));
  });

  it("permanent deletion always asks and authorizes only permanent deletion", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;
    const file = createFile({ id: "f1", name: "doc.txt", path: "/mock/doc.txt" });
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));
    const remove = vi.fn(() => ({ trashPath: null }));
    controller.onInvoke("trash_file", remove);
    const user = userEvent.setup();
    render(<App />);
    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await screen.findByRole("alertdialog", { name: "Permanently delete?" });
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(expect.objectContaining({ allowUnsafe: false, allowPermanentDelete: true })));
  });

  it("shows a retryable undo error without losing the saved recovery action", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;
    const file = createFile({ id: "nas", name: "doc.txt", path: "/Volumes/NAS/doc.txt" });
    controller.bridge.open = async () => "/Volumes/NAS";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));
    controller.onInvoke("trash_file", () => ({ trashPath: "/local-backup/doc.txt" }));
    const restore = vi.fn().mockRejectedValueOnce(new Error("Original folder unavailable. Reconnect the NAS.")).mockResolvedValue(null);
    controller.onInvoke("restore_file", restore);
    const user = userEvent.setup();
    const { container } = render(<App />);
    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await user.click(screen.getByRole("button", { name: "Trash ↑" }));
    await user.click(screen.getByRole("button", { name: "Undo ↓" }));
    const error = await screen.findByRole("alertdialog", { name: "Couldn’t complete undo" });
    expect(error).toHaveTextContent("Reconnect the NAS");
    expect(error).toHaveTextContent("/local-backup/doc.txt");
    expect(container.querySelector(".file-list")?.textContent).not.toContain("doc.txt");
    await user.click(screen.getByRole("button", { name: "Retry undo" }));
    await waitFor(() => expect(container.querySelector(".file-list")?.textContent).toContain("doc.txt"));
    expect(restore).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Undo ↓" })).toBeDisabled();
  });

  it("supports trash then undo flow", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const file = createFile({ id: "f1", name: "doc.txt", kind: "text", path: "/mock/doc.txt" });
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));
    controller.onInvoke("trash_file", () => ({ trashPath: "/trash/doc.txt" }));
    controller.onInvoke("restore_file", () => null);

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("doc.txt")
    );

    await user.click(screen.getByRole("button", { name: "Trash ↑" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent ?? "").not.toContain("doc.txt")
    );

    await user.click(screen.getByRole("button", { name: "Undo ↓" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("doc.txt")
    );
  });

  it("switches narrow layouts to preview swipes and hides directional buttons", async () => {
    mockNarrowLayout();
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const file = createFile({ id: "f1", name: "doc.txt", kind: "text", path: "/mock/doc.txt" });
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));

    const user = userEvent.setup();
    render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));

    expect(screen.queryByRole("button", { name: "Prev ←" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next →" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trash ↑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo ↓" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Swipe actions" })).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "Swipe the preview: left previous, right next, up trash, down undo",
      ),
    ).toBeInTheDocument();
  });

  it("uses swipe gestures for next and previous selection on narrow layouts", async () => {
    mockNarrowLayout();
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({ id: "f1", name: "alpha.txt", kind: "text", path: "/mock/alpha.txt" }),
      createFile({ id: "f2", name: "beta.txt", kind: "text", path: "/mock/beta.txt" }),
    ];
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await screen.findByText("/mock/alpha.txt");

    const previewSurface = screen.getByLabelText(
      "Swipe the preview: left previous, right next, up trash, down undo",
    );
    await swipeSurface(previewSurface, 80, 0);
    await waitFor(() => expect(screen.getByText("/mock/beta.txt")).toBeInTheDocument());

    await swipeSurface(previewSurface, -80, 0);
    await waitFor(() => expect(screen.getByText("/mock/alpha.txt")).toBeInTheDocument());
  });

  it("uses swipe up to trash and swipe down to undo on narrow layouts", async () => {
    mockNarrowLayout();
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const file = createFile({ id: "f1", name: "doc.txt", kind: "text", path: "/mock/doc.txt" });
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));
    controller.onInvoke("trash_file", () => ({ trashPath: "/trash/doc.txt" }));
    controller.onInvoke("restore_file", () => null);

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("doc.txt")
    );

    const previewSurface = screen.getByLabelText(
      "Swipe the preview: left previous, right next, up trash, down undo",
    );
    await swipeSurface(previewSurface, 0, -80);
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent ?? "").not.toContain("doc.txt")
    );

    await swipeSurface(
      screen.getByLabelText(
        "Swipe the preview: left previous, right next, up trash, down undo",
      ),
      0,
      80,
    );
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("doc.txt")
    );
  });

  it("ignores swipe gestures while the settings modal is open", async () => {
    mockNarrowLayout();
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({ id: "f1", name: "alpha.txt", kind: "text", path: "/mock/alpha.txt" }),
      createFile({ id: "f2", name: "beta.txt", kind: "text", path: "/mock/beta.txt" }),
    ];
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));

    const user = userEvent.setup();
    render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await screen.findByText("/mock/alpha.txt");
    await user.click(screen.getByRole("button", { name: "Open settings" }));

    const previewSurface = screen.getByLabelText(
      "Swipe the preview: left previous, right next, up trash, down undo",
    );
    await swipeSurface(previewSurface, 80, 0);

    expect(screen.getByText("/mock/alpha.txt")).toBeInTheDocument();
  });

  it("uses Android all-files access and passes the selected storage path into scans", async () => {
    await withAndroidUserAgent(async () => {
      const controller = createMockBridge();
      installBaseHandlers(controller);
      window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

      const desktopOpen = vi.fn(async () => "/desktop-should-not-open");
      controller.bridge.open = desktopOpen;
      controller.onInvoke("pick_android_directory", () => ({
        token: "/storage/emulated/0",
        label: "/storage/emulated/0",
      }));
      controller.onInvoke("list_local_directories", (args) => {
        if (args?.path === "/storage/emulated/0/Pictures") {
          return {
            currentPath: "/storage/emulated/0/Pictures",
            parentPath: "/storage/emulated/0",
            directories: [],
          };
        }
        return {
          currentPath: "/storage/emulated/0",
          parentPath: "/storage/emulated",
          directories: [
            {
              path: "/storage/emulated/0/Pictures",
              label: "Pictures",
            },
          ],
        };
      });
      controller.onInvoke("scan_folder", (args) => {
        expect(args?.folderPath).toBe("/storage/emulated/0/Pictures");
        expect(args?.folderLabel).toBe("/storage/emulated/0/Pictures");
        return {
          files: [
            createFile({
              id: "f1",
              name: "photo.jpg",
              kind: "image",
              path: "/storage/emulated/0/Pictures/photo.jpg",
            }),
          ],
          total: 1,
        };
      });

      const user = userEvent.setup();
      render(<App />);

      await clickFolderPicker(user);
      await user.click(await screen.findByRole("button", { name: "Pictures" }));
      await user.click(screen.getByRole("button", { name: "Use this folder" }));
      expect(desktopOpen).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Scan folder" }));

      expect((await screen.findAllByText("photo.jpg")).length).toBeGreaterThan(0);
    });
  });

  it("disables external open actions on Android", async () => {
    await withAndroidUserAgent(async () => {
      const controller = createMockBridge();
      installBaseHandlers(controller);
      window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

      controller.onInvoke("pick_android_directory", () => ({
        token: "/storage/emulated/0",
        label: "/storage/emulated/0",
      }));
      controller.onInvoke("list_local_directories", (args) => {
        if (args?.path === "/storage/emulated/0/Pictures") {
          return {
            currentPath: "/storage/emulated/0/Pictures",
            parentPath: "/storage/emulated/0",
            directories: [],
          };
        }
        return {
          currentPath: "/storage/emulated/0",
          parentPath: "/storage/emulated",
          directories: [
            {
              path: "/storage/emulated/0/Pictures",
              label: "Pictures",
            },
          ],
        };
      });
      controller.onInvoke("scan_folder", () => ({
        files: [
          createFile({
            id: "f1",
            name: "notes.txt",
            kind: "text",
            path: "Pictures/notes.txt",
          }),
        ],
        total: 1,
      }));

      const user = userEvent.setup();
      render(<App />);

      await clickFolderPicker(user);
      await user.click(await screen.findByRole("button", { name: "Pictures" }));
      await user.click(screen.getByRole("button", { name: "Use this folder" }));
      await user.click(screen.getByRole("button", { name: "Scan folder" }));

      expect(
        await screen.findByRole("button", { name: "Open containing folder" }),
      ).toBeDisabled();
    });
  });

  it("moves Android details and settings into the preview action bar", async () => {
    await withAndroidUserAgent(async () => {
      const controller = createMockBridge();
      installBaseHandlers(controller);
      window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

      controller.onInvoke("pick_android_directory", () => ({
        token: "/storage/emulated/0",
        label: "/storage/emulated/0",
      }));
      controller.onInvoke("list_local_directories", (args) => {
        if (args?.path === "/storage/emulated/0/Pictures") {
          return {
            currentPath: "/storage/emulated/0/Pictures",
            parentPath: "/storage/emulated/0",
            directories: [],
          };
        }
        return {
          currentPath: "/storage/emulated/0",
          parentPath: "/storage/emulated",
          directories: [
            {
              path: "/storage/emulated/0/Pictures",
              label: "Pictures",
            },
          ],
        };
      });
      controller.onInvoke("scan_folder", () => ({
        files: [
          createFile({
            id: "f1",
            name: "notes.txt",
            kind: "text",
            path: "Pictures/notes.txt",
          }),
        ],
        total: 1,
      }));
      const shareFile = vi.fn();
      controller.onInvoke("share_file", shareFile);

      const user = userEvent.setup();
      render(<App />);

      expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();

      await clickFolderPicker(user);
      await user.click(await screen.findByRole("button", { name: "Pictures" }));
      await user.click(screen.getByRole("button", { name: "Use this folder" }));
      await user.click(screen.getByRole("button", { name: "Scan folder" }));

      await screen.findByText("notes.txt");
      expect(screen.queryByLabelText("File details")).not.toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Open settings" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Show file details" }));
      expect(await screen.findByLabelText("File details")).toBeInTheDocument();
      expect(screen.getByText("Full path")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Share file" }));
      await waitFor(() =>
        expect(shareFile).toHaveBeenCalledWith({
          id: "f1",
          mimeType: "image/jpeg",
        }),
      );
    });
  });

  it("renders streamed scan batches and keeps the final result authoritative", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    const readPreview = vi.fn(() => "preview");
    controller.onInvoke("read_text_preview", readPreview);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const streamedFile = createFile({
      id: "f1",
      name: "streamed.txt",
      kind: "text",
      path: "/mock/streamed.txt",
    });
    const finalFile = createFile({
      id: "f2",
      name: "final.jpg",
      kind: "image",
      path: "/mock/final.jpg",
    });
    let scanId = "";
    let resolveScan: ((result: ScanResult) => void) | null = null;

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", (args) => {
      scanId = String(args?.scanId ?? "");
      return new Promise<ScanResult>((resolve) => {
        resolveScan = resolve;
      });
    });

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await waitFor(() => expect(resolveScan).not.toBeNull());

    await act(async () => {
      controller.emit("scan_batch", { scanId, files: [streamedFile] });
    });
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("streamed.txt")
    );

    expect(readPreview).not.toHaveBeenCalled();

    await act(async () => {
      resolveScan?.({ files: [streamedFile, finalFile], total: 2 });
    });
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("final.jpg")
    );

    const fileNames = Array.from(container.querySelectorAll(".file-item .filename")).map((node) =>
      node.textContent?.trim()
    );
    expect(fileNames).toEqual(["final.jpg", "streamed.txt"]);
  });

  it("dedupes repeated files from scan batches and final scan results", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const duplicated = createFile({
      id: "f1",
      name: "same.txt",
      kind: "text",
      path: "/mock/same.txt",
    });
    const later = createFile({
      id: "f2",
      name: "later.jpg",
      kind: "image",
      path: "/mock/later.jpg",
    });
    let scanId = "";
    let resolveScan: ((result: ScanResult) => void) | null = null;

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", (args) => {
      scanId = String(args?.scanId ?? "");
      return new Promise<ScanResult>((resolve) => {
        resolveScan = resolve;
      });
    });

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await waitFor(() => expect(resolveScan).not.toBeNull());

    await act(async () => {
      controller.emit("scan_batch", {
        scanId,
        files: [duplicated, duplicated],
      });
    });
    await waitFor(() =>
      expect(container.querySelectorAll(".file-item .filename")).toHaveLength(1),
    );

    await act(async () => {
      resolveScan?.({
        files: [duplicated, duplicated, later],
        total: 3,
      });
    });
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("later.jpg"),
    );

    const fileNames = Array.from(
      container.querySelectorAll(".file-item .filename"),
    ).map((node) => node.textContent?.trim());
    expect(fileNames).toEqual(["later.jpg", "same.txt"]);
  });

  it("loads a previous cached scan without running a fresh scan", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const cachedFile = createFile({
      id: "f1",
      name: "cached.txt",
      kind: "text",
      path: "/mock/cached.txt",
    });
    let scanFolderCalls = 0;
    let finishHydration: (() => void) | undefined;
    let hydrateArgs: Record<string, unknown> | undefined;

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("get_cached_scan", () => ({
      folderPath: "/mock",
      filterMode: "all",
      includeSubfolders: false,
      includeHidden: false,
      useHashForDuplicates: true,
      duplicateMinSizeBytes: 0,
      cachedAtMs: Date.now(),
      files: [cachedFile],
      total: 1,
    }));
    controller.onInvoke("hydrate_cached_scan", (args) => {
      hydrateArgs = args;
      return new Promise<void>((resolve) => { finishHydration = resolve; });
    });
    controller.onInvoke("scan_folder", () => {
      scanFolderCalls += 1;
      return { files: [], total: 0 };
    });

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await user.click(screen.getByRole("button", { name: "Load previous scan" }));
    expect(await screen.findByRole("dialog", { name: "Loading previous scan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load previous scan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop scan" })).not.toBeInTheDocument();
    await act(async () => finishHydration?.());

    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("cached.txt"),
    );

    expect(scanFolderCalls).toBe(0);
    expect(hydrateArgs).toEqual({
      request: {
        folderPath: "/mock",
        files: [cachedFile],
      },
    });
  });

  it("closes the previous scan prompt from the top-right close button", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("get_cached_scan", () => ({
      folderPath: "/mock",
      filterMode: "all",
      includeSubfolders: false,
      includeHidden: false,
      useHashForDuplicates: true,
      duplicateMinSizeBytes: 0,
      cachedAtMs: Date.now(),
      files: [],
      total: 0,
    }));

    const user = userEvent.setup();
    render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    expect(screen.getByText("Previous scan available")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close previous scan dialog" }));

    await waitFor(() =>
      expect(screen.queryByText("Previous scan available")).not.toBeInTheDocument()
    );
  });

  it("selects the next visible file after repeated trash operations", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const files = [
      createFile({ id: "f1", name: "alpha.txt", kind: "text", path: "/mock/alpha.txt" }),
      createFile({ id: "f2", name: "beta.txt", kind: "text", path: "/mock/beta.txt" }),
      createFile({ id: "f3", name: "gamma.txt", kind: "text", path: "/mock/gamma.txt" }),
    ];
    const trashedIds: string[] = [];

    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files, total: files.length }));
    controller.onInvoke("trash_file", (args) => {
      const id = String(args?.id ?? "");
      trashedIds.push(id);
      return { trashPath: `/trash/${id}` };
    });

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("alpha.txt")
    );

    await user.click(screen.getByRole("button", { name: "Trash ↑" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent ?? "").not.toContain("alpha.txt")
    );

    await user.click(screen.getByRole("button", { name: "Trash ↑" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent ?? "").not.toContain("beta.txt")
    );

    expect(trashedIds).toEqual(["f1", "f2"]);
    expect(container.querySelector(".file-list")?.textContent).toContain("gamma.txt");
  });

  it("keeps the suggestions entrypoint hidden for now", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
    window.__TIDY_DESKTOP_BRIDGE__ = controller.bridge;

    const file = createFile({ id: "f1", name: "old.zip", kind: "compressed", path: "/mock/old.zip" });
    controller.bridge.open = async () => "/mock";
    controller.onInvoke("scan_folder", () => ({ files: [file], total: 1 }));

    const suggestionSet: SuggestionSet = {
      generatedMs: Date.now(),
      folderPath: "/mock",
      totalReclaimableBytes: 100,
      suggestions: [
        {
          id: "s1",
          actionType: "trash",
          sourcePath: "/mock/old.zip",
          destinationPath: null,
          safetyLevel: "safe",
          reclaimableBytes: 100,
          reason: { code: "stale", message: "Old archive" },
        },
      ],
    };

    controller.onInvoke("build_cleanup_suggestions", () => suggestionSet);
    controller.onInvoke("apply_action_batch", (args) => {
      if (args?.request && typeof args.request === "object") {
        const request = args.request as { dryRun?: boolean };
        if (request.dryRun) {
          return {
            batchId: "b1",
            dryRun: true,
            applied: 1,
            blocked: 0,
            failed: 0,
            results: [{ id: "s1", status: "planned", message: "ok", undoable: true }],
          };
        }
      }
      return {
        batchId: "b2",
        dryRun: false,
        applied: 1,
        blocked: 0,
        failed: 0,
        results: [{ id: "s1", status: "applied", message: "done", undoable: true }],
      };
    });

    const user = userEvent.setup();
    const { container } = render(<App />);

    await clickFolderPicker(user);
    await user.click(screen.getByRole("button", { name: "Scan folder" }));
    await waitFor(() =>
      expect(container.querySelector(".file-list")?.textContent).toContain("old.zip")
    );

    expect(
      screen.queryByRole("button", {
        name: "AI suggestions (work in progress)",
      }),
    ).not.toBeInTheDocument();
  });
});
