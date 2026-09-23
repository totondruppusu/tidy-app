import { expect, test } from "playwright/test";

test("large folder remains navigable with bounded mounted rows", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "tidy-settings",
      JSON.stringify({
        viewMode: "list",
        sortMode: "name_asc",
        extensionFilterMode: "all",
      }),
    );
    const files = Array.from({ length: 10000 }, (_, index) => ({
      id: `f${index}`,
      name: `file-${String(index).padStart(5, "0")}.txt`,
      path: `/mock/folder-${index % 100}/file-${String(index).padStart(5, "0")}.txt`,
      kind: "text",
      sizeBytes: index,
      modifiedMs: 1000,
      mime: "text/plain",
    })).reverse();
    (window as any).__TIDY_DESKTOP_BRIDGE__ = {
      isTauri: () => true,
      open: async () => "/mock",
      confirm: async () => true,
      convertFileSrc: (id: string) => id,
      listen: async () => () => {},
      getCurrentWindow: () => ({
        isFullscreen: async () => false,
        onResized: async () => () => {},
        setTheme: async () => {},
      }),
      invoke: async (command: string) => {
        if (command === "scan_folder") {
          performance.mark("scan-result");
          return { files, total: files.length };
        }
        if (command === "get_recent_undo_actions") return [];
        if (command === "read_text_preview") return "preview";
        return null;
      },
    };
  });
  await page.goto("/");
  await page.getByText("Select folder…").click();
  await page.getByRole("button", { name: "Scan folder" }).click();
  await expect(page.locator(".file-item.active")).toContainText(
    "file-00000.txt",
  );
  const measurement = await page.evaluate(() => ({
    resultToRowsMs:
      performance.now() -
      performance.getEntriesByName("scan-result")[0].startTime,
    mountedFiles: document.querySelectorAll(".file-item").length,
  }));
  console.log(JSON.stringify(measurement));
  if (!process.env.TIDY_PERF_BASELINE)
    expect(measurement.mountedFiles).toBeLessThan(100);
  await page.locator(".file-list").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(
    page.locator(".file-list .filename", { hasText: "file-09999.txt" }),
  ).toBeVisible();
  await page.locator(".file-item", { hasText: "file-09999.txt" }).click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".file-item.active")).toContainText(
    "file-09998.txt",
  );
  // Keyboard selection must bring an unmounted row into view.
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".file-item.active")).toContainText(
    "file-09958.txt",
  );
  await expect(page.locator(".file-item.active")).toBeVisible();
  await page.keyboard.down("ArrowLeft");
  await page.keyboard.down("ArrowLeft");
  await page.keyboard.up("ArrowLeft");
  await expect(page.locator(".file-item.active")).toContainText(
    "file-09954.txt",
  );
  await expect(page.locator(".virtual-file-list-active-indicator")).toBeVisible();
  if (!process.env.TIDY_PERF_BASELINE) {
    const controls = page.locator(".list-header-controls select");
    await controls.nth(1).selectOption("extension");
    await expect(page.locator(".list-section-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.locator(".list-section-toggle").click();
    await expect(page.locator(".file-item.active")).toBeVisible();
    await page.locator(".file-list").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.locator(".list-section-toggle").click();
    await expect(page.locator(".file-item")).toHaveCount(0);
    await page.locator(".list-section-toggle").click();
    await expect(page.locator(".file-item.active")).toBeVisible();
    await controls.nth(2).selectOption("tree");
    await expect(page.locator(".file-item.active")).toBeVisible();
    await page.getByRole("button", { name: "Fold all", exact: true }).click();
    await expect(page.locator(".file-item")).toHaveCount(0);
    await page.getByRole("button", { name: "Unfold all", exact: true }).click();
    await expect(page.locator(".file-item.active")).toBeVisible();
    expect(await page.locator(".file-item").count()).toBeLessThan(100);
    await page.screenshot({ path: testInfo.outputPath("large-folder.png") });
  }
});
