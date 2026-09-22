#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hashing;
use hashing::*;

mod index;
use index::IndexStore;

mod android_files;
mod file_operations;
mod media_protocol;
mod operations;
mod persistence;
mod platform_preview;
mod previews;
mod scanning;

use file_operations::*;
use media_protocol::protocol_response;
use operations::*;
use persistence::*;
use platform_preview::*;
use previews::*;
use scanning::*;

use image::ImageReader;
use mime_guess::MimeGuess;
use percent_encoding::percent_decode_str;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::backtrace::Backtrace;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
enum ManagedFileSource {
  LocalPath(PathBuf),
  #[cfg(target_os = "android")]
  AndroidDocument(AndroidDocumentSource),
}

#[derive(Clone)]
enum ManagedDirectory {
  LocalPath(PathBuf),
  #[cfg(target_os = "android")]
  AndroidTree(AndroidTreeDirectory),
}

#[cfg(target_os = "android")]
#[derive(Clone)]
struct AndroidDocumentSource {
  document_uri: String,
  tree_uri: String,
  relative_path: String,
  parent_relative_path: String,
  name: String,
  mime_type: String,
  size_bytes: u64,
  modified_ms: Option<u64>,
}

#[cfg(target_os = "android")]
#[derive(Clone)]
struct AndroidTreeDirectory {
  tree_uri: String,
  label: String,
}

#[cfg(target_os = "android")]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidRestoreTarget {
  tree_uri: String,
  parent_relative_path: String,
}

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

