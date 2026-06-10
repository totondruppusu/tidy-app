import type { FileEntry } from "../types";

export const getExtension = (name: string) => {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return "none";
  }
  return name.slice(lastDot + 1).toLowerCase();
};

export const dedupeFileEntries = (files: FileEntry[]) => {
  const seen = new Set<string>();
  const deduped: FileEntry[] = [];
  for (const file of files) {
    const key = file.path || file.id;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(file);
  }
  return deduped;
};
