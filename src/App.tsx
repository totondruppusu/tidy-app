import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

type FilterMode =
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
type SortMode =
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
type DensityMode = "comfortable" | "compact";
type GroupMode = "none" | "type" | "extension" | "duplicates";
type ThemeMode = "light" | "dark";
type ViewMode = "tree" | "list";

type FileEntry = {
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

type ArchivePreview = {
  entries: string[];
  truncated: boolean;
};

type ScanResult = {
  files: FileEntry[];
  total: number;
};

type ScanProgress = {
  scanId: string;
  scanned: number;
  matched: number;
  total: number;
  phase: "indexing" | "scanning";
};

type ScanBatch = {
  scanId: string;
  files: FileEntry[];
};

type MoveResult = {
  newName: string;
  targetPath: string;
};

type TrashResult = {
  trashPath: string;
};

type FolderTrashEntry = {
  id: string;
  relativePath: string;
};

type FolderTrashItem = {
  file: FileEntry;
  relativePath: string;
};

type UndoAction =
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

const MAX_UNDO_STACK = 20;
const PREVIEW_DELAY_MS = 120;
const OFFICE_PREVIEW_EXTENSIONS = ["doc", "docx", "xlsx", "ppt", "pptx", "key", "odp"];
const SCROLL_HINT_TOLERANCE = 6;

const updateScrollHint = (scrollNode: HTMLElement, frameNode: HTMLElement) => {
  const maxScroll = scrollNode.scrollHeight - scrollNode.clientHeight;
  const canScroll = maxScroll > SCROLL_HINT_TOLERANCE;
  const showTop = canScroll && scrollNode.scrollTop > SCROLL_HINT_TOLERANCE;
  const showBottom = canScroll && scrollNode.scrollTop < maxScroll - SCROLL_HINT_TOLERANCE;
  frameNode.classList.toggle("scroll-hint-top", showTop);
  frameNode.classList.toggle("scroll-hint-bottom", showBottom);
};

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
};

const shouldOpenOnEnter = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return true;
  }
  if (target === document.body || target === document.documentElement) {
    return true;
  }
  if (target.closest("[data-prevent-open-on-enter]")) {
    return false;
  }
  return Boolean(target.closest(".file-list"));
};

