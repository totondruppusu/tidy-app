import type { FileEntry, GroupMode } from "../types";
import { getExtension } from "./files";

const KIND_ORDER: FileEntry["kind"][] = [
  "image",
  "video",
  "audio",
  "docs",
  "text",
  "compressed",
  "executable",
  "binary",
];

export const getGroupKey = (mode: GroupMode, file: FileEntry) => {
  if (mode === "extension") {
    return getExtension(file.name);
  }
  if (mode === "duplicates") {
    return file.duplicateGroup ?? file.id;
  }
  return file.kind;
};

export const getGroupIdForFile = (mode: GroupMode, file: FileEntry) =>
  mode === "none" ? null : `${mode}:${getGroupKey(mode, file)}`;

export const sortGroupKeys = (mode: GroupMode, keys: string[]) => {
  const sorted = [...keys];
  sorted.sort((a, b) => {
    if (mode === "type") {
      return KIND_ORDER.indexOf(a as FileEntry["kind"]) - KIND_ORDER.indexOf(b as FileEntry["kind"]);
    }
    if (mode === "duplicates") {
      return a.localeCompare(b);
    }
    if (a === "none") {
      return 1;
    }
    if (b === "none") {
      return -1;
    }
    return a.localeCompare(b);
  });
  return sorted;
};

export const groupFilesByMode = (mode: GroupMode, list: FileEntry[]) => {
  const groups = new Map<string, FileEntry[]>();
  list.forEach((file) => {
    const key = getGroupKey(mode, file);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(file);
    } else {
      groups.set(key, [file]);
    }
  });
  let keys = Array.from(groups.keys());
  if (mode === "duplicates") {
    keys.sort((a, b) => {
      const groupA = groups.get(a) ?? [];
      const groupB = groups.get(b) ?? [];
      const countDelta = groupB.length - groupA.length;
      if (countDelta !== 0) {
        return countDelta;
      }
      const nameA = groupA[0]?.name ?? "";
      const nameB = groupB[0]?.name ?? "";
      return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
    });
  } else {
    keys = sortGroupKeys(mode, keys);
  }
  return { groups, keys };
};
