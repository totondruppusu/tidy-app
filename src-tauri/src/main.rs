use image::ImageReader;
use mime_guess::MimeGuess;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::backtrace::Backtrace;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::http::header::{HeaderMap, HeaderName, HeaderValue};
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;
use bzip2::read::BzDecoder;
use flate2::read::GzDecoder;
use tar::Archive;
use xz2::read::XzDecoder;
use zip::ZipArchive;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FileKind {
  Image,
  Video,
  Audio,
  Docs,
  Text,
  Compressed,
  Executable,
  Binary,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
  id: String,
  name: String,
  kind: FileKind,
  path: String,
  size_bytes: u64,
  modified_ms: Option<u64>,
  mime: String,
  duplicate_group: Option<String>,
}

#[derive(Clone)]
struct IndexedCandidate {
  path: PathBuf,
  path_display: String,
  name: String,
  kind: FileKind,
  size_bytes: u64,
  modified_ms: Option<u64>,
  mime: Option<String>,
}

#[derive(Clone)]
struct DuplicateCandidate {
  path: PathBuf,
  size_bytes: u64,
  modified_ms: Option<u64>,
}

#[derive(Clone, Copy)]
struct LumaPixel {
  value: u8,
  alpha: u8,
}

struct DecodedImage {
  width: usize,
  height: usize,
  pixels: Vec<LumaPixel>,
}

struct EdgeMap {
  width: usize,
  height: usize,
  sums: Vec<u32>,
}

struct CountMap {
  width: usize,
  height: usize,
  sums: Vec<u32>,
}

#[derive(Default)]
struct TextBandStats {
  groups: usize,
  wide_groups: usize,
  max_active_cells: usize,
}

#[derive(Default)]
struct IndexStore {
  folder_path: Option<String>,
  files: Vec<FileEntry>,
  by_id: HashMap<String, FileEntry>,
  sorted_ids_by_mode: HashMap<String, Vec<String>>,
}