#[derive(Default, Serialize, Deserialize)]
struct HashCache {
  entries: HashMap<String, HashCacheEntry>,
  #[serde(skip)]
  dirty: bool,
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
  map: Mutex<HashMap<String, ManagedFileSource>>,
  index: Mutex<IndexStore>,
  hash_cache: Mutex<Option<HashCache>>,
  hash_cache_path: PathBuf,
  preview_map: Mutex<HashMap<String, String>>,
  preview_jobs: Mutex<()>,
  destination: Mutex<Option<ManagedDirectory>>,
  scan_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
  scan_jobs: Mutex<()>,
  mutation_jobs: Mutex<()>,
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


const MAX_ARCHIVE_ENTRIES: usize = 200;
const MAX_RANGE_CHUNK_BYTES: u64 = 1_048_576;
const MAX_TEXT_PREVIEW_BYTES: u64 = 1_048_576;
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
    #[serde(default, rename = "allowUnsafe")]
    allow_unsafe: bool,
    file: FileEntry,
    #[serde(rename = "fromPath")]
    from_path: String,
    #[serde(rename = "toPath")]
    to_path: String,
  },
  #[serde(rename = "trash")]
  Trash {
    #[serde(default, rename = "allowUnsafe")]
    allow_unsafe: bool,
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
    #[serde(default, rename = "allowUnsafe")]
    allow_unsafe: bool,
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

#[derive(Clone, Serialize, Deserialize)]
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
struct CachedScan<Files = Vec<FileEntry>> {
  folder_path: String,
  filter_mode: String,
  include_subfolders: bool,
  include_hidden: bool,
  use_hash_for_duplicates: bool,
  duplicate_min_size_bytes: u64,
  cached_at_ms: u64,
  files: Files,
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
  #[serde(default)]
  indexed: usize,
  #[serde(default)]
  issues: Vec<ScanIssue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveResult {
  new_name: String,
  target_path: String,
  restore_source: Option<String>,
  restore_destination: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashResult {
  trash_path: Option<String>,
  restore_destination: Option<String>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDirectoryEntry {
  path: String,
  label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDirectoryListing {
  current_path: String,
  parent_path: Option<String>,
  directories: Vec<LocalDirectoryEntry>,
}

#[derive(Clone, Copy)]
enum TrashMode {
  System,
  Permanent,
}

#[cfg(target_os = "android")]
fn move_to_system_trash(_path: &Path) -> Result<(), String> {
  Err("System trash is not available on Android yet. Use permanent delete instead.".to_string())
}

#[cfg(not(target_os = "android"))]
fn move_to_system_trash(path: &Path) -> Result<(), String> {
  trash::delete(path).map_err(|error| error.to_string())
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


fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64
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
fn set_destination(
  state: tauri::State<'_, AppState>,
  destination: String,
  label: Option<String>,
) {
  let mut dest = state.destination.lock().expect("destination lock");
  *dest = Some(parse_managed_directory(destination, label));
}

#[tauri::command]
fn pick_android_directory(app_handle: AppHandle) -> Result<android_files::DirectorySelection, String> {
  #[cfg(target_os = "android")]
  {
    return android_files::pick_directory(&app_handle);
  }

  #[cfg(not(target_os = "android"))]
  let _ = app_handle;

  #[allow(unreachable_code)]
  Err("Android folder picking is unavailable on this platform.".to_string())
}

#[tauri::command]
fn list_local_directories(path: Option<String>) -> Result<LocalDirectoryListing, String> {
  #[cfg(target_os = "android")]
  let fallback_root = "/storage/emulated/0".to_string();
  #[cfg(not(target_os = "android"))]
  let fallback_root = "/".to_string();

  let current_path = path.unwrap_or(fallback_root);
  let current = PathBuf::from(&current_path);
  if !current.exists() {
    return Err("Folder not found.".to_string());
  }
  if !current.is_dir() {
    return Err("Path is not a folder.".to_string());
  }

  let mut directories = Vec::new();
  for entry in fs::read_dir(&current).map_err(|error| error.to_string())? {
    let entry = match entry {
      Ok(entry) => entry,
      Err(_) => continue,
    };
    let path = entry.path();
    let metadata = match entry.metadata() {
      Ok(metadata) => metadata,
      Err(_) => continue,
    };
    if !metadata.is_dir() {
      continue;
    }
    let label = match path.file_name().and_then(|name| name.to_str()) {
      Some(name) => name.to_string(),
      None => continue,
    };
    directories.push(LocalDirectoryEntry {
      path: path.to_string_lossy().to_string(),
      label,
    });
  }

  directories.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));

  let parent_path = current
    .parent()
    .and_then(|parent| parent.to_str())
    .map(|parent| parent.to_string())
    .filter(|parent| !parent.is_empty() && parent != &current_path);

  Ok(LocalDirectoryListing {
    current_path,
    parent_path,
    directories,
  })
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
async fn get_cached_scan(
  app_handle: AppHandle,
  request: ScanCacheRequest,
) -> Result<Option<CachedScan>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let app_data_dir = app_handle
      .path()
      .app_data_dir()
      .map_err(|error| error.to_string())?;
    let path = scan_cache_file_path(&app_data_dir, &request);
    Ok(load_cached_scan(&path))
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn store_cached_scan_result(
  app_handle: AppHandle,
  request: ScanCacheRequest,
  result: ScanResult,
) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|error| error.to_string())?;
    persist_scan_result(&app_data_dir, request, &result, None)

  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn hydrate_cached_scan(
  app_handle: AppHandle,
  request: HydrateCachedScanRequest,
) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let state = app_handle.state::<AppState>();
    let next_map = request
      .files
      .iter()
      .map(|file| {
        (
          file.id.clone(),
          ManagedFileSource::LocalPath(PathBuf::from(&file.path)),
        )
      })
      .collect::<HashMap<_, _>>();
    {
      let mut map = state.map.lock().expect("map lock");
      *map = next_map;
    }
    {
      let mut index = state.index.lock().expect("index lock");
      index.replace(request.folder_path, request.files);
    }
    state.preview_map.lock().expect("preview map lock").clear();
    Ok(())
  })
  .await
  .map_err(|error| error.to_string())?
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
async fn query_index(
  app_handle: AppHandle,
  request: QueryIndexRequest,
) -> Result<QueryIndexResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let state = app_handle.state::<AppState>();
    let mut index = state.index.lock().expect("index lock");
    Ok(index.query(request))
  })
  .await
  .map_err(|error| error.to_string())?
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
  Ok(index.get(&id).cloned())
}

