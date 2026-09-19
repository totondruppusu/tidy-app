import type { FileEntry, GroupMode, TreeNode, ViewMode } from "../types";
import { groupFilesByMode } from "./grouping";
import { buildFileTree, getFolderCollapseKey } from "./tree";
import { formatDuplicateGroupMeta, formatGroupTitle } from "./format";

export type FileListRow =
  | { type: "file"; key: string; file: FileEntry; depth?: number }
  | {
      type: "folder";
      key: string;
      name: string;
      path: string;
      depth: number;
      totalBytes: number;
      fileCount: number;
      end: number;
    }
  | {
      type: "group";
      key: string;
      title: string;
      meta: string | null;
      count: string;
      end: number;
    };

// Build hierarchy and keyboard order together, independent of selection and collapse state.
export function buildFileListModel(
  files: FileEntry[],
  mode: GroupMode,
  view: ViewMode,
  folder: string | null,
) {
  const rows: FileListRow[] = [];
  const fileOrder: string[] = [];
  const folderKeys: string[] = [];
  const addFile = (file: FileEntry, depth?: number) => {
    rows.push({ type: "file", key: file.id, file, depth });
    fileOrder.push(file.id);
  };
  const addNodes = (nodes: TreeNode[], depth: number, group: string | null) => {
    for (const node of nodes) {
      if (node.type === "file") {
        addFile(node.file, Math.max(0, depth - 1));
        continue;
      }
      const key = getFolderCollapseKey(group, node.path);
      folderKeys.push(key);
      const row: FileListRow = {
        type: "folder",
        key,
        name: node.name,
        path: node.path,
        depth,
        totalBytes: node.totalBytes,
        fileCount: node.fileCount,
        end: 0,
      };
      rows.push(row);
      addNodes(node.children, depth + 1, group);
      row.end = rows.length;
    }
  };
  const addFiles = (entries: FileEntry[], group: string | null) => {
    if (view === "tree")
      addNodes(buildFileTree(entries, folder).children, 0, group);
    else entries.forEach((file) => addFile(file));
  };
  if (mode === "none") addFiles(files, null);
  else {
    const { groups, keys } = groupFilesByMode(mode, files);
    for (const key of keys) {
      const entries = groups.get(key)!;
      const group = `${mode}:${key}`;
      const row: FileListRow = {
        type: "group",
        key: group,
        title: formatGroupTitle(mode, key, entries),
        meta: mode === "duplicates" ? formatDuplicateGroupMeta(entries) : null,
        count:
          mode === "duplicates"
            ? `${entries.length} copies`
            : `${entries.length}`,
        end: 0,
      };
      rows.push(row);
      addFiles(entries, group);
      row.end = rows.length;
    }
  }
  return { rows, fileOrder, folderKeys };
}

export function visibleListRows(
  rows: FileListRow[],
  folders: Record<string, boolean>,
  groups: Record<string, boolean>,
) {
  const visible: FileListRow[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    visible.push(row);
    i =
      row.type !== "file" &&
      (row.type === "folder" ? folders[row.key] : groups[row.key])
        ? row.end
        : i + 1;
  }
  return visible;
}