const buildMediaUrl = (id: string) => `media://localhost/${id}`;

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) {
    return "Unknown";
  }
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  const display = value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${display} ${units[index]}`;
};

const formatTimestamp = (timestamp: number | null) => {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return "Unknown";
  }
  return new Date(timestamp).toLocaleString();
};

const formatKindLabel = (kind: FileEntry["kind"]) => {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "docs":
      return "Docs";
    case "text":
      return "Text";
    case "compressed":
      return "Compressed";
    case "executable":
      return "Executable";
    case "binary":
      return "Binary";
    default:
      return "Other";
  }
};

const formatGroupLabel = (kind: FileEntry["kind"]) => {
  switch (kind) {
    case "image":
      return "Images";
    case "video":
      return "Videos";
    case "audio":
      return "Audio";
    case "docs":
      return "Docs";
    case "text":
      return "Text files";
    case "compressed":
      return "Compressed";
    case "executable":
      return "Executables";
    case "binary":
      return "Binary";
    default:
      return "Other files";
  }
};

const formatPathLabel = (path: string | null) => {
  if (!path) {
    return "Not set";
  }
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

const getExtension = (name: string) => {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return "none";
  }
  return name.slice(lastDot + 1).toLowerCase();
};

const formatExtensionLabel = (extension: string) => {
  if (extension === "none") {
    return "No extension";
  }
  return `.${extension}`;
};

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

const getGroupKey = (mode: GroupMode, file: FileEntry) => {
  if (mode === "extension") {
    return getExtension(file.name);
  }
  if (mode === "duplicates") {
    return file.duplicateGroup ?? file.id;
  }
  return file.kind;
};

const getGroupIdForFile = (mode: GroupMode, file: FileEntry) =>
  mode === "none" ? null : `${mode}:${getGroupKey(mode, file)}`;

const sortGroupKeys = (mode: GroupMode, keys: string[]) => {
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

const groupFilesByMode = (mode: GroupMode, list: FileEntry[]) => {
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

type TreeFolderNode = {
  type: "folder";
  name: string;
  path: string;
  children: TreeNode[];
  fileCount: number;
};

type TreeFileNode = {
  type: "file";
  file: FileEntry;
};

type TreeNode = TreeFolderNode | TreeFileNode;

const getFolderCollapseKey = (groupId: string | null, path: string) =>
  groupId ? `${groupId}::${path}` : path;

const sortTreeNodesByIndex = (nodes: TreeNode[], indexMap: Map<string, number>) => {
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

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const formatGroupTitle = (mode: GroupMode, key: string, groupFiles?: FileEntry[]) => {
  if (mode === "duplicates") {
    if (!groupFiles || groupFiles.length === 0) {
      return "Duplicate set";
    }
    const nameSet = new Set(groupFiles.map((file) => file.name));
    return nameSet.size === 1 ? groupFiles[0].name : "Duplicate set";
  }
  if (mode === "extension") {
    return formatExtensionLabel(key);
  }
  return formatGroupLabel(key as FileEntry["kind"]);
};

const formatDuplicateGroupMeta = (groupFiles: FileEntry[]) => {
  if (groupFiles.length === 0) {
    return null;
  }
  const sizeLabel = formatBytes(groupFiles[0].sizeBytes);
  const nameCount = new Set(groupFiles.map((file) => file.name)).size;
  const parts = [`${sizeLabel} each`];
  if (nameCount > 1) {
    parts.unshift(`${nameCount} names`);
  }
  return parts.join(" · ");
};

const DESTINATION_SLOT_COUNT = 5;
const SETTINGS_KEY = "tidy-settings";
const TREE_INDENT_PX = 16;

const splitPathSegments = (path: string) => path.split(/[\\/]+/).filter(Boolean);

const getRelativeSegments = (fullPath: string, basePath: string | null) => {
  const fullSegments = splitPathSegments(fullPath);
  if (!basePath) {
    return fullSegments;
  }
  const baseSegments = splitPathSegments(basePath);
  let index = 0;
  while (index < baseSegments.length && fullSegments[index] === baseSegments[index]) {
    index += 1;
  }
  return fullSegments.slice(index);
};

const formatRelativeFolder = (fullPath: string, basePath: string | null) => {
  const segments = getRelativeSegments(fullPath, basePath);
  if (segments.length <= 1) {
    return "Root folder";
  }
  return segments.slice(0, -1).join("/");
};

const buildFileTree = (list: FileEntry[], basePath: string | null) => {
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

const extractFolder = (path: string) => {
  const match = path.match(/^(.*)[\\/][^\\/]+$/);
  return match ? match[1] : path;
};

const getInitialTheme = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "light";
  }
  const stored = window.localStorage.getItem("tidy-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
};

type StoredSettings = {
  filterMode?: FilterMode;
  includeSubfolders?: boolean;
  includeHidden?: boolean;
  confirmTrash?: boolean;
  sortMode?: SortMode;
  groupMode?: GroupMode;
  listDensity?: DensityMode;
  viewMode?: ViewMode;
  destinationSlots?: (string | null)[];
};

const FILTER_MODES: FilterMode[] = [
  "all",
  "images",
  "videos",
  "images_videos",
  "audio",
  "docs",
  "text",
  "compressed",
  "executables",
  "binary",
  "duplicates",
];
const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
  { value: "all", label: "All files" },
  { value: "images", label: "Images" },
  { value: "videos", label: "Videos" },
  { value: "images_videos", label: "Images + Videos" },
  { value: "audio", label: "Audio" },
  { value: "docs", label: "Docs" },
  { value: "text", label: "Text" },
  { value: "compressed", label: "Compressed" },
  { value: "executables", label: "Executables" },
  { value: "binary", label: "Binary" },
  { value: "duplicates", label: "Duplicates" },
];
const SORT_MODES: SortMode[] = [
  "none",
  "name_asc",
  "name_desc",
  "size_desc",
  "size_asc",
  "date_desc",
  "date_asc",
  "type_asc",
  "type_desc",
  "extension_asc",
  "extension_desc",
];
const GROUP_MODES: GroupMode[] = ["none", "type", "extension", "duplicates"];
const DENSITY_MODES: DensityMode[] = ["comfortable", "compact"];
const VIEW_MODES: ViewMode[] = ["tree", "list"];

const isFilterMode = (value: unknown): value is FilterMode =>
  typeof value === "string" && FILTER_MODES.includes(value as FilterMode);

const isSortMode = (value: unknown): value is SortMode =>
  typeof value === "string" && SORT_MODES.includes(value as SortMode);

const isGroupMode = (value: unknown): value is GroupMode =>
  typeof value === "string" && GROUP_MODES.includes(value as GroupMode);

const isDensityMode = (value: unknown): value is DensityMode =>
  typeof value === "string" && DENSITY_MODES.includes(value as DensityMode);

const isViewMode = (value: unknown): value is ViewMode =>
  typeof value === "string" && VIEW_MODES.includes(value as ViewMode);

const normalizeDestinationSlots = (value: unknown): (string | null)[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => (typeof entry === "string" ? entry : null));
};

const getStoredSettings = (): StoredSettings => {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const settings: StoredSettings = {};
    if (isFilterMode(parsed.filterMode)) {
      settings.filterMode = parsed.filterMode;
    }
    if (typeof parsed.includeSubfolders === "boolean") {
      settings.includeSubfolders = parsed.includeSubfolders;
    }
    if (typeof parsed.includeHidden === "boolean") {
      settings.includeHidden = parsed.includeHidden;
    }
    if (typeof parsed.confirmTrash === "boolean") {
      settings.confirmTrash = parsed.confirmTrash;
    }
    if (isSortMode(parsed.sortMode)) {
      settings.sortMode = parsed.sortMode;
    }
    if (isGroupMode(parsed.groupMode)) {
      settings.groupMode = parsed.groupMode;
    }
    if (isDensityMode(parsed.listDensity)) {
      settings.listDensity = parsed.listDensity;
    }
    if (isViewMode(parsed.viewMode)) {
      settings.viewMode = parsed.viewMode;
    }
    const storedSlots = normalizeDestinationSlots(parsed.destinationSlots);
    if (storedSlots) {
      settings.destinationSlots = storedSlots;
    }
    return settings;
  } catch (error) {
    console.warn("Failed to read stored settings.", error);
    return {};
  }
};

export default function App() {
  const [storedSettings] = useState(() => getStoredSettings());
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [, setStatus] = useState("Select a folder to begin.");
  const [filterMode, setFilterMode] = useState<FilterMode>(storedSettings.filterMode ?? "all");
  const [includeSubfolders, setIncludeSubfolders] = useState(
    storedSettings.includeSubfolders ?? false
  );
  const [includeHidden, setIncludeHidden] = useState(storedSettings.includeHidden ?? false);
  const [destinationSlots, setDestinationSlots] = useState<(string | null)[]>(() => {
    const storedSlots = storedSettings.destinationSlots;
    if (!storedSlots) {
      return Array.from({ length: DESTINATION_SLOT_COUNT }, () => null);
    }
    const normalized = storedSlots.slice(0, DESTINATION_SLOT_COUNT);
    while (normalized.length < DESTINATION_SLOT_COUNT) {
      normalized.push(null);
    }
    return normalized;
  });
  const [confirmTrash, setConfirmTrash] = useState(storedSettings.confirmTrash ?? true);
  const [sortMode, setSortMode] = useState<SortMode>(storedSettings.sortMode ?? "name_asc");
  const [groupMode, setGroupMode] = useState<GroupMode>(storedSettings.groupMode ?? "none");
  const isDuplicateFilter = filterMode === "duplicates";
  const effectiveGroupMode: GroupMode = isDuplicateFilter ? "duplicates" : groupMode;
  const displayGroupMode: GroupMode = isDuplicateFilter ? "duplicates" : groupMode;
  const [listDensity, setListDensity] = useState<DensityMode>(
    storedSettings.listDensity ?? "comfortable"
  );
  const [viewMode, setViewMode] = useState<ViewMode>(storedSettings.viewMode ?? "tree");
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [renderCount, setRenderCount] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDrawerMode, setIsDrawerMode] = useState(false);
  const [isExtensionsCollapsed, setIsExtensionsCollapsed] = useState(true);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [isPreviewPanning, setIsPreviewPanning] = useState(false);
  const [officePreviewId, setOfficePreviewId] = useState<string | null>(null);
  const [officePreviewStatus, setOfficePreviewStatus] = useState<"idle" | "loading" | "error">(
    "idle"
  );
  const [archiveEntries, setArchiveEntries] = useState<string[]>([]);
  const [archiveTruncated, setArchiveTruncated] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<"idle" | "loading" | "error">("idle");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const previewZoomTargetRef = useRef(1);
  const previewZoomRafRef = useRef<number | null>(null);
  const previewPanStartRef = useRef<{ x: number; y: number } | null>(null);
  const previewPanPointerRef = useRef<{ x: number; y: number } | null>(null);
  const previewDelayTimeoutRef = useRef<number | null>(null);
  const activeScanId = useRef<string | null>(null);
  const listItemRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const previousActiveFileIdRef = useRef<string | null>(null);
  const visibleFileOrderRef = useRef<string[]>([]);
  const previousExtensionsRef = useRef<string[]>([]);
  const hasUserAdjustedExtensionsRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const fileListFrameRef = useRef<HTMLDivElement | null>(null);
  const fileListScrollRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("tidy-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const handleChange = () => setIsDrawerMode(mediaQuery.matches);
    handleChange();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (isDrawerMode) {
      setIsSidebarCollapsed(true);
    }
  }, [isDrawerMode]);

  const syncScrollHints = useCallback((scrollNode: HTMLElement | null, frameNode: HTMLElement | null) => {
    if (!scrollNode || !frameNode) {
      return;
    }
    updateScrollHint(scrollNode, frameNode);
  }, []);

  useEffect(() => {
    const scrollNode = fileListScrollRef.current;
    const frameNode = fileListFrameRef.current;
    if (!scrollNode || !frameNode) {
      return;
    }
    let raf = 0;
    const handle = () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() => updateScrollHint(scrollNode, frameNode));
    };
    handle();
    scrollNode.addEventListener("scroll", handle, { passive: true });
    const resizeObserver = new ResizeObserver(handle);
    resizeObserver.observe(scrollNode);
    return () => {
      scrollNode.removeEventListener("scroll", handle);
      resizeObserver.disconnect();
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [isSidebarCollapsed]);

  useEffect(() => {
    const scrollNode = previewScrollRef.current;
    const frameNode = previewFrameRef.current;
    if (!scrollNode || !frameNode) {
      return;
    }
    let raf = 0;
    const handle = () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
      raf = requestAnimationFrame(() => updateScrollHint(scrollNode, frameNode));
    };
    handle();
    scrollNode.addEventListener("scroll", handle, { passive: true });
    const resizeObserver = new ResizeObserver(handle);
    resizeObserver.observe(scrollNode);
    return () => {
      scrollNode.removeEventListener("scroll", handle);
      resizeObserver.disconnect();
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const snapshot: StoredSettings = {
      filterMode,
      includeSubfolders,
      includeHidden,
      confirmTrash,
      sortMode,
      groupMode,
      listDensity,
      viewMode,
      destinationSlots,
    };
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("Failed to persist settings.", error);
    }
  }, [
    filterMode,
    includeSubfolders,
    includeHidden,
    confirmTrash,
    sortMode,
    groupMode,
    listDensity,
    viewMode,
    destinationSlots,
  ]);

  useEffect(() => {
    const applyWindowTheme = async () => {
      if (!isTauri()) {
        return;
      }
      try {
        await getCurrentWindow().setTheme(theme === "dark" ? "Dark" : "Light");
      } catch (error) {
        console.warn("Failed to sync window theme.", error);
      }
    };
    void applyWindowTheme();
  }, [theme]);

  const updateStatus = useCallback((message: string) => {
    setStatus(message);
  }, []);

  const sortFiles = useCallback(
    (list: FileEntry[]) => {
      if (sortMode === "none") {
        return list;
      }
      const next = [...list];
      const compareName = (a: FileEntry, b: FileEntry) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      const compareExtension = (a: FileEntry, b: FileEntry) =>
        getExtension(a.name).localeCompare(getExtension(b.name), undefined, { sensitivity: "base" });
      const compareType = (a: FileEntry, b: FileEntry) =>
        a.kind.localeCompare(b.kind, undefined, { sensitivity: "base" });
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
    },
    [sortMode]
  );

  const allExtensions = useMemo(() => {
    const set = new Set<string>();
    files.forEach((file) => {
      set.add(getExtension(file.name));
    });
    const list = Array.from(set);
    list.sort((a, b) => {
      if (a === "none") {
        return 1;
      }
      if (b === "none") {
        return -1;
      }
      return a.localeCompare(b);
    });
    return list;
  }, [files]);

  const selectedExtensionsSet = useMemo(
    () => new Set(selectedExtensions),
    [selectedExtensions]
  );

  useEffect(() => {
    setSelectedExtensions((current) => {
      if (allExtensions.length === 0) {
        hasUserAdjustedExtensionsRef.current = false;
        return [];
      }
      if (!hasUserAdjustedExtensionsRef.current) {
        return allExtensions;
      }
      const prev = previousExtensionsRef.current;
      const hadAllSelected =
        prev.length > 0 && prev.every((extension) => current.includes(extension)) && current.length >= prev.length;
      if (current.length === 0 || hadAllSelected) {
        return allExtensions;
      }
      return current.filter((extension) => allExtensions.includes(extension));
    });
    previousExtensionsRef.current = allExtensions;
  }, [allExtensions]);

  const allExtensionsSelected =
    allExtensions.length > 0 && selectedExtensions.length === allExtensions.length;
  const someExtensionsSelected =
    selectedExtensions.length > 0 && selectedExtensions.length < allExtensions.length;

  useEffect(() => {
    if (!selectAllRef.current) {
      return;
    }
    selectAllRef.current.indeterminate = someExtensionsSelected;
  }, [someExtensionsSelected]);

  const filteredFiles = useMemo(() => {
    if (selectedExtensionsSet.size === 0) {
      return [];
    }
    return files.filter((file) => selectedExtensionsSet.has(getExtension(file.name)));
  }, [files, selectedExtensionsSet]);

  const sortedFiles = useMemo(() => sortFiles(filteredFiles), [filteredFiles, sortFiles]);
  const sortedIndexById = useMemo(() => {
    const map = new Map<string, number>();
    sortedFiles.forEach((file, index) => {
      map.set(file.id, index);
    });
    return map;
  }, [sortedFiles]);
  const currentFile = sortedFiles[currentIndex];
  const previewFile = sortedFiles[previewIndex];
  const previewExtension = previewFile ? getExtension(previewFile.name) : "none";
  const isMediaPreview = previewFile?.kind === "image" || previewFile?.kind === "video";
  const isAudioPreview = previewFile?.kind === "audio";
  const isTextPreview = previewFile?.kind === "text";
  const isPdfPreview = previewFile?.kind === "docs" && previewExtension === "pdf";
  const isOfficePreview =
    previewFile?.kind === "docs" && OFFICE_PREVIEW_EXTENSIONS.includes(previewExtension);
  const isDocumentPreview = isTextPreview || isPdfPreview;
  const isArchivePreview = previewFile?.kind === "compressed";
  const isFallbackPreview =
    Boolean(previewFile) &&
    !isMediaPreview &&
    !isAudioPreview &&
    !isDocumentPreview &&
    !isOfficePreview &&
    !isArchivePreview;
  const hasFiles = sortedFiles.length > 0;
  const isZoomablePreview = isMediaPreview;

  useEffect(() => {
    if (!previewFile || !isOfficePreview) {
      setOfficePreviewId(null);
      setOfficePreviewStatus("idle");
      return;
    }
    if (!isTauri()) {
      setOfficePreviewId(null);
      setOfficePreviewStatus("error");
      return;
    }
    let isActive = true;
    setOfficePreviewId(null);
    setOfficePreviewStatus("loading");
    invoke<string>("generate_preview", { id: previewFile.id })
      .then((previewId) => {
        if (!isActive) {
          return;
        }
        setOfficePreviewId(previewId);
        setOfficePreviewStatus("idle");
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }
        console.warn("Failed to generate office preview.", error);
        setOfficePreviewId(null);
        setOfficePreviewStatus("error");
      });
    return () => {
      isActive = false;
    };
  }, [previewFile?.id, isOfficePreview]);

  useEffect(() => {
    if (!previewFile || !isArchivePreview) {
      setArchiveEntries([]);
      setArchiveTruncated(false);
      setArchiveStatus("idle");
      setArchiveError(null);
      return;
    }
    if (!isTauri()) {
      setArchiveEntries([]);
      setArchiveTruncated(false);
      setArchiveStatus("error");
      setArchiveError("Archive preview requires the desktop app.");
      return;
    }
    let isActive = true;
    setArchiveEntries([]);
    setArchiveTruncated(false);
    setArchiveStatus("loading");
    setArchiveError(null);
    invoke<ArchivePreview>("list_archive_entries", { id: previewFile.id })
      .then((result) => {
        if (!isActive) {
          return;
        }
        setArchiveEntries(result.entries);
        setArchiveTruncated(result.truncated);
        setArchiveStatus("idle");
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }
        console.warn("Failed to load archive preview.", error);
        setArchiveEntries([]);
        setArchiveTruncated(false);
        setArchiveStatus("error");
        setArchiveError("Preview unavailable for this archive.");
      });
    return () => {
      isActive = false;
    };
  }, [previewFile?.id, isArchivePreview]);

  useEffect(() => {
    setPreviewZoom(1);
    previewZoomTargetRef.current = 1;
    setPreviewPan({ x: 0, y: 0 });
    if (previewZoomRafRef.current !== null) {
      cancelAnimationFrame(previewZoomRafRef.current);
      previewZoomRafRef.current = null;
    }
  }, [previewFile?.id]);

  const handlePreviewWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey) {
        return;
      }
      if (previewFile?.kind !== "image" && previewFile?.kind !== "video") {
        return;
      }
      event.preventDefault();
      if (Math.abs(event.deltaY) < 0.6) {
        return;
      }
      const zoomFactor = Math.exp(-event.deltaY * 0.0045);
      previewZoomTargetRef.current = clampNumber(
        previewZoomTargetRef.current * zoomFactor,
        0.5,
        4
      );
      if (previewZoomRafRef.current !== null) {
        return;
      }
      const tick = () => {
        setPreviewZoom((value) => {
          const target = previewZoomTargetRef.current;
          const diff = target - value;
          if (Math.abs(diff) < 0.001) {
            previewZoomRafRef.current = null;
            return target;
          }
          previewZoomRafRef.current = requestAnimationFrame(tick);
          return value + diff * 0.18;
        });
      };
      previewZoomRafRef.current = requestAnimationFrame(tick);
    },
    [previewFile]
  );

  const setPreviewZoomValue = useCallback((value: number) => {
    const clamped = clampNumber(value, 0.5, 4);
    previewZoomTargetRef.current = clamped;
    if (previewZoomRafRef.current !== null) {
      cancelAnimationFrame(previewZoomRafRef.current);
      previewZoomRafRef.current = null;
    }
    setPreviewZoom(clamped);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!isZoomablePreview) {
      return;
    }
    setPreviewZoomValue(previewZoomTargetRef.current / 1.15);
  }, [isZoomablePreview, setPreviewZoomValue]);

  const handleZoomIn = useCallback(() => {
    if (!isZoomablePreview) {
      return;
    }
    setPreviewZoomValue(previewZoomTargetRef.current * 1.15);
  }, [isZoomablePreview, setPreviewZoomValue]);

  const handleZoomReset = useCallback(() => {
    if (!isZoomablePreview) {
      return;
    }
    setPreviewZoomValue(1);
    setPreviewPan({ x: 0, y: 0 });
  }, [isZoomablePreview, setPreviewZoomValue]);

  const handlePreviewPanStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (previewFile?.kind !== "image") {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      previewPanStartRef.current = { x: previewPan.x, y: previewPan.y };
      previewPanPointerRef.current = { x: event.clientX, y: event.clientY };
      setIsPreviewPanning(true);
    },
    [previewFile?.kind, previewPan.x, previewPan.y]
  );

  const handlePreviewPanMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!previewPanStartRef.current || !previewPanPointerRef.current) {
      return;
    }
    const startPan = previewPanStartRef.current;
    const startPointer = previewPanPointerRef.current;
    setPreviewPan({
      x: startPan.x + (event.clientX - startPointer.x),
      y: startPan.y + (event.clientY - startPointer.y),
    });
  }, []);

  const handlePreviewPanEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!previewPanStartRef.current) {
      return;
    }
    previewPanStartRef.current = null;
    previewPanPointerRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsPreviewPanning(false);
  }, []);

  useEffect(() => {
    return () => {
      if (previewZoomRafRef.current !== null) {
        cancelAnimationFrame(previewZoomRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (sortedFiles.length === 0) {
      if (currentIndex !== 0) {
        setCurrentIndex(0);
      }
      return;
    }
    if (currentIndex >= sortedFiles.length) {
      setCurrentIndex(sortedFiles.length - 1);
    }
  }, [currentIndex, sortedFiles.length]);

  useEffect(() => {
    if (sortedFiles.length === 0) {
      setPreviewIndex(0);
      return;
    }
    if (previewIndex >= sortedFiles.length) {
      setPreviewIndex(sortedFiles.length - 1);
    }
  }, [previewIndex, sortedFiles.length]);

  useEffect(() => {
    if (previewDelayTimeoutRef.current !== null) {
      window.clearTimeout(previewDelayTimeoutRef.current);
    }
    previewDelayTimeoutRef.current = window.setTimeout(() => {
      setPreviewIndex(currentIndex);
      previewDelayTimeoutRef.current = null;
    }, PREVIEW_DELAY_MS);
    return () => {
      if (previewDelayTimeoutRef.current !== null) {
        window.clearTimeout(previewDelayTimeoutRef.current);
        previewDelayTimeoutRef.current = null;
      }
    };
  }, [currentIndex]);

  const handleScan = useCallback(
    async (folderPath?: string) => {
      if (!folderPath) {
        updateStatus("No folder selected.");
        return;
      }
      const scanId = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
      activeScanId.current = scanId;
      setIsLoading(true);
      setScanProgress({ scanId, scanned: 0, matched: 0, total: 0, phase: "indexing" });
      setFiles([]);
      setCurrentIndex(0);
      setRenderCount(0);
      setUndoStack([]);
      setCollapsedGroups({});
      setCollapsedFolders({});
      updateStatus(includeSubfolders ? "Scanning folders and subfolders..." : "Scanning folder...");
      try {
        const result = await invoke<ScanResult>("scan_folder", {
          folderPath,
          filterMode,
          includeSubfolders,
          includeHidden,
          scanId
        });
        if (activeScanId.current !== scanId) {
          return;
        }
        setFiles(result.files);
        setCurrentFolder(folderPath);
        updateStatus(`Loaded ${result.files.length} items from ${folderPath}.`);
      } catch (error) {
        if (activeScanId.current !== scanId) {
          return;
        }
        updateStatus(`Scan failed: ${String(error)}`);
      } finally {
        if (activeScanId.current === scanId) {
          setIsLoading(false);
          setScanProgress(null);
          activeScanId.current = null;
        }
      }
    },
    [filterMode, includeSubfolders, includeHidden, updateStatus]
  );

  const pickFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setCurrentFolder(selected);
        updateStatus("Folder selected. Click search to scan.");
      } else {
        updateStatus("No folder selected.");
      }
    } catch (error) {
      updateStatus(`Folder picker failed: ${String(error)}`);
    }
  }, [handleScan, updateStatus]);

  const updateDestinationSlot = useCallback((slotIndex: number, destination: string) => {
    setDestinationSlots((prev) => {
      const next = [...prev];
      next[slotIndex] = destination;
      return next;
    });
  }, []);

  const getOrderSnapshot = useCallback((sortedPrev: FileEntry[]) => {
    const order = visibleFileOrderRef.current;
    if (order.length === 0) {
      return sortedPrev.map((file) => file.id);
    }
    const idSet = new Set(sortedPrev.map((file) => file.id));
    const filtered = order.filter((id) => idSet.has(id));
    return filtered.length > 0 ? filtered : sortedPrev.map((file) => file.id);
  }, [visibleFileOrderRef]);

  const getNextVisibleId = useCallback(
    (currentId: string | null, order: string[], removedSet: Set<string>) => {
      if (!currentId) {
        return null;
      }
      if (!removedSet.has(currentId)) {
        return currentId;
      }
      const position = order.indexOf(currentId);
      if (position === -1) {
        return null;
      }
      for (let i = position + 1; i < order.length; i += 1) {
        const candidate = order[i];
        if (!removedSet.has(candidate)) {
          return candidate;
        }
      }
      for (let i = position - 1; i >= 0; i -= 1) {
        const candidate = order[i];
        if (!removedSet.has(candidate)) {
          return candidate;
        }
      }
      return null;
    },
    []
  );

  const pickDestinationForSlot = useCallback(
    async (slotIndex: number) => {
      try {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === "string") {
          updateDestinationSlot(slotIndex, selected);
          updateStatus(`Destination ${slotIndex + 1} set to ${selected}.`);
          return selected;
        }
        updateStatus("No destination selected.");
      } catch (error) {
        updateStatus(`Destination picker failed: ${String(error)}`);
      }
      return null;
    },
    [updateDestinationSlot, updateStatus]
  );

  const removeFileById = useCallback(
    (removedId: string) => {
      setFiles((prev) => {
        const filterByExtension = (file: FileEntry) =>
          selectedExtensionsSet.has(getExtension(file.name));
        const sortedPrev = sortFiles(prev.filter(filterByExtension));
        const orderSnapshot = getOrderSnapshot(sortedPrev);
        const removedSet = new Set([removedId]);
        const removedIndex = sortedPrev.findIndex((file) => file.id === removedId);
        const next = prev.filter((file) => file.id !== removedId);
        const sortedNext = sortFiles(next.filter(filterByExtension));
        setCurrentIndex((current) => {
          if (removedIndex === -1) {
            return current;
          }
          if (sortedPrev.length === 0) {
            return 0;
          }
          const boundedCurrent = Math.min(current, sortedPrev.length - 1);
          const currentId = sortedPrev[boundedCurrent]?.id ?? null;
          // Keep selection aligned with the visible order when removing files.
          const targetId = getNextVisibleId(currentId, orderSnapshot, removedSet);
          if (!targetId) {
            return sortedNext.length === 0 ? 0 : Math.min(boundedCurrent, sortedNext.length - 1);
          }
          const nextIndex = sortedNext.findIndex((file) => file.id === targetId);
          if (nextIndex === -1) {
            return sortedNext.length === 0 ? 0 : Math.min(boundedCurrent, sortedNext.length - 1);
          }
          return nextIndex;
        });
        return next;
      });
    },
    [selectedExtensionsSet, sortFiles, getOrderSnapshot, getNextVisibleId]
  );

  const removeFilesByIds = useCallback(
    (removedIds: string[]) => {
      const removedSet = new Set(removedIds);
      if (removedSet.size === 0) {
        return;
      }
      setFiles((prev) => {
        const filterByExtension = (file: FileEntry) =>
          selectedExtensionsSet.has(getExtension(file.name));
        const sortedPrev = sortFiles(prev.filter(filterByExtension));
        const next = prev.filter((file) => !removedSet.has(file.id));
        const sortedNext = sortFiles(next.filter(filterByExtension));
        const orderSnapshot = getOrderSnapshot(sortedPrev);
        setCurrentIndex((current) => {
          if (sortedPrev.length === 0) {
            return 0;
          }
          const boundedCurrent = Math.min(current, sortedPrev.length - 1);
          const currentId = sortedPrev[boundedCurrent]?.id ?? null;
          const targetId = getNextVisibleId(currentId, orderSnapshot, removedSet);
          if (!targetId) {
            return sortedNext.length === 0 ? 0 : Math.min(boundedCurrent, sortedNext.length - 1);
          }
          const nextIndex = sortedNext.findIndex((file) => file.id === targetId);
          if (nextIndex === -1) {
            return sortedNext.length === 0 ? 0 : Math.min(boundedCurrent, sortedNext.length - 1);
          }
          return nextIndex;
        });
        return next;
      });
    },
    [selectedExtensionsSet, sortFiles, getOrderSnapshot, getNextVisibleId]
  );

  const restoreFileEntry = useCallback(
    (restored: FileEntry) => {
      setFiles((prev) => {
        if (prev.some((file) => file.id === restored.id)) {
          return prev;
        }
        const next = [...prev, restored];
        const filterByExtension = (file: FileEntry) =>
          selectedExtensionsSet.has(getExtension(file.name));
        const sortedNext = sortFiles(next.filter(filterByExtension));
        const restoredIndex = sortedNext.findIndex((file) => file.id === restored.id);
        if (restoredIndex !== -1) {
          setCurrentIndex(restoredIndex);
        }
        return next;
      });
    },
    [selectedExtensionsSet, sortFiles]
  );

  const pushUndo = useCallback((action: UndoAction) => {
    setUndoStack((prev) => {
      const next = [action, ...prev];
      return next.length > MAX_UNDO_STACK ? next.slice(0, MAX_UNDO_STACK) : next;
    });
  }, []);

  const trashCurrent = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    const shouldTrash = confirmTrash
      ? await confirm(`Move ${currentFile.name} to trash?`, { title: "Confirm trash" })
      : true;
    if (!shouldTrash) {
      return;
    }
    try {
      const result = await invoke<TrashResult>("trash_file", { id: currentFile.id });
      removeFileById(currentFile.id);
      pushUndo({
        kind: "trash",
        file: currentFile,
        fromPath: currentFile.path,
        trashPath: result.trashPath,
      });
      updateStatus(`Moved ${currentFile.name} to trash.`);
    } catch (error) {
      updateStatus(`Trash failed: ${String(error)}`);
    }
  }, [confirmTrash, currentFile, removeFileById, updateStatus, pushUndo]);

  const getFolderFiles = useCallback(
    (folderPath: string) => {
      const folderSegments = splitPathSegments(folderPath);
      if (folderSegments.length === 0) {
        return [];
      }
      return files.filter((file) => {
        const relativeSegments = getRelativeSegments(file.path, currentFolder);
        if (relativeSegments.length < folderSegments.length) {
          return false;
        }
        return folderSegments.every((segment, index) => relativeSegments[index] === segment);
      });
    },
    [files, currentFolder]
  );

  const trashFolder = useCallback(
    async (folderPath: string) => {
      if (!currentFolder) {
        updateStatus("No folder selected.");
        return;
      }
      const folderFiles = getFolderFiles(folderPath);
      if (folderFiles.length === 0) {
        updateStatus("Folder is empty.");
        return;
      }
      const folderSegments = splitPathSegments(folderPath);
      const folderLabel = folderSegments[folderSegments.length - 1] ?? folderPath;
      const shouldTrash = await confirm(
        `Move ${folderLabel} and all its contents (${folderFiles.length} item${
          folderFiles.length === 1 ? "" : "s"
        }) to trash?`,
        { title: "Confirm folder trash" }
      );
      if (!shouldTrash) {
        return;
      }
      const base = currentFolder.replace(/[\\/]+$/, "");
      const fullFolderPath = `${base}/${folderPath}`;
      const items: FolderTrashItem[] = folderFiles.map((file) => ({
        file,
        relativePath: getRelativeSegments(file.path, fullFolderPath).join("/"),
      }));
      try {
        const result = await invoke<TrashResult>("trash_folder", {
          folderPath: fullFolderPath,
          files: items.map((item) => ({ id: item.file.id, relativePath: item.relativePath })),
        });
        removeFilesByIds(folderFiles.map((file) => file.id));
        pushUndo({
          kind: "trash-folder",
          folderPath: fullFolderPath,
          trashPath: result.trashPath,
          items,
        });
        updateStatus(`Moved ${folderLabel} to trash.`);
      } catch (error) {
        updateStatus(`Trash folder failed: ${String(error)}`);
      }
    },
    [currentFolder, getFolderFiles, updateStatus, removeFilesByIds, pushUndo]
  );

  const moveCurrentToSlot = useCallback(
    async (slotIndex: number, allowPickIfMissing = false) => {
      if (!currentFile) {
        updateStatus("No file selected.");
        return;
      }
      let destinationPath = destinationSlots[slotIndex] ?? null;
      if (!destinationPath) {
        if (allowPickIfMissing) {
          destinationPath = await pickDestinationForSlot(slotIndex);
        } else {
          updateStatus(`Destination ${slotIndex + 1} not set.`);
          return;
        }
      }
      if (!destinationPath) {
        return;
      }
      try {
        await invoke("set_destination", { destination: destinationPath });
        const result = await invoke<MoveResult>("move_file", { id: currentFile.id });
        removeFileById(currentFile.id);
        pushUndo({
          kind: "move",
          file: currentFile,
          fromPath: currentFile.path,
          toPath: result.targetPath,
        });
        updateStatus(`Moved to ${result.targetPath}.`);
      } catch (error) {
        updateStatus(`Move failed: ${String(error)}`);
      }
    },
    [currentFile, destinationSlots, pickDestinationForSlot, removeFileById, updateStatus, pushUndo]
  );

  const moveCurrent = useCallback(async () => {
    await moveCurrentToSlot(0, true);
  }, [moveCurrentToSlot]);

  const openFileInFinder = useCallback(
    async (file: FileEntry) => {
      try {
        await invoke("reveal_in_file_manager", { path: file.path, reveal: true });
      } catch (error) {
        updateStatus(`Open in Finder failed: ${String(error)}`);
      }
    },
    [updateStatus]
  );

  const openFileInSystem = useCallback(
    async (file: FileEntry) => {
      try {
        await invoke("reveal_in_file_manager", { path: file.path, reveal: false });
      } catch (error) {
        updateStatus(`Open file failed: ${String(error)}`);
      }
    },
    [updateStatus]
  );

  const openCurrentInFinder = useCallback(async () => {
    if (!currentFile) {
      updateStatus("No file selected.");
      return;
    }
    await openFileInFinder(currentFile);
  }, [currentFile, openFileInFinder, updateStatus]);

  const goNext = useCallback(() => {
    const order = visibleFileOrderRef.current;
    if (!currentFile || order.length === 0) {
      return;
    }
    const position = order.indexOf(currentFile.id);
    if (position === -1 || position >= order.length - 1) {
      return;
    }
    const nextId = order[position + 1];
    const nextIndex = sortedIndexById.get(nextId);
    if (nextIndex === undefined) {
      return;
    }
    setCurrentIndex(nextIndex);
  }, [currentFile, sortedIndexById]);

  const goPrev = useCallback(() => {
    const order = visibleFileOrderRef.current;
    if (!currentFile || order.length === 0) {
      return;
    }
    const position = order.indexOf(currentFile.id);
    if (position <= 0) {
      return;
    }
    const prevId = order[position - 1];
    const prevIndex = sortedIndexById.get(prevId);
    if (prevIndex === undefined) {
      return;
    }
    setCurrentIndex(prevIndex);
  }, [currentFile, sortedIndexById]);

  const undoLastAction = useCallback(async () => {
    const lastAction = undoStack[0];
    if (!lastAction) {
      updateStatus("Nothing to undo.");
      return;
    }
    if (lastAction.kind === "trash-folder") {
      try {
        await invoke("restore_folder", {
          source: lastAction.trashPath,
          destination: lastAction.folderPath,
          files: lastAction.items.map((item) => ({
            id: item.file.id,
            relativePath: item.relativePath,
          })),
        });
        lastAction.items.forEach((item) => restoreFileEntry(item.file));
        setUndoStack((prev) => prev.slice(1));
        updateStatus(`Restored ${lastAction.items.length} items.`);
      } catch (error) {
        updateStatus(`Undo failed: ${String(error)}`);
      }
      return;
    }
    const sourcePath = lastAction.kind === "move" ? lastAction.toPath : lastAction.trashPath;
    try {
      await invoke("restore_file", {
        id: lastAction.file.id,
        source: sourcePath,
        destination: lastAction.fromPath,
      });
      restoreFileEntry(lastAction.file);
      setUndoStack((prev) => prev.slice(1));
      updateStatus(`Undid ${lastAction.kind}.`);
    } catch (error) {
      updateStatus(`Undo failed: ${String(error)}`);
    }
  }, [undoStack, restoreFileEntry, updateStatus]);

  const toggleVideoPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isHelpOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsHelpOpen(false);
        }
        return;
      }
      if (isSettingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsSettingsOpen(false);
        }
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      if ((event.code === "Space" || event.key === " ") && currentFile?.kind === "video") {
        event.preventDefault();
        toggleVideoPlayback();
        return;
      }
      if (event.key >= "1" && event.key <= "5") {
        event.preventDefault();
        void moveCurrentToSlot(Number(event.key) - 1);
        return;
      }
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
          event.preventDefault();
          goNext();
          break;
        case "ArrowUp":
          event.preventDefault();
          void trashCurrent();
          break;
        case "ArrowDown":
          event.preventDefault();
          void undoLastAction();
          break;
        case "Enter":
          if (!shouldOpenOnEnter(event.target)) {
            return;
          }
          event.preventDefault();
          void openCurrentInFinder();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    currentFile,
    goNext,
    goPrev,
    isHelpOpen,
    isSettingsOpen,
    moveCurrentToSlot,
    openCurrentInFinder,
    toggleVideoPlayback,
    trashCurrent,
    undoLastAction,
  ]);

  useEffect(() => {
    let isMounted = true;
    const unlistenPromise = listen<ScanProgress>("scan_progress", (event) => {
      if (!isMounted) {
        return;
      }
      if (event.payload.scanId !== activeScanId.current) {
        return;
      }
      setScanProgress(event.payload);
    });
    const unlistenBatchPromise = listen<ScanBatch>("scan_batch", (event) => {
      if (!isMounted) {
        return;
      }
      if (event.payload.scanId !== activeScanId.current) {
        return;
      }
      setFiles((prev) => [...prev, ...event.payload.files]);
    });
    return () => {
      isMounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
      void unlistenBatchPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (sortedFiles.length === 0) {
      setRenderCount(0);
      return;
    }
    setRenderCount((prev) => Math.min(prev, sortedFiles.length));
    let cancelled = false;
    const step = () => {
      if (cancelled) {
        return;
      }
      setRenderCount((prev) => {
        if (prev >= sortedFiles.length) {
          return prev;
        }
        const next = Math.min(prev + 200, sortedFiles.length);
        if (next < sortedFiles.length) {
          requestAnimationFrame(step);
        }
        return next;
      });
    };
    requestAnimationFrame(step);
    return () => {
      cancelled = true;
    };
  }, [sortedFiles.length]);

  useEffect(() => {
    if (currentIndex + 1 > renderCount) {
      setRenderCount(Math.min(currentIndex + 1, sortedFiles.length));
    }
  }, [currentIndex, renderCount, sortedFiles.length]);

  const visibleFiles = useMemo(() => sortedFiles.slice(0, renderCount), [sortedFiles, renderCount]);

  const folderKeys = useMemo(() => {
    const keys = new Set<string>();
    const addKey = (groupId: string | null, path: string) => {
      if (!path) {
        return;
      }
      keys.add(getFolderCollapseKey(groupId, path));
    };
    sortedFiles.forEach((file) => {
      const segments = getRelativeSegments(file.path, currentFolder);
      const folderSegments = segments.length > 1 ? segments.slice(0, -1) : [];
      if (folderSegments.length === 0) {
        return;
      }
      const groupId = getGroupIdForFile(effectiveGroupMode, file);
      let currentPath = "";
      folderSegments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        addKey(groupId, currentPath);
      });
    });
    return Array.from(keys);
  }, [sortedFiles, effectiveGroupMode, currentFolder]);

  const hasFolders = folderKeys.length > 0;
  const hasCollapsedFolders = useMemo(
    () => folderKeys.some((key) => collapsedFolders[key]),
    [folderKeys, collapsedFolders]
  );

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);

  const toggleAllFolders = useCallback(() => {
    if (!hasFolders) {
      return;
    }
    if (hasCollapsedFolders) {
      setCollapsedFolders({});
      return;
    }
    const next: Record<string, boolean> = {};
    folderKeys.forEach((key) => {
      next[key] = true;
    });
    setCollapsedFolders(next);
  }, [folderKeys, hasCollapsedFolders, hasFolders]);

  const toggleFolderCollapse = useCallback((folderKey: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [folderKey]: !prev[folderKey] }));
  }, []);

  const listRender = useMemo(() => {
    const showDuplicateLocation = isDuplicateFilter && viewMode === "list";
    const renderButton = (file: FileEntry, index: number, depth?: number) => (
      <button
        key={file.id}
        className={`file-item ${depth !== undefined ? "tree-item" : ""}`}
        onClick={() => setCurrentIndex(index)}
        onDoubleClick={() => void openFileInFinder(file)}
        ref={(node) => listItemRefs.current.set(file.id, node)}
        type="button"
        disabled={isLoading}
        style={
          depth !== undefined
            ? ({ "--tree-indent": `${depth * TREE_INDENT_PX}px` } as React.CSSProperties)
            : undefined
        }
      >
        <span className={`badge badge-${file.kind}`}>{file.kind}</span>
        <span className="file-content">
          <span className="filename">{file.name}</span>
          {showDuplicateLocation && (
            <span className="file-location">{formatRelativeFolder(file.path, currentFolder)}</span>
          )}
        </span>
      </button>
    );

    const indexMap = new Map<string, number>();
    visibleFiles.forEach((file, index) => {
      indexMap.set(file.id, index);
    });

    const isDuplicateGrouping = effectiveGroupMode === "duplicates";

    if (viewMode === "list") {
      if (effectiveGroupMode === "none") {
        return { items: visibleFiles.map((file, index) => renderButton(file, index)) };
      }

      const { groups, keys } = groupFilesByMode(effectiveGroupMode, visibleFiles);

      const items: JSX.Element[] = [];
      keys.forEach((key) => {
        const groupFiles = groups.get(key);
        if (!groupFiles || groupFiles.length === 0) {
          return;
        }
        const groupId = `${effectiveGroupMode}:${key}`;
        const isGroupCollapsed = Boolean(collapsedGroups[groupId]);
        const groupTitle = formatGroupTitle(effectiveGroupMode, key, groupFiles);
        const groupMeta = isDuplicateGrouping ? formatDuplicateGroupMeta(groupFiles) : null;
        const countLabel = isDuplicateGrouping ? `${groupFiles.length} copies` : `${groupFiles.length}`;
        items.push(
          <div
            key={`${effectiveGroupMode}-${key}`}
            className={`list-section${isDuplicateGrouping ? " list-section-duplicates" : ""}`}
          >
            <button
              type="button"
              className="list-section-toggle"
              onClick={() => toggleGroupCollapse(groupId)}
              aria-expanded={!isGroupCollapsed}
              aria-label={
                isGroupCollapsed ? `Expand ${groupTitle}` : `Collapse ${groupTitle}`
              }
              disabled={isLoading}
              data-prevent-open-on-enter
            >
              <span className="list-section-caret" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  {isGroupCollapsed ? (
                    <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                  ) : (
                    <path d="M6 9l6 6 6-6H6Z" />
                  )}
                </svg>
              </span>
              <span className="list-section-text">
                <span className="list-section-title">{groupTitle}</span>
                {groupMeta && <span className="list-section-meta">{groupMeta}</span>}
              </span>
              <span className="list-section-count">{countLabel}</span>
            </button>
            {!isGroupCollapsed && (
              <div className="list-section-items">
                {groupFiles.map((file) => renderButton(file, indexMap.get(file.id) ?? 0))}
              </div>
            )}
          </div>
        );
      });
      return { items };
    }

    const renderTreeNodes = (nodes: TreeNode[], depth: number, groupId: string | null) => {
      const sortedNodes = sortTreeNodesByIndex(nodes, indexMap);
      return sortedNodes.map((node) => {
        if (node.type === "file") {
          const index = indexMap.get(node.file.id) ?? 0;
          return renderButton(node.file, index, depth);
        }
        const folderKey = getFolderCollapseKey(groupId, node.path);
        const isCollapsed = Boolean(collapsedFolders[folderKey]);
        return (
          <div key={`folder-${folderKey}`} className="tree-node">
            <div
              className="folder-item tree-item"
              style={{ "--tree-indent": `${depth * TREE_INDENT_PX}px` } as React.CSSProperties}
            >
              <button
                type="button"
                className="folder-item-toggle"
                onClick={() => toggleFolderCollapse(folderKey)}
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
                disabled={isLoading}
                data-prevent-open-on-enter
              >
                <span className="folder-caret" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    {isCollapsed ? (
                      <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                    ) : (
                      <path d="M6 9l6 6 6-6H6Z" />
                    )}
                  </svg>
                </span>
                <span className="folder-name">{node.name}</span>
                <span className="folder-count">{node.fileCount}</span>
              </button>
              <button
                type="button"
                className="folder-trash-button"
                onClick={(event) => {
                  event.stopPropagation();
                  void trashFolder(node.path);
                }}
                aria-label={`Trash ${node.name}`}
                title={`Trash ${node.name}`}
                disabled={isLoading}
                data-prevent-open-on-enter
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M9 4h6l1 2h4v2H4V6h4l1-2Zm1 6h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 10h2v8H7v-8Z" />
                </svg>
              </button>
            </div>
            {!isCollapsed && (
              <div className="tree-children">
                {renderTreeNodes(node.children, depth + 1, groupId)}
              </div>
            )}
          </div>
        );
      });
    };

    const renderTreeForFiles = (entries: FileEntry[], groupId: string | null) => {
      const tree = buildFileTree(entries, currentFolder);
      return renderTreeNodes(tree.children, 0, groupId);
    };

    if (effectiveGroupMode === "none") {
      return { items: renderTreeForFiles(visibleFiles, null) };
    }

    const { groups, keys } = groupFilesByMode(effectiveGroupMode, visibleFiles);
    const items: JSX.Element[] = [];
    keys.forEach((key) => {
      const groupFiles = groups.get(key);
      if (!groupFiles || groupFiles.length === 0) {
        return;
      }
      const groupId = `${effectiveGroupMode}:${key}`;
      const isGroupCollapsed = Boolean(collapsedGroups[groupId]);
      const groupTitle = formatGroupTitle(effectiveGroupMode, key, groupFiles);
      const groupMeta = isDuplicateGrouping ? formatDuplicateGroupMeta(groupFiles) : null;
      const countLabel = isDuplicateGrouping ? `${groupFiles.length} copies` : `${groupFiles.length}`;
      items.push(
        <div
          key={`${effectiveGroupMode}-${key}`}
          className={`list-section${isDuplicateGrouping ? " list-section-duplicates" : ""}`}
        >
          <button
            type="button"
            className="list-section-toggle"
            onClick={() => toggleGroupCollapse(groupId)}
            aria-expanded={!isGroupCollapsed}
            aria-label={isGroupCollapsed ? `Expand ${groupTitle}` : `Collapse ${groupTitle}`}
            disabled={isLoading}
            data-prevent-open-on-enter
          >
            <span className="list-section-caret" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                {isGroupCollapsed ? (
                  <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                ) : (
                  <path d="M6 9l6 6 6-6H6Z" />
                )}
              </svg>
            </span>
            <span className="list-section-text">
              <span className="list-section-title">{groupTitle}</span>
              {groupMeta && <span className="list-section-meta">{groupMeta}</span>}
            </span>
            <span className="list-section-count">{countLabel}</span>
          </button>
          {!isGroupCollapsed && (
            <div className="list-section-items">
              {renderTreeForFiles(groupFiles, groupId)}
            </div>
          )}
        </div>
      );
    });
    return { items };
  }, [
    visibleFiles,
    isLoading,
    effectiveGroupMode,
    isDuplicateFilter,
    openFileInFinder,
    currentFolder,
    viewMode,
    collapsedGroups,
    collapsedFolders,
    toggleGroupCollapse,
    toggleFolderCollapse,
    trashFolder,
  ]);

  const listItems = listRender.items;

  const visibleFileOrder = useMemo(() => {
    const order: string[] = [];
    if (viewMode === "list") {
      if (effectiveGroupMode === "none") {
        return sortedFiles.map((file) => file.id);
      }
      const { groups, keys } = groupFilesByMode(effectiveGroupMode, sortedFiles);
      keys.forEach((key) => {
        const groupFiles = groups.get(key);
        if (!groupFiles || groupFiles.length === 0) {
          return;
        }
        groupFiles.forEach((file) => order.push(file.id));
      });
      return order;
    }

    const indexMap = new Map<string, number>();
    sortedFiles.forEach((file, index) => {
      indexMap.set(file.id, index);
    });

    const collectTreeNodes = (nodes: TreeNode[], groupId: string | null) => {
      const sortedNodes = sortTreeNodesByIndex(nodes, indexMap);
      sortedNodes.forEach((node) => {
        if (node.type === "file") {
          order.push(node.file.id);
          return;
        }
        collectTreeNodes(node.children, groupId);
      });
    };

    const collectTreeForFiles = (entries: FileEntry[], groupId: string | null) => {
      const tree = buildFileTree(entries, currentFolder);
      collectTreeNodes(tree.children, groupId);
    };

    if (effectiveGroupMode === "none") {
      collectTreeForFiles(sortedFiles, null);
      return order;
    }

    const { groups, keys } = groupFilesByMode(effectiveGroupMode, sortedFiles);

    keys.forEach((key) => {
      const groupFiles = groups.get(key);
      if (!groupFiles || groupFiles.length === 0) {
        return;
      }
      const groupId = `${effectiveGroupMode}:${key}`;
      collectTreeForFiles(groupFiles, groupId);
    });

    return order;
  }, [sortedFiles, effectiveGroupMode, currentFolder, viewMode]);

  useEffect(() => {
    visibleFileOrderRef.current = visibleFileOrder;
  }, [visibleFileOrder]);

  useEffect(() => {
    if (!currentFile) {
      return;
    }
    const groupId = getGroupIdForFile(effectiveGroupMode, currentFile);
    if (groupId) {
      setCollapsedGroups((prev) => {
        if (!prev[groupId]) {
          return prev;
        }
        const next = { ...prev };
        next[groupId] = false;
        return next;
      });
    }
    const relativeSegments = getRelativeSegments(currentFile.path, currentFolder);
    const folderSegments = relativeSegments.length > 1 ? relativeSegments.slice(0, -1) : [];
    if (folderSegments.length === 0) {
      return;
    }
    setCollapsedFolders((prev) => {
      let next = prev;
      let currentPath = "";
      folderSegments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const key = getFolderCollapseKey(groupId, currentPath);
        if (next[key]) {
          if (next === prev) {
            next = { ...prev };
          }
          delete next[key];
        }
      });
      return next;
    });
  }, [currentFile, currentFolder, effectiveGroupMode]);

  useEffect(() => {
    const previousId = previousActiveFileIdRef.current;
    if (previousId && previousId !== currentFile?.id) {
      const previousNode = listItemRefs.current.get(previousId);
      if (previousNode) {
        previousNode.classList.remove("active");
        previousNode.removeAttribute("aria-current");
      }
    }
    if (currentFile?.id) {
      const currentNode = listItemRefs.current.get(currentFile.id);
      if (currentNode) {
        currentNode.classList.add("active");
        currentNode.setAttribute("aria-current", "true");
      }
    }
    previousActiveFileIdRef.current = currentFile?.id ?? null;
  }, [currentFile?.id, renderCount, collapsedGroups, collapsedFolders, effectiveGroupMode, viewMode]);

  useEffect(() => {
    if (!currentFile) {
      return;
    }
    const node = listItemRefs.current.get(currentFile.id);
    if (!node) {
      return;
    }
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: "nearest" });
    });
  }, [currentFile, renderCount, collapsedGroups, collapsedFolders]);

  const loadingMessage = useMemo(() => {
    if (!isLoading || !scanProgress) {
      return null;
    }
    if (scanProgress.phase === "indexing") {
      return `Indexing ${scanProgress.scanned} files...`;
    }
    const percent = scanProgress.total
      ? Math.min(100, Math.round((scanProgress.scanned / scanProgress.total) * 100))
      : 0;
    return `Scanning ${percent}% · ${scanProgress.scanned}/${scanProgress.total} files · ${scanProgress.matched} matched`;
  }, [isLoading, scanProgress]);

  const isRenderingList = renderCount < sortedFiles.length;
  const progressPercent =
    isLoading && scanProgress && scanProgress.total
      ? Math.min(100, Math.round((scanProgress.scanned / scanProgress.total) * 100))
      : null;
  const totalFiles = files.length;
  const filteredCount = sortedFiles.length;

  useEffect(() => {
    syncScrollHints(fileListScrollRef.current, fileListFrameRef.current);
  }, [
    syncScrollHints,
    viewMode,
    effectiveGroupMode,
    listDensity,
    renderCount,
    filteredCount,
    collapsedGroups,
    collapsedFolders,
    isLoading,
    isExtensionsCollapsed,
  ]);

  useEffect(() => {
    syncScrollHints(previewScrollRef.current, previewFrameRef.current);
  }, [
    syncScrollHints,
    previewFile?.id,
    isLoading,
    archiveStatus,
    officePreviewStatus,
    archiveEntries.length,
  ]);
  const folderLabel = currentFolder ? formatPathLabel(currentFolder) : "No folder selected";
  const folderSizeBytes = useMemo(
    () => files.reduce((total, file) => total + file.sizeBytes, 0),
    [files]
  );

  return (
    <div className={`app-shell ${isLoading ? "is-loading" : ""} ${isSidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="titlebar-drag" data-tauri-drag-region />
      {isSidebarCollapsed && (
        <button
          type="button"
          className="icon-button sidebar-toggle floating-toggle"
          onClick={() => setIsSidebarCollapsed((prev) => !prev)}
          aria-label="Show sidebar"
          aria-controls="sidebar-panel"
          aria-pressed={isSidebarCollapsed}
          title="Show sidebar"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="24" height="24">
            <path d="M9 5.5 16 12 9 18.5V5.5Z" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="icon-button settings-button app-settings-button"
        onClick={() => setIsSettingsOpen(true)}
        aria-label="Open settings"
        aria-haspopup="dialog"
        aria-expanded={isSettingsOpen}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="24" height="24">
          <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.02 7.02 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.57.23-1.12.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.61 7.86a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.4 1.05.71 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.57-.23 1.12-.54 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
        </svg>
      </button>
      {isDrawerMode && !isSidebarCollapsed && (
        <div className="drawer-backdrop" aria-hidden="true" onClick={() => setIsSidebarCollapsed(true)} />
      )}
      <div className="app-grid">
        {!isSidebarCollapsed && (
          <aside className="list-panel" id="sidebar-panel">
            <div className="list-top-controls">
              <button
                type="button"
                className="icon-button sidebar-toggle"
                onClick={() => setIsSidebarCollapsed((prev) => !prev)}
                aria-label={isSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                aria-controls="sidebar-panel"
                aria-pressed={isSidebarCollapsed}
                title={isSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="24" height="24">
                  {isSidebarCollapsed ? (
                    <path d="M9 5.5 16 12 9 18.5V5.5Z" />
                  ) : (
                    <path d="M15 5.5 8 12l7 6.5V5.5Z" />
                  )}
                </svg>
              </button>
              <div className="searchbar-controls" role="group" aria-label="Folder search controls">
                <button
                  type="button"
                  className="pill-button"
                  onClick={pickFolder}
                  disabled={isLoading}
                  title={currentFolder ?? "No folder selected"}
                >
                  <span className="pill-label">Folder</span>
                  <span className="pill-value">{currentFolder ? folderLabel : "Select folder…"}</span>
                </button>
                <div className="toolbar-control">
                  <select
                    value={filterMode}
                    onChange={(event) => setFilterMode(event.target.value as FilterMode)}
                    disabled={isLoading}
                  >
                    {FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="icon-button search-button"
                  onClick={() => handleScan(currentFolder ?? undefined)}
                  disabled={isLoading || !currentFolder}
                  aria-label="Scan folder"
                  title="Scan folder"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M15.5 14h-.79l-.28-.27a6 6 0 1 0-.71.71l.27.28v.79L20 20.5 21.5 19l-6-5zM10 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="list-header">
              <div className="list-header-top">
                <div className="list-title">
                  <span>Files</span>
                  <span className="badge badge-text">{totalFiles}</span>
                </div>
                <div className="list-header-actions">
                  {viewMode === "tree" && (
                    <button
                      type="button"
                      className="list-expand-button"
                      onClick={toggleAllFolders}
                      disabled={!hasFolders || isLoading}
                      data-prevent-open-on-enter
                      title={hasCollapsedFolders ? "Expand all folders" : "Collapse all folders"}
                    >
                      {hasCollapsedFolders ? "Expand all" : "Collapse all"}
                    </button>
                  )}
                  {isRenderingList && <span className="rendering">Rendering list...</span>}
                </div>
              </div>
              <div className="list-header-controls">
                <div className="toolbar-control">
                  <span className="control-label">Sort</span>
                  <select
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value as SortMode)}
                    disabled={isLoading}
                  >
                    <option value="none">None</option>
                    <option value="name_asc">Name (A-Z)</option>
                    <option value="name_desc">Name (Z-A)</option>
                    <option value="size_desc">Size (Largest)</option>
                    <option value="size_asc">Size (Smallest)</option>
                    <option value="date_desc">Date (Newest)</option>
                    <option value="date_asc">Date (Oldest)</option>
                    <option value="type_asc">Type (A-Z)</option>
                    <option value="type_desc">Type (Z-A)</option>
                    <option value="extension_asc">Extension (A-Z)</option>
                    <option value="extension_desc">Extension (Z-A)</option>
                  </select>
                </div>
                <div className="toolbar-control">
                  <span className="control-label">Group</span>
                  <select
                    value={displayGroupMode}
                    onChange={(event) => setGroupMode(event.target.value as GroupMode)}
                    disabled={isLoading || isDuplicateFilter}
                  >
                    <option value="none">None</option>
                    <option value="type">Type</option>
                    <option value="extension">Extension</option>
                    {isDuplicateFilter && <option value="duplicates">Duplicate sets</option>}
                  </select>
                </div>
                <div className="toolbar-control">
                  <span className="control-label">View</span>
                  <select
                    value={viewMode}
                    onChange={(event) => setViewMode(event.target.value as ViewMode)}
                    disabled={isLoading}
                  >
                    <option value="tree">Tree</option>
                    <option value="list">List</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="file-list-frame scroll-hints" ref={fileListFrameRef}>
              <div
                ref={fileListScrollRef}
                className={`file-list ${isLoading ? "loading" : ""} ${
                  listDensity === "compact" ? "density-compact" : "density-comfortable"
                }`}
              >
                {hasFiles ? (
                  listItems
                ) : isLoading ? (
                  <div className="skeleton-list" aria-hidden="true">
                    {Array.from({ length: 8 }).map((_, index) => (
                      <div key={`skeleton-${index}`} className="skeleton-item" />
                    ))}
                  </div>
                ) : (
                  <div className="empty">
                    {totalFiles === 0 ? "No files loaded." : "No files match the selected extensions."}
                  </div>
                )}
                {isRenderingList && <div className="list-progress">Showing {renderCount} of {filteredCount}</div>}
              </div>
            </div>
            <div className="list-footer">
              <div className="list-footer-header">
                <div className="footer-title">Extensions</div>
                <button
                  type="button"
                  className="icon-button extensions-toggle"
                  onClick={() => setIsExtensionsCollapsed((prev) => !prev)}
                  aria-label={isExtensionsCollapsed ? "Expand extensions" : "Collapse extensions"}
                  aria-pressed={isExtensionsCollapsed}
                  title={isExtensionsCollapsed ? "Expand extensions" : "Collapse extensions"}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    {isExtensionsCollapsed ? (
                      <path d="M6 15l6-6 6 6H6Z" />
                    ) : (
                      <path d="M6 9l6 6 6-6H6Z" />
                    )}
                  </svg>
                </button>
              </div>
              {!isExtensionsCollapsed && (
                <>
                  {allExtensions.length === 0 ? (
                    <div className="extensions-empty">No extensions found.</div>
                  ) : (
                    <>
                      <div className="extensions-controls">
                        <label className="extension-filter extension-toggle">
                          <input
                            ref={selectAllRef}
                            type="checkbox"
                            checked={allExtensionsSelected}
                            onChange={(event) => {
                              hasUserAdjustedExtensionsRef.current = true;
                              setSelectedExtensions(event.target.checked ? allExtensions : []);
                            }}
                            disabled={isLoading}
                          />
                          <span>All</span>
                        </label>
                      </div>
                      <div className="extension-filters">
                        {allExtensions.map((extension) => (
                          <label key={extension} className="extension-filter">
                            <input
                              type="checkbox"
                              checked={selectedExtensions.includes(extension)}
                              onChange={() => {
                                hasUserAdjustedExtensionsRef.current = true;
                                setSelectedExtensions((current) =>
                                  current.includes(extension)
                                    ? current.filter((value) => value !== extension)
                                    : [...current, extension]
                                );
                              }}
                              disabled={isLoading}
                            />
                            <span>{formatExtensionLabel(extension)}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </aside>
        )}

        <main className="content">
          <div className="preview-frame scroll-hints" ref={previewFrameRef}>
            <section className="preview-panel" ref={previewScrollRef}>
          {isLoading ? (
            <div className="loading-state">
              <div className="spinner" />
              <div className="loading-title">Scanning files</div>
              <div className="loading-subtitle">{loadingMessage ?? "Collecting file list..."}</div>
            </div>
          ) : previewFile ? (
            <div className="preview-content">
              <div className="preview-layout">
                <div className="preview-media" onWheel={handlePreviewWheel}>
                  {isMediaPreview && (
                    <div
                      className={`preview-zoom${previewFile.kind === "image" ? " is-draggable" : ""}${
                        isPreviewPanning ? " is-panning" : ""
                      }`}
                      style={{
                        transform:
                          previewFile.kind === "image"
                            ? `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`
                            : `scale(${previewZoom})`,
                      }}
                      onPointerDown={handlePreviewPanStart}
                      onPointerMove={handlePreviewPanMove}
                      onPointerUp={handlePreviewPanEnd}
                      onPointerCancel={handlePreviewPanEnd}
                    >
                      {previewFile.kind === "image" && (
                        <img
                          src={buildMediaUrl(previewFile.id)}
                          alt={previewFile.name}
                          draggable={false}
                          onDragStart={(event) => event.preventDefault()}
                        />
                      )}
                      {previewFile.kind === "video" && (
                        <video ref={videoRef} controls src={buildMediaUrl(previewFile.id)} />
                      )}
                    </div>
                  )}
                  {isAudioPreview && (
                    <audio controls src={buildMediaUrl(previewFile.id)} />
                  )}
                  {isDocumentPreview && (
                    <div className="preview-document">
                      <iframe
                        title={`Preview of ${previewFile.name}`}
                        src={buildMediaUrl(previewFile.id)}
                      />
                    </div>
                  )}
                  {isOfficePreview && (
                    <div className="preview-office">
                      <div className="preview-office-preview">
                        {officePreviewStatus === "loading" && (
                          <div className="preview-office-status">Generating preview...</div>
                        )}
                        {officePreviewStatus === "error" && (
                          <div className="preview-office-status">Preview unavailable.</div>
                        )}
                        {officePreviewStatus === "idle" && officePreviewId && (
                          <img
                            src={buildMediaUrl(officePreviewId)}
                            alt={`Preview of ${previewFile.name}`}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  {isArchivePreview && (
                    <div className="preview-archive">
                      <div className="preview-archive-header">
                        <div className="preview-archive-title">Archive contents</div>
                        {archiveStatus === "loading" && (
                          <div className="preview-archive-status">Loading...</div>
                        )}
                      </div>
                      {archiveStatus === "error" && (
                        <div className="preview-archive-status">
                          {archiveError ?? "Preview unavailable for this archive."}
                        </div>
                      )}
                      {archiveStatus === "idle" && (
                        <>
                          {archiveEntries.length > 0 ? (
                            <ul className="preview-archive-list">
                              {archiveEntries.map((entry, index) => (
                                <li key={`${entry}-${index}`} className="preview-archive-item">
                                  {entry}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="preview-archive-empty">No entries found.</div>
                          )}
                          {archiveTruncated && (
                            <div className="preview-archive-note">
                              Showing first {archiveEntries.length} items.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {isFallbackPreview && (
                    <div className="preview-fallback">
                      <div className="preview-fallback-icon">
                        {previewExtension === "none" ? "FILE" : previewExtension.toUpperCase()}
                      </div>
                      <div className="preview-fallback-label">
                        {formatKindLabel(previewFile.kind)}
                      </div>
                      <div className="preview-fallback-hint">No rich preview available.</div>
                    </div>
                  )}
                </div>
                <div className="preview-actions">
                  <button
                    type="button"
                    className="preview-action-button"
                    onClick={() => void openFileInSystem(previewFile)}
                  >
                    Open file
                  </button>
                  <div className="preview-zoom-controls">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={handleZoomOut}
                      disabled={!isZoomablePreview}
                      aria-label="Zoom out"
                      title="Zoom out"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M5 11h14v2H5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="icon-button preview-zoom-reset"
                      onClick={handleZoomReset}
                      disabled={!isZoomablePreview}
                      aria-label="Reset zoom"
                      title="Reset zoom"
                    >
                      <span className="preview-zoom-value">
                        {Math.round(previewZoom * 100)}%
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={handleZoomIn}
                      disabled={!isZoomablePreview}
                      aria-label="Zoom in"
                      title="Zoom in"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="caption" aria-hidden="true" />
                <aside className="preview-details" aria-label="File details">
                  <div className="file-meta">
                    <div>
                      <span className="meta-label">Name</span>
                      <span className="meta-value">{previewFile.name}</span>
                    </div>
                    <div>
                      <span className="meta-label">Type</span>
                      <span className="meta-value">{formatKindLabel(previewFile.kind)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Extension</span>
                      <span className="meta-value">
                        {previewExtension === "none" ? "None" : `.${previewExtension}`}
                      </span>
                    </div>
                    <div>
                      <span className="meta-label">MIME</span>
                      <span className="meta-value">{previewFile.mime}</span>
                    </div>
                    <div>
                      <span className="meta-label">Size</span>
                      <span className="meta-value">{formatBytes(previewFile.sizeBytes)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Modified</span>
                      <span className="meta-value">{formatTimestamp(previewFile.modifiedMs)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Folder</span>
                      <span className="meta-value">{extractFolder(previewFile.path)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Folder size</span>
                      <span className="meta-value">{formatBytes(folderSizeBytes)}</span>
                    </div>
                    <div>
                      <span className="meta-label">Full path</span>
                      <span className="meta-value mono">{previewFile.path}</span>
                    </div>
                    <div>
                      <span className="meta-label">Position</span>
                      <span className="meta-value">
                        {previewIndex + 1} of {filteredCount}
                      </span>
                    </div>
                    <div>
                      <span className="meta-label">ID</span>
                      <span className="meta-value mono">{previewFile.id}</span>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          ) : (
            <div className="preview-message">
              <div className="placeholder">Select a folder to preview files.</div>
            </div>
          )}
            </section>
          </div>
        </main>

        <footer className="actions">
          <div className="actions-row">
            <div className="destination-row" aria-label="Move destinations">
              {destinationSlots.map((destinationPath, index) => (
                <button
                  key={`destination-${index}`}
                  type="button"
                  className={`destination-button ${destinationPath ? "is-set" : "is-empty"}`}
                  onClick={() => void pickDestinationForSlot(index)}
                  disabled={isLoading}
                  title={destinationPath ?? `Set destination ${index + 1}`}
                  aria-label={`Set destination ${index + 1}`}
                >
                  <span className="destination-index">{index + 1}</span>
                  <span className="destination-label">
                    {destinationPath ? formatPathLabel(destinationPath) : "Set folder…"}
                  </span>
                </button>
              ))}
            </div>
            <div className="action-row">
              <button
                className="action-button action-prev"
                type="button"
                onClick={goPrev}
                disabled={!hasFiles || currentIndex === 0 || isLoading}
              >
                Prev ←
              </button>
              <button
                className="action-button action-undo"
                type="button"
                onClick={undoLastAction}
                disabled={undoStack.length === 0 || isLoading}
              >
                Undo ↓
              </button>
              <button
                className="action-button action-next"
                type="button"
                onClick={goNext}
                disabled={!hasFiles || currentIndex >= filteredCount - 1 || isLoading}
              >
                Next →
              </button>
              <button
                className="action-button action-trash"
                type="button"
                onClick={trashCurrent}
                disabled={!hasFiles || isLoading}
              >
                Trash ↑
              </button>
            </div>
          </div>
        </footer>
      </div>

      {isSettingsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-header">
              <h2 id="settings-title" className="modal-title">
                Settings
              </h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Close settings"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Filter mode</div>
                  <div className="setting-subtitle">Choose which files appear in the list.</div>
                </div>
                <select
                  value={filterMode}
                  onChange={(event) => setFilterMode(event.target.value as FilterMode)}
                  disabled={isLoading}
                >
                  {FILTER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Include subfolders</div>
                  <div className="setting-subtitle">Scan nested directories when choosing a folder.</div>
                </div>
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={includeSubfolders}
                    onChange={(event) => setIncludeSubfolders(event.target.checked)}
                    disabled={isLoading}
                  />
                  <span>{includeSubfolders ? "On" : "Off"}</span>
                </label>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Include hidden items</div>
                  <div className="setting-subtitle">Show dotfiles and hidden folders in scans.</div>
                </div>
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={includeHidden}
                    onChange={(event) => setIncludeHidden(event.target.checked)}
                    disabled={isLoading}
                  />
                  <span>{includeHidden ? "On" : "Off"}</span>
                </label>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Trash alert</div>
                  <div className="setting-subtitle">Show a confirmation dialog before deleting.</div>
                </div>
                <label className={`setting-toggle${confirmTrash ? "" : " is-warning"}`}>
                  <input
                    type="checkbox"
                    checked={confirmTrash}
                    onChange={(event) => setConfirmTrash(event.target.checked)}
                    disabled={isLoading}
                  />
                  <span>{confirmTrash ? "On" : "Off"}</span>
                </label>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">List density</div>
                  <div className="setting-subtitle">Control how compact the file list appears.</div>
                </div>
                <select
                  value={listDensity}
                  onChange={(event) => setListDensity(event.target.value as DensityMode)}
                  disabled={isLoading}
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </div>
              <div className="settings-row">
                <div className="setting-info">
                  <div className="setting-title">Dark mode</div>
                  <div className="setting-subtitle">Switch to a darker color palette.</div>
                </div>
                <label className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={theme === "dark"}
                    onChange={(event) => setTheme(event.target.checked ? "dark" : "light")}
                    disabled={isLoading}
                  />
                  <span>{theme === "dark" ? "On" : "Off"}</span>
                </label>
              </div>
            </div>
            <div className="modal-footer modal-footer-settings">
              <button type="button" className="help-button" onClick={() => setIsHelpOpen(true)}>
                Help & Shortcuts
              </button>
              <button type="button" onClick={() => setIsSettingsOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      {isHelpOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsHelpOpen(false);
            }
          }}
        >
          <div className="modal-panel help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
            <div className="modal-header">
              <h2 id="help-title" className="modal-title">
                Help & Shortcuts
              </h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsHelpOpen(false)}
                aria-label="Close help"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z" />
                </svg>
              </button>
            </div>
            <div className="modal-body help-body">
              <div className="help-grid">
                <section className="help-section">
                  <h3 className="help-section-title">Quick Start</h3>
                  <ul className="help-list">
                    <li>Select a folder, then click the search icon to scan it.</li>
                    <li>Pick a filter mode to focus on images, docs, or other file types.</li>
                    <li>Click a file to preview it; double-click to reveal it in your file manager.</li>
                    <li>Use the extensions list to narrow the scan to specific suffixes.</li>
                  </ul>
                </section>
                <section className="help-section">
                  <h3 className="help-section-title">Views & Sorting</h3>
                  <ul className="help-list">
                    <li>Sort by name, size, date, type, or extension.</li>
                    <li>Group the list by type or extension, then collapse sections as needed.</li>
                    <li>Switch between list and tree views to browse folders.</li>
                    <li>Use the expand-all toggle when browsing tree view folders.</li>
                  </ul>
                </section>
                <section className="help-section">
                  <h3 className="help-section-title">Preview & Details</h3>
                  <ul className="help-list">
                    <li>Images and videos support zoom controls and smooth zooming.</li>
                    <li>Drag to pan images and use the zoom reset to snap back.</li>
                    <li>Text, PDF, Office, and archive previews render when available.</li>
                    <li>Use Open file to launch the file in its default app.</li>
                  </ul>
                </section>
                <section className="help-section">
                  <h3 className="help-section-title">Move & Clean Up</h3>
                  <ul className="help-list">
                    <li>Set destination slots 1-5 to move files with one click.</li>
                    <li>Use Prev and Next to step through the list quickly.</li>
                    <li>Trash removes the current file; Undo restores the last action.</li>
                    <li>In tree view, trash an entire folder from its trash button.</li>
                  </ul>
                </section>
                <section className="help-section">
                  <h3 className="help-section-title">Settings</h3>
                  <ul className="help-list">
                    <li>Include subfolders to scan nested directories.</li>
                    <li>Include hidden items to scan dotfiles and hidden folders.</li>
                    <li>Toggle trash confirmation and switch between light and dark mode.</li>
                    <li>Adjust list density for a roomier or compact list.</li>
                  </ul>
                </section>
                <section className="help-section help-section-wide">
                  <h3 className="help-section-title">Shortcuts</h3>
                  <div className="help-shortcuts">
                    <div className="help-shortcut">
                      <span className="help-key">Arrow Left</span>
                      <span>Previous file</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">Arrow Right</span>
                      <span>Next file</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">Arrow Up</span>
                      <span>Trash current file</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">Arrow Down</span>
                      <span>Undo last action</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">Enter</span>
                      <span>Reveal in file manager</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">1-5</span>
                      <span>Move to destination slot</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">Space</span>
                      <span>Play or pause video</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">Ctrl + Scroll</span>
                      <span>Zoom images and videos</span>
                    </div>
                    <div className="help-shortcut">
                      <span className="help-key">Esc</span>
                      <span>Close settings or help</span>
                    </div>
                  </div>
                </section>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setIsHelpOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
