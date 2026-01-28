export type FilterMode =
  | "all"
  | "images"
  | "videos"
  | "images_videos"
  | "audio"
  | "docs"
  | "text"
  | "compressed"
  | "executables"
  | "binary"
  | "duplicates";

export type SortMode =
  | "none"
  | "name_asc"
  | "name_desc"
  | "size_desc"
  | "size_asc"
  | "date_desc"
  | "date_asc"
  | "type_asc"
  | "type_desc"
  | "extension_asc"
  | "extension_desc";

export type DensityMode = "comfortable" | "compact";
export type GroupMode = "none" | "type" | "extension" | "duplicates";
export type ThemeMode = "light" | "dark";
export type ViewMode = "tree" | "list";
export type ExtensionFilterMode = "all" | "remember" | "common";
export type TrashBehavior = "system" | "permanent";

export type FileEntry = {
  id: string;
  name: string;
  kind:
    | "image"
    | "video"
    | "audio"
    | "docs"
    | "text"
    | "compressed"
    | "executable"
    | "binary";
  path: string;
  sizeBytes: number;
  modifiedMs: number | null;
  mime: string;
  duplicateGroup?: string | null;
};

export type ArchivePreview = {
  entries: string[];
  truncated: boolean;
};

export type ScanResult = {
  files: FileEntry[];
  total: number;
};

export type ScanProgress = {
  scanId: string;
  scanned: number;
  matched: number;
  total: number;
  phase: "indexing" | "scanning";
};

export type ScanBatch = {
  scanId: string;
  files: FileEntry[];
};

export type MoveResult = {
  newName: string;
  targetPath: string;
};

export type TrashResult = {
  trashPath: string | null;
};

export type ActivitySnapshot = {
  timestampMs: number;
  status?: string | null;
  currentFolder?: string | null;
  isLoading: boolean;
  isMutating: boolean;
  isCancellingScan: boolean;
  scanId?: string | null;
  scanPhase?: string | null;
  scanScanned?: number | null;
  scanMatched?: number | null;
  scanTotal?: number | null;
  mutationLabel?: string | null;
  eventLoopLagMs?: number | null;
};

export type CrashReport = {
  id: string;
  createdMs: number;
  message: string;
  location?: string | null;
  thread?: string | null;
  backtrace?: string | null;
  appName: string;
  appVersion: string;
  os: string;
  arch: string;
  reportPath: string;
  lastActivity?: ActivitySnapshot | null;
  lastHeartbeatMs?: number | null;
};

export type FolderTrashEntry = {
  id: string;
  relativePath: string;
};

export type FolderTrashItem = {
  file: FileEntry;
  relativePath: string;
};

export type UndoAction =
  | {
      kind: "move";
      file: FileEntry;
      fromPath: string;
      toPath: string;
    }
  | {
      kind: "trash";
      file: FileEntry;
      fromPath: string;
      trashPath: string;
    }
  | {
      kind: "trash-folder";
      folderPath: string;
      trashPath: string;
      items: FolderTrashItem[];
    };

export type TreeFolderNode = {
  type: "folder";
  name: string;
  path: string;
  children: TreeNode[];
  fileCount: number;
};

export type TreeFileNode = {
  type: "file";
  file: FileEntry;
};

export type TreeNode = TreeFolderNode | TreeFileNode;

export type StoredSettings = {
  filterMode?: FilterMode;
  autoScanOnPick?: boolean;
  rememberLastFolder?: boolean;
  lastFolder?: string;
  includeSubfolders?: boolean;
  includeHidden?: boolean;
  autoPlayMedia?: boolean;
  skipLargePreviews?: boolean;
  useHashForDuplicates?: boolean;
  duplicateMinSizeBytes?: number;
  confirmTrash?: boolean;
  trashBehavior?: TrashBehavior;
  sortMode?: SortMode;
  groupMode?: GroupMode;
  listDensity?: DensityMode;
  viewMode?: ViewMode;
  extensionFilterMode?: ExtensionFilterMode;
  extensionSelection?: string[];
  destinationSlots?: (string | null)[];
};
