import type { FileEntry, TreeFolderNode, TreeFileNode, TreeNode } from "../types";
import { getRelativeSegments } from "./path";

export const getFolderCollapseKey = (groupId: string | null, path: string) =>
  groupId ? `${groupId}::${path}` : path;

export const sortTreeNodesByIndex = (nodes: TreeNode[], indexMap: Map<string, number>) => {
  const folders: TreeFolderNode[] = [];
  const files: TreeFileNode[] = [];
  nodes.forEach((node) => {
    if (node.type === "folder") {
      folders.push(node);
    } else {
      files.push(node);
    }
  });
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  files.sort((a, b) => (indexMap.get(a.file.id) ?? 0) - (indexMap.get(b.file.id) ?? 0));
  return [...folders, ...files];
};

export const buildFileTree = (list: FileEntry[], basePath: string | null) => {
  const root: TreeFolderNode = { type: "folder", name: "", path: "", children: [], fileCount: 0 };
  const folderMap = new Map<string, TreeFolderNode>();
  folderMap.set("", root);
  list.forEach((file) => {
    const segments = getRelativeSegments(file.path, basePath);
    const folderSegments = segments.length > 1 ? segments.slice(0, -1) : [];
    let currentPath = "";
    let parent = root;
    parent.fileCount += 1;
    folderSegments.forEach((segment) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = { type: "folder", name: segment, path: currentPath, children: [], fileCount: 0 };
        folderMap.set(currentPath, folder);
        parent.children.push(folder);
      }
      folder.fileCount += 1;
      parent = folder;
    });
    parent.children.push({ type: "file", file });
  });
  return root;
};
