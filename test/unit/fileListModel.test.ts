import { describe, expect, it } from "vitest";
import {
  buildFileListModel,
  visibleListRows,
} from "../../src/lib/fileListModel";
import { sortFileEntries } from "../../src/lib/sorting";
import { rowAtOffset } from "../../src/lib/useVirtualScroll";
import { createFile } from "../mocks/files";
import type { SortMode } from "../../src/types";

const files = [
  createFile({
    id: "a",
    name: "alpha.txt",
    path: "/root/one/alpha.txt",
    kind: "text",
    sizeBytes: 10,
  }),
  createFile({
    id: "b",
    name: "Beta.jpg",
    path: "/root/one/two/Beta.jpg",
    sizeBytes: 20,
  }),
  createFile({
    id: "c",
    name: "charlie.txt",
    path: "/root/charlie.txt",
    kind: "text",
    sizeBytes: 30,
  }),
];

describe("file list model", () => {
  it("shares tree order and folder totals, preserving keyboard access to collapsed files", () => {
    const model = buildFileListModel(files, "none", "tree", "/root");
    expect(model.fileOrder).toEqual(["b", "a", "c"]);
    expect(model.folderKeys).toEqual(["one", "one/two"]);
    expect(model.rows[0]).toMatchObject({
      type: "folder",
      totalBytes: 30,
      fileCount: 2,
    });
    expect(
      visibleListRows(model.rows, { one: true }, {}).map((row) => row.key),
    ).toEqual(["one", "c"]);
    expect(
      visibleListRows(model.rows, { "one/two": true }, {}).map(
        (row) => row.key,
      ),
    ).toEqual(["one", "one/two", "a", "c"]);
  });
  it("separates group collapse keys and skips whole collapsed groups", () => {
    const model = buildFileListModel(files, "extension", "tree", "/root");
    expect(model.folderKeys).toContain("extension:txt::one");
    const visible = visibleListRows(model.rows, {}, { "extension:jpg": true });
    expect(
      visible.filter((row) => row.type === "file").map((row) => row.key),
    ).toEqual(["a", "c"]);
    expect(model.fileOrder).toContain("b");
  });
  it("finds rows by offset including empty lists and exact boundaries", () => {
    expect(rowAtOffset([0], 200)).toBe(0);
    expect(rowAtOffset([0, 34, 74, 108], 33)).toBe(0);
    expect(rowAtOffset([0, 34, 74, 108], 34)).toBe(1);
    expect(rowAtOffset([0, 34, 74, 108], 80)).toBe(2);
    expect(rowAtOffset([0, 34, 74, 108], 500)).toBe(3);
  });
  it.each<[SortMode, string[]]>([
    ["name_asc", ["a", "b", "c"]],
    ["name_desc", ["c", "b", "a"]],
    ["size_desc", ["c", "b", "a"]],
    ["size_asc", ["a", "b", "c"]],
    ["extension_asc", ["b", "a", "c"]],
    ["extension_desc", ["a", "c", "b"]],
    ["type_asc", ["b", "a", "c"]],
    ["type_desc", ["a", "c", "b"]],
    ["date_asc", ["a", "b", "c"]],
    ["date_desc", ["a", "b", "c"]],
  ])("sorts %s without mutating source order", (mode, expected) => {
    const input = [...files].reverse();
    expect(sortFileEntries(input, mode).map((file) => file.id)).toEqual(
      expected,
    );
    expect(input.map((file) => file.id)).toEqual(["c", "b", "a"]);
  });
});
