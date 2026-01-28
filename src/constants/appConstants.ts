import type {
  DensityMode,
  ExtensionFilterMode,
  FilterMode,
  GroupMode,
  SortMode,
  TrashBehavior,
  ViewMode,
} from "../types";

export const MAX_UNDO_STACK = 20;
export const PREVIEW_DELAY_MS = 120;
export const OFFICE_PREVIEW_EXTENSIONS = ["doc", "docx", "xlsx", "ppt", "pptx", "key", "odp"];
export const LARGE_PREVIEW_SIZE_BYTES = 50 * 1024 * 1024;
export const COMMON_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "heic",
  "heif",
  "webp",
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "txt",
  "md",
  "csv",
  "json",
  "mp3",
  "wav",
  "mp4",
  "mov",
  "mkv",
  "zip",
  "rar",
]);
export const SCROLL_HINT_TOLERANCE = 6;
export const CRASH_REPORT_EMAIL = "<placeholder>@info.com";
export const MAX_CRASH_EMAIL_BODY = 4000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const EVENT_LOOP_POLL_MS = 1000;
export const EVENT_LOOP_LAG_WARN_MS = 500;
export const OFFICE_PREVIEW_DEBOUNCE_MS = 500;
export const ARCHIVE_PREVIEW_DEBOUNCE_MS = 250;
export const DESTINATION_SLOT_COUNT = 5;
export const SETTINGS_KEY = "tidy-settings";
export const TREE_INDENT_PX = 16;

export const FILTER_MODES: FilterMode[] = [
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

export const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
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

export const SORT_MODES: SortMode[] = [
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

export const GROUP_MODES: GroupMode[] = ["none", "type", "extension", "duplicates"];
export const DENSITY_MODES: DensityMode[] = ["comfortable", "compact"];
export const VIEW_MODES: ViewMode[] = ["tree", "list"];
export const EXTENSION_FILTER_MODES: ExtensionFilterMode[] = ["all", "remember", "common"];
export const TRASH_BEHAVIORS: TrashBehavior[] = ["system", "permanent"];

export const DUPLICATE_MIN_SIZE_OPTIONS = [
  { value: 0, label: "Any size" },
  { value: 1024 * 1024, label: "1 MB+" },
  { value: 5 * 1024 * 1024, label: "5 MB+" },
  { value: 20 * 1024 * 1024, label: "20 MB+" },
  { value: 100 * 1024 * 1024, label: "100 MB+" },
];
