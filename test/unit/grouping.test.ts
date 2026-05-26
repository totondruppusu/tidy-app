import { describe, expect, it } from "vitest";
import { getGroupIdForFile, getGroupKey, groupFilesByMode, sortGroupKeys } from "../../src/lib/grouping";
import { createFile } from "../mocks/files";

describe("grouping", () => {
  it("builds group keys by mode", () => {
    const file = createFile({ name: "photo.JPG", kind: "image", duplicateGroup: "dup-1" });
    expect(getGroupKey("extension", file)).toBe("jpg");
    expect(getGroupKey("duplicates", file)).toBe("dup-1");
    expect(getGroupKey("type", file)).toBe("image");
    expect(getGroupIdForFile("none", file)).toBeNull();
    expect(getGroupIdForFile("type", file)).toBe("type:image");
  });

  it("sorts keys predictably", () => {
    expect(sortGroupKeys("type", ["text", "image", "audio"]).slice(0, 2)).toEqual(["image", "audio"]);
    expect(sortGroupKeys("extension", ["none", "jpg", "txt"])).toEqual(["jpg", "txt", "none"]);
  });

  it("groups duplicates by size and name fallback", () => {
    const files = [
      createFile({ id: "1", name: "a.txt", duplicateGroup: "g1" }),
      createFile({ id: "2", name: "a.txt", duplicateGroup: "g1" }),
      createFile({ id: "3", name: "b.txt", duplicateGroup: "g2" }),
    ];
    const result = groupFilesByMode("duplicates", files);
    expect(result.keys[0]).toBe("g1");
    expect(result.groups.get("g1")).toHaveLength(2);
  });
});