#[tauri::command]
async fn read_text_preview(app_handle: AppHandle, id: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let state = app_handle.state::<AppState>();
    let source = {
      let map = state.map.lock().expect("map lock");
      map.get(&id).cloned().ok_or("File not found")?
    };
    let path = managed_source_to_local_path(&app_handle, &source)?;
    if !path.exists() {
      return Err("File not found".into());
    }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let max_len = usize::try_from(MAX_TEXT_PREVIEW_BYTES).unwrap_or(usize::MAX);
    let file = File::open(&path).map_err(|error| error.to_string())?;
    let mut buffer = Vec::with_capacity(
      usize::try_from(metadata.len().min(MAX_TEXT_PREVIEW_BYTES)).unwrap_or(max_len),
    );
    file
      .take(MAX_TEXT_PREVIEW_BYTES)
      .read_to_end(&mut buffer)
      .map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_archive_entries(app_handle: AppHandle, id: String) -> Result<ArchivePreview, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let state = app_handle.state::<AppState>();
    let source = {
      let map = state.map.lock().expect("map lock");
      map.get(&id).cloned().ok_or("File not found")?
    };
    let path = managed_source_to_local_path(&app_handle, &source)?;
    if !path.exists() {
      return Err("File not found".into());
    }

    match detect_archive_kind(&path) {
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
    }
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn extract_office_fallback_preview(
  app_handle: AppHandle,
  id: String,
) -> Result<OfficeFallbackPreview, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let state = app_handle.state::<AppState>();
    let source = {
      let map = state.map.lock().expect("map lock");
      map.get(&id).cloned().ok_or("File not found")?
    };
    let path = managed_source_to_local_path(&app_handle, &source)?;
    if !path.exists() {
      return Err("File not found".into());
    }
    extract_office_fallback(&path)
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
fn reveal_in_file_manager(path: String, reveal: bool) -> Result<(), String> {
  if cfg!(target_os = "android") {
    return Err("Opening files in the platform file manager is unavailable on Android.".into());
  }

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

fn file_age_days(metadata: &fs::Metadata) -> Option<u64> {
  let modified = metadata.modified().ok()?;
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
async fn build_cleanup_suggestions(request: SuggestionsRequest) -> Result<SuggestionSet, String> {
  tauri::async_runtime::spawn_blocking(move || collect_cleanup_suggestions(request))
    .await
    .map_err(|error| error.to_string())?
}

fn collect_cleanup_suggestions(request: SuggestionsRequest) -> Result<SuggestionSet, String> {
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

  for files in groups.values_mut() {
    if files.len() < 2 {
      continue;
    }
    files.sort_by_cached_key(|path| {
      std::cmp::Reverse(fs::metadata(path).ok().and_then(|meta| meta.modified().ok()).unwrap_or(UNIX_EPOCH))
    });
    for duplicate in files.iter().skip(1) {
      let bytes = fs::metadata(duplicate).map(|meta| meta.len()).unwrap_or(0);
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
    if is_downloads_or_installer(path) && file_age_days(&metadata).unwrap_or(0) >= stale_days {
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
    for entry in WalkDir::new(&root).into_iter()
      .filter_entry(|entry| request.include_hidden || !is_hidden_entry(entry.path(), &root))
      .filter_map(|entry| entry.ok()) {
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

  let mut seen = std::collections::HashSet::new();
  suggestions.retain(|suggestion| seen.insert(suggestion.source_path.clone()));
  if suggestions.len() > max_results {
    suggestions.truncate(max_results);
  }

  Ok(SuggestionSet {
    generated_ms: now_ms(),
    folder_path: request.folder_path,
    total_reclaimable_bytes: suggestions.iter().map(|item| item.reclaimable_bytes).sum(),
    suggestions,
  })
}

fn unique_path(destination: &Path, file_name: &str) -> PathBuf {
  let mut candidate = destination.join(file_name);
  if fs::symlink_metadata(&candidate).is_err() {
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
    if fs::symlink_metadata(&candidate).is_err() {
      return candidate;
    }
  }
  destination.join(format!("{} ({})", stem, Uuid::new_v4()))
}

#[cfg(target_os = "android")]
fn is_android_content_uri(value: &str) -> bool {
  value.starts_with("content://")
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn is_android_content_uri(_value: &str) -> bool {
  false
}

#[cfg(target_os = "android")]
fn serialize_android_restore_target(target: &AndroidRestoreTarget) -> String {
  format!(
    "android-target::{}",
    serde_json::to_string(target).unwrap_or_else(|_| "{}".to_string())
  )
}

#[cfg(not(target_os = "android"))]
#[allow(dead_code)]
fn serialize_android_restore_target(_target: &()) -> String {
  String::new()
}

#[cfg(target_os = "android")]
fn parse_android_restore_target(value: &str) -> Option<AndroidRestoreTarget> {
  value
    .strip_prefix("android-target::")
    .and_then(|json| serde_json::from_str::<AndroidRestoreTarget>(json).ok())
}

#[cfg(target_os = "android")]
fn android_source_to_local_path(app: &AppHandle, source: &AndroidDocumentSource) -> Result<PathBuf, String> {
  let cache_dir = app.path().app_cache_dir().map_err(|error| error.to_string())?;
  let export_root = cache_dir.join("android-source-cache");
  fs::create_dir_all(&export_root).map_err(|error| error.to_string())?;
  let extension = Path::new(&source.name)
    .extension()
    .and_then(|ext| ext.to_str())
    .unwrap_or("bin");
  let cache_key = Sha256::digest(
    format!(
      "{}:{}:{}:{}",
      source.document_uri,
      source.size_bytes,
      source.modified_ms.unwrap_or_default(),
      source.name
    )
    .as_bytes(),
  );
  let local_path = export_root.join(format!("{:x}.{}", cache_key, extension));
  if local_path.exists() {
    return Ok(local_path);
  }
  android_files::copy_document_to_path(
    app,
    &source.document_uri,
    &local_path.to_string_lossy(),
  )?;
  Ok(local_path)
}

fn managed_source_to_local_path(app: &AppHandle, source: &ManagedFileSource) -> Result<PathBuf, String> {
  #[cfg(not(target_os = "android"))]
  let _ = app;
  match source {
    ManagedFileSource::LocalPath(path) => Ok(path.clone()),
    #[cfg(target_os = "android")]
    ManagedFileSource::AndroidDocument(source) => android_source_to_local_path(app, source),
  }
}

#[cfg(target_os = "android")]
fn android_document_from_entry(entry: android_files::AndroidDocumentEntry) -> AndroidDocumentSource {
  AndroidDocumentSource {
    document_uri: entry.document_uri,
    tree_uri: entry.tree_uri,
    relative_path: entry.relative_path,
    parent_relative_path: entry.parent_relative_path,
    name: entry.name,
    mime_type: entry
      .mime_type
      .unwrap_or_else(|| "application/octet-stream".to_string()),
    size_bytes: entry.size_bytes,
    modified_ms: entry.modified_ms,
  }
}

#[cfg(target_os = "android")]
fn file_entry_from_android_source(id: String, folder_label: &str, source: &AndroidDocumentSource) -> FileEntry {
  let display_path = if source.relative_path.is_empty() {
    folder_label.to_string()
  } else {
    format!(
      "{}/{}",
      folder_label.trim_end_matches('/'),
      source.relative_path
    )
  };
  let kind = classify_file(Path::new(&source.name));
  let mime = if source.mime_type.trim().is_empty() {
    MimeGuess::from_path(&source.name)
      .first_or_octet_stream()
      .essence_str()
      .to_string()
  } else {
    source.mime_type.clone()
  };
  FileEntry {
    id,
    name: source.name.clone(),
    kind,
    path: display_path,
    size_bytes: source.size_bytes,
    modified_ms: source.modified_ms,
    mime,
    duplicate_group: None,
  }
}

fn local_source_path(source: &ManagedFileSource) -> Option<&Path> {
  match source {
    ManagedFileSource::LocalPath(path) => Some(path.as_path()),
    #[cfg(target_os = "android")]
    ManagedFileSource::AndroidDocument(_) => None,
  }
}

fn parse_managed_directory(destination: String, label: Option<String>) -> ManagedDirectory {
  #[cfg(target_os = "android")]
  if is_android_content_uri(&destination) {
    return ManagedDirectory::AndroidTree(AndroidTreeDirectory {
      tree_uri: destination,
      label: label.unwrap_or_else(|| "Selected folder".to_string()),
    });
  }

  #[cfg(not(target_os = "android"))]
  let _ = label;
  ManagedDirectory::LocalPath(PathBuf::from(destination))
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
  let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
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
  if is_text_extension(&extension) || is_text_file_name(file_name) {
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
    .split(['/', '\\'])
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
    "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "heic" | "heif" | "svg"
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
      | "cer"
      | "htm"
      | "html"
      | "css"
      | "scss"
      | "sass"
      | "less"
      | "js"
      | "mjs"
      | "cjs"
      | "ts"
      | "mts"
      | "cts"
      | "jsx"
      | "tsx"
      | "vue"
      | "svelte"
      | "astro"
      | "log"
      | "ini"
      | "conf"
      | "cfg"
      | "toml"
      | "properties"
      | "env"
      | "sql"
      | "graphql"
      | "gql"
      | "py"
      | "rb"
      | "php"
      | "java"
      | "kt"
      | "kts"
      | "groovy"
      | "scala"
      | "clj"
      | "cljs"
      | "edn"
      | "go"
      | "rs"
      | "c"
      | "h"
      | "cpp"
      | "cc"
      | "cxx"
      | "hpp"
      | "hh"
      | "hxx"
      | "cs"
      | "swift"
      | "dart"
      | "lua"
      | "pl"
      | "pm"
      | "r"
      | "bash"
      | "zsh"
      | "fish"
      | "psm1"
      | "psd1"
      | "cmake"
      | "m"
      | "mm"
      | "pom"
  )
}

fn is_text_file_name(file_name: &str) -> bool {
  let normalized = file_name.to_lowercase();
  normalized.starts_with(".env")
    || normalized.starts_with(".babelrc")
    || normalized.starts_with(".eslintrc.")
    || normalized.starts_with(".prettierrc.")
    || normalized.starts_with(".stylelintrc.")
    || matches!(
      normalized.as_str(),
      ".bash_profile"
        | ".bashrc"
        | ".editorconfig"
        | ".eslintrc"
        | ".gitattributes"
        | ".gitignore"
        | ".gitmodules"
        | ".npmrc"
        | ".prettierrc"
        | ".profile"
        | ".stylelintrc"
        | ".yarnrc"
        | ".zshrc"
        | "cmakelists.txt"
        | "dockerfile"
        | "gemfile"
        | "gnumakefile"
        | "justfile"
        | "makefile"
        | "procfile"
        | "rakefile"
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
    "bin" | "dat" | "db" | "sqlite" | "bak" | "pak" | "img" | "iso" | "woff" | "woff2" | "otf" | "icns"
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let context = tauri::generate_context!();
  tauri::Builder::default()
    .setup(|app| {
      #[cfg(not(target_os = "android"))]
      if let Some(window) = app.get_webview_window("main") {
        let constraints = tauri::WindowSizeConstraints {
          min_width: Some(tauri::LogicalUnit::new(350.0).into()),
          ..Default::default()
        };
        if let Err(error) = window.set_size_constraints(constraints) {
          eprintln!("Failed to set minimum window size: {error}");
        }
      }

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
      app.manage(AppState {
        map: Mutex::new(HashMap::new()),
        index: Mutex::new(IndexStore::default()),
        hash_cache: Mutex::new(None),
        hash_cache_path,
        preview_map: Mutex::new(HashMap::new()),
        preview_jobs: Mutex::new(()),
        destination: Mutex::new(None),
        scan_cancellations: Mutex::new(HashMap::new()),
        scan_jobs: Mutex::new(()),
        mutation_jobs: Mutex::new(()),
        trash_dir,
      });
      let maintenance_app = app.handle().clone();
      tauri::async_runtime::spawn_blocking(move || {
        let state = maintenance_app.state::<AppState>();
        {
          let _job = state.preview_jobs.lock().expect("preview jobs lock");
          if let Ok(cache) = maintenance_app.path().app_cache_dir() {
            if let Err(error) = cleanup_preview_sessions(&cache.join("previews")) {
              eprintln!("Preview cleanup: {}", error);
            }
          }
        }
        let _job = state.mutation_jobs.lock().expect("mutation jobs lock");
        let _ = cleanup_unreferenced_backups(&maintenance_app, &state.trash_dir);
      });
      Ok(())
    })
    .plugin(android_files::init())
    .plugin(tauri_plugin_dialog::init())
    .register_asynchronous_uri_scheme_protocol("media", |context, request, responder| {
      let app = context.app_handle().clone();
      tauri::async_runtime::spawn_blocking(move || {
        let response = protocol_response(&app, request).unwrap_or_else(|_| {
          Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .expect("response")
        });
        responder.respond(response);
      });
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
      read_text_preview,
      cancel_scan,
      build_cleanup_suggestions,
      apply_action_batch,
      undo_action_batch,
      deletion_path_warning,
      trash_file,
      trash_folder,
      move_file,
      restore_file,
      restore_folder,
      set_destination,
      pick_android_directory,
      list_local_directories,
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
          mark_session_clean_best_effort(app_handle);
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
  #[ignore = "manual performance measurement"]
  fn benchmark_index_large_folder() {
    let files = (0..10_000)
      .map(|n| {
        test_entry(
          &format!("id{n}"),
          &format!("file{n}.txt"),
          FileKind::Text,
          n,
          None,
        )
      })
      .collect();
    let mut index = IndexStore::default();
    let started = Instant::now();
    index.replace("/bench".into(), files);
    println!("index replace 10000: {:?}", started.elapsed());
    let started = Instant::now();
    for n in 10_000..10_100 {
      index.upsert(test_entry(
        &format!("id{n}"),
        &format!("file{n}.txt"),
        FileKind::Text,
        n,
        None,
      ));
    }
    println!("index upsert 100: {:?}", started.elapsed());
    for label in ["cold", "cached"] {
      let started = Instant::now();
      let result = index.query(QueryIndexRequest {
        filter_mode: None,
        selected_extensions: None,
        sort_mode: Some("name_asc".into()),
        group_mode: None,
        offset: Some(0),
        limit: Some(200),
      });
      assert_eq!(result.files.len(), 200);
      println!("index query {}: {:?}", label, started.elapsed());
    }
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
  fn classify_file_recognizes_code_and_config_text_files() {
    assert!(matches!(classify_file(Path::new("/tmp/main.rs")), FileKind::Text));
    assert!(matches!(classify_file(Path::new("/tmp/script.py")), FileKind::Text));
    assert!(matches!(classify_file(Path::new("/tmp/.env.local")), FileKind::Text));
    assert!(matches!(classify_file(Path::new("/tmp/Dockerfile")), FileKind::Text));
    assert!(matches!(classify_file(Path::new("/tmp/.gitignore")), FileKind::Text));
  }

  #[test]
  fn classify_file_recognizes_requested_preview_formats() {
    for extension in ["cer", "pom"] {
      assert!(matches!(
        classify_file(Path::new(&format!("/tmp/file.{}", extension))),
        FileKind::Text
      ));
    }
    assert!(matches!(classify_file(Path::new("/tmp/icon.svg")), FileKind::Image));
    for extension in ["woff", "woff2", "otf", "icns"] {
      assert!(matches!(
        classify_file(Path::new(&format!("/tmp/file.{}", extension))),
        FileKind::Binary
      ));
    }
    assert!(matches!(
      classify_file(Path::new("/tmp/pom.xml")),
      FileKind::Text
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
  fn empty_folder_suggestions_respect_hidden_exclusion() {
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    fs::create_dir_all(root.join(".hidden/empty")).unwrap(); fs::create_dir(root.join("visible")).unwrap();
    for hidden in [false, true] {
      let result = collect_cleanup_suggestions(SuggestionsRequest {
        folder_path: root.to_string_lossy().into_owned(), include_subfolders: true, include_hidden: hidden,
        stale_days: None, min_large_file_bytes: None, max_results: None,
      }).unwrap();
      assert_eq!(result.suggestions.len(), if hidden { 2 } else { 1 });
      if !hidden { assert!(result.suggestions.iter().all(|entry| !entry.source_path.contains(".hidden"))); }
    }
    fs::remove_dir_all(root).unwrap();
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

    let result = collect_cleanup_suggestions(SuggestionsRequest {
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
