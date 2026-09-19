import type { FileEntry, SortMode } from "../types";
import { getExtension } from "./files";
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

export function sortFileEntries(
  list: FileEntry[],
  sortMode: SortMode,
): FileEntry[] {
  if (sortMode === "none") {
    return list;
  }
  const next = [...list];
  const extensions = sortMode.startsWith("extension_")
    ? new Map(list.map((file) => [file.id, getExtension(file.name)]))
    : null;
  const compareName = (a: FileEntry, b: FileEntry) =>
    collator.compare(a.name, b.name);
  const compareExtension = (a: FileEntry, b: FileEntry) =>
    collator.compare(extensions!.get(a.id)!, extensions!.get(b.id)!);
  const compareType = (a: FileEntry, b: FileEntry) =>
    collator.compare(a.kind, b.kind);
  next.sort((a, b) => {
    switch (sortMode) {
      case "size_desc":
        return b.sizeBytes - a.sizeBytes || compareName(a, b);
      case "size_asc":
        return a.sizeBytes - b.sizeBytes || compareName(a, b);
      case "date_desc":
        return (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) || compareName(a, b);
      case "date_asc":
        return (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0) || compareName(a, b);
      case "type_asc":
        return compareType(a, b) || compareName(a, b);
      case "type_desc":
        return compareType(b, a) || compareName(a, b);
      case "extension_asc":
        return compareExtension(a, b) || compareName(a, b);
      case "extension_desc":
        return compareExtension(b, a) || compareName(a, b);
      case "name_desc":
        return compareName(b, a);
      case "name_asc":
      default:
        return compareName(a, b);
    }
  });
  return next;
}
