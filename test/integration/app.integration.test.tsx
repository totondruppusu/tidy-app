import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
  controller.onInvoke("get_crash_report", () => null);
  controller.onInvoke("get_preview_capabilities", () => previewCapabilities);
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
};

describe("App integration", () => {
  const clickFolderPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    const picker = screen.getByText("Select folder…").closest("button");
    expect(picker).not.toBeNull();
    await user.click(picker!);
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

    await user.selectOptions(screen.getByDisplayValue("Tree"), "list");
    await user.selectOptions(screen.getByDisplayValue("Name (A-Z)"), "size_desc");

    const fileNames = Array.from(container.querySelectorAll(".file-item .filename")).map((n) =>
      n.textContent?.trim()
    );
    expect(fileNames[0]).toBe("big.jpg");
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

  it("renders streamed scan batches and keeps the final result authoritative", async () => {
    const controller = createMockBridge();
    installBaseHandlers(controller);
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

  it("builds and previews suggestions", async () => {
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

    await user.click(screen.getByRole("button", { name: "Open AI suggestions" }));
    await user.click(screen.getByRole("button", { name: "Build suggestions" }));
    expect(await screen.findByText("Old archive")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Preview selected" }));
    expect(await screen.findByText("Preview ready")).toBeInTheDocument();
  });
});
