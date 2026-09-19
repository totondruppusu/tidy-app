import { expect, test } from "playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "tidy-settings",
      JSON.stringify({
        viewMode: "tree",
        sortMode: "name_asc",
        confirmTrash: false,
      }),
    );
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const files = Array.from({ length: 3000 }, (_, i) => ({
      id: `f${i}`,
      name: `file-${String(i).padStart(4, "0")}.txt`,
      path: `\\\\?\\c:\\USERS\\Sam\\Documents\\${"long-folder-name-".repeat(8)}\\file-${String(i).padStart(4, "0")}.txt`,
      kind: "text",
      sizeBytes: i,
      modifiedMs: 1,
      mime: "text/plain",
    }));
    const state = window as any;
    state.testCommands = [];
    state.__TIDY_DESKTOP_BRIDGE__ = {
      isTauri: () => true,
      open: async () => "C:\\Users\\Sam\\Documents",
      convertFileSrc: (id: string) => id,
      listen: async (name: string, listener: (event: unknown) => void) => {
        const bucket = listeners.get(name) ?? new Set();
        bucket.add(listener);
        listeners.set(name, bucket);
        return () => bucket.delete(listener);
      },
      getCurrentWindow: () => ({
        isFullscreen: async () => false,
        onResized: async () => () => {},
        setTheme: async () => {},
      }),
      invoke: async (command: string, args: any) => {
        state.testCommands.push({ command, args });
        if (command === "scan_folder") {
          state.progress = (phase: string, scanned = 1024) =>
            listeners.get("scan_progress")?.forEach((listener) =>
              listener({
                payload: {
                  scanId: args.scanId,
                  phase,
                  scanned,
                  matched: 100,
                  total: 3000,
                },
              }),
            );
          if (state.delayScan)
            return new Promise((resolve, reject) => {
              state.finishScan = () => resolve({ files, total: files.length });
              state.stopScan = () => reject("Scan cancelled");
            });
          return { files, total: files.length };
        }
        if (command === "cancel_scan") return null;
        if (command === "deletion_path_warning")
          return "This location is protected by safety policy";
        if (command === "trash_file")
          return { trashPath: `/backup/${args.id}` };
        if (command === "trash_folder") return { trashPath: "/backup/folder" };
        if (command === "restore_folder") return null;
        if (command === "restore_file") {
          if (state.failUndo)
            throw new Error("Original folder unavailable. Reconnect the NAS.");
          return null;
        }
        if (command === "get_recent_undo_actions") return [];
        if (command === "read_text_preview") return "preview";
        return null;
      },
    };
  });
});

test("Windows-style paths and long folder rows remain usable across resize and density changes", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByText("Select folder…").click();
  await page.getByRole("button", { name: "Scan folder" }).click();
  await expect(page.locator(".folder-name")).toHaveCount(1); // No phantom C:/Users hierarchy.
  const folder = page.locator(".folder-item");
  const geometry = await folder.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const button = node
      .querySelector(".folder-trash-button")!
      .getBoundingClientRect();
    const label = node.querySelector(".folder-label")!.getBoundingClientRect();
    return {
      fits: button.right <= box.right && label.bottom <= box.bottom,
      height: box.height,
    };
  });
  expect(geometry.fits).toBe(true);
  expect(geometry.height).toBe(42);
  await page.getByRole("button", { name: "Unfold all", exact: true }).click();
  await page.locator(".file-list").evaluate((node) => {
    node.scrollTop = 50000;
  });
  await expect
    .poll(() => page.locator(".file-item").first().textContent())
    .not.toContain("file-0000");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page
    .locator(".settings-section-header")
    .filter({ hasText: "Layout" })
    .click();
  await page
    .locator(".settings-row")
    .filter({ hasText: "List density" })
    .locator("select")
    .selectOption("compact");
  await expect(page.locator(".blocking-overlay")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(
    await page.locator(".file-list").evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(40000);
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.locator(".file-list").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(
    page.locator(".file-list .filename").filter({ hasText: "file-2999.txt" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(
    page.locator(".file-list .filename").filter({ hasText: "file-2999.txt" }),
  ).toBeVisible();
  expect(await page.locator(".file-item").count()).toBeLessThan(100);
  await page.screenshot({ path: testInfo.outputPath("windows-path-list.png") });
});

test("scan stages are clear, cancellable and do not trigger file shortcuts", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.evaluate(() => {
    (window as any).delayScan = true;
  });
  await page.getByText("Select folder…").click();
  await page.getByRole("button", { name: "Scan folder" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("Scanning folder");
  await page.evaluate(() => (window as any).progress("indexing"));
  await expect(dialog).toContainText("1,024 files checked");
  await page.evaluate(() => (window as any).progress("scanning"));
  await expect(dialog).toHaveAccessibleName("Scanning folder");
  await page.evaluate(() => (window as any).progress("duplicates"));
  await expect(dialog).toHaveAccessibleName("Checking duplicates");
  await page.keyboard.press("ArrowUp");
  expect(
    await page.evaluate(() =>
      (window as any).testCommands.some(
        (item: any) => item.command === "trash_file",
      ),
    ),
  ).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("scan-progress.png") });
  await page.getByRole("button", { name: "Stop scan" }).click();
  await expect(dialog).toHaveAccessibleName("Stopping scan…");
  await expect(
    page.getByRole("button", { name: "Stopping..." }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).stopScan());
  await expect(dialog).toHaveCount(0);
});

test("protected deletion defaults to cancel and requires explicit approval", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByText("Select folder…").click();
  await page.getByRole("button", { name: "Scan folder" }).click();
  await page.getByRole("button", { name: "Trash ↑" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Delete from a protected location?",
  });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Move to trash", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move to trash", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("protected-delete.png") });
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() =>
      (window as any).testCommands.some(
        (item: any) => item.command === "trash_file",
      ),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Trash ↑" }).click();
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).testCommands.find(
          (item: any) => item.command === "trash_file",
        ).args.allowUnsafe,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).failUndo = true;
  });
  await page.getByRole("button", { name: "Undo ↓" }).click();
  const failure = page.getByRole("alertdialog", {
    name: "Couldn’t complete undo",
  });
  await expect(failure).toContainText("Reconnect the NAS");
  await expect(failure).toContainText("/backup/f0");
  await page.screenshot({ path: testInfo.outputPath("undo-retry.png") });
  await page.evaluate(() => {
    (window as any).failUndo = false;
  });
  await page.getByRole("button", { name: "Retry undo" }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo ↓" })).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as any).testCommands.filter(
          (item: any) => item.command === "restore_file",
        ).length,
    ),
  ).toBe(2);
});

test("folder undo restores thousands of rows together and keeps the list bounded", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByText("Select folder…").click();
  await page.getByRole("button", { name: "Scan folder" }).click();
  await expect(page.locator(".folder-count")).toHaveText("3000");
  await page.locator(".folder-trash-button").click();
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(page.locator(".folder-count")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo ↓" }).click();
  await expect(page.locator(".list-title .badge")).toHaveText("3000");
  await expect(page.locator(".file-item.active")).toContainText(
    "file-0000.txt",
  );
  await expect(page.locator(".file-item.active")).toBeVisible();
  await page.locator(".file-list").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(
    page.locator(".file-list .filename").filter({ hasText: "file-2999.txt" }),
  ).toBeVisible();
  expect(await page.locator(".file-item").count()).toBeLessThan(100);
  await expect(page.getByRole("button", { name: "Undo ↓" })).toBeDisabled();
});
