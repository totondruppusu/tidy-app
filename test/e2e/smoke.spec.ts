import { expect, test, type Page } from "playwright/test";

const installBridgeScript = () => {
  (window as Window & { __TIDY_DESKTOP_BRIDGE__?: unknown }).__TIDY_DESKTOP_BRIDGE__ = (() => {
    const state: {
      files: Array<{
        id: string;
        name: string;
        kind: string;
        path: string;
        sizeBytes: number;
        modifiedMs: number;
        mime: string;
        duplicateGroup: null;
      }>;
      removed: Array<{
        id: string;
        name: string;
        kind: string;
        path: string;
        sizeBytes: number;
        modifiedMs: number;
        mime: string;
        duplicateGroup: null;
      }>;
    } = {
      files: [
        {
          id: "f1",
          name: "alpha.txt",
          kind: "text",
          path: "/mock/alpha.txt",
          sizeBytes: 200,
          modifiedMs: 1000,
          mime: "text/plain",
          duplicateGroup: null,
        },
        {
          id: "f2",
          name: "old.zip",
          kind: "compressed",
          path: "/mock/old.zip",
          sizeBytes: 500,
          modifiedMs: 2000,
          mime: "application/zip",
          duplicateGroup: null,
        },
      ],
      removed: [],
    };

    const previewCapabilities = {
      platform: "e2e",
      textPreview: true,
      pdfPreview: true,
      mediaPreview: true,
      archivePreview: true,
      officeRichPreview: false,
      officeFallbackPreview: true,
      notes: [],
    };

    return {
      isTauri: () => true,
      open: async () => "/mock",
      confirm: async () => true,
      listen: async () => () => {},
      getCurrentWindow: () => ({
        isFullscreen: async () => false,
        onResized: async () => () => {},
        setTheme: async () => {},
      }),
      invoke: async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "get_crash_report":
            return null;
          case "get_preview_capabilities":
            return previewCapabilities;
          case "get_recent_undo_actions":
            return [];
          case "store_recent_undo_actions":
          case "update_heartbeat":
          case "log_client_error":
          case "reveal_in_file_manager":
          case "set_destination":
            return null;
          case "scan_folder":
            return { files: [...state.files], total: state.files.length };
          case "trash_file": {
            const id = String(args?.id ?? "");
            const index = state.files.findIndex((file) => file.id === id);
            if (index >= 0) {
              const [removed] = state.files.splice(index, 1);
              state.removed.push(removed);
            }
            return { trashPath: `/trash/${id}` };
          }
          case "restore_file": {
            const id = String(args?.id ?? "");
            const index = state.removed.findIndex((file) => file.id === id);
            if (index >= 0) {
              const [restored] = state.removed.splice(index, 1);
              state.files.push(restored);
            }
            return null;
          }
          case "build_cleanup_suggestions":
            return {
              generatedMs: Date.now(),
              folderPath: "/mock",
              totalReclaimableBytes: 500,
              suggestions: [
                {
                  id: "s1",
                  actionType: "trash",
                  sourcePath: "/mock/old.zip",
                  destinationPath: null,
                  safetyLevel: "safe",
                  reclaimableBytes: 500,
                  reason: { code: "stale", message: "Old archive" },
                },
              ],
            };
          case "apply_action_batch": {
            const request = (args?.request ?? {}) as { dryRun?: boolean };
            if (request.dryRun) {
              return {
                batchId: "dry-1",
                dryRun: true,
                applied: 1,
                blocked: 0,
                failed: 0,
                results: [{ id: "s1", status: "planned", message: "ok", undoable: true }],
              };
            }
            return {
              batchId: "live-1",
              dryRun: false,
              applied: 1,
              blocked: 0,
              failed: 0,
              results: [{ id: "s1", status: "applied", message: "done", undoable: true }],
            };
          }
          case "list_archive_entries":
            return { entries: ["a.txt", "b.txt"], truncated: false };
          default:
            return null;
        }
      },
    };
  })();
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installBridgeScript);
  await page.goto("/");
});

const swipeHandle = async (page: Page, deltaX: number, deltaY: number) => {
  const surface = page.getByLabel(
    "Swipe the preview: left previous, right next, up trash, down undo",
  );
  const box = await surface.boundingBox();
  if (!box) {
    throw new Error("Swipe preview surface not found");
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 8 });
  await page.mouse.up();
};

const openFolderPicker = async (page: Page) => {
  const picker = page.getByText("Select folder…");
  if ((await picker.count()) === 0) {
    await page.getByRole("button", { name: "Show sidebar" }).click();
  }
  await page.getByText("Select folder…").click();
};

const closeSidebarIfOpen = async (page: Page) => {
  const hideSidebar = page.getByRole("button", { name: "Hide sidebar" });
  if ((await hideSidebar.count()) > 0) {
    await hideSidebar.click();
  }
};

test("boots with empty prompt", async ({ page }) => {
  await expect(page.getByText("Select a folder to preview files.")).toBeVisible();
});

test("scan journey populates files", async ({ page }) => {
  await openFolderPicker(page);
  await page.getByRole("button", { name: "Scan folder" }).click();
  await expect(page.locator(".file-list .filename", { hasText: "alpha.txt" })).toBeVisible();
  await expect(page.locator(".file-list .filename", { hasText: "old.zip" })).toBeVisible();
});

test("trash and undo restores file", async ({ page }) => {
  await openFolderPicker(page);
  await page.getByRole("button", { name: "Scan folder" }).click();
  await expect(page.locator(".file-list .filename", { hasText: "alpha.txt" })).toBeVisible();

  await page.getByRole("button", { name: "Trash ↑" }).click();
  await expect(page.locator(".file-list .filename", { hasText: "alpha.txt" })).toHaveCount(0);

  await page.getByRole("button", { name: "Undo ↓" }).click();
  await expect(page.locator(".file-list .filename", { hasText: "alpha.txt" })).toBeVisible();
});

test("mobile viewport swaps directional buttons for preview swipes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFolderPicker(page);
  await page.getByRole("button", { name: "Scan folder" }).click();
  await closeSidebarIfOpen(page);

  await expect(
    page.getByLabel("Swipe the preview: left previous, right next, up trash, down undo"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Prev ←" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next →" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Trash ↑" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo ↓" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Swipe actions" })).toHaveCount(0);
});

test("mobile swipe gestures navigate files", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFolderPicker(page);
  await page.getByRole("button", { name: "Scan folder" }).click();
  await closeSidebarIfOpen(page);
  await expect(page.getByText("/mock/alpha.txt")).toBeVisible();

  await swipeHandle(page, 90, 0);
  await expect(page.getByText("/mock/old.zip")).toBeVisible();

  await swipeHandle(page, -90, 0);
  await expect(page.getByText("/mock/alpha.txt")).toBeVisible();
});

test("mobile swipe up trashes and swipe down undoes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFolderPicker(page);
  await page.getByRole("button", { name: "Scan folder" }).click();
  await closeSidebarIfOpen(page);
  await expect(page.getByText("/mock/alpha.txt")).toBeVisible();

  await swipeHandle(page, 0, -90);
  await expect(page.getByText("/mock/old.zip")).toBeVisible();

  await swipeHandle(page, 0, 90);
  await expect(page.getByText("/mock/alpha.txt")).toBeVisible();
});

test("suggestions entrypoint remains hidden for now", async ({
  page,
}) => {
  await openFolderPicker(page);
  await page.getByRole("button", { name: "Scan folder" }).click();

  await expect(
    page.getByRole("button", {
      name: "AI suggestions (work in progress)",
    }),
  ).toHaveCount(0);
});
