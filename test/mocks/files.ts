import type { FileEntry } from "../../src/types";

export const createFile = (overrides: Partial<FileEntry> = {}): FileEntry => ({
  id: overrides.id ?? "file-1",
  name: overrides.name ?? "image.jpg",
  kind: overrides.kind ?? "image",
  path: overrides.path ?? "/root/image.jpg",
  sizeBytes: overrides.sizeBytes ?? 1024,
  modifiedMs: overrides.modifiedMs ?? 1000,
  mime: overrides.mime ?? "image/jpeg",
  duplicateGroup: overrides.duplicateGroup ?? null,
});