#[derive(Default, Serialize, Deserialize)]
struct HashCache {
  entries: HashMap<String, HashCacheEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashCacheEntry {
  hash: String,
  size_bytes: u64,
  modified_ms: Option<u64>,
  hashed_ms: u64,
}

struct AppState {
  map: Mutex<HashMap<String, PathBuf>>,
  index: Mutex<IndexStore>,
  hash_cache: Mutex<HashCache>,
  hash_cache_path: PathBuf,
  preview_map: Mutex<HashMap<String, String>>,
  destination: Mutex<Option<PathBuf>>,
  scan_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
  trash_dir: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
  id: String,
  started_ms: u64,
  last_heartbeat_ms: u64,
  clean_shutdown: bool,
  app_name: String,
  app_version: String,
  os: String,
  arch: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivitySnapshot {
  timestamp_ms: u64,
  status: Option<String>,
  current_folder: Option<String>,
  is_loading: bool,
  is_mutating: bool,
  is_cancelling_scan: bool,
  scan_id: Option<String>,
  scan_phase: Option<String>,
  scan_scanned: Option<u64>,
  scan_matched: Option<u64>,
  scan_total: Option<u64>,
  mutation_label: Option<String>,
  event_loop_lag_ms: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrashReport {
  id: String,
  created_ms: u64,
  message: String,
  location: Option<String>,
  thread: Option<String>,
  backtrace: Option<String>,
  app_name: String,
  app_version: String,
  os: String,
  arch: String,
  report_path: String,
  last_activity: Option<ActivitySnapshot>,
  last_heartbeat_ms: Option<u64>,
}

static TRASH_CLEANED: AtomicBool = AtomicBool::new(false);

const MAX_ARCHIVE_ENTRIES: usize = 200;
const MAX_RANGE_CHUNK_BYTES: u64 = 1_048_576;
const QLMANAGE_TIMEOUT_SECS: u64 = 10;
const WINDOWS_OFFICE_PREVIEW_TIMEOUT_SECS: u64 = 20;
const QLMANAGE_POLL_MS: u64 = 100;
const MAX_UNDO_STACK: usize = 20;
const OPERATION_HISTORY_FILE: &str = "operation-history.jsonl";
const UNDO_ACTIONS_FILE: &str = "undo-actions.json";
const APPLIED_BATCHES_DIR: &str = "applied-batches";
const HASH_CACHE_FILE: &str = "hash-cache.json";
const SCAN_CACHE_DIR: &str = "scan-cache";
const PARTIAL_HASH_BYTES: usize = 65_536;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderTrashItemPayload {
  file: FileEntry,
  relative_path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum UndoActionPayload {
  #[serde(rename = "move")]
  Move {
    file: FileEntry,
    #[serde(rename = "fromPath")]
    from_path: String,
    #[serde(rename = "toPath")]
    to_path: String,
  },
  #[serde(rename = "trash")]
  Trash {
    file: FileEntry,
    #[serde(rename = "fromPath")]
    from_path: String,
    #[serde(rename = "trashPath")]
    trash_path: String,
  },
  #[serde(rename = "trash-folder")]
  TrashFolder {
    #[serde(rename = "folderPath")]
    folder_path: String,
    #[serde(rename = "trashPath")]
    trash_path: String,
    items: Vec<FolderTrashItemPayload>,
  },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationJournalEntry {
  id: String,
  timestamp_ms: u64,
  operation: String,
  status: String,
  mode: Option<String>,
  source: Option<String>,
  destination: Option<String>,
  safety_level: Option<String>,
  message: Option<String>,
  rollback: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationHistoryPage {
  entries: Vec<OperationJournalEntry>,
  next_cursor: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCapabilities {
  platform: String,
  text_preview: bool,
  pdf_preview: bool,
  media_preview: bool,
  archive_preview: bool,
  office_rich_preview: bool,
  office_fallback_preview: bool,
  notes: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanIssue {
  code: String,
  message: String,
  path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanStats {
  indexed: usize,
  matched: usize,
  duplicate_groups: usize,
  duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResultV2 {
  files: Vec<FileEntry>,
  total: usize,
  stats: ScanStats,
  issues: Vec<ScanIssue>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRequestV2 {
  folder_path: String,
  filter_mode: String,
  include_subfolders: bool,
  include_hidden: bool,
  use_hash_for_duplicates: bool,
  duplicate_min_size_bytes: u64,
  scan_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanCacheRequest {
  folder_path: String,
  filter_mode: String,
  include_subfolders: bool,
  include_hidden: bool,
  use_hash_for_duplicates: bool,
  duplicate_min_size_bytes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedScan {
  folder_path: String,
  filter_mode: String,
  include_subfolders: bool,
  include_hidden: bool,
  use_hash_for_duplicates: bool,
  duplicate_min_size_bytes: u64,
  cached_at_ms: u64,
  files: Vec<FileEntry>,
  total: usize,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HydrateCachedScanRequest {
  folder_path: String,
  files: Vec<FileEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum SafetyLevel {
  Safe,
  Review,
  Manual,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionReason {
  code: String,
  message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Suggestion {
  id: String,
  action_type: String,
  source_path: String,
  destination_path: Option<String>,
  safety_level: SafetyLevel,
  reclaimable_bytes: u64,
  reason: SuggestionReason,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionSet {
  generated_ms: u64,
  folder_path: String,
  total_reclaimable_bytes: u64,
  suggestions: Vec<Suggestion>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionsRequest {
  folder_path: String,
  include_subfolders: bool,
  include_hidden: bool,
  max_results: Option<usize>,
  min_large_file_bytes: Option<u64>,
  stale_days: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionBatchItem {
  id: String,
  action_type: String,
  source_path: String,
  destination_path: Option<String>,
  safety_level: Option<String>,
  reason: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionBatchRequest {
  actions: Vec<ActionBatchItem>,
  allow_unsafe: Option<bool>,
  dry_run: Option<bool>,
  allow_permanent_delete: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionResult {
  id: String,
  status: String,
  message: String,
  undoable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionBatchResult {
  batch_id: String,
  dry_run: bool,
  applied: usize,
  blocked: usize,
  failed: usize,
  results: Vec<ActionResult>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoBatchAction {
  action_type: String,
  source_path: String,
  rollback_source: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoBatchRecord {
  batch_id: String,
  created_ms: u64,
  actions: Vec<UndoBatchAction>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UndoBatchResult {
  batch_id: String,
  restored: usize,
  failed: usize,
  messages: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficeFallbackPreview {
  mode: String,
  title: String,
  excerpt: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct ScanResult {
  files: Vec<FileEntry>,
  total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveResult {
  new_name: String,
  target_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashResult {
  trash_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchivePreview {
  entries: Vec<String>,
  truncated: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderTrashEntry {
  id: String,
  relative_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
  scan_id: String,
  scanned: usize,
  matched: usize,
  total: usize,
  phase: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanBatch {
  scan_id: String,
  files: Vec<FileEntry>,
}

fn emit_scan_progress(
  window: &tauri::Window,
  scan_id: &str,
  scanned: usize,
  matched: usize,
  total: usize,
  phase: &str,
) {
  let _ = window.emit(
    "scan_progress",
    ScanProgress {
      scan_id: scan_id.to_string(),
      scanned,
      matched,
      total,
      phase: phase.to_string(),
    },
  );
}

fn build_scan_entries_for_candidates(
  chunk: &[IndexedCandidate],
  filter: &str,
  duplicate_groups: Option<&HashMap<PathBuf, String>>,
  cancel_flag: &Arc<AtomicBool>,
) -> Vec<(FileEntry, PathBuf)> {
  chunk
    .par_iter()
    .filter_map(|candidate| {
      if cancel_flag.load(Ordering::Relaxed) {
        return None;
      }
      let duplicate_group = duplicate_groups
        .and_then(|duplicates| duplicates.get(&candidate.path).cloned());
      let is_match = if duplicate_groups.is_some() {
        duplicate_group.is_some()
      } else {
        matches_candidate_filter(filter, candidate)
      };
      if !is_match {
        return None;
      }

      let id = Uuid::new_v4().to_string();
      let entry = FileEntry {
        id,
        name: candidate.name.clone(),
        kind: candidate.kind.clone(),
        path: candidate.path_display.clone(),
        size_bytes: candidate.size_bytes,
        modified_ms: candidate.modified_ms,
        mime: resolve_mime_type(candidate),
        duplicate_group,
      };
      Some((entry, candidate.path.clone()))
    })
    .collect()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryIndexRequest {
  filter_mode: Option<String>,
  selected_extensions: Option<Vec<String>>,
  sort_mode: Option<String>,
  group_mode: Option<String>,
  offset: Option<usize>,
  limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupCount {
  key: String,
  count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryIndexResult {
  files: Vec<FileEntry>,
  total: usize,
  offset: usize,
  limit: usize,
  groups: Vec<GroupCount>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexStats {
  folder_path: Option<String>,
  total: usize,
  extensions: Vec<GroupCount>,
  duplicate_groups: usize,
}

#[derive(Clone, Copy)]
enum TrashMode {
  System,
  Permanent,
}

fn parse_trash_mode(value: &str) -> TrashMode {
  match value {
    "permanent" => TrashMode::Permanent,
    _ => TrashMode::System,
  }
}

fn get_extension(name: &str) -> String {
  let Some(last_dot) = name.rfind('.') else {
    return "none".to_string();
  };
  if last_dot == 0 || last_dot == name.len() - 1 {
    return "none".to_string();
  }
  name[last_dot + 1..].to_lowercase()
}

fn kind_rank(kind: &FileKind) -> usize {
  match kind {
    FileKind::Image => 0,
    FileKind::Video => 1,
    FileKind::Audio => 2,
    FileKind::Docs => 3,
    FileKind::Text => 4,
    FileKind::Compressed => 5,
    FileKind::Executable => 6,
    FileKind::Binary => 7,
  }
}

fn compare_file_entries(a: &FileEntry, b: &FileEntry, sort_mode: &str) -> std::cmp::Ordering {
  let compare_name = || a.name.to_lowercase().cmp(&b.name.to_lowercase());
  match sort_mode {
    "none" => a.id.cmp(&b.id),
    "name_desc" => compare_name().reverse(),
    "size_desc" => b.size_bytes.cmp(&a.size_bytes).then_with(compare_name),
    "size_asc" => a.size_bytes.cmp(&b.size_bytes).then_with(compare_name),
    "date_desc" => b.modified_ms.unwrap_or(0).cmp(&a.modified_ms.unwrap_or(0)).then_with(compare_name),
    "date_asc" => a.modified_ms.unwrap_or(0).cmp(&b.modified_ms.unwrap_or(0)).then_with(compare_name),
    "type_desc" => kind_rank(&b.kind).cmp(&kind_rank(&a.kind)).then_with(compare_name),
    "type_asc" => kind_rank(&a.kind).cmp(&kind_rank(&b.kind)).then_with(compare_name),
    "extension_desc" => get_extension(&b.name).cmp(&get_extension(&a.name)).then_with(compare_name),
    "extension_asc" => get_extension(&a.name).cmp(&get_extension(&b.name)).then_with(compare_name),
    _ => compare_name(),
  }
}

fn index_group_key(mode: &str, file: &FileEntry) -> String {
  match mode {
    "extension" => get_extension(&file.name),
    "duplicates" => file.duplicate_group.clone().unwrap_or_else(|| file.id.clone()),
    "type" => format!("{:?}", kind_rank(&file.kind)),
    _ => "all".to_string(),
  }
}

impl IndexStore {
  fn replace(&mut self, folder_path: String, files: Vec<FileEntry>) {
    self.folder_path = Some(folder_path);
    self.by_id = files
      .iter()
      .map(|file| (file.id.clone(), file.clone()))
      .collect();
    self.files = files;
    self.rebuild_sorted_indexes();
  }

  fn remove(&mut self, id: &str) {
    self.by_id.remove(id);
    self.files.retain(|file| file.id != id);
    self.sorted_ids_by_mode
      .values_mut()
      .for_each(|ids| ids.retain(|value| value != id));
  }

  fn remove_path(&mut self, path: &Path) {
    let path = path.to_string_lossy().to_string();
    let removed_ids = self
      .files
      .iter()
      .filter(|file| file.path == path)
      .map(|file| file.id.clone())
      .collect::<Vec<_>>();
    self.remove_many(removed_ids.iter().map(|id| id.as_str()));
  }

  fn remove_subtree(&mut self, path: &Path) {
    let prefix = path.to_string_lossy().to_string();
    let nested_prefix = format!("{}/", prefix);
    let removed_ids = self
      .files
      .iter()
      .filter(|file| file.path == prefix || file.path.starts_with(&nested_prefix))
      .map(|file| file.id.clone())
      .collect::<Vec<_>>();
    self.remove_many(removed_ids.iter().map(|id| id.as_str()));
  }

  fn remove_many<'a>(&mut self, ids: impl Iterator<Item = &'a str>) {
    let removed = ids.map(|id| id.to_string()).collect::<std::collections::HashSet<_>>();
    if removed.is_empty() {
      return;
    }
    removed.iter().for_each(|id| {
      self.by_id.remove(id);
    });
    self.files.retain(|file| !removed.contains(file.id.as_str()));
    self.sorted_ids_by_mode
      .values_mut()
      .for_each(|sorted_ids| sorted_ids.retain(|id| !removed.contains(id)));
  }

  fn upsert(&mut self, file: FileEntry) {
    self.by_id.insert(file.id.clone(), file);
    self.files = self.by_id.values().cloned().collect();
    self.rebuild_sorted_indexes();
  }

  fn rebuild_sorted_indexes(&mut self) {
    self.sorted_ids_by_mode.clear();
    for mode in [
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
    ] {
      let mut list = self.files.clone();
      list.sort_by(|a, b| compare_file_entries(a, b, mode));
      self.sorted_ids_by_mode.insert(mode.to_string(), list.into_iter().map(|file| file.id).collect());
    }
  }

  fn query(&self, request: QueryIndexRequest) -> QueryIndexResult {
    let filter = request.filter_mode.unwrap_or_else(|| "all".to_string());
    let sort = request.sort_mode.unwrap_or_else(|| "name_asc".to_string());
    let group = request.group_mode.unwrap_or_else(|| "none".to_string());
    let offset = request.offset.unwrap_or(0);
    let limit = request.limit.unwrap_or(200).clamp(1, 2_000);
    let selected_extensions = request
      .selected_extensions
      .map(|extensions| extensions.into_iter().collect::<std::collections::HashSet<_>>());
    let ids = self
      .sorted_ids_by_mode
      .get(&sort)
      .or_else(|| self.sorted_ids_by_mode.get("name_asc"));
    let mut matched = Vec::new();
    let mut groups = HashMap::<String, usize>::new();
    for id in ids.into_iter().flatten() {
      let Some(file) = self.by_id.get(id) else {
        continue;
      };
      if filter == "duplicates" && file.duplicate_group.is_none() {
        continue;
      }
      if !matches_file_filter(&filter, &file.name, &file.path, &file.kind) {
        continue;
      }
      if let Some(extensions) = selected_extensions.as_ref() {
        if !extensions.contains(&get_extension(&file.name)) {
          continue;
        }
      }
      *groups.entry(index_group_key(&group, file)).or_insert(0) += 1;
      matched.push(file.clone());
    }
    let total = matched.len();
    let files = matched.into_iter().skip(offset).take(limit).collect();
    let mut groups = groups
      .into_iter()
      .map(|(key, count)| GroupCount { key, count })
      .collect::<Vec<_>>();
    groups.sort_by(|a, b| a.key.cmp(&b.key));
    QueryIndexResult {
      files,
      total,
      offset,
      limit,
      groups,
    }
  }

  fn stats(&self) -> IndexStats {
    let mut extensions = HashMap::<String, usize>::new();
    let mut duplicate_groups = std::collections::HashSet::<String>::new();
    for file in &self.files {
      *extensions.entry(get_extension(&file.name)).or_insert(0) += 1;
      if let Some(group) = file.duplicate_group.as_ref() {
        duplicate_groups.insert(group.clone());
      }
    }
    let mut extensions = extensions
      .into_iter()
      .map(|(key, count)| GroupCount { key, count })
      .collect::<Vec<_>>();
    extensions.sort_by(|a, b| a.key.cmp(&b.key));
    IndexStats {
      folder_path: self.folder_path.clone(),
      total: self.files.len(),
      extensions,
      duplicate_groups: duplicate_groups.len(),
    }
  }
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64
}

fn history_file_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
  app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|dir| dir.join(OPERATION_HISTORY_FILE))
}

fn undo_actions_file_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
  app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|dir| dir.join(UNDO_ACTIONS_FILE))
}

fn batch_record_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
  app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|dir| dir.join(APPLIED_BATCHES_DIR))
}

fn hash_cache_file_path(app_data_dir: &Path) -> PathBuf {
  app_data_dir.join(HASH_CACHE_FILE)
}

fn scan_cache_dir(app_data_dir: &Path) -> PathBuf {
  app_data_dir.join(SCAN_CACHE_DIR)
}

fn scan_cache_key(request: &ScanCacheRequest) -> String {
  let payload = format!(
    "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
    request.folder_path,
    request.filter_mode,
    request.include_subfolders,
    request.include_hidden,
    request.use_hash_for_duplicates,
    request.duplicate_min_size_bytes
  );
  let mut hasher = Sha256::new();
  hasher.update(payload.as_bytes());
  format!("{:x}", hasher.finalize())
}

fn scan_cache_file_path(app_data_dir: &Path, request: &ScanCacheRequest) -> PathBuf {
  scan_cache_dir(app_data_dir).join(format!("{}.json", scan_cache_key(request)))
}

fn load_hash_cache(path: &Path) -> HashCache {
  fs::read_to_string(path)
    .ok()
    .and_then(|data| serde_json::from_str(&data).ok())
    .unwrap_or_default()
}

fn store_hash_cache(path: &Path, cache: &HashCache) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string(cache).map_err(|error| error.to_string())?;
  fs::write(path, serialized).map_err(|error| error.to_string())
}

fn load_cached_scan(path: &Path) -> Option<CachedScan> {
  fs::read_to_string(path)
    .ok()
    .and_then(|contents| serde_json::from_str(&contents).ok())
}

fn store_cached_scan(path: &Path, cached_scan: &CachedScan) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized =
    serde_json::to_string(cached_scan).map_err(|error| error.to_string())?;
  fs::write(path, serialized).map_err(|error| error.to_string())
}

fn modified_ms_from_metadata(metadata: &fs::Metadata) -> Option<u64> {
  metadata
    .modified()
    .ok()
    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis() as u64)
}

fn hash_cache_key(path: &Path, size_bytes: u64, modified_ms: Option<u64>) -> String {
  format!(
    "{}|{}|{}",
    path.to_string_lossy(),
    size_bytes,
    modified_ms.unwrap_or(0)
  )
}

fn preview_cache_key(path: &Path, size_bytes: u64, modified_ms: Option<u64>) -> String {
  let mut hasher = Sha256::new();
  hasher.update(hash_cache_key(path, size_bytes, modified_ms).as_bytes());
  format!("{:x}", hasher.finalize())
}

fn cached_full_hash(candidate: &DuplicateCandidate, cache: &HashCache) -> Option<String> {
  let key = hash_cache_key(&candidate.path, candidate.size_bytes, candidate.modified_ms);
  let entry = cache.entries.get(&key)?;
  if entry.size_bytes == candidate.size_bytes && entry.modified_ms == candidate.modified_ms {
    return Some(entry.hash.clone());
  }
  None
}

fn insert_cached_full_hash(candidate: &DuplicateCandidate, hash: String, cache: &mut HashCache) {
  let key = hash_cache_key(&candidate.path, candidate.size_bytes, candidate.modified_ms);
  cache.entries.insert(
    key,
    HashCacheEntry {
      hash,
      size_bytes: candidate.size_bytes,
      modified_ms: candidate.modified_ms,
      hashed_ms: now_ms(),
    },
  );
}

fn append_operation_journal(
  app_handle: &AppHandle,
  operation: &str,
  status: &str,
  mode: Option<String>,
  source: Option<String>,
  destination: Option<String>,
  safety_level: Option<String>,
  message: Option<String>,
  rollback: Option<serde_json::Value>,
) -> Result<String, String> {
  let history_path = history_file_path(app_handle)?;
  if let Some(parent) = history_path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let entry_id = Uuid::new_v4().to_string();
  let entry = OperationJournalEntry {
    id: entry_id.clone(),
    timestamp_ms: now_ms(),
    operation: operation.to_string(),
    status: status.to_string(),
    mode,
    source,
    destination,
    safety_level,
    message,
    rollback,
  };
  let serialized = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
  let mut file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&history_path)
    .map_err(|error| error.to_string())?;
  file
    .write_all(serialized.as_bytes())
    .map_err(|error| error.to_string())?;
  file.write_all(b"\n").map_err(|error| error.to_string())?;
  file.sync_all().ok();
  Ok(entry_id)
}

fn load_operation_history(app_handle: &AppHandle) -> Result<Vec<OperationJournalEntry>, String> {
  let history_path = history_file_path(app_handle)?;
  if !history_path.exists() {
    return Ok(Vec::new());
  }
  let contents = fs::read_to_string(history_path).map_err(|error| error.to_string())?;
  let mut entries = Vec::new();
  for line in contents.lines() {
    if line.trim().is_empty() {
      continue;
    }
    if let Ok(entry) = serde_json::from_str::<OperationJournalEntry>(line) {
      entries.push(entry);
    }
  }
  entries.reverse();
  Ok(entries)
}

fn load_recent_undo_actions(app_handle: &AppHandle) -> Result<Vec<UndoActionPayload>, String> {
  let path = undo_actions_file_path(app_handle)?;
  if !path.exists() {
    return Ok(Vec::new());
  }
  let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
  serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn store_recent_undo_actions_internal(
  app_handle: &AppHandle,
  mut actions: Vec<UndoActionPayload>,
) -> Result<(), String> {
  if actions.len() > MAX_UNDO_STACK {
    actions.truncate(MAX_UNDO_STACK);
  }
  let path = undo_actions_file_path(app_handle)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string_pretty(&actions).map_err(|error| error.to_string())?;
  fs::write(path, serialized).map_err(|error| error.to_string())
}

fn is_path_in_subtree(path: &Path, root: &Path) -> bool {
  let path = path.components().collect::<Vec<_>>();
  let root = root.components().collect::<Vec<_>>();
  if root.len() > path.len() {
    return false;
  }
  root.iter().zip(path.iter()).all(|(a, b)| a == b)
}

fn protected_path_reason(path: &Path) -> Option<String> {
  let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
  if cfg!(target_os = "macos") {
    let protected_roots = ["/System", "/Library", "/Applications"];
    for root in protected_roots {
      if is_path_in_subtree(&canonical, Path::new(root)) {
        return Some(format!("{} is protected by safety policy", root));
      }
    }
  }
  if cfg!(target_os = "windows") {
    let lower = canonical.to_string_lossy().to_lowercase();
    let protected_patterns = [
      "\\windows",
      "\\program files",
      "\\program files (x86)",
      "\\programdata",
      "\\$recycle.bin",
      "\\system volume information",
    ];
    if protected_patterns.iter().any(|pattern| lower.contains(pattern)) {
      return Some("Windows system path is protected by safety policy".to_string());
    }
  }
  let lower = canonical.to_string_lossy().to_lowercase();
  if lower.contains("/.trash") || lower.contains("\\$recycle.bin") {
    return Some("Recycle bins are protected by safety policy".to_string());
  }
  None
}

fn ensure_safe_path(path: &Path, allow_unsafe: bool) -> Result<(), String> {
  if allow_unsafe {
    return Ok(());
  }
  if let Some(reason) = protected_path_reason(path) {
    return Err(format!("Blocked by safety policy: {}", reason));
  }
  Ok(())
}

fn ensure_existing_path(path: &Path, allow_unsafe: bool) -> Result<(), String> {
  if !path.exists() {
    return Err("Path does not exist.".into());
  }
  ensure_safe_path(path, allow_unsafe)
}

fn ensure_destination_writable(destination: &Path, allow_unsafe: bool) -> Result<(), String> {
  if let Some(parent) = destination.parent() {
    ensure_safe_path(parent, allow_unsafe)?;
    if !parent.exists() {
      fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let probe_path = parent.join(format!(".tidy-write-check-{}", Uuid::new_v4()));
    OpenOptions::new()
      .create_new(true)
      .write(true)
      .open(&probe_path)
      .map_err(|error| format!("Destination is not writable: {}", error))?;
    let _ = fs::remove_file(probe_path);
  }
  Ok(())
}

fn partial_hash_file(path: &Path) -> Result<String, String> {
  let mut file = File::open(path).map_err(|error| error.to_string())?;
  let metadata = file.metadata().map_err(|error| error.to_string())?;
  let size = metadata.len() as usize;
  let mut hasher = Sha256::new();

  let mut start_buf = vec![0u8; std::cmp::min(PARTIAL_HASH_BYTES, size)];
  if !start_buf.is_empty() {
    file.read_exact(&mut start_buf).map_err(|error| error.to_string())?;
    hasher.update(&start_buf);
  }
  if size > PARTIAL_HASH_BYTES {
    let end_len = std::cmp::min(PARTIAL_HASH_BYTES, size - PARTIAL_HASH_BYTES);
    file
      .seek(SeekFrom::End(-(end_len as i64)))
      .map_err(|error| error.to_string())?;
    let mut end_buf = vec![0u8; end_len];
    file.read_exact(&mut end_buf).map_err(|error| error.to_string())?;
    hasher.update(&end_buf);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

fn decode_xml_entities(value: &str) -> String {
  value
    .replace("&amp;", "&")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&apos;", "'")
}

fn extract_text_from_xml(xml: &str) -> String {
  let mut in_tag = false;
  let mut output = String::new();
  for character in xml.chars() {
    match character {
      '<' => {
        in_tag = true;
        output.push(' ');
      }
      '>' => in_tag = false,
      _ if !in_tag => output.push(character),
      _ => {}
    }
  }
  decode_xml_entities(&output)
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn extract_text_from_binary_office(data: &[u8]) -> String {
  fn push_candidate(parts: &mut Vec<String>, candidate: &mut String) {
    let normalized = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() >= 4 {
      parts.push(normalized);
    }
    candidate.clear();
  }

  let mut parts = Vec::new();
  let mut ascii = String::new();
  let mut utf16 = String::new();

  for &byte in data {
    if byte.is_ascii_graphic() || byte == b' ' {
      ascii.push(byte as char);
      continue;
    }
    if ascii.len() >= 4 {
      push_candidate(&mut parts, &mut ascii);
    } else {
      ascii.clear();
    }
  }
  if ascii.len() >= 4 {
    push_candidate(&mut parts, &mut ascii);
  }

  for offset in 0..=1 {
    utf16.clear();
    for chunk in data[offset..].chunks_exact(2) {
      let value = u16::from_le_bytes([chunk[0], chunk[1]]);
      let ch = char::from_u32(value as u32);
      if let Some(ch) = ch {
        if !ch.is_control() && !matches!(ch, '\u{fffd}' | '\u{feff}') {
          utf16.push(ch);
          continue;
        }
        if ch == '\n' || ch == '\r' || ch == '\t' {
          utf16.push(' ');
          continue;
        }
      }
      if utf16.chars().count() >= 4 {
        push_candidate(&mut parts, &mut utf16);
      } else {
        utf16.clear();
      }
    }
    if utf16.chars().count() >= 4 {
      push_candidate(&mut parts, &mut utf16);
    }
  }

  parts.join("\n")
}

fn read_zip_entry_to_string(archive: &mut ZipArchive<File>, name: &str) -> Result<Option<String>, String> {
  let mut entry = match archive.by_name(name) {
    Ok(entry) => entry,
    Err(_) => return Ok(None),
  };
  let mut data = String::new();
  entry
    .read_to_string(&mut data)
    .map_err(|error| error.to_string())?;
  Ok(Some(data))
}

fn extract_office_fallback(path: &Path) -> Result<OfficeFallbackPreview, String> {
  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("")
    .to_lowercase();
  let title = path
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("Office file")
    .to_string();
  let excerpt = match extension.as_str() {
    "docx" | "xlsx" | "pptx" | "odp" => {
      let file = File::open(path).map_err(|error| error.to_string())?;
      let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
      let xml_sources: Vec<&str> = match extension.as_str() {
        "docx" => vec!["word/document.xml"],
        "xlsx" => vec!["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"],
        "pptx" => vec!["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml"],
        "odp" => vec!["content.xml"],
        _ => Vec::new(),
      };
      let mut parts = Vec::new();
      for source in xml_sources {
        if let Some(xml) = read_zip_entry_to_string(&mut archive, source)? {
          let text = extract_text_from_xml(&xml);
          if !text.is_empty() {
            parts.push(text);
          }
        }
      }
      if parts.is_empty() {
        return Err("Could not extract readable fallback text.".into());
      }
      parts.join("\n\n")
    }
    "doc" | "xls" | "ppt" => {
      let data = fs::read(path).map_err(|error| error.to_string())?;
      let extracted = extract_text_from_binary_office(&data);
      if extracted.is_empty() {
        return Err("Could not extract readable fallback text.".into());
      }
      extracted
    }
    _ => return Err("No fallback extractor for this file type.".into()),
  };
  let excerpt = excerpt.chars().take(5000).collect::<String>();
  Ok(OfficeFallbackPreview {
    mode: "text-fallback".to_string(),
    title,
    excerpt,
  })
}

fn clear_trash_dir(trash_dir: &Path) -> std::io::Result<()> {
  if !trash_dir.exists() {
    return Ok(());
  }
  for entry in fs::read_dir(trash_dir)? {
    let entry = entry?;
    let file_type = entry.file_type()?;
    let entry_path = entry.path();
    if file_type.is_dir() {
      fs::remove_dir_all(entry_path)?;
    } else {
      fs::remove_file(entry_path)?;
    }
  }
  Ok(())
}

fn clear_trash_dir_best_effort(trash_dir: &Path) {
  if let Err(error) = clear_trash_dir(trash_dir) {
    eprintln!(
      "Failed to clear trash directory {}: {}",
      trash_dir.display(),
      error
    );
  }
}

fn crash_report_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
  app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|dir| dir.join("crash-reports"))
}

fn crash_report_pointer_path(report_dir: &Path) -> PathBuf {
  report_dir.join("last_crash.json")
}

fn session_file_path(report_dir: &Path) -> PathBuf {
  report_dir.join("last_session.json")
}

fn activity_file_path(report_dir: &Path) -> PathBuf {
  report_dir.join("last_activity.json")
}

fn store_crash_report(report_dir: &Path, report: &CrashReport) -> Result<(), String> {
  fs::create_dir_all(report_dir).map_err(|error| error.to_string())?;
  let report_path = PathBuf::from(&report.report_path);
  let serialized = serde_json::to_string_pretty(report).map_err(|error| error.to_string())?;
  let mut report_file = File::create(&report_path).map_err(|error| error.to_string())?;
  report_file
    .write_all(serialized.as_bytes())
    .map_err(|error| error.to_string())?;
  report_file.sync_all().ok();
  let pointer_path = crash_report_pointer_path(report_dir);
  let mut pointer_file = File::create(&pointer_path).map_err(|error| error.to_string())?;
  pointer_file
    .write_all(serialized.as_bytes())
    .map_err(|error| error.to_string())?;
  pointer_file.sync_all().ok();
  Ok(())
}

fn load_last_crash_report(report_dir: &Path) -> Option<CrashReport> {
  let pointer_path = crash_report_pointer_path(report_dir);
  let contents = fs::read_to_string(pointer_path).ok()?;
  serde_json::from_str(&contents).ok()
}

fn store_activity_snapshot(report_dir: &Path, snapshot: &ActivitySnapshot) -> Result<(), String> {
  fs::create_dir_all(report_dir).map_err(|error| error.to_string())?;
  let serialized = serde_json::to_string_pretty(snapshot).map_err(|error| error.to_string())?;
  let path = activity_file_path(report_dir);
  let mut file = File::create(&path).map_err(|error| error.to_string())?;
  file
    .write_all(serialized.as_bytes())
    .map_err(|error| error.to_string())?;
  file.sync_all().ok();
  Ok(())
}

fn load_activity_snapshot(report_dir: &Path) -> Option<ActivitySnapshot> {
  let path = activity_file_path(report_dir);
  let contents = fs::read_to_string(path).ok()?;
  serde_json::from_str(&contents).ok()
}

fn store_session_info(report_dir: &Path, session: &SessionInfo) -> Result<(), String> {
  fs::create_dir_all(report_dir).map_err(|error| error.to_string())?;
  let serialized = serde_json::to_string_pretty(session).map_err(|error| error.to_string())?;
  let path = session_file_path(report_dir);
  let mut file = File::create(&path).map_err(|error| error.to_string())?;
  file
    .write_all(serialized.as_bytes())
    .map_err(|error| error.to_string())?;
  file.sync_all().ok();
  Ok(())
}

fn load_session_info(report_dir: &Path) -> Option<SessionInfo> {
  let path = session_file_path(report_dir);
  let contents = fs::read_to_string(path).ok()?;
  serde_json::from_str(&contents).ok()
}

fn create_unclean_shutdown_report(report_dir: &Path, session: &SessionInfo) -> Result<(), String> {
  let report_id = Uuid::new_v4().to_string();
  let last_activity = load_activity_snapshot(report_dir);
  let report_path = report_dir.join(format!("crash-{}.json", report_id));
  let report = CrashReport {
    id: report_id,
    created_ms: session.last_heartbeat_ms.max(session.started_ms),
    message: "Previous session ended unexpectedly (force quit or hang).".to_string(),
    location: None,
    thread: None,
    backtrace: None,
    app_name: session.app_name.clone(),
    app_version: session.app_version.clone(),
    os: session.os.clone(),
    arch: session.arch.clone(),
    report_path: report_path.to_string_lossy().to_string(),
    last_activity,
    last_heartbeat_ms: Some(session.last_heartbeat_ms),
  };
  store_crash_report(report_dir, &report)
}

fn mark_session_clean_best_effort(app_handle: &AppHandle) {
  let report_dir = match crash_report_dir(app_handle) {
    Ok(dir) => dir,
    Err(_) => return,
  };
  let mut session = match load_session_info(&report_dir) {
    Some(session) => session,
    None => return,
  };
  let now_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64;
  session.clean_shutdown = true;
  session.last_heartbeat_ms = now_ms;
  let _ = store_session_info(&report_dir, &session);
}

fn install_panic_hook(crash_dir: PathBuf, app_name: String, app_version: String) {
  let default_hook = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |panic_info| {
    let last_activity = load_activity_snapshot(&crash_dir);
    let last_heartbeat_ms = load_session_info(&crash_dir).map(|session| session.last_heartbeat_ms);
    let report_id = Uuid::new_v4().to_string();
    let created_ms = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap_or_default()
      .as_millis() as u64;
    let message = if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
      (*message).to_string()
    } else if let Some(message) = panic_info.payload().downcast_ref::<String>() {
      message.clone()
    } else {
      "Unknown panic".to_string()
    };
    let location = panic_info
      .location()
      .map(|location| format!("{}:{}", location.file(), location.line()));
    let thread = std::thread::current().name().map(|name| name.to_string());
    let backtrace = Some(Backtrace::force_capture().to_string());
    let report_path = crash_dir.join(format!("crash-{}.json", report_id));
    let report = CrashReport {
      id: report_id,
      created_ms,
      message,
      location,
      thread,
      backtrace,
      app_name: app_name.clone(),
      app_version: app_version.clone(),
      os: std::env::consts::OS.to_string(),
      arch: std::env::consts::ARCH.to_string(),
      report_path: report_path.to_string_lossy().to_string(),
      last_activity,
      last_heartbeat_ms,
    };
    if let Err(error) = store_crash_report(&crash_dir, &report) {
      eprintln!("Failed to store crash report: {}", error);
    }
    default_hook(panic_info);
  }));
}

#[tauri::command]
fn set_destination(state: tauri::State<'_, AppState>, destination: String) {
  let mut dest = state.destination.lock().expect("destination lock");
  *dest = Some(PathBuf::from(destination));
}

#[tauri::command]
fn get_crash_report(app_handle: AppHandle) -> Result<Option<CrashReport>, String> {
  let report_dir = crash_report_dir(&app_handle)?;
  let pointer_path = crash_report_pointer_path(&report_dir);
  if !pointer_path.exists() {
    return Ok(None);
  }
  let contents = fs::read_to_string(&pointer_path).map_err(|error| error.to_string())?;
  let report = serde_json::from_str(&contents).map_err(|error| error.to_string())?;
  Ok(Some(report))
}

#[tauri::command]
fn clear_crash_report(app_handle: AppHandle) -> Result<(), String> {
  let report_dir = crash_report_dir(&app_handle)?;
  let pointer_path = crash_report_pointer_path(&report_dir);
  if pointer_path.exists() {
    fs::remove_file(pointer_path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn log_client_error(
  app_handle: AppHandle,
  message: String,
  stack: Option<String>,
) -> Result<(), String> {
  let report_dir = crash_report_dir(&app_handle)?;
  fs::create_dir_all(&report_dir).map_err(|error| error.to_string())?;
  let log_path = report_dir.join("client-errors.log");
  let mut file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|error| error.to_string())?;
  let created_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  let header = format!("{} | {}\n", created_ms, message);
  file
    .write_all(header.as_bytes())
    .map_err(|error| error.to_string())?;
  if let Some(stack) = stack {
    file
      .write_all(stack.as_bytes())
      .map_err(|error| error.to_string())?;
    file
      .write_all(b"\n")
      .map_err(|error| error.to_string())?;
  }
  file
    .write_all(b"---\n")
    .map_err(|error| error.to_string())?;
  file.sync_all().ok();
  Ok(())
}

#[tauri::command]
fn get_operation_history(
  app_handle: AppHandle,
  cursor: Option<usize>,
  limit: Option<usize>,
) -> Result<OperationHistoryPage, String> {
  let entries = load_operation_history(&app_handle)?;
  let start = cursor.unwrap_or(0);
  let page_size = limit.unwrap_or(50).clamp(1, 200);
  let paged = entries
    .iter()
    .skip(start)
    .take(page_size)
    .cloned()
    .collect::<Vec<_>>();
  let next_cursor = if start + paged.len() < entries.len() {
    Some(start + paged.len())
  } else {
    None
  };
  Ok(OperationHistoryPage {
    entries: paged,
    next_cursor,
  })
}

#[tauri::command]
fn get_recent_undo_actions(app_handle: AppHandle) -> Result<Vec<UndoActionPayload>, String> {
  load_recent_undo_actions(&app_handle)
}

#[tauri::command]
fn store_recent_undo_actions(
  app_handle: AppHandle,
  actions: Vec<UndoActionPayload>,
) -> Result<(), String> {
  store_recent_undo_actions_internal(&app_handle, actions)
}

#[tauri::command]
fn get_preview_capabilities() -> PreviewCapabilities {
  let mut notes = Vec::new();
  let office_rich = cfg!(target_os = "macos")
    || (cfg!(target_os = "windows") && detect_windows_libreoffice().is_some());
  if cfg!(target_os = "windows") {
    if office_rich {
      notes.push(
        "Windows Office preview uses LibreOffice to generate a cached PDF preview.".to_string(),
      );
    } else {
      notes.push(
        "Install LibreOffice to enable rich Office previews on Windows; text fallback is used otherwise."
          .to_string(),
      );
    }
  } else if !office_rich {
    notes.push("Rich Office preview is unavailable on this platform; text fallback is used.".to_string());
  }
  PreviewCapabilities {
    platform: std::env::consts::OS.to_string(),
    text_preview: true,
    pdf_preview: true,
    media_preview: true,
    archive_preview: true,
    office_rich_preview: office_rich,
    office_fallback_preview: true,
    notes,
  }
}

#[tauri::command]
fn get_cached_scan(
  app_handle: AppHandle,
  request: ScanCacheRequest,
) -> Result<Option<CachedScan>, String> {
  let app_data_dir = app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())?;
  let path = scan_cache_file_path(&app_data_dir, &request);
  Ok(load_cached_scan(&path))
}

#[tauri::command]
fn store_cached_scan_result(
  app_handle: AppHandle,
  request: ScanCacheRequest,
  result: ScanResult,
) -> Result<(), String> {
  let app_data_dir = app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())?;
  let path = scan_cache_file_path(&app_data_dir, &request);
  let cached_at_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64;
  let cached_scan = CachedScan {
    folder_path: request.folder_path,
    filter_mode: request.filter_mode,
    include_subfolders: request.include_subfolders,
    include_hidden: request.include_hidden,
    use_hash_for_duplicates: request.use_hash_for_duplicates,
    duplicate_min_size_bytes: request.duplicate_min_size_bytes,
    cached_at_ms,
    files: result.files,
    total: result.total,
  };
  store_cached_scan(&path, &cached_scan)
}

#[tauri::command]
fn hydrate_cached_scan(
  state: tauri::State<'_, AppState>,
  request: HydrateCachedScanRequest,
) -> Result<(), String> {
  let next_map = request
    .files
    .iter()
    .map(|file| (file.id.clone(), PathBuf::from(&file.path)))
    .collect::<HashMap<_, _>>();
  {
    let mut map = state.map.lock().expect("map lock");
    *map = next_map;
  }
  {
    let mut index = state.index.lock().expect("index lock");
    index.replace(request.folder_path, request.files);
  }
  state
    .preview_map
    .lock()
    .expect("preview map lock")
    .clear();
  Ok(())
}

#[tauri::command]
fn update_heartbeat(
  app_handle: AppHandle,
  activity: Option<ActivitySnapshot>,
) -> Result<(), String> {
  let report_dir = crash_report_dir(&app_handle)?;
  let mut session = load_session_info(&report_dir).ok_or("Session not initialized")?;
  let now_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64;
  session.last_heartbeat_ms = now_ms;
  store_session_info(&report_dir, &session)?;
  if let Some(mut snapshot) = activity {
    if snapshot.timestamp_ms == 0 {
      snapshot.timestamp_ms = now_ms;
    }
    store_activity_snapshot(&report_dir, &snapshot)?;
  }
  Ok(())
}

#[tauri::command]
fn cancel_scan(state: tauri::State<'_, AppState>, scan_id: String) -> Result<(), String> {
  let cancellations = state
    .scan_cancellations
    .lock()
    .expect("scan cancellations lock");
  if let Some(flag) = cancellations.get(&scan_id) {
    flag.store(true, Ordering::Relaxed);
  }
  Ok(())
}

struct ScanCancelGuard {
  app_handle: AppHandle,
  scan_id: String,
}

impl ScanCancelGuard {
  fn new(app_handle: AppHandle, scan_id: String) -> Self {
    Self { app_handle, scan_id }
  }
}

impl Drop for ScanCancelGuard {
  fn drop(&mut self) {
    let state = self.app_handle.state::<AppState>();
    if let Ok(mut cancellations) = state.scan_cancellations.lock() {
      cancellations.remove(&self.scan_id);
    };
  }
}

#[tauri::command]
async fn scan_folder(
  window: tauri::Window,
  folder_path: String,
  filter_mode: String,
  include_subfolders: bool,
  include_hidden: bool,
  use_hash_for_duplicates: bool,
  duplicate_min_size_bytes: u64,
  scan_id: String,
) -> Result<ScanResult, String> {
  let app_handle = window.app_handle().clone();
  let window = window.clone();
  let cancel_flag = Arc::new(AtomicBool::new(false));
  {
    let state = app_handle.state::<AppState>();
    let mut cancellations = state
      .scan_cancellations
      .lock()
      .expect("scan cancellations lock");
    cancellations.insert(scan_id.clone(), cancel_flag.clone());
  }
  tauri::async_runtime::spawn_blocking(move || {
    let _cancel_guard = ScanCancelGuard::new(app_handle.clone(), scan_id.clone());
    let state = app_handle.state::<AppState>();
    let mut entries = Vec::new();
    {
      state.map.lock().expect("map lock").clear();
      state.preview_map.lock().expect("preview map lock").clear();
    }

    let folder = PathBuf::from(&folder_path);
    if !folder.exists() {
      return Err("Folder not found".into());
    }

    let filter = filter_mode.as_str();
    let is_duplicate_scan = filter == "duplicates";
    emit_scan_progress(&window, &scan_id, 0, 0, 0, "indexing");

    let mut candidates: Vec<IndexedCandidate> = Vec::new();
    let mut discovered = 0usize;
    let mut indexed = 0usize;
    let index_chunk_size = 1024usize;
    let scan_chunk_size = 1024usize;
    let mut scanned = 0usize;
    let mut last_emit = 0usize;
    let mut matched = 0usize;
    let mut batch = Vec::with_capacity(500);
    let mut next_map = HashMap::new();
    let mut pending_paths = Vec::with_capacity(index_chunk_size);

    let mut flush_index_chunk =
      |pending_paths: &mut Vec<PathBuf>, discovered_total: usize| -> Result<(), String> {
        if pending_paths.is_empty() {
          return Ok(());
        }
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }

        let chunk_paths = std::mem::take(pending_paths);
        let chunk_len = chunk_paths.len();
        let indexed_chunk: Vec<IndexedCandidate> =
          chunk_paths.into_par_iter().map(index_scan_candidate).collect();
        indexed += chunk_len;
        emit_scan_progress(&window, &scan_id, indexed, 0, discovered_total, "indexing");

        if is_duplicate_scan {
          candidates.extend(indexed_chunk);
          return Ok(());
        }

        let chunk_results = build_scan_entries_for_candidates(
          &indexed_chunk,
          filter,
          None,
          &cancel_flag,
        );
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }

        scanned += indexed_chunk.len();
        matched += chunk_results.len();
        for (entry, path) in chunk_results {
          next_map.insert(entry.id.clone(), path);
          entries.push(entry.clone());
          batch.push(entry);
          if batch.len() >= 500 {
            let _ = window.emit(
              "scan_batch",
              ScanBatch {
                scan_id: scan_id.clone(),
                files: std::mem::take(&mut batch),
              },
            );
          }
        }

        if scanned.saturating_sub(last_emit) >= scan_chunk_size {
          emit_scan_progress(&window, &scan_id, scanned, matched, 0, "scanning");
          last_emit = scanned;
        }
        Ok(())
      };

    if include_subfolders {
      for entry in WalkDir::new(&folder)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| include_hidden || !is_hidden_entry(entry.path(), &folder))
      {
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }
        let entry = match entry {
          Ok(entry) => entry,
          Err(_) => continue,
        };
        if !entry.file_type().is_file() {
          continue;
        }
        pending_paths.push(entry.path().to_path_buf());
        discovered += 1;
        if pending_paths.len() >= index_chunk_size {
          flush_index_chunk(&mut pending_paths, 0)?;
        }
      }
    } else {
      for entry in fs::read_dir(&folder).map_err(|error| error.to_string())? {
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }
        let entry = match entry {
          Ok(entry) => entry,
          Err(_) => continue,
        };
        let path = entry.path();
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
          continue;
        }
        if !include_hidden && is_hidden_entry(&path, &folder) {
          continue;
        }
        pending_paths.push(path);
        discovered += 1;
        if pending_paths.len() >= index_chunk_size {
          flush_index_chunk(&mut pending_paths, 0)?;
        }
      }
    }
    flush_index_chunk(&mut pending_paths, discovered)?;

    let total = discovered;
    if !is_duplicate_scan {
      emit_scan_progress(&window, &scan_id, scanned, matched, total, "scanning");
    }

    let duplicate_groups = if is_duplicate_scan {
      if cancel_flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
      let duplicate_candidates: Vec<DuplicateCandidate> = candidates
        .par_iter()
        .map(|candidate| DuplicateCandidate {
          path: candidate.path.clone(),
          size_bytes: candidate.size_bytes,
          modified_ms: candidate.modified_ms,
        })
        .collect();
      let mut hash_cache = state.hash_cache.lock().expect("hash cache lock");
      let groups = find_duplicate_groups_from_candidates_with_cache(
        &duplicate_candidates,
        use_hash_for_duplicates,
        duplicate_min_size_bytes,
        Some(&cancel_flag),
        Some(&mut hash_cache),
      )?;
      let _ = store_hash_cache(&state.hash_cache_path, &hash_cache);
      Some(groups)
    } else {
      None
    };
    if is_duplicate_scan {
      scanned = 0;
      last_emit = 0;
      matched = 0;
      for chunk in candidates.chunks(scan_chunk_size) {
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }
        let chunk_results = build_scan_entries_for_candidates(
          chunk,
          filter,
          duplicate_groups.as_ref(),
          &cancel_flag,
        );
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }

        scanned += chunk.len();
        matched += chunk_results.len();
        for (entry, path) in chunk_results {
          next_map.insert(entry.id.clone(), path);
          entries.push(entry.clone());
          batch.push(entry);
          if batch.len() >= 500 {
            let _ = window.emit(
              "scan_batch",
              ScanBatch {
                scan_id: scan_id.clone(),
                files: std::mem::take(&mut batch),
              },
            );
          }
        }

        if scanned.saturating_sub(last_emit) >= scan_chunk_size {
          emit_scan_progress(&window, &scan_id, scanned, matched, total, "scanning");
          last_emit = scanned;
        }
      }
    }

    entries.sort_by_cached_key(|entry| entry.name.to_lowercase());
    {
      let mut map = state.map.lock().expect("map lock");
      *map = next_map;
    }
    {
      let mut index = state.index.lock().expect("index lock");
      index.replace(folder_path.clone(), entries.clone());
    }

    if scanned != last_emit || matched > 0 {
      emit_scan_progress(&window, &scan_id, scanned, matched, total, "scanning");
    }
    if !batch.is_empty() {
      let _ = window.emit(
        "scan_batch",
        ScanBatch {
          scan_id: scan_id.clone(),
          files: batch,
        },
      );
    }
    let total = entries.len();
    Ok(ScanResult { files: entries, total })
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn scan_folder_v2(
  window: tauri::Window,
  request: ScanRequestV2,
) -> Result<ScanResultV2, String> {
  let started = Instant::now();
  let scan_id = request
    .scan_id
    .unwrap_or_else(|| Uuid::new_v4().to_string());
  let result = scan_folder(
    window,
    request.folder_path,
    request.filter_mode,
    request.include_subfolders,
    request.include_hidden,
    request.use_hash_for_duplicates,
    request.duplicate_min_size_bytes,
    scan_id,
  )
  .await?;
  let duplicate_groups = result
    .files
    .iter()
    .filter_map(|entry| entry.duplicate_group.clone())
    .collect::<std::collections::HashSet<_>>()
    .len();
  Ok(ScanResultV2 {
    total: result.total,
    stats: ScanStats {
      indexed: result.total,
      matched: result.files.len(),
      duplicate_groups,
      duration_ms: started.elapsed().as_millis() as u64,
    },
    files: result.files,
    issues: Vec::new(),
  })
}

#[tauri::command]
fn query_index(
  state: tauri::State<'_, AppState>,
  request: QueryIndexRequest,
) -> Result<QueryIndexResult, String> {
  let index = state.index.lock().expect("index lock");
  Ok(index.query(request))
}

#[tauri::command]
fn get_index_stats(state: tauri::State<'_, AppState>) -> Result<IndexStats, String> {
  let index = state.index.lock().expect("index lock");
  Ok(index.stats())
}

#[tauri::command]
fn get_file_by_id(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<Option<FileEntry>, String> {
  let index = state.index.lock().expect("index lock");
  Ok(index.by_id.get(&id).cloned())
}

#[tauri::command]
fn trash_file(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  id: String,
  trash_mode: String,
  allow_unsafe: Option<bool>,
) -> Result<TrashResult, String> {
  let allow_unsafe = allow_unsafe.unwrap_or(false);
  let mode = parse_trash_mode(&trash_mode);
  let mut map = state.map.lock().expect("map lock");
  let path = map.remove(&id).ok_or("File not found")?;
  if let Err(error) = ensure_existing_path(&path, allow_unsafe) {
    map.insert(id.clone(), path.clone());
    let _ = append_operation_journal(
      &app_handle,
      "trash_file",
      "blocked",
      Some(trash_mode.clone()),
      Some(path.to_string_lossy().to_string()),
      None,
      Some("safe".to_string()),
      Some(error.clone()),
      None,
    );
    return Err(error);
  }
  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid file name")?;
  match mode {
    TrashMode::System => {
      fs::create_dir_all(&state.trash_dir).map_err(|error| error.to_string())?;
      let target_path = unique_path(&state.trash_dir, file_name);
      fs::copy(&path, &target_path).map_err(|error| error.to_string())?;
      if let Err(error) = trash::delete(&path) {
        let _ = fs::remove_file(&target_path);
        map.insert(id, path.clone());
        let _ = append_operation_journal(
          &app_handle,
          "trash_file",
          "error",
          Some("system".to_string()),
          Some(path.to_string_lossy().to_string()),
          Some(target_path.to_string_lossy().to_string()),
          Some("safe".to_string()),
          Some(error.to_string()),
          None,
        );
        return Err(error.to_string());
      }
      let _ = append_operation_journal(
        &app_handle,
        "trash_file",
        "success",
        Some("system".to_string()),
        Some(path.to_string_lossy().to_string()),
        Some(target_path.to_string_lossy().to_string()),
        Some("safe".to_string()),
        None,
        Some(serde_json::json!({
          "rollbackSource": target_path.to_string_lossy().to_string(),
          "rollbackDestination": path.to_string_lossy().to_string(),
        })),
      );
      state.index.lock().expect("index lock").remove(&id);
      Ok(TrashResult {
        trash_path: Some(target_path.to_string_lossy().to_string()),
      })
    }
    TrashMode::Permanent => {
      if !allow_unsafe {
        map.insert(id, path.clone());
        let message = "Permanent delete requires advanced override.";
        let _ = append_operation_journal(
          &app_handle,
          "trash_file",
          "blocked",
          Some("permanent".to_string()),
          Some(path.to_string_lossy().to_string()),
          None,
          Some("manual".to_string()),
          Some(message.to_string()),
          None,
        );
        return Err(message.into());
      }
      fs::remove_file(&path).map_err(|error| error.to_string())?;
      let _ = append_operation_journal(
        &app_handle,
        "trash_file",
        "success",
        Some("permanent".to_string()),
        Some(path.to_string_lossy().to_string()),
        None,
        Some("manual".to_string()),
        None,
        None,
      );
      state.index.lock().expect("index lock").remove(&id);
      Ok(TrashResult { trash_path: None })
    }
  }
}

#[tauri::command]
fn trash_folder(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  folder_path: String,
  files: Vec<FolderTrashEntry>,
  trash_mode: String,
  allow_unsafe: Option<bool>,
) -> Result<TrashResult, String> {
  let allow_unsafe = allow_unsafe.unwrap_or(false);
  let mode = parse_trash_mode(&trash_mode);
  let source_path = PathBuf::from(folder_path.clone());
  if !source_path.exists() {
    return Err("Folder not found".into());
  }
  if !source_path.is_dir() {
    return Err("Target is not a folder".into());
  }
  ensure_safe_path(&source_path, allow_unsafe)?;
  let folder_name = source_path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid folder name")?;
  match mode {
    TrashMode::System => {
      fs::create_dir_all(&state.trash_dir).map_err(|error| error.to_string())?;
      let target_path = unique_path(&state.trash_dir, folder_name);
      copy_dir_recursive(&source_path, &target_path)?;
      if let Err(error) = trash::delete(&source_path) {
        let _ = fs::remove_dir_all(&target_path);
        let _ = append_operation_journal(
          &app_handle,
          "trash_folder",
          "error",
          Some("system".to_string()),
          Some(folder_path.clone()),
          Some(target_path.to_string_lossy().to_string()),
          Some("safe".to_string()),
          Some(error.to_string()),
          None,
        );
        return Err(error.to_string());
      }
      let mut map = state.map.lock().expect("map lock");
      files.iter().for_each(|entry| {
        map.remove(&entry.id);
      });
      state
        .index
        .lock()
        .expect("index lock")
        .remove_many(files.iter().map(|entry| entry.id.as_str()));
      let _ = append_operation_journal(
        &app_handle,
        "trash_folder",
        "success",
        Some("system".to_string()),
        Some(folder_path),
        Some(target_path.to_string_lossy().to_string()),
        Some("safe".to_string()),
        None,
        Some(serde_json::json!({
          "rollbackSource": target_path.to_string_lossy().to_string(),
          "rollbackDestination": source_path.to_string_lossy().to_string(),
          "fileCount": files.len()
        })),
      );
      Ok(TrashResult {
        trash_path: Some(target_path.to_string_lossy().to_string()),
      })
    }
    TrashMode::Permanent => {
      if !allow_unsafe {
        let _ = append_operation_journal(
          &app_handle,
          "trash_folder",
          "blocked",
          Some("permanent".to_string()),
          Some(folder_path),
          None,
          Some("manual".to_string()),
          Some("Permanent delete requires advanced override.".to_string()),
          None,
        );
        return Err("Permanent delete requires advanced override.".into());
      }
      fs::remove_dir_all(&source_path).map_err(|error| error.to_string())?;
      let mut map = state.map.lock().expect("map lock");
      files.iter().for_each(|entry| {
        map.remove(&entry.id);
      });
      state
        .index
        .lock()
        .expect("index lock")
        .remove_many(files.iter().map(|entry| entry.id.as_str()));
      let _ = append_operation_journal(
        &app_handle,
        "trash_folder",
        "success",
        Some("permanent".to_string()),
        Some(source_path.to_string_lossy().to_string()),
        None,
        Some("manual".to_string()),
        None,
        None,
      );
      Ok(TrashResult { trash_path: None })
    }
  }
}

#[tauri::command]
fn move_file(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  id: String,
  allow_unsafe: Option<bool>,
) -> Result<MoveResult, String> {
  let allow_unsafe = allow_unsafe.unwrap_or(false);
  let destination = state
    .destination
    .lock()
    .expect("destination lock")
    .clone()
    .ok_or("Destination not set")?;

  let mut map = state.map.lock().expect("map lock");
  let source = map.remove(&id).ok_or("File not found")?;
  if let Err(error) = ensure_existing_path(&source, allow_unsafe) {
    map.insert(id.clone(), source);
    return Err(error);
  }
  let file_name = source
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid file name")?;

  let target_path = unique_path(&destination, file_name);
  if let Err(error) = ensure_destination_writable(&target_path, allow_unsafe) {
    map.insert(id.clone(), source);
    return Err(error);
  }

  if let Err(error) = move_path(&source, &target_path) {
    map.insert(id, source);
    return Err(error);
  }

  let new_name = target_path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid target name")?
    .to_string();

  let _ = append_operation_journal(
    &app_handle,
    "move_file",
    "success",
    Some("move".to_string()),
    Some(source.to_string_lossy().to_string()),
    Some(target_path.to_string_lossy().to_string()),
    Some("safe".to_string()),
    None,
    Some(serde_json::json!({
      "rollbackSource": target_path.to_string_lossy().to_string(),
      "rollbackDestination": source.to_string_lossy().to_string(),
    })),
  );

  state.index.lock().expect("index lock").remove(&id);

  Ok(MoveResult {
    new_name,
    target_path: target_path.to_string_lossy().to_string(),
  })
}

#[tauri::command]
fn restore_file(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  id: String,
  source: String,
  destination: String,
  allow_unsafe: Option<bool>,
) -> Result<(), String> {
  let allow_unsafe = allow_unsafe.unwrap_or(false);
  let source_path = PathBuf::from(source);
  ensure_existing_path(&source_path, allow_unsafe)?;
  let destination_path = PathBuf::from(destination);
  if destination_path.exists() {
    return Err("Restore target already exists.".into());
  }
  ensure_destination_writable(&destination_path, allow_unsafe)?;
  move_path(&source_path, &destination_path)?;
  let destination_display = destination_path.to_string_lossy().to_string();
  let mut map = state.map.lock().expect("map lock");
  map.insert(id.clone(), destination_path.clone());
  state
    .index
    .lock()
    .expect("index lock")
    .upsert(file_entry_from_path(id, &destination_path));
  let _ = append_operation_journal(
    &app_handle,
    "restore_file",
    "success",
    Some("restore".to_string()),
    Some(source_path.to_string_lossy().to_string()),
    Some(destination_display),
    Some("safe".to_string()),
    None,
    None,
  );
  Ok(())
}

#[tauri::command]
fn restore_folder(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  source: String,
  destination: String,
  files: Vec<FolderTrashEntry>,
  allow_unsafe: Option<bool>,
) -> Result<(), String> {
  let allow_unsafe = allow_unsafe.unwrap_or(false);
  let source_path = PathBuf::from(source);
  ensure_existing_path(&source_path, allow_unsafe)?;
  let destination_path = PathBuf::from(destination);
  if destination_path.exists() {
    return Err("Restore target already exists.".into());
  }
  ensure_destination_writable(&destination_path, allow_unsafe)?;
  move_dir(&source_path, &destination_path)?;
  let mut map = state.map.lock().expect("map lock");
  let mut restored_files = Vec::new();
  files.iter().for_each(|entry| {
    let path = destination_path.join(&entry.relative_path);
    map.insert(entry.id.clone(), path.clone());
    restored_files.push(file_entry_from_path(entry.id.clone(), &path));
  });
  {
    let mut index = state.index.lock().expect("index lock");
    restored_files.into_iter().for_each(|file| index.upsert(file));
  }
  let _ = append_operation_journal(
    &app_handle,
    "restore_folder",
    "success",
    Some("restore".to_string()),
    Some(source_path.to_string_lossy().to_string()),
    Some(destination_path.to_string_lossy().to_string()),
    Some("safe".to_string()),
    None,
    None,
  );
  Ok(())
}

#[tauri::command]
async fn list_archive_entries(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<ArchivePreview, String> {
  let path = {
    let map = state.map.lock().expect("map lock");
    map.get(&id).cloned().ok_or("File not found")?
  };
  if !path.exists() {
    return Err("File not found".into());
  }

  tauri::async_runtime::spawn_blocking(move || match detect_archive_kind(&path) {
    Some(ArchiveKind::Zip) => list_zip_entries(&path),
    Some(ArchiveKind::Tar) => {
      let file = File::open(&path).map_err(|error| error.to_string())?;
      list_tar_entries(BufReader::new(file))
    }
    Some(ArchiveKind::TarGz) => {
      let file = File::open(&path).map_err(|error| error.to_string())?;
      list_tar_entries(GzDecoder::new(BufReader::new(file)))
    }
    Some(ArchiveKind::TarBz2) => {
      let file = File::open(&path).map_err(|error| error.to_string())?;
      list_tar_entries(BzDecoder::new(BufReader::new(file)))
    }
    Some(ArchiveKind::TarXz) => {
      let file = File::open(&path).map_err(|error| error.to_string())?;
      list_tar_entries(XzDecoder::new(BufReader::new(file)))
    }
    None => Err("Preview not available for this archive format.".into()),
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn extract_office_fallback_preview(
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<OfficeFallbackPreview, String> {
  let path = {
    let map = state.map.lock().expect("map lock");
    map.get(&id).cloned().ok_or("File not found")?
  };
  if !path.exists() {
    return Err("File not found".into());
  }
  tauri::async_runtime::spawn_blocking(move || extract_office_fallback(&path))
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn generate_preview(
  app: AppHandle,
  state: tauri::State<'_, AppState>,
  id: String,
) -> Result<String, String> {
  let source_path = {
    let map = state.map.lock().expect("map lock");
    map.get(&id).cloned().ok_or("File not found")?
  };
  if !source_path.exists() {
    return Err("File not found".into());
  }

  let existing_id = {
    let preview_map = state.preview_map.lock().expect("preview map lock");
    preview_map.get(&id).cloned()
  };
  if let Some(existing_id) = existing_id {
    let map = state.map.lock().expect("map lock");
    if let Some(existing_path) = map.get(&existing_id) {
      if existing_path.exists() {
        return Ok(existing_id);
      }
    }
  }

  let cache_dir = app.path().app_cache_dir().map_err(|error| error.to_string())?;
  let preview_root = cache_dir.join("previews");
  let metadata = fs::metadata(&source_path).map_err(|error| error.to_string())?;
  let preview_cache_root = preview_root.join("office-cache");
  let cached_preview_path = preview_cache_root.join(format!(
    "{}.pdf",
    preview_cache_key(
      &source_path,
      metadata.len(),
      modified_ms_from_metadata(&metadata),
    )
  ));
  if cached_preview_path.exists() {
    let preview_id = format!("preview:{}.pdf", Uuid::new_v4());
    {
      let mut map = state.map.lock().expect("map lock");
      map.insert(preview_id.clone(), cached_preview_path);
    }
    state
      .preview_map
      .lock()
      .expect("preview map lock")
      .insert(id, preview_id.clone());
    return Ok(preview_id);
  }
  let session_dir = preview_root.join(Uuid::new_v4().to_string());
  let source_path_clone = source_path.clone();
  let cached_preview_path_clone = cached_preview_path.clone();
  let preview_path = tauri::async_runtime::spawn_blocking(move || {
    fs::create_dir_all(&preview_root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&preview_cache_root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;
    run_platform_preview(&session_dir, &source_path_clone, Some(&cached_preview_path_clone))
  })
  .await
  .map_err(|error| error.to_string())??;

  let preview_extension = preview_path
    .extension()
    .and_then(|ext| ext.to_str())
    .unwrap_or("bin");
  let preview_id = format!("preview:{}.{}", Uuid::new_v4(), preview_extension);
  {
    let mut map = state.map.lock().expect("map lock");
    map.insert(preview_id.clone(), preview_path);
  }
  state
    .preview_map
    .lock()
    .expect("preview map lock")
    .insert(id, preview_id.clone());
  Ok(preview_id)
}

#[tauri::command]
fn reveal_in_file_manager(path: String, reveal: bool) -> Result<(), String> {
  let target = PathBuf::from(path);
  if !target.exists() {
    return Err("Path not found".into());
  }

  let status = if cfg!(target_os = "macos") {
    let mut cmd = Command::new("open");
    if reveal {
      cmd.arg("-R");
    }
    cmd.arg(&target).status()
  } else if cfg!(target_os = "windows") {
    let mut cmd = Command::new("explorer");
    if reveal {
      cmd.arg("/select,");
    }
    cmd.arg(&target).status()
  } else {
    let mut cmd = Command::new("xdg-open");
    let open_target = if reveal {
      target.parent().unwrap_or(&target).to_path_buf()
    } else {
      target
    };
    cmd.arg(open_target).status()
  };

  match status {
    Ok(status) if status.success() => Ok(()),
    Ok(status) => Err(format!("Could not open file manager (exit code {}).", status)),
    Err(error) => Err(format!("Could not open file manager: {}", error)),
  }
}

fn is_temp_or_cache_path(path: &Path) -> bool {
  let lower = path.to_string_lossy().to_lowercase();
  lower.contains("/tmp/")
    || lower.contains("\\temp\\")
    || lower.contains("/cache/")
    || lower.contains("\\cache\\")
}

fn is_downloads_or_installer(path: &Path) -> bool {
  let lower = path.to_string_lossy().to_lowercase();
  if lower.contains("/downloads/") || lower.contains("\\downloads\\") {
    return true;
  }
  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("")
    .to_lowercase();
  matches!(extension.as_str(), "exe" | "msi" | "dmg" | "pkg" | "zip" | "rar" | "7z")
}

fn file_age_days(path: &Path) -> Option<u64> {
  let modified = fs::metadata(path).ok()?.modified().ok()?;
  let elapsed = SystemTime::now().duration_since(modified).ok()?;
  Some(elapsed.as_secs() / 86_400)
}

fn collect_scan_paths(
  folder_path: &str,
  include_subfolders: bool,
  include_hidden: bool,
) -> Result<Vec<PathBuf>, String> {
  let folder = PathBuf::from(folder_path);
  if !folder.exists() {
    return Err("Folder not found".into());
  }
  if include_subfolders {
    Ok(
      WalkDir::new(&folder)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| include_hidden || !is_hidden_entry(entry.path(), &folder))
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.path().to_path_buf())
        .collect(),
    )
  } else {
    Ok(
      fs::read_dir(&folder)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .filter(|entry| include_hidden || !is_hidden_entry(&entry.path(), &folder))
        .map(|entry| entry.path())
        .collect(),
    )
  }
}

#[tauri::command]
fn build_cleanup_suggestions(request: SuggestionsRequest) -> Result<SuggestionSet, String> {
  let max_results = request.max_results.unwrap_or(200).clamp(1, 2000);
  let min_large_file_bytes = request.min_large_file_bytes.unwrap_or(250 * 1024 * 1024);
  let stale_days = request.stale_days.unwrap_or(30);
  let paths = collect_scan_paths(
    &request.folder_path,
    request.include_subfolders,
    request.include_hidden,
  )?;

  let duplicates = find_duplicate_groups(&paths, true, 1024 * 1024, None)?;
  let mut groups: HashMap<String, Vec<PathBuf>> = HashMap::new();
  for (path, group) in duplicates {
    groups.entry(group).or_default().push(path);
  }

  let mut suggestions = Vec::new();
  let mut reclaimable = 0u64;

  for files in groups.values_mut() {
    if files.len() < 2 {
      continue;
    }
    files.sort_by(|a, b| {
      let a_time = fs::metadata(a)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .unwrap_or(UNIX_EPOCH);
      let b_time = fs::metadata(b)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .unwrap_or(UNIX_EPOCH);
      b_time.cmp(&a_time)
    });
    for duplicate in files.iter().skip(1) {
      let bytes = fs::metadata(duplicate).map(|meta| meta.len()).unwrap_or(0);
      reclaimable += bytes;
      suggestions.push(Suggestion {
        id: Uuid::new_v4().to_string(),
        action_type: "trash".to_string(),
        source_path: duplicate.to_string_lossy().to_string(),
        destination_path: None,
        safety_level: SafetyLevel::Safe,
        reclaimable_bytes: bytes,
        reason: SuggestionReason {
          code: "duplicate".to_string(),
          message: "Duplicate file detected (keeping most recent copy).".to_string(),
        },
      });
    }
  }

  for path in &paths {
    let metadata = match fs::metadata(path) {
      Ok(meta) => meta,
      Err(_) => continue,
    };
    if metadata.len() < min_large_file_bytes {
      continue;
    }
    if is_downloads_or_installer(path) && file_age_days(path).unwrap_or(0) >= stale_days {
      reclaimable += metadata.len();
      suggestions.push(Suggestion {
        id: Uuid::new_v4().to_string(),
        action_type: "trash".to_string(),
        source_path: path.to_string_lossy().to_string(),
        destination_path: None,
        safety_level: SafetyLevel::Review,
        reclaimable_bytes: metadata.len(),
        reason: SuggestionReason {
          code: "stale-large-file".to_string(),
          message: "Large installer/download has not changed recently.".to_string(),
        },
      });
    } else if is_temp_or_cache_path(path) {
      reclaimable += metadata.len();
      suggestions.push(Suggestion {
        id: Uuid::new_v4().to_string(),
        action_type: "trash".to_string(),
        source_path: path.to_string_lossy().to_string(),
        destination_path: None,
        safety_level: SafetyLevel::Manual,
        reclaimable_bytes: metadata.len(),
        reason: SuggestionReason {
          code: "temp-cache".to_string(),
          message: "File appears to be temporary or cache data.".to_string(),
        },
      });
    }
  }

  if request.include_subfolders {
    let root = PathBuf::from(&request.folder_path);
    for entry in WalkDir::new(&root).into_iter().filter_map(|entry| entry.ok()) {
      if !entry.file_type().is_dir() {
        continue;
      }
      let path = entry.path();
      if path == root {
        continue;
      }
      let mut iterator = match fs::read_dir(path) {
        Ok(iter) => iter,
        Err(_) => continue,
      };
      if iterator.next().is_none() && protected_path_reason(path).is_none() {
        suggestions.push(Suggestion {
          id: Uuid::new_v4().to_string(),
          action_type: "remove-empty-folder".to_string(),
          source_path: path.to_string_lossy().to_string(),
          destination_path: None,
          safety_level: SafetyLevel::Safe,
          reclaimable_bytes: 0,
          reason: SuggestionReason {
            code: "empty-folder".to_string(),
            message: "Folder is empty and can be removed.".to_string(),
          },
        });
      }
    }
  }

  if suggestions.len() > max_results {
    suggestions.truncate(max_results);
  }

  Ok(SuggestionSet {
    generated_ms: now_ms(),
    folder_path: request.folder_path,
    total_reclaimable_bytes: reclaimable,
    suggestions,
  })
}

fn batch_record_file_path(app_handle: &AppHandle, batch_id: &str) -> Result<PathBuf, String> {
  let directory = batch_record_dir(app_handle)?;
  fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
  Ok(directory.join(format!("{}.json", batch_id)))
}

fn store_batch_record(app_handle: &AppHandle, record: &UndoBatchRecord) -> Result<(), String> {
  let path = batch_record_file_path(app_handle, &record.batch_id)?;
  let serialized = serde_json::to_string_pretty(record).map_err(|error| error.to_string())?;
  fs::write(path, serialized).map_err(|error| error.to_string())
}

fn load_batch_record(app_handle: &AppHandle, batch_id: &str) -> Result<UndoBatchRecord, String> {
  let path = batch_record_file_path(app_handle, batch_id)?;
  let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
  serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn remove_batch_record(app_handle: &AppHandle, batch_id: &str) -> Result<(), String> {
  let path = batch_record_file_path(app_handle, batch_id)?;
  if path.exists() {
    fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn apply_action_batch(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  request: ActionBatchRequest,
) -> Result<ActionBatchResult, String> {
  let allow_unsafe = request.allow_unsafe.unwrap_or(false);
  let allow_permanent_delete = request.allow_permanent_delete.unwrap_or(false);
  let dry_run = request.dry_run.unwrap_or(true);
  let batch_id = Uuid::new_v4().to_string();

  let mut results = Vec::new();
  let mut applied = 0usize;
  let mut blocked = 0usize;
  let mut failed = 0usize;
  let mut undo_actions = Vec::new();

  for action in request.actions {
    let source = PathBuf::from(&action.source_path);
    if let Err(error) = ensure_existing_path(&source, allow_unsafe) {
      blocked += 1;
      results.push(ActionResult {
        id: action.id.clone(),
        status: "blocked".to_string(),
        message: error.clone(),
        undoable: false,
      });
      let _ = append_operation_journal(
        &app_handle,
        "batch_action",
        "blocked",
        Some(action.action_type.clone()),
        Some(action.source_path.clone()),
        action.destination_path.clone(),
        action.safety_level.clone(),
        Some(error),
        None,
      );
      continue;
    }
    if action.action_type == "delete" && !allow_permanent_delete {
      blocked += 1;
      let message = "Permanent delete is disabled for batch actions.";
      results.push(ActionResult {
        id: action.id.clone(),
        status: "blocked".to_string(),
        message: message.to_string(),
        undoable: false,
      });
      continue;
    }
    if dry_run {
      applied += 1;
      results.push(ActionResult {
        id: action.id.clone(),
        status: "planned".to_string(),
        message: "Dry run: action validated.".to_string(),
        undoable: matches!(action.action_type.as_str(), "move" | "trash"),
      });
      continue;
    }

    let operation_outcome = (|| -> Result<(bool, String), String> {
      match action.action_type.as_str() {
        "move" => {
          let destination = match action.destination_path.as_ref() {
            Some(path) => PathBuf::from(path),
            None => return Err("Move action requires destinationPath.".to_string()),
          };
          ensure_destination_writable(&destination, allow_unsafe)?;
          move_path(&source, &destination)?;
          undo_actions.push(UndoBatchAction {
            action_type: "move".to_string(),
            source_path: destination.to_string_lossy().to_string(),
            rollback_source: Some(source.to_string_lossy().to_string()),
          });
          Ok((true, destination.to_string_lossy().to_string()))
        }
        "trash" => {
          let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Invalid source path".to_string())?;
          fs::create_dir_all(&state.trash_dir).map_err(|error| error.to_string())?;
          let backup_path = unique_path(&state.trash_dir, file_name);
          if source.is_dir() {
            copy_dir_recursive(&source, &backup_path)?;
          } else {
            fs::copy(&source, &backup_path).map_err(|error| error.to_string())?;
          }
          if let Err(error) = trash::delete(&source) {
            if backup_path.is_dir() {
              let _ = fs::remove_dir_all(&backup_path);
            } else {
              let _ = fs::remove_file(&backup_path);
            }
            return Err(error.to_string());
          }
          undo_actions.push(UndoBatchAction {
            action_type: "trash".to_string(),
            source_path: source.to_string_lossy().to_string(),
            rollback_source: Some(backup_path.to_string_lossy().to_string()),
          });
          Ok((true, backup_path.to_string_lossy().to_string()))
        }
        "remove-empty-folder" => {
          if fs::read_dir(&source)
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
          {
            return Err("Folder is not empty.".to_string());
          }
          fs::remove_dir(&source).map_err(|error| error.to_string())?;
          Ok((false, String::new()))
        }
        "delete" => {
          if source.is_dir() {
            fs::remove_dir_all(&source).map_err(|error| error.to_string())?;
          } else {
            fs::remove_file(&source).map_err(|error| error.to_string())?;
          }
          Ok((false, String::new()))
        }
        _ => Err("Unsupported action type.".to_string()),
      }
    })();

    match operation_outcome {
      Ok((undoable, destination)) => {
        applied += 1;
        {
          let mut index = state.index.lock().expect("index lock");
          match action.action_type.as_str() {
            "move" | "trash" | "delete" => {
              if source.is_dir() {
                index.remove_subtree(&source);
              } else {
                index.remove_path(&source);
              }
            }
            "remove-empty-folder" => index.remove_subtree(&source),
            _ => {}
          }
        }
        let message = if destination.is_empty() {
          "Applied".to_string()
        } else {
          format!("Applied -> {}", destination)
        };
        let message = if let Some(reason) = action.reason.clone() {
          format!("{} ({})", message, reason)
        } else {
          message
        };
        results.push(ActionResult {
          id: action.id.clone(),
          status: "applied".to_string(),
          message: message.clone(),
          undoable,
        });
        let _ = append_operation_journal(
          &app_handle,
          "batch_action",
          "success",
          Some(action.action_type.clone()),
          Some(action.source_path),
          action.destination_path.clone(),
          action.safety_level,
          Some(message),
          None,
        );
      }
      Err(error) => {
        failed += 1;
        results.push(ActionResult {
          id: action.id.clone(),
          status: "error".to_string(),
          message: error.clone(),
          undoable: false,
        });
        let _ = append_operation_journal(
          &app_handle,
          "batch_action",
          "error",
          Some(action.action_type.clone()),
          Some(action.source_path),
          action.destination_path.clone(),
          action.safety_level,
          Some(error),
          None,
        );
      }
    }
  }

  if !dry_run && !undo_actions.is_empty() {
    let record = UndoBatchRecord {
      batch_id: batch_id.clone(),
      created_ms: now_ms(),
      actions: undo_actions,
    };
    let _ = store_batch_record(&app_handle, &record);
  }

  Ok(ActionBatchResult {
    batch_id,
    dry_run,
    applied,
    blocked,
    failed,
    results,
  })
}

#[tauri::command]
fn undo_action_batch(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  batch_id: String,
) -> Result<UndoBatchResult, String> {
  let record = load_batch_record(&app_handle, &batch_id)?;
  let mut restored = 0usize;
  let mut failed = 0usize;
  let mut messages = Vec::new();

  for action in record.actions.iter().rev() {
    let result = match action.action_type.as_str() {
      "move" => {
        let rollback_path = action
          .rollback_source
          .as_ref()
          .ok_or("Missing rollback source for move action".to_string())?;
        move_path(Path::new(&action.source_path), Path::new(rollback_path))
      }
      "trash" => {
        let backup = action
          .rollback_source
          .as_ref()
          .ok_or("Missing backup source for trash action".to_string())?;
        let backup_path = PathBuf::from(backup);
        let target = PathBuf::from(&action.source_path);
        if backup_path.is_dir() {
          move_dir(&backup_path, &target)
        } else {
          move_path(&backup_path, &target)
        }
      }
      _ => Ok(()),
    };
    match result {
      Ok(_) => {
        restored += 1;
        {
          let restored_path = if action.action_type == "move" {
            action.rollback_source.as_ref().map(PathBuf::from)
          } else {
            Some(PathBuf::from(&action.source_path))
          };
          if let Some(restored_path) = restored_path {
            let mapped = {
              let mut index = state.index.lock().expect("index lock");
              upsert_index_path_or_tree(&mut index, &restored_path)
            };
            let mut map = state.map.lock().expect("map lock");
            mapped.into_iter().for_each(|(id, path)| {
              map.insert(id, path);
            });
          }
        }
        messages.push(format!("Restored {}", action.source_path));
      }
      Err(error) => {
        failed += 1;
        messages.push(format!("Failed to restore {}: {}", action.source_path, error));
      }
    }
  }
  if failed == 0 {
    let _ = remove_batch_record(&app_handle, &batch_id);
  }
  let _ = append_operation_journal(
    &app_handle,
    "undo_action_batch",
    if failed == 0 { "success" } else { "error" },
    Some("undo-batch".to_string()),
    None,
    None,
    Some("safe".to_string()),
    Some(format!("restored={}, failed={}", restored, failed)),
    None,
  );
  Ok(UndoBatchResult {
    batch_id,
    restored,
    failed,
    messages,
  })
}

fn unique_path(destination: &Path, file_name: &str) -> PathBuf {
  let mut candidate = destination.join(file_name);
  if !candidate.exists() {
    return candidate;
  }
  let path = Path::new(file_name);
  let stem = path
    .file_stem()
    .and_then(|stem| stem.to_str())
    .unwrap_or("file");
  let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
  for index in 1..1000 {
    let name = if ext.is_empty() {
      format!("{} ({})", stem, index)
    } else {
      format!("{} ({}).{}", stem, index, ext)
    };
    candidate = destination.join(name);
    if !candidate.exists() {
      return candidate;
    }
  }
  destination.join(format!("{} ({})", stem, Uuid::new_v4()))
}

fn move_path(source: &Path, target: &Path) -> Result<(), String> {
  match fs::rename(source, target) {
    Ok(_) => Ok(()),
    Err(error) => {
      if error.raw_os_error() == Some(18) {
        fs::copy(source, target).map_err(|error| error.to_string())?;
        fs::remove_file(source).map_err(|error| error.to_string())?;
        Ok(())
      } else {
        Err(error.to_string())
      }
    }
  }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
  for entry in WalkDir::new(source) {
    let entry = entry.map_err(|error| error.to_string())?;
    let relative = entry
      .path()
      .strip_prefix(source)
      .map_err(|error| error.to_string())?;
    let destination = target.join(relative);
    if entry.file_type().is_dir() {
      fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    } else {
      if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
      }
      fs::copy(entry.path(), &destination).map_err(|error| error.to_string())?;
    }
  }
  Ok(())
}

fn move_dir(source: &Path, target: &Path) -> Result<(), String> {
  match fs::rename(source, target) {
    Ok(_) => Ok(()),
    Err(error) => {
      if error.raw_os_error() == Some(18) {
        copy_dir_recursive(source, target)?;
        fs::remove_dir_all(source).map_err(|error| error.to_string())?;
        Ok(())
      } else {
        Err(error.to_string())
      }
    }
  }
}

fn index_scan_candidate(path: PathBuf) -> IndexedCandidate {
  let path_display = path.to_string_lossy().to_string();
  let name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("Unknown")
    .to_string();
  let kind = classify_file(&path);
  let metadata = fs::metadata(&path).ok();
  let size_bytes = metadata.as_ref().map(|meta| meta.len()).unwrap_or(0);
  let modified_ms = metadata.as_ref().and_then(modified_ms_from_metadata);

  IndexedCandidate {
    path,
    path_display,
    name,
    kind,
    size_bytes,
    modified_ms,
    mime: None,
  }
}

fn resolve_mime_type(candidate: &IndexedCandidate) -> String {
  if let Some(mime) = candidate.mime.as_ref() {
    return mime.clone();
  }
  MimeGuess::from_path(&candidate.path)
    .first_or_octet_stream()
    .essence_str()
    .to_string()
}

fn file_entry_from_path(id: String, path: &Path) -> FileEntry {
  let candidate = index_scan_candidate(path.to_path_buf());
  let mime = resolve_mime_type(&candidate);
  FileEntry {
    id,
    name: candidate.name,
    kind: candidate.kind,
    path: candidate.path_display,
    size_bytes: candidate.size_bytes,
    modified_ms: candidate.modified_ms,
    mime,
    duplicate_group: None,
  }
}

fn upsert_index_path_or_tree(index: &mut IndexStore, path: &Path) -> Vec<(String, PathBuf)> {
  let mut mapped = Vec::new();
  if path.is_file() {
    let id = Uuid::new_v4().to_string();
    index.upsert(file_entry_from_path(id.clone(), path));
    mapped.push((id, path.to_path_buf()));
    return mapped;
  }
  if path.is_dir() {
    for entry in WalkDir::new(path).into_iter().filter_map(|entry| entry.ok()) {
      if entry.file_type().is_file() {
        let id = Uuid::new_v4().to_string();
        index.upsert(file_entry_from_path(id.clone(), entry.path()));
        mapped.push((id, entry.path().to_path_buf()));
      }
    }
  }
  mapped
}

fn classify_file(path: &Path) -> FileKind {
  let extension = path
    .extension()
    .and_then(|ext| ext.to_str())
    .unwrap_or("")
    .to_lowercase();
  if is_image_extension(&extension) {
    return FileKind::Image;
  }
  if is_video_extension(&extension) {
    return FileKind::Video;
  }
  if is_audio_extension(&extension) {
    return FileKind::Audio;
  }
  if is_docs_extension(&extension) {
    return FileKind::Docs;
  }
  if is_text_extension(&extension) {
    return FileKind::Text;
  }
  if is_compressed_extension(&extension) {
    return FileKind::Compressed;
  }
  if is_executable_extension(&extension) {
    return FileKind::Executable;
  }
  if is_binary_extension(&extension) {
    return FileKind::Binary;
  }
  FileKind::Binary
}

fn matches_filter(filter: &str, kind: &FileKind) -> bool {
  match filter {
    "images" => matches!(kind, FileKind::Image),
    "videos" => matches!(kind, FileKind::Video),
    "images_videos" => matches!(kind, FileKind::Image | FileKind::Video),
    "audio" => matches!(kind, FileKind::Audio),
    "docs" => matches!(kind, FileKind::Docs),
    "text" => matches!(kind, FileKind::Text),
    "compressed" => matches!(kind, FileKind::Compressed),
    "executables" => matches!(kind, FileKind::Executable),
    "binary" => matches!(kind, FileKind::Binary),
    _ => true,
  }
}

fn matches_candidate_filter(filter: &str, candidate: &IndexedCandidate) -> bool {
  matches_file_filter(filter, &candidate.name, &candidate.path_display, &candidate.kind)
}

fn matches_file_filter(filter: &str, name: &str, path: &str, kind: &FileKind) -> bool {
  if filter == "screenshots" {
    return is_screenshot_file(name, path, kind);
  }
  matches_filter(filter, kind)
}

fn is_screenshot_file(name: &str, path: &str, kind: &FileKind) -> bool {
  if !matches!(kind, FileKind::Image) {
    return false;
  }

  let image_path = Path::new(path);
  let normalized_name = normalize_screenshot_match_text(name);
  if normalized_name.contains("screenshot")
    || normalized_name.contains("screen shot")
    || normalized_name.contains("screen capture")
    || normalized_name.contains("screencapture")
    || normalized_name.contains("schermata")
    || normalized_name.contains("captura de pantalla")
    || normalized_name.contains("bildschirmfoto")
  {
    return true;
  }

  path
    .split(|character| character == '/' || character == '\\')
    .any(|segment| {
      let normalized_segment = normalize_screenshot_match_text(segment);
      normalized_segment == "screenshots" || normalized_segment == "screen shots"
    })
    || has_screenshot_or_meme_content(image_path)
}

fn normalize_screenshot_match_text(value: &str) -> String {
  value
    .to_lowercase()
    .chars()
    .map(|character| match character {
      '_' | '-' | '.' => ' ',
      _ => character,
    })
    .collect::<String>()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn has_screenshot_or_meme_content(path: &Path) -> bool {
  let Ok(image) = decode_image_luma(path) else {
    return false;
  };
  has_screenshot_or_meme_content_from_image(&image)
}

fn has_screenshot_or_meme_content_from_image(image: &DecodedImage) -> bool {
  has_text_or_number_content(image) || has_strict_ui_only_screenshot(image)
}

fn decode_image_luma(path: &Path) -> Result<DecodedImage, String> {
  let image = ImageReader::open(path)
    .map_err(|error| error.to_string())?
    .with_guessed_format()
    .map_err(|error| error.to_string())?
    .decode()
    .map_err(|error| error.to_string())?
    .to_rgba8();
  let width = image.width() as usize;
  let height = image.height() as usize;
  if width == 0 || height == 0 {
    return Err("Invalid image dimensions.".into());
  }

  let pixels = image
    .pixels()
    .map(|pixel| LumaPixel {
      value: rgb_to_luma(pixel[0], pixel[1], pixel[2]),
      alpha: pixel[3],
    })
    .collect();

  Ok(DecodedImage {
    width,
    height,
    pixels,
  })
}

fn rgb_to_luma(red: u8, green: u8, blue: u8) -> u8 {
  ((u32::from(red) * 299 + u32::from(green) * 587 + u32::from(blue) * 114) / 1000) as u8
}

fn has_battery_icon_like_shape(image: &DecodedImage) -> bool {
  if image.width < 120 || image.height < 120 {
    return false;
  }
  if has_filled_battery_badge_like_shape(image) {
    return true;
  }

  let search_x_start = image.width * 45 / 100;
  let search_x_end = image.width.saturating_sub(1);
  let search_y_start = 0usize;
  let search_y_end = (image.height * 18 / 100).clamp(24, 160).min(image.height.saturating_sub(1));
  let min_width = (image.width / 120).clamp(8, 24);
  let max_width = (image.width / 12).clamp(36, 120);
  let min_height = (image.height / 220).clamp(4, 14);
  let max_height = (image.height / 45).clamp(12, 48);
  let edge_map_height = (search_y_end + max_height + 8).min(image.height);
  let edges = build_edge_map(image, edge_map_height);

  for y in (search_y_start..search_y_end).step_by(2) {
    for x in (search_x_start..search_x_end).step_by(2) {
      for candidate_width in (min_width..=max_width).step_by(2) {
        if x + candidate_width >= image.width {
          break;
        }
        for candidate_height in min_height..=max_height {
          if y + candidate_height >= image.height {
            break;
          }
          let aspect = candidate_width as f32 / candidate_height as f32;
          if !(1.8..=4.8).contains(&aspect) {
            continue;
          }
          if is_battery_outline_candidate(&edges, x, y, candidate_width, candidate_height) {
            return true;
          }
        }
      }
    }
  }

  false
}

fn has_filled_battery_badge_like_shape(image: &DecodedImage) -> bool {
  let search_y_end = (image.height * 10 / 100).clamp(32, 150).min(image.height);
  let dark = build_count_map(image, search_y_end, |pixel| pixel.alpha >= 180 && pixel.value <= 55);
  let bright = build_count_map(image, search_y_end, |pixel| pixel.alpha >= 180 && pixel.value >= 200);
  let x_start = image.width * 70 / 100;
  let x_end = image.width.saturating_sub(image.width * 3 / 100);
  let min_width = (image.width * 3 / 100).clamp(20, 48);
  let max_width = (image.width * 10 / 100).clamp(48, 140);
  let min_height = (image.height / 180).clamp(10, 24);
  let max_height = (image.height / 55).clamp(24, 64);

  for y in (0..search_y_end).step_by(2) {
    for x in (x_start..x_end).step_by(2) {
      for width in (min_width..=max_width).step_by(2) {
        if x + width > x_end {
          break;
        }
        for height in min_height..=max_height {
          if y + height > search_y_end {
            break;
          }
          let aspect = width as f32 / height as f32;
          if !(1.15..=3.8).contains(&aspect) {
            continue;
          }
          if has_contrasting_badge_fill(&dark, x, y, width, height)
            || has_contrasting_badge_fill(&bright, x, y, width, height)
          {
            return true;
          }
        }
      }
    }
  }

  false
}

fn has_contrasting_badge_fill(map: &CountMap, x: usize, y: usize, width: usize, height: usize) -> bool {
  let inner = map.rect_score(x, y, width, height);
  if inner < 0.38 {
    return false;
  }
  let padding = (height / 2).max(4);
  let outer_x = x.saturating_sub(padding);
  let outer_y = y.saturating_sub(padding);
  let outer_right = (x + width + padding).min(map.width);
  let outer_bottom = (y + height + padding).min(map.height);
  let outer_width = outer_right.saturating_sub(outer_x);
  let outer_height = outer_bottom.saturating_sub(outer_y);
  let outer_area = outer_width.saturating_mul(outer_height);
  let inner_area = width.saturating_mul(height);
  if outer_area <= inner_area {
    return false;
  }
  let outer_sum = map.rect_sum(outer_x, outer_y, outer_width, outer_height);
  let inner_sum = map.rect_sum(x, y, width, height);
  let ring = (outer_sum.saturating_sub(inner_sum)) as f32 / (outer_area - inner_area) as f32;
  inner - ring >= 0.20
}

fn has_strict_ui_only_screenshot(image: &DecodedImage) -> bool {
  if !has_phone_screenshot_dimensions(image) {
    return false;
  }

  mobile_screenshot_ui_score(image) >= 4
}

fn mobile_screenshot_ui_score(image: &DecodedImage) -> usize {
  let mut score = 0usize;
  if has_battery_icon_like_shape(image) {
    score += 2;
  }
  if has_dynamic_island_like_shape(image) {
    score += 2;
  }
  if has_home_indicator_like_shape(image) {
    score += 1;
  }
  if has_status_bar_activity(image) {
    score += 1;
  }

  score
}

fn has_text_or_number_content(image: &DecodedImage) -> bool {
  if image.width < 240 || image.height < 240 {
    return false;
  }
  let edges = build_edge_map(image, image.height);
  let top = text_line_stats_in_band(&edges, 0, image.height * 28 / 100);
  let middle = text_line_stats_in_band(&edges, image.height * 28 / 100, image.height * 72 / 100);
  let bottom = text_line_stats_in_band(&edges, image.height * 72 / 100, image.height);
  let wide_groups = top.wide_groups + middle.wide_groups + bottom.wide_groups;

  top.wide_groups >= 2
    || bottom.wide_groups >= 2
    || (wide_groups >= 4 && has_low_photo_texture_bias(&edges))
}

fn text_line_stats_in_band(edges: &EdgeMap, y_start: usize, y_end: usize) -> TextBandStats {
  if y_end <= y_start || edges.width < 80 {
    return TextBandStats::default();
  }
  let y_end = y_end.min(edges.height);
  let cell_count = 12usize;
  let cell_width = (edges.width / cell_count).max(1);
  let window_height = (edges.height / 160).clamp(3, 8);
  let mut stats = TextBandStats::default();
  let mut in_group = false;
  let mut group_max_active_cells = 0usize;

  for y in y_start..y_end.saturating_sub(window_height) {
    let active_cells = (0..cell_count)
      .filter(|cell| {
        let x = cell * cell_width;
        let width = if *cell == cell_count - 1 {
          edges.width.saturating_sub(x)
        } else {
          cell_width
        };
        edges.rect_score(x, y, width, window_height) >= 0.012
      })
      .count();
    stats.max_active_cells = stats.max_active_cells.max(active_cells);
    let text_like_row = active_cells >= 6;
    if text_like_row && !in_group {
      stats.groups += 1;
      in_group = true;
      group_max_active_cells = active_cells;
    } else if text_like_row {
      group_max_active_cells = group_max_active_cells.max(active_cells);
    } else if !text_like_row {
      if in_group && group_max_active_cells >= 7 {
        stats.wide_groups += 1;
      }
      in_group = false;
      group_max_active_cells = 0;
    }
  }
  if in_group && group_max_active_cells >= 7 {
    stats.wide_groups += 1;
  }

  stats
}

fn has_low_photo_texture_bias(edges: &EdgeMap) -> bool {
  let top = edges.rect_score(0, 0, edges.width, edges.height * 25 / 100);
  let center_y = edges.height * 35 / 100;
  let center_height = edges.height * 30 / 100;
  let center = edges.rect_score(0, center_y, edges.width, center_height);
  top >= center * 1.15 || center >= top * 1.15
}

fn has_phone_screenshot_dimensions(image: &DecodedImage) -> bool {
  if image.width < 300 || image.height < 600 || image.height <= image.width {
    return false;
  }
  let ratio = image.width as f32 / image.height as f32;
  (0.40..=0.62).contains(&ratio)
}

fn has_dynamic_island_like_shape(image: &DecodedImage) -> bool {
  let search_y_end = (image.height * 8 / 100).clamp(36, 150).min(image.height);
  let dark = build_count_map(image, search_y_end, |pixel| pixel.alpha >= 180 && pixel.value <= 35);
  let min_width = (image.width * 22 / 100).max(70);
  let max_width = (image.width * 58 / 100).max(min_width);
  let min_height = (image.height * 2 / 100).max(12);
  let max_height = (image.height * 5 / 100).max(min_height);
  let x_start = image.width * 18 / 100;
  let x_end = image.width * 82 / 100;

  for y in (0..search_y_end).step_by(3) {
    for x in (x_start..x_end).step_by(4) {
      for width in (min_width..=max_width).step_by(8) {
        if x + width > x_end {
          break;
        }
        for height in (min_height..=max_height).step_by(3) {
          if y + height > search_y_end {
            break;
          }
          let aspect = width as f32 / height as f32;
          if !(3.0..=8.5).contains(&aspect) {
            continue;
          }
          if dark.rect_score(x, y, width, height) >= 0.72 {
            return true;
          }
        }
      }
    }
  }

  false
}

fn has_home_indicator_like_shape(image: &DecodedImage) -> bool {
  let search_y_start = image.height * 88 / 100;
  let bright = build_count_map(image, image.height, |pixel| pixel.alpha >= 180 && pixel.value >= 225);
  let dark = build_count_map(image, image.height, |pixel| pixel.alpha >= 180 && pixel.value <= 35);
  let min_width = (image.width * 24 / 100).max(80);
  let max_width = (image.width * 48 / 100).max(min_width);
  let min_height = (image.height / 320).clamp(3, 10);
  let max_height = (image.height / 120).clamp(8, 24);
  let x_start = image.width * 22 / 100;
  let x_end = image.width * 78 / 100;

  for y in (search_y_start..image.height).step_by(2) {
    for x in (x_start..x_end).step_by(4) {
      for width in (min_width..=max_width).step_by(8) {
        if x + width > x_end {
          break;
        }
        for height in min_height..=max_height {
          if y + height >= image.height {
            break;
          }
          let aspect = width as f32 / height as f32;
          if aspect < 18.0 {
            continue;
          }
          if bright.rect_score(x, y, width, height) >= 0.82
            || dark.rect_score(x, y, width, height) >= 0.82
          {
            return true;
          }
        }
      }
    }
  }

  false
}

fn has_status_bar_activity(image: &DecodedImage) -> bool {
  let band_height = (image.height * 8 / 100).clamp(36, 140).min(image.height);
  let edges = build_edge_map(image, band_height);
  let left_score = edges.rect_score(0, 0, image.width * 34 / 100, band_height);
  let right_x = image.width * 64 / 100;
  let right_score = edges.rect_score(right_x, 0, image.width.saturating_sub(right_x), band_height);
  left_score >= 0.035 && right_score >= 0.035
}

fn is_battery_outline_candidate(
  edges: &EdgeMap,
  x: usize,
  y: usize,
  width: usize,
  height: usize,
) -> bool {
  let top = edge_line_score(edges, x, y, width, true);
  let bottom = edge_line_score(edges, x, y + height, width, true);
  let left = edge_line_score(edges, x, y, height, false);
  let right = edge_line_score(edges, x + width, y, height, false);
  if top < 0.55 || bottom < 0.55 || left < 0.45 || right < 0.45 {
    return false;
  }

  let center_y = y + height / 2;
  let nub_width = (width / 5).clamp(2, 8);
  let nub_height = (height / 2).max(2);
  let nub_x = x + width + 1;
  let nub_y = center_y.saturating_sub(nub_height / 2);
  if nub_x + nub_width >= edges.width || nub_y + nub_height >= edges.height {
    return false;
  }
  edges.rect_score(nub_x, nub_y, nub_width, nub_height) >= 0.18
}

fn edge_line_score(edges: &EdgeMap, x: usize, y: usize, length: usize, horizontal: bool) -> f32 {
  if length == 0 {
    return 0.0;
  }
  if horizontal {
    edges.rect_score(x, y, length, 1)
  } else {
    edges.rect_score(x, y, 1, length)
  }
}

fn build_edge_map(image: &DecodedImage, height: usize) -> EdgeMap {
  let height = height.min(image.height);
  let stride = image.width + 1;
  let mut sums = vec![0u32; (image.width + 1) * (height + 1)];
  for y in 0..height {
    for x in 0..image.width {
      let value = if is_high_contrast_pixel(image, x, y) { 1 } else { 0 };
      let index = (y + 1) * stride + x + 1;
      sums[index] =
        value + sums[index - 1] + sums[index - stride] - sums[index - stride - 1];
    }
  }
  EdgeMap {
    width: image.width,
    height,
    sums,
  }
}

fn build_count_map(
  image: &DecodedImage,
  height: usize,
  matches_pixel: impl Fn(LumaPixel) -> bool,
) -> CountMap {
  let height = height.min(image.height);
  let stride = image.width + 1;
  let mut sums = vec![0u32; (image.width + 1) * (height + 1)];
  for y in 0..height {
    for x in 0..image.width {
      let value = if matches_pixel(image.pixels[y * image.width + x]) { 1 } else { 0 };
      let index = (y + 1) * stride + x + 1;
      sums[index] =
        value + sums[index - 1] + sums[index - stride] - sums[index - stride - 1];
    }
  }
  CountMap {
    width: image.width,
    height,
    sums,
  }
}

impl EdgeMap {
  fn rect_score(&self, x: usize, y: usize, width: usize, height: usize) -> f32 {
    let area = width.saturating_mul(height);
    if area == 0 || x + width > self.width || y + height > self.height {
      return 0.0;
    }
    self.rect_sum(x, y, width, height) as f32 / area as f32
  }

  fn rect_sum(&self, x: usize, y: usize, width: usize, height: usize) -> u32 {
    let stride = self.width + 1;
    let x2 = x + width;
    let y2 = y + height;
    self.sums[y2 * stride + x2] + self.sums[y * stride + x]
      - self.sums[y * stride + x2]
      - self.sums[y2 * stride + x]
  }
}

impl CountMap {
  fn rect_score(&self, x: usize, y: usize, width: usize, height: usize) -> f32 {
    let area = width.saturating_mul(height);
    if area == 0 || x + width > self.width || y + height > self.height {
      return 0.0;
    }
    self.rect_sum(x, y, width, height) as f32 / area as f32
  }

  fn rect_sum(&self, x: usize, y: usize, width: usize, height: usize) -> u32 {
    let stride = self.width + 1;
    let x2 = x + width;
    let y2 = y + height;
    self.sums[y2 * stride + x2] + self.sums[y * stride + x]
      - self.sums[y * stride + x2]
      - self.sums[y2 * stride + x]
  }
}

fn is_high_contrast_pixel(image: &DecodedImage, x: usize, y: usize) -> bool {
  if x == 0 || y == 0 || x + 1 >= image.width || y + 1 >= image.height {
    return false;
  }
  let pixel = image.pixels[y * image.width + x];
  if pixel.alpha < 180 {
    return false;
  }
  let neighbors = [
    image.pixels[y * image.width + x - 1],
    image.pixels[y * image.width + x + 1],
    image.pixels[(y - 1) * image.width + x],
    image.pixels[(y + 1) * image.width + x],
  ];
  neighbors.iter().any(|neighbor| {
    neighbor.alpha >= 180 && pixel.value.abs_diff(neighbor.value) >= 90
  })
}

fn hash_file(path: &Path) -> Result<String, String> {
  let file = File::open(path).map_err(|error| error.to_string())?;
  let mut reader = BufReader::new(file);
  let mut hasher = Sha256::new();
  let mut buffer = [0u8; 8192];
  loop {
    let read = reader.read(&mut buffer).map_err(|error| error.to_string())?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

fn find_duplicate_groups(
  paths: &[PathBuf],
  use_hash: bool,
  min_size_bytes: u64,
  cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<HashMap<PathBuf, String>, String> {
  let candidates = paths
    .iter()
    .filter_map(|path| {
      if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
          return None;
        }
      }
      fs::metadata(path).ok().map(|metadata| DuplicateCandidate {
        path: path.clone(),
        size_bytes: metadata.len(),
        modified_ms: modified_ms_from_metadata(&metadata),
      })
    })
    .collect::<Vec<_>>();
  if let Some(flag) = cancel_flag {
    if flag.load(Ordering::Relaxed) {
      return Err("Scan cancelled".into());
    }
  }
  find_duplicate_groups_from_candidates(&candidates, use_hash, min_size_bytes, cancel_flag)
}

fn find_duplicate_groups_from_candidates(
  candidates: &[DuplicateCandidate],
  use_hash: bool,
  min_size_bytes: u64,
  cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<HashMap<PathBuf, String>, String> {
  find_duplicate_groups_from_candidates_with_cache(candidates, use_hash, min_size_bytes, cancel_flag, None)
}

fn find_duplicate_groups_from_candidates_with_cache(
  candidates: &[DuplicateCandidate],
  use_hash: bool,
  min_size_bytes: u64,
  cancel_flag: Option<&Arc<AtomicBool>>,
  mut hash_cache: Option<&mut HashCache>,
) -> Result<HashMap<PathBuf, String>, String> {
  let mut size_map: HashMap<u64, Vec<DuplicateCandidate>> = HashMap::new();
  for candidate in candidates {
    if let Some(flag) = cancel_flag {
      if flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
    }
    if candidate.size_bytes < min_size_bytes {
      continue;
    }
    size_map
      .entry(candidate.size_bytes)
      .or_default()
      .push(candidate.clone());
  }

  let mut duplicates = HashMap::new();
  for (size, group) in size_map.into_iter() {
    if let Some(flag) = cancel_flag {
      if flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
    }
    if group.len() < 2 {
      continue;
    }
    if use_hash {
      // Stage 2: partial hash (first/last chunks) to reduce full-hash work.
      let mut partial_map: HashMap<String, Vec<DuplicateCandidate>> = HashMap::new();
      let partial_hashes = group
        .par_iter()
        .filter_map(|candidate| {
          if cancel_flag
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false)
          {
            return None;
          }
          partial_hash_file(&candidate.path)
            .ok()
            .map(|hash| (hash, candidate.clone()))
        })
        .collect::<Vec<_>>();
      if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }
      }
      for (hash, path) in partial_hashes {
        partial_map.entry(hash).or_default().push(path);
      }

      // Stage 3: full hash only for remaining candidate groups with early termination.
      for partial_group in partial_map.into_values() {
        if partial_group.len() < 2 {
          continue;
        }
        if partial_group.len() < 2 {
          continue;
        }
        let mut full_hash_map: HashMap<String, Vec<PathBuf>> = HashMap::new();
        let mut missing = Vec::new();
        if let Some(cache) = hash_cache.as_deref() {
          for candidate in &partial_group {
            if let Some(hash) = cached_full_hash(candidate, cache) {
              full_hash_map.entry(hash).or_default().push(candidate.path.clone());
            } else {
              missing.push(candidate.clone());
            }
          }
        } else {
          missing = partial_group.clone();
        }
        
        if !missing.is_empty() {
          let full_hashes = missing
            .par_iter()
            .filter_map(|candidate| {
              if cancel_flag
                .map(|flag| flag.load(Ordering::Relaxed))
                .unwrap_or(false)
              {
                return None;
              }
              hash_file(&candidate.path).ok().map(|hash| (hash, candidate.clone()))
            })
            .collect::<Vec<_>>();
          if let Some(flag) = cancel_flag {
            if flag.load(Ordering::Relaxed) {
              return Err("Scan cancelled".into());
            }
          }
          for (hash, candidate) in full_hashes {
            if let Some(cache) = hash_cache.as_deref_mut() {
              insert_cached_full_hash(&candidate, hash.clone(), cache);
            }
            full_hash_map.entry(hash).or_default().push(candidate.path);
          }
        }
        
        for (hash, files) in full_hash_map.into_iter() {
          if files.len() > 1 {
            for path in files {
              duplicates.insert(path.clone(), hash.clone());
            }
          }
        }
      }
    } else {
      let group_key = format!("size-{}", size);
      for candidate in group {
        duplicates.insert(candidate.path.clone(), group_key.clone());
      }
    }
  }
  Ok(duplicates)
}

fn is_hidden_entry(path: &Path, root: &Path) -> bool {
  if path == root {
    return false;
  }
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    if let Ok(metadata) = fs::metadata(path) {
      let attrs = metadata.file_attributes();
      if attrs & FILE_ATTRIBUTE_HIDDEN != 0 || attrs & FILE_ATTRIBUTE_SYSTEM != 0 {
        return true;
      }
    }
  }
  let relative = path.strip_prefix(root).unwrap_or(path);
  relative.components().any(|component| {
    let name = component.as_os_str().to_string_lossy();
    name.starts_with('.')
  })
}

fn is_image_extension(extension: &str) -> bool {
  matches!(
    extension,
    "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "heic" | "heif"
  )
}

fn is_video_extension(extension: &str) -> bool {
  matches!(
    extension,
    "mp4" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "m4v" | "mpeg" | "mpg"
  )
}

fn is_audio_extension(extension: &str) -> bool {
  matches!(
    extension,
    "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" | "opus" | "aiff" | "wma" | "alac"
  )
}

fn is_docs_extension(extension: &str) -> bool {
  matches!(
    extension,
    "pdf"
      | "doc"
      | "docx"
      | "odt"
      | "rtf"
      | "ppt"
      | "pptx"
      | "key"
      | "pages"
      | "numbers"
      | "xls"
      | "xlsx"
      | "ods"
      | "odp"
  )
}

fn is_text_extension(extension: &str) -> bool {
  matches!(
    extension,
    "txt"
      | "md"
      | "markdown"
      | "csv"
      | "tsv"
      | "json"
      | "yaml"
      | "yml"
      | "xml"
      | "html"
      | "css"
      | "js"
      | "ts"
      | "jsx"
      | "tsx"
      | "log"
      | "ini"
      | "conf"
      | "toml"
      | "env"
      | "sql"
  )
}

fn is_compressed_extension(extension: &str) -> bool {
  matches!(
    extension,
    "zip"
      | "rar"
      | "7z"
      | "tar"
      | "gz"
      | "tgz"
      | "bz2"
      | "xz"
      | "zst"
      | "lz"
      | "lz4"
      | "cab"
  )
}

fn is_executable_extension(extension: &str) -> bool {
  matches!(
    extension,
    "exe"
      | "msi"
      | "dmg"
      | "pkg"
      | "app"
      | "bat"
      | "cmd"
      | "sh"
      | "ps1"
      | "jar"
      | "run"
      | "apk"
  )
}

fn is_binary_extension(extension: &str) -> bool {
  matches!(
    extension,
    "bin" | "dat" | "db" | "sqlite" | "bak" | "pak" | "img" | "iso"
  )
}

enum ArchiveKind {
  Zip,
  Tar,
  TarGz,
  TarBz2,
  TarXz,
}

fn detect_archive_kind(path: &Path) -> Option<ArchiveKind> {
  let name = path.file_name()?.to_string_lossy().to_lowercase();
  if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
    return Some(ArchiveKind::TarGz);
  }
  if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") {
    return Some(ArchiveKind::TarBz2);
  }
  if name.ends_with(".tar.xz") || name.ends_with(".txz") {
    return Some(ArchiveKind::TarXz);
  }
  if name.ends_with(".tar") {
    return Some(ArchiveKind::Tar);
  }
  let extension = path.extension()?.to_string_lossy().to_lowercase();
  if extension == "zip" {
    return Some(ArchiveKind::Zip);
  }
  None
}

fn wait_for_child(child: &mut Child, timeout_secs: u64) -> Result<(), String> {
  let timeout = Duration::from_secs(timeout_secs);
  let start = Instant::now();
  loop {
    if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
      if !status.success() {
        return Err("Preview generation failed.".into());
      }
      return Ok(());
    }
    if start.elapsed() >= timeout {
      let _ = child.kill();
      let _ = child.wait();
      return Err("Preview generation timed out.".into());
    }
    std::thread::sleep(Duration::from_millis(QLMANAGE_POLL_MS));
  }
}

fn run_qlmanage_preview(session_dir: &Path, source_path: &Path) -> Result<PathBuf, String> {
  let mut child = Command::new("qlmanage")
    .arg("-t")
    .arg("-s")
    .arg("1400")
    .arg("-o")
    .arg(session_dir)
    .arg(source_path)
    .spawn()
    .map_err(|error| error.to_string())?;

  wait_for_child(&mut child, QLMANAGE_TIMEOUT_SECS)?;

  fs::read_dir(session_dir)
    .map_err(|error| error.to_string())?
    .filter_map(|entry| entry.ok())
    .map(|entry| entry.path())
    .find(|path| {
      path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg"))
        .unwrap_or(false)
    })
    .ok_or("Preview file not found".into())
}

fn file_url_from_path(path: &Path) -> String {
  let normalized = path.to_string_lossy().replace('\\', "/");
  format!("file:///{}", normalized)
}

fn detect_windows_libreoffice() -> Option<PathBuf> {
  let mut candidates = Vec::new();
  if let Some(program_files) = std::env::var_os("ProgramFiles") {
    candidates.push(
      PathBuf::from(&program_files)
        .join("LibreOffice")
        .join("program")
        .join("soffice.com"),
    );
    candidates.push(
      PathBuf::from(&program_files)
        .join("LibreOffice")
        .join("program")
        .join("soffice.exe"),
    );
  }
  if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
    candidates.push(
      PathBuf::from(&program_files_x86)
        .join("LibreOffice")
        .join("program")
        .join("soffice.com"),
    );
    candidates.push(
      PathBuf::from(&program_files_x86)
        .join("LibreOffice")
        .join("program")
        .join("soffice.exe"),
    );
  }
  if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.exists()) {
    return Some(candidate);
  }

  let discovered = Command::new("where")
    .arg("soffice.com")
    .output()
    .ok()
    .filter(|output| output.status.success())
    .and_then(|output| {
      let stdout = String::from_utf8_lossy(&output.stdout);
      stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
    });
  if discovered.is_some() {
    return discovered;
  }

  Command::new("where")
    .arg("soffice.exe")
    .output()
    .ok()
    .filter(|output| output.status.success())
    .and_then(|output| {
      let stdout = String::from_utf8_lossy(&output.stdout);
      stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
    })
}

fn run_windows_libreoffice_preview(
  session_dir: &Path,
  source_path: &Path,
  cached_preview_path: &Path,
) -> Result<PathBuf, String> {
  let soffice_path = detect_windows_libreoffice()
    .ok_or("LibreOffice not found. Install LibreOffice to enable Office previews.".to_string())?;
  let profile_dir = session_dir
    .parent()
    .unwrap_or(session_dir)
    .join("lo-profile");
  fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;
  let user_installation = file_url_from_path(&profile_dir);

  let mut child = Command::new(&soffice_path)
    .arg("--headless")
    .arg("--nologo")
    .arg("--nodefault")
    .arg("--norestore")
    .arg("--nolockcheck")
    .arg(format!("-env:UserInstallation={}", user_installation))
    .arg("--convert-to")
    .arg("pdf")
    .arg("--outdir")
    .arg(session_dir)
    .arg(source_path)
    .spawn()
    .map_err(|error| {
      if soffice_path.as_os_str().to_string_lossy().contains("soffice.") {
        format!("Failed to start LibreOffice: {}. Install LibreOffice or add it to PATH.", error)
      } else {
        error.to_string()
      }
    })?;

  wait_for_child(&mut child, WINDOWS_OFFICE_PREVIEW_TIMEOUT_SECS)?;

  let source_stem = source_path
    .file_stem()
    .and_then(|value| value.to_str())
    .ok_or("Preview file name is invalid".to_string())?;
  let converted_preview = session_dir.join(format!("{}.pdf", source_stem));
  let preview_path = if converted_preview.exists() {
    converted_preview
  } else {
    fs::read_dir(session_dir)
      .map_err(|error| error.to_string())?
      .filter_map(|entry| entry.ok())
      .map(|entry| entry.path())
      .find(|path| {
        path
          .extension()
          .and_then(|ext| ext.to_str())
          .map(|ext| ext.eq_ignore_ascii_case("pdf"))
          .unwrap_or(false)
      })
      .ok_or("Preview file not found".to_string())?
  };

  fs::copy(&preview_path, cached_preview_path).map_err(|error| error.to_string())?;
  Ok(cached_preview_path.to_path_buf())
}

fn run_platform_preview(
  session_dir: &Path,
  source_path: &Path,
  cached_preview_path: Option<&Path>,
) -> Result<PathBuf, String> {
  if cfg!(target_os = "macos") {
    return run_qlmanage_preview(session_dir, source_path);
  }
  if cfg!(target_os = "windows") {
    let cached_preview_path =
      cached_preview_path.ok_or("Preview cache path missing".to_string())?;
    return run_windows_libreoffice_preview(session_dir, source_path, cached_preview_path);
  }
  Err("Preview generation is not supported on this platform.".into())
}

fn list_zip_entries(path: &Path) -> Result<ArchivePreview, String> {
  let file = File::open(path).map_err(|error| error.to_string())?;
  let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
  let mut entries = Vec::new();
  let total = archive.len();
  for index in 0..archive.len() {
    let file = archive.by_index(index).map_err(|error| error.to_string())?;
    entries.push(file.name().to_string());
    if entries.len() >= MAX_ARCHIVE_ENTRIES {
      break;
    }
  }
  Ok(ArchivePreview {
    entries,
    truncated: total > MAX_ARCHIVE_ENTRIES,
  })
}

fn list_tar_entries<R: Read>(reader: R) -> Result<ArchivePreview, String> {
  let mut archive = Archive::new(reader);
  let mut entries = Vec::new();
  let mut truncated = false;
  let tar_entries = archive.entries().map_err(|error| error.to_string())?;
  for entry in tar_entries {
    let entry = entry.map_err(|error| error.to_string())?;
    let path = entry.path().map_err(|error| error.to_string())?;
    entries.push(path.to_string_lossy().to_string());
    if entries.len() >= MAX_ARCHIVE_ENTRIES {
      truncated = true;
      break;
    }
  }
  Ok(ArchivePreview { entries, truncated })
}

fn parse_range(range: &str, size: u64, max_length: Option<u64>) -> Option<(u64, u64)> {
  if !range.starts_with("bytes=") {
    return None;
  }
  let range = range.trim_start_matches("bytes=");
  let mut parts = range.split('-');
  let start_part = parts.next()?.trim();
  let end_part = parts.next().map(|value| value.trim());
  let (start, end) = if start_part.is_empty() {
    let suffix_length = end_part?.parse::<u64>().ok()?;
    if suffix_length == 0 || size == 0 {
      return None;
    }
    let mut length = suffix_length.min(size);
    if let Some(max_length) = max_length {
      length = length.min(max_length);
    }
    let start = size.saturating_sub(length);
    (start, size.saturating_sub(1))
  } else {
    let start = start_part.parse::<u64>().ok()?;
    let end = match end_part {
      Some("") | None => {
        let mut end = size.saturating_sub(1);
        if let Some(max_length) = max_length {
          let capped = start.saturating_add(max_length.saturating_sub(1));
          end = std::cmp::min(capped, end);
        }
        end
      }
      Some(value) => value.parse::<u64>().ok()?,
    };
    (start, end)
  };
  if start > end || start >= size {
    return None;
  }
  let end = std::cmp::min(end, size.saturating_sub(1));
  Some((start, end))
}

fn should_cap_range_requests(content_type: &str) -> bool {
  !(content_type.starts_with("image/") || content_type == "application/pdf")
}

fn build_response(
  status: StatusCode,
  headers: HeaderMap,
  body: Vec<u8>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
  let mut builder = Response::builder().status(status);
  for (name, value) in headers {
    if let Some(name) = name {
      builder = builder.header(name, value);
    }
  }
  Ok(builder.body(body)?)
}

fn protocol_response(
  app: &AppHandle,
  request: tauri::http::Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
  let id = request
    .uri()
    .path()
    .trim_start_matches('/')
    .to_string();
  if id.is_empty() {
    return build_response(StatusCode::NOT_FOUND, HeaderMap::new(), Vec::new());
  }

  let state = app.state::<AppState>();
  let map = state.map.lock().expect("map lock");
  let path = match map.get(&id) {
    Some(path) => path.clone(),
    None => {
      return build_response(StatusCode::NOT_FOUND, HeaderMap::new(), Vec::new());
    }
  };

  let mut file = File::open(&path)?;
  let metadata = file.metadata()?;
  let size = metadata.len();

  let content_type = MimeGuess::from_path(&path)
    .first_or_octet_stream()
    .essence_str()
    .to_string();

  let mut headers = HeaderMap::new();
  headers.insert(
    HeaderName::from_static("content-type"),
    HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")),
  );
  headers.insert(
    HeaderName::from_static("accept-ranges"),
    HeaderValue::from_static("bytes"),
  );

  if let Some(range_value) = request.headers().get("range") {
    if let Ok(range_str) = range_value.to_str() {
      let max_range_length = if should_cap_range_requests(&content_type) {
        Some(MAX_RANGE_CHUNK_BYTES)
      } else {
        None
      };
      if let Some((start, end)) = parse_range(range_str, size, max_range_length) {
        let length = end - start + 1;
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = vec![0u8; length as usize];
        file.read_exact(&mut buffer)?;
        headers.insert(
          HeaderName::from_static("content-range"),
          HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, size))
            .unwrap_or(HeaderValue::from_static("bytes 0-0/0")),
        );
        headers.insert(
          HeaderName::from_static("content-length"),
          HeaderValue::from_str(&length.to_string()).unwrap_or(HeaderValue::from_static("0")),
        );
        return build_response(StatusCode::PARTIAL_CONTENT, headers, buffer);
      }
    }
  }

  let mut buffer = Vec::with_capacity(size as usize);
  file.read_to_end(&mut buffer)?;
  headers.insert(
    HeaderName::from_static("content-length"),
    HeaderValue::from_str(&buffer.len().to_string()).unwrap_or(HeaderValue::from_static("0")),
  );
  build_response(StatusCode::OK, headers, buffer)
}

fn main() {
  let context = tauri::generate_context!();
  tauri::Builder::default()
    .setup(|app| {
      let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
      let trash_dir = app_data_dir.join("trash");
      let crash_dir = app_data_dir.join("crash-reports");
      let batches_dir = app_data_dir.join(APPLIED_BATCHES_DIR);
      let hash_cache_path = hash_cache_file_path(&app_data_dir);
      fs::create_dir_all(&trash_dir).map_err(|error| error.to_string())?;
      fs::create_dir_all(&crash_dir).map_err(|error| error.to_string())?;
      fs::create_dir_all(&batches_dir).map_err(|error| error.to_string())?;
      let hash_cache = load_hash_cache(&hash_cache_path);
      if let Some(previous_session) = load_session_info(&crash_dir) {
        if !previous_session.clean_shutdown {
          let skip_report = load_last_crash_report(&crash_dir)
            .map(|report| report.created_ms >= previous_session.started_ms)
            .unwrap_or(false);
          if !skip_report {
            if let Err(error) = create_unclean_shutdown_report(&crash_dir, &previous_session) {
              eprintln!("Failed to store unclean shutdown report: {}", error);
            }
          }
        }
      }
      let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
      let session = SessionInfo {
        id: Uuid::new_v4().to_string(),
        started_ms: now_ms,
        last_heartbeat_ms: now_ms,
        clean_shutdown: false,
        app_name: app.package_info().name.to_string(),
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
      };
      if let Err(error) = store_session_info(&crash_dir, &session) {
        eprintln!("Failed to store session info: {}", error);
      }
      install_panic_hook(
        crash_dir,
        app.package_info().name.to_string(),
        app.package_info().version.to_string(),
      );
      clear_trash_dir_best_effort(&trash_dir);
      app.manage(AppState {
        map: Mutex::new(HashMap::new()),
        index: Mutex::new(IndexStore::default()),
        hash_cache: Mutex::new(hash_cache),
        hash_cache_path,
        preview_map: Mutex::new(HashMap::new()),
        destination: Mutex::new(None),
        scan_cancellations: Mutex::new(HashMap::new()),
        trash_dir,
      });
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .register_asynchronous_uri_scheme_protocol("media", |context, request, responder| {
      let response = protocol_response(context.app_handle(), request).unwrap_or_else(|_| {
        Response::builder()
          .status(StatusCode::INTERNAL_SERVER_ERROR)
          .body(Vec::new())
          .expect("response")
      });
      responder.respond(response);
    })
    .invoke_handler(tauri::generate_handler![
      get_crash_report,
      clear_crash_report,
      log_client_error,
      get_operation_history,
      get_recent_undo_actions,
      store_recent_undo_actions,
      get_preview_capabilities,
      get_cached_scan,
      store_cached_scan_result,
      hydrate_cached_scan,
      update_heartbeat,
      scan_folder,
      scan_folder_v2,
      query_index,
      get_index_stats,
      get_file_by_id,
      cancel_scan,
      build_cleanup_suggestions,
      apply_action_batch,
      undo_action_batch,
      trash_file,
      trash_folder,
      move_file,
      restore_file,
      restore_folder,
      set_destination,
      list_archive_entries,
      extract_office_fallback_preview,
      generate_preview,
      reveal_in_file_manager
    ])
    .build(context)
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
          mark_session_clean_best_effort(&app_handle);
          let already_cleaned =
            TRASH_CLEANED.swap(true, Ordering::Relaxed);
          if already_cleaned {
            return;
          }
          let trash_dir = app_handle.state::<AppState>().trash_dir.clone();
          clear_trash_dir_best_effort(&trash_dir);
        }
        _ => {}
      }
    });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn test_entry(id: &str, name: &str, kind: FileKind, size: u64, duplicate_group: Option<&str>) -> FileEntry {
    FileEntry {
      id: id.to_string(),
      name: name.to_string(),
      kind,
      path: format!("/tmp/{}", name),
      size_bytes: size,
      modified_ms: Some(size),
      mime: "application/octet-stream".to_string(),
      duplicate_group: duplicate_group.map(|value| value.to_string()),
    }
  }

  #[test]
  fn clear_trash_dir_removes_contents() {
    let base = std::env::temp_dir().join(format!("tidy-trash-test-{}", Uuid::new_v4()));
    fs::create_dir_all(base.join("nested")).unwrap();
    fs::write(base.join("a.txt"), b"hi").unwrap();
    fs::write(base.join("nested").join("b.txt"), b"hi").unwrap();

    clear_trash_dir(&base).unwrap();

    assert!(fs::read_dir(&base).unwrap().next().is_none());
    let _ = fs::remove_dir_all(&base);
  }

  #[test]
  fn clear_trash_dir_missing_is_ok() {
    let base = std::env::temp_dir().join(format!("tidy-trash-test-missing-{}", Uuid::new_v4()));
    clear_trash_dir(&base).unwrap();
  }

  #[test]
  fn xml_text_extraction_removes_tags() {
    let xml = "<w:document><w:p>Hello <w:t>world</w:t> &amp; friends</w:p></w:document>";
    let text = extract_text_from_xml(xml);
    assert!(text.contains("Hello"));
    assert!(text.contains("world"));
    assert!(text.contains("&"));
  }

  #[test]
  fn binary_office_fallback_extracts_ascii_and_utf16_text() {
    let mut data = b"ABCD plain text section".to_vec();
    data.extend_from_slice(&[0, 1, 2, 3]);
    data.extend("Hello from UTF16".encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
    let text = extract_text_from_binary_office(&data);
    assert!(text.contains("plain text section"));
    assert!(text.contains("Hello from UTF16"));
  }

  #[test]
  fn partial_hash_is_stable() {
    let path = std::env::temp_dir().join(format!("tidy-partial-hash-{}", Uuid::new_v4()));
    fs::write(&path, vec![7u8; 400_000]).unwrap();
    let a = partial_hash_file(&path).unwrap();
    let b = partial_hash_file(&path).unwrap();
    assert_eq!(a, b);
    let _ = fs::remove_file(path);
  }

  #[test]
  fn safety_check_allows_regular_paths() {
    let path = std::env::temp_dir().join(format!("tidy-safe-{}", Uuid::new_v4()));
    fs::write(&path, b"ok").unwrap();
    assert!(ensure_safe_path(&path, false).is_ok());
    let _ = fs::remove_file(path);
  }

  #[test]
  fn safety_check_blocks_trash_paths() {
    let path = PathBuf::from("/tmp/.Trash/tidy-test.txt");
    assert!(ensure_safe_path(&path, false).is_err());
    assert!(ensure_safe_path(&path, true).is_ok());
  }

  #[test]
  fn classify_and_filter_helpers_match_expected_kinds() {
    let image_kind = classify_file(Path::new("/tmp/file.jpg"));
    let docs_kind = classify_file(Path::new("/tmp/file.pdf"));
    let binary_kind = classify_file(Path::new("/tmp/file.unknownext"));
    assert!(matches!(image_kind, FileKind::Image));
    assert!(matches!(docs_kind, FileKind::Docs));
    assert!(matches!(binary_kind, FileKind::Binary));
    assert!(matches_filter("images", &image_kind));
    assert!(!matches_filter("images", &docs_kind));
    assert!(matches_filter("all", &binary_kind));
    assert!(matches_file_filter(
      "screenshots",
      "Screenshot 2026-06-06 at 10.30.00.png",
      "/tmp/Screenshot 2026-06-06 at 10.30.00.png",
      &image_kind,
    ));
    assert!(matches_file_filter(
      "screenshots",
      "IMG_0001.PNG",
      "/tmp/Screenshots/IMG_0001.PNG",
      &image_kind,
    ));
    assert!(!matches_file_filter(
      "screenshots",
      "Screenshot notes.txt",
      "/tmp/Screenshot notes.txt",
      &docs_kind,
    ));
    assert!(!matches_file_filter(
      "screenshots",
      "holiday.png",
      "/tmp/Photos/holiday.png",
      &image_kind,
    ));
  }

  #[test]
  fn screenshot_content_detector_finds_battery_like_status_icon() {
    let mut image = test_luma_image(360, 640, 245);
    draw_rect_outline(&mut image, 300, 18, 28, 12, 25);
    draw_filled_rect(&mut image, 330, 22, 4, 5, 25);
    assert!(has_battery_icon_like_shape(&image));
    assert!(mobile_screenshot_ui_score(&image) >= 2);
    assert!(!has_strict_ui_only_screenshot(&image));
  }

  #[test]
  fn screenshot_content_detector_ignores_plain_images() {
    let image = test_luma_image(360, 640, 245);
    assert!(!has_strict_ui_only_screenshot(&image));
  }

  #[test]
  fn screenshot_content_detector_finds_dynamic_island_status_area() {
    let mut image = test_luma_image(1320, 2868, 245);
    draw_filled_rect(&mut image, 370, 42, 580, 110, 5);
    draw_filled_rect(&mut image, 92, 80, 160, 42, 5);
    draw_filled_rect(&mut image, 980, 80, 210, 42, 5);
    assert!(mobile_screenshot_ui_score(&image) >= 2);
    assert!(has_strict_ui_only_screenshot(&image));
  }

  #[test]
  fn screenshot_content_detector_finds_home_indicator_status_area() {
    let mut image = test_luma_image(1320, 2868, 35);
    draw_filled_rect(&mut image, 92, 80, 160, 42, 245);
    draw_filled_rect(&mut image, 980, 80, 210, 42, 245);
    draw_filled_rect(&mut image, 430, 2800, 460, 12, 245);
    assert!(mobile_screenshot_ui_score(&image) >= 2);
    assert!(has_strict_ui_only_screenshot(&image));
  }

  #[test]
  fn screenshot_content_detector_matches_provided_examples_when_available() {
    for path in [
      "/Volumes/personal_folder/tempscreen/Diocane/IMG_4826.png",
      "/Volumes/personal_folder/tempscreen/Diocane/IMG_4992.png",
      "/Volumes/personal_folder/tempscreen/Diocane/IMG_4998.png",
      "/Volumes/personal_folder/tempscreen/Diocane/IMG_5009.png",
      "/Volumes/personal_folder/tempscreen/Diocane/IMG_6850.png",
      "/Volumes/personal_folder/tempscreen/Diocane/IMG_7257.png",
    ] {
      let path = Path::new(path);
      if path.exists() {
        assert!(
          has_screenshot_or_meme_content(path),
          "expected {} to be detected as a screenshot",
          path.display(),
        );
      }
    }
  }

  #[test]
  fn screenshot_content_detector_rejects_non_phone_battery_like_photo_patch() {
    let mut image = test_luma_image(1280, 720, 120);
    draw_filled_rect(&mut image, 980, 40, 90, 36, 245);
    draw_filled_rect(&mut image, 250, 160, 280, 180, 25);
    assert!(has_battery_icon_like_shape(&image));
    assert!(!has_text_or_number_content(&image));
  }

  #[test]
  fn screenshot_content_detector_rejects_incidental_photo_text() {
    let mut image = test_luma_image(1200, 1600, 135);
    draw_text_like_line(&mut image, 420, 1120, 340, 30, 245);
    draw_filled_rect(&mut image, 120, 180, 360, 500, 70);
    draw_filled_rect(&mut image, 620, 360, 260, 180, 45);
    assert!(!has_text_or_number_content(&image));
    assert!(!has_screenshot_or_meme_content_from_image(&image));
  }

  #[test]
  fn screenshot_content_detector_rejects_photo_texture_rows() {
    let mut image = test_luma_image(1280, 720, 130);
    for y in (40..680).step_by(42) {
      draw_filled_rect(&mut image, 0, y, 1280, 4, 45);
    }
    for x in (0..1280).step_by(90) {
      draw_filled_rect(&mut image, x, 0, 6, 720, 220);
    }
    assert!(!has_text_or_number_content(&image));
    assert!(!has_screenshot_or_meme_content_from_image(&image));
  }

  #[test]
  fn screenshot_content_detector_finds_meme_like_text_layout() {
    let mut image = test_luma_image(900, 900, 80);
    draw_text_like_line(&mut image, 80, 60, 720, 24, 245);
    draw_text_like_line(&mut image, 110, 116, 660, 24, 245);
    assert!(has_text_or_number_content(&image));
    assert!(has_screenshot_or_meme_content_from_image(&image));
  }

  #[test]
  fn screenshot_content_detector_rejects_weak_ui_without_text() {
    let mut image = test_luma_image(1320, 2868, 245);
    draw_rect_outline(&mut image, 1100, 74, 54, 24, 25);
    draw_filled_rect(&mut image, 1158, 82, 6, 10, 25);
    assert!(!has_text_or_number_content(&image));
    assert!(!has_strict_ui_only_screenshot(&image));
    assert!(!has_screenshot_or_meme_content_from_image(&image));
  }

  fn test_luma_image(width: usize, height: usize, value: u8) -> DecodedImage {
    DecodedImage {
      width,
      height,
      pixels: vec![LumaPixel { value, alpha: 255 }; width * height],
    }
  }

  fn draw_rect_outline(image: &mut DecodedImage, x: usize, y: usize, width: usize, height: usize, value: u8) {
    for px in x..=x + width {
      set_test_pixel(image, px, y, value);
      set_test_pixel(image, px, y + height, value);
    }
    for py in y..=y + height {
      set_test_pixel(image, x, py, value);
      set_test_pixel(image, x + width, py, value);
    }
  }

  fn draw_filled_rect(image: &mut DecodedImage, x: usize, y: usize, width: usize, height: usize, value: u8) {
    for py in y..y + height {
      for px in x..x + width {
        set_test_pixel(image, px, py, value);
      }
    }
  }

  fn draw_text_like_line(image: &mut DecodedImage, x: usize, y: usize, width: usize, height: usize, value: u8) {
    let block_width = 18usize;
    let gap = 10usize;
    let mut cursor = x;
    while cursor + block_width < x + width {
      draw_filled_rect(image, cursor, y, block_width, height, value);
      cursor += block_width + gap;
    }
  }

  fn set_test_pixel(image: &mut DecodedImage, x: usize, y: usize, value: u8) {
    if x < image.width && y < image.height {
      image.pixels[y * image.width + x] = LumaPixel { value, alpha: 255 };
    }
  }

  #[test]
  fn parse_range_handles_standard_and_capped_ranges() {
    assert_eq!(parse_range("bytes=0-9", 100, None), Some((0, 9)));
    assert_eq!(parse_range("bytes=10-", 100, Some(5)), Some((10, 14)));
    assert_eq!(parse_range("bytes=-10", 100, None), Some((90, 99)));
    assert_eq!(parse_range("bytes=-10", 100, Some(4)), Some((96, 99)));
    assert_eq!(parse_range("bytes=90-200", 100, None), Some((90, 99)));
    assert_eq!(parse_range("bytes=101-200", 100, None), None);
    assert_eq!(parse_range("items=0-9", 100, None), None);
  }

  #[test]
  fn range_capping_skips_images_and_pdfs() {
    assert!(!should_cap_range_requests("image/png"));
    assert!(!should_cap_range_requests("application/pdf"));
    assert!(should_cap_range_requests("text/plain"));
  }

  #[test]
  fn duplicate_grouping_detects_same_content_files() {
    let base = PathBuf::from(format!("/tmp/tidy-duplicates-{}", Uuid::new_v4()));
    fs::create_dir_all(&base).unwrap();
    let a = base.join("a.bin");
    let b = base.join("b.bin");
    fs::write(&a, vec![8u8; 1_200_000]).unwrap();
    fs::write(&b, vec![8u8; 1_200_000]).unwrap();
    let duplicates = find_duplicate_groups(&[a.clone(), b.clone()], true, 1_000_000, None).unwrap();
    assert_eq!(duplicates.len(), 2);
    let a_group = duplicates.get(&a).cloned();
    let b_group = duplicates.get(&b).cloned();
    assert_eq!(a_group, b_group);

    let below_min_size =
      find_duplicate_groups(&[a.clone(), b.clone()], true, 2_000_000, None).unwrap();
    assert!(below_min_size.is_empty());

    let _ = fs::remove_dir_all(base);
  }

  #[test]
  fn index_store_queries_sorted_filtered_and_duplicate_pages() {
    let mut index = IndexStore::default();
    index.replace(
      "/tmp".to_string(),
      vec![
        test_entry("a", "alpha.txt", FileKind::Text, 10, None),
        test_entry("b", "beta.jpg", FileKind::Image, 30, Some("hash-1")),
        test_entry("c", "gamma.jpg", FileKind::Image, 20, Some("hash-1")),
      ],
    );

    let result = index.query(QueryIndexRequest {
      filter_mode: Some("images".to_string()),
      selected_extensions: Some(vec!["jpg".to_string()]),
      sort_mode: Some("size_desc".to_string()),
      group_mode: Some("extension".to_string()),
      offset: Some(0),
      limit: Some(1),
    });
    assert_eq!(result.total, 2);
    assert_eq!(result.files[0].id, "b");
    assert_eq!(result.groups[0].key, "jpg");
    assert_eq!(result.groups[0].count, 2);

    let duplicates = index.query(QueryIndexRequest {
      filter_mode: Some("duplicates".to_string()),
      selected_extensions: None,
      sort_mode: Some("name_asc".to_string()),
      group_mode: Some("duplicates".to_string()),
      offset: Some(0),
      limit: Some(10),
    });
    assert_eq!(duplicates.total, 2);
    assert!(duplicates.files.iter().all(|file| file.duplicate_group.is_some()));

    index.remove("b");
    let stats = index.stats();
    assert_eq!(stats.total, 2);
    assert_eq!(stats.duplicate_groups, 1);
  }

  #[test]
  fn duplicate_grouping_reuses_cached_full_hashes_for_unchanged_files() {
    let base = PathBuf::from(format!("/tmp/tidy-hash-cache-{}", Uuid::new_v4()));
    fs::create_dir_all(&base).unwrap();
    let a = base.join("a.bin");
    let b = base.join("b.bin");
    fs::write(&a, vec![5u8; 1_200_000]).unwrap();
    fs::write(&b, vec![5u8; 1_200_000]).unwrap();
    let metadata_a = fs::metadata(&a).unwrap();
    let metadata_b = fs::metadata(&b).unwrap();
    let candidates = vec![
      DuplicateCandidate {
        path: a.clone(),
        size_bytes: metadata_a.len(),
        modified_ms: modified_ms_from_metadata(&metadata_a),
      },
      DuplicateCandidate {
        path: b.clone(),
        size_bytes: metadata_b.len(),
        modified_ms: modified_ms_from_metadata(&metadata_b),
      },
    ];

    let mut cache = HashCache::default();
    let first = find_duplicate_groups_from_candidates_with_cache(
      &candidates,
      true,
      1_000_000,
      None,
      Some(&mut cache),
    )
    .unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(cache.entries.len(), 2);

    let cached_hashes = cache
      .entries
      .values()
      .map(|entry| entry.hash.clone())
      .collect::<std::collections::HashSet<_>>();
    let second = find_duplicate_groups_from_candidates_with_cache(
      &candidates,
      true,
      1_000_000,
      None,
      Some(&mut cache),
    )
    .unwrap();
    assert_eq!(second.len(), 2);
    assert_eq!(cache.entries.len(), 2);
    assert_eq!(
      cached_hashes,
      cache
        .entries
        .values()
        .map(|entry| entry.hash.clone())
        .collect::<std::collections::HashSet<_>>()
    );
    let changed_candidate = DuplicateCandidate {
      path: a.clone(),
      size_bytes: metadata_a.len(),
      modified_ms: candidates[0].modified_ms.map(|value| value + 1).or(Some(1)),
    };
    assert!(cached_full_hash(&changed_candidate, &cache).is_none());

    let _ = fs::remove_dir_all(base);
  }

  #[test]
  fn build_cleanup_suggestions_produces_safe_review_and_manual_items() {
    let root = PathBuf::from(format!("/tmp/tidy-suggestions-{}", Uuid::new_v4()));
    let cache_dir = root.join("cache");
    fs::create_dir_all(&cache_dir).unwrap();
    let duplicate_a = root.join("dupe-a.bin");
    let duplicate_b = root.join("dupe-b.bin");
    let review_zip = root.join("installer.zip");
    let manual_cache = cache_dir.join("cache.tmp");
    fs::write(&duplicate_a, vec![4u8; 1_200_000]).unwrap();
    fs::write(&duplicate_b, vec![4u8; 1_200_000]).unwrap();
    fs::write(&review_zip, vec![6u8; 2_000]).unwrap();
    fs::write(&manual_cache, vec![9u8; 2_000]).unwrap();

    let result = build_cleanup_suggestions(SuggestionsRequest {
      folder_path: root.to_string_lossy().to_string(),
      include_subfolders: true,
      include_hidden: true,
      max_results: Some(100),
      min_large_file_bytes: Some(1),
      stale_days: Some(0),
    })
    .unwrap();

    assert!(result
      .suggestions
      .iter()
      .any(|item| matches!(item.safety_level, SafetyLevel::Safe)));
    assert!(result
      .suggestions
      .iter()
      .any(|item| matches!(item.safety_level, SafetyLevel::Review)));
    assert!(result
      .suggestions
      .iter()
      .any(|item| matches!(item.safety_level, SafetyLevel::Manual)));

    let _ = fs::remove_dir_all(root);
  }
}
