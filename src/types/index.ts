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
export type SafetyLevel = "safe" | "review" | "manual";
export type SuggestionSortMode = "largest_first" | "safest_first" | "path_asc";
export type SuggestionActionFilter = "all" | "trash" | "remove-empty-folder" | "move" | "delete";
export type SuggestionsMode = "review" | "advanced";

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

export type OfficeFallbackPreview = {
  mode: string;
  title: string;
  excerpt: string;
};

export type ScanResult = {
  files: FileEntry[];
  total: number;
};

export type ScanStats = {
  indexed: number;
  matched: number;
  duplicateGroups: number;
  durationMs: number;
};

export type ScanIssue = {
  code: string;
  message: string;
  path?: string | null;
};

export type ScanResultV2 = {
  files: FileEntry[];
  total: number;
  stats: ScanStats;
  issues: ScanIssue[];
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

export type QueryIndexRequest = {
  filterMode?: FilterMode;
  selectedExtensions?: string[];
  sortMode?: SortMode;
  groupMode?: GroupMode;
  offset?: number;
  limit?: number;
};

export type GroupCount = {
  key: string;
  count: number;
};

export type QueryIndexResult = {
  files: FileEntry[];
  total: number;
  offset: number;
  limit: number;
  groups: GroupCount[];
};

export type IndexStats = {
  folderPath?: string | null;
  total: number;
  extensions: GroupCount[];
  duplicateGroups: number;
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

export type PreviewCapabilities = {
  platform: string;
  textPreview: boolean;
  pdfPreview: boolean;
  mediaPreview: boolean;
  archivePreview: boolean;
  officeRichPreview: boolean;
  officeFallbackPreview: boolean;
  notes: string[];
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

export type SuggestionReason = {
  code: string;
  message: string;
};

export type Suggestion = {
  id: string;
  actionType: string;
  sourcePath: string;
  destinationPath?: string | null;
  safetyLevel: SafetyLevel;
  reclaimableBytes: number;
  reason: SuggestionReason;
};

export type SuggestionSet = {
  generatedMs: number;
  folderPath: string;
  totalReclaimableBytes: number;
  suggestions: Suggestion[];
};

export type ActionBatchItem = {
  id: string;
  actionType: string;
  sourcePath: string;
  destinationPath?: string | null;
  safetyLevel?: SafetyLevel | string | null;
  reason?: string | null;
};

export type ActionBatch = {
  actions: ActionBatchItem[];
  allowUnsafe?: boolean;
  dryRun?: boolean;
  allowPermanentDelete?: boolean;
};

export type ActionResult = {
  id: string;
  status: "planned" | "applied" | "blocked" | "error";
  message: string;
  undoable: boolean;
};

export type ActionBatchResult = {
  batchId: string;
  dryRun: boolean;
  applied: number;
  blocked: number;
  failed: number;
  results: ActionResult[];
};

export type OperationJournalEntry = {
  id: string;
  timestampMs: number;
  operation: string;
  status: string;
  mode?: string | null;
  source?: string | null;
  destination?: string | null;
  safetyLevel?: string | null;
  message?: string | null;
  rollback?: Record<string, unknown> | null;
};

export type OperationHistoryPage = {
  entries: OperationJournalEntry[];
  nextCursor?: number | null;
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
  suggestionStaleDays?: number;
  suggestionMinLargeFileBytes?: number;
  suggestionMaxResults?: number;
  suggestionSortMode?: SuggestionSortMode;
  suggestionActionFilter?: SuggestionActionFilter;
  suggestionsMode?: SuggestionsMode;
  suggestionPresetId?: string;
  suggestionPresets?: SuggestionPreset[];
};

export type SuggestionPreset = {
  id: string;
  name: string;
  staleDays: number;
  minLargeFileBytes: number;
  maxResults: number;
  safetyFilter: SafetyLevel;
  actionFilter: SuggestionActionFilter;
  sortMode: SuggestionSortMode;
  searchQuery?: string;
};
