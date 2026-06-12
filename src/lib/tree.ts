import type { FileEntry, TreeFolderNode } from "../types";
import { getRelativeSegments } from "./path";

export const getFolderCollapseKey = (groupId: string | null, path: string) =>
  groupId ? `${groupId}::${path}` : path;

export const buildFileTree = (list: FileEntry[], basePath: string | null) => {
  const root: TreeFolderNode = {
    type: "folder",
    name: "",
    path: "",
    children: [],
    fileCount: 0,
    totalBytes: 0,
  };
  const folderMap = new Map<string, TreeFolderNode>();
  folderMap.set("", root);
  list.forEach((file) => {
    const segments = getRelativeSegments(file.path, basePath);
    const folderSegments = segments.length > 1 ? segments.slice(0, -1) : [];
    let currentPath = "";
    let parent = root;
    parent.fileCount += 1;
    parent.totalBytes += file.sizeBytes;
    folderSegments.forEach((segment) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = {
          type: "folder",
          name: segment,
          path: currentPath,
          children: [],
          fileCount: 0,
          totalBytes: 0,
        };
        folderMap.set(currentPath, folder);
        parent.children.push(folder);
      }
      folder.fileCount += 1;
      folder.totalBytes += file.sizeBytes;
      parent = folder;
    });
    parent.children.push({ type: "file", file });
  });
  return root;
};
