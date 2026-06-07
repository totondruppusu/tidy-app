import { describe, expect, it, vi } from "vitest";
import { getExtension } from "../../src/lib/files";
import { buildFileTree, getFolderCollapseKey, sortTreeNodesByIndex } from "../../src/lib/tree";
import { extractFolder, formatRelativeFolder, getRelativeSegments, splitPathSegments } from "../../src/lib/path";
import { isEditableTarget, shouldOpenOnEnter, updateScrollHint } from "../../src/lib/dom";
import { buildMediaUrl } from "../../src/lib/media";
import { createFile } from "../mocks/files";

describe("files/path/tree/dom/media", () => {
  it("extracts file extensions", () => {
    expect(getExtension("file.txt")).toBe("txt");
    expect(getExtension(".env")).toBe("none");
    expect(getExtension("noext")).toBe("none");
  });

  it("resolves path helpers", () => {
    expect(splitPathSegments("/a/b\\c")).toEqual(["a", "b", "c"]);
    expect(getRelativeSegments("/root/a/b.txt", "/root")).toEqual(["a", "b.txt"]);
    expect(formatRelativeFolder("/root/a/b.txt", "/root")).toBe("a");
    expect(extractFolder("/root/a/b.txt")).toBe("/root/a");
  });

  it("builds and sorts file tree", () => {
    const files = [
      createFile({ id: "2", path: "/root/b/c.txt", name: "c.txt", kind: "text" }),
      createFile({ id: "1", path: "/root/a/d.txt", name: "d.txt", kind: "text" }),
    ];
    const tree = buildFileTree(files, "/root");
    expect(tree.fileCount).toBe(2);
    expect(getFolderCollapseKey("group:1", "a")).toBe("group:1::a");

    const indexMap = new Map([
      ["1", 0],
      ["2", 1],
    ]);
    const sorted = sortTreeNodesByIndex(tree.children, indexMap);
    expect(sorted[0].type).toBe("folder");
  });

  it("updates scroll hints and keyboard eligibility", () => {
    const scrollNode = document.createElement("div");
    const frameNode = document.createElement("div");
    Object.defineProperty(scrollNode, "clientHeight", { value: 100 });
    Object.defineProperty(scrollNode, "scrollHeight", { value: 300 });
    Object.defineProperty(scrollNode, "scrollTop", { value: 50, writable: true });
    updateScrollHint(scrollNode, frameNode);
    expect(frameNode.classList.contains("scroll-hint-top")).toBe(true);
    expect(frameNode.classList.contains("scroll-hint-bottom")).toBe(true);

    const input = document.createElement("input");
    expect(isEditableTarget(input)).toBe(true);
    expect(shouldOpenOnEnter(document.body)).toBe(true);

    const list = document.createElement("div");
    list.className = "file-list";
    const button = document.createElement("button");
    list.appendChild(button);
    expect(shouldOpenOnEnter(button)).toBe(true);

    const block = document.createElement("div");
    block.dataset.preventOpenOnEnter = "1";
    const child = document.createElement("span");
    block.appendChild(child);
    expect(shouldOpenOnEnter(child)).toBe(false);
  });

  it("builds media urls by platform", () => {
    window.__TIDY_DESKTOP_BRIDGE__ = { isTauri: () => true };
    const uaSpy = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Windows");
    expect(buildMediaUrl("abc")).toBe("http://media.localhost/abc");
    uaSpy.mockRestore();

    window.__TIDY_DESKTOP_BRIDGE__ = { isTauri: () => false };
    expect(buildMediaUrl("abc")).toBe("media://localhost/abc");
  });
});
