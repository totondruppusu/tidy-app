import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "../../src/app/App";
import { createMockBridge } from "../mocks/bridge";
import { createFile } from "../mocks/files";
import type { PreviewCapabilities, SuggestionSet } from "../../src/types";

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
