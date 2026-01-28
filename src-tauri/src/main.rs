use mime_guess::MimeGuess;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::backtrace::Backtrace;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
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

#[derive(Clone, Serialize)]
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

#[derive(Clone, Serialize)]
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

struct AppState {
  map: Mutex<HashMap<String, PathBuf>>,
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
const QLMANAGE_POLL_MS: u64 = 100;

#[derive(Serialize)]
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
    let mut map = state.map.lock().expect("map lock");
    map.clear();
    state.preview_map.lock().expect("preview map lock").clear();

    let folder = PathBuf::from(&folder_path);
    if !folder.exists() {
      return Err("Folder not found".into());
    }

    let iterator: Box<dyn Iterator<Item = PathBuf>> = if include_subfolders {
      Box::new(
        WalkDir::new(&folder)
          .follow_links(false)
          .into_iter()
          .filter_entry(|entry| include_hidden || !is_hidden_entry(entry.path(), &folder))
          .filter_map(|entry| entry.ok())
          .filter(|entry| entry.file_type().is_file())
          .filter(|entry| include_hidden || !is_hidden_entry(entry.path(), &folder))
          .map(|entry| entry.path().to_path_buf()),
      )
    } else {
      Box::new(
        fs::read_dir(&folder)
          .map_err(|error| error.to_string())?
          .filter_map(|entry| entry.ok())
          .filter(|entry| entry.file_type().map(|ft| ft.is_file()).unwrap_or(false))
          .filter(|entry| include_hidden || !is_hidden_entry(&entry.path(), &folder))
          .map(|entry| entry.path()),
      )
    };

    let filter = filter_mode.as_str();
    let mut paths = Vec::new();
    let mut scanned = 0usize;
    let mut last_emit = 0usize;
    for path in iterator {
      if cancel_flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
      scanned += 1;
      paths.push(path);
      if scanned.saturating_sub(last_emit) >= 300 {
        let _ = window.emit(
          "scan_progress",
          ScanProgress {
            scan_id: scan_id.clone(),
            scanned,
            matched: 0,
            total: 0,
            phase: "indexing".to_string(),
          },
        );
        last_emit = scanned;
      }
    }

    if scanned != last_emit {
      let _ = window.emit(
        "scan_progress",
        ScanProgress {
          scan_id: scan_id.clone(),
          scanned,
          matched: 0,
          total: 0,
          phase: "indexing".to_string(),
        },
      );
    }

    let total = paths.len();
    let duplicate_groups = if filter == "duplicates" {
      if cancel_flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
      Some(find_duplicate_groups(
        &paths,
        use_hash_for_duplicates,
        duplicate_min_size_bytes,
        Some(&cancel_flag),
      )?)
    } else {
      None
    };
    scanned = 0;
    last_emit = 0;
    let mut matched = 0usize;
    let mut batch = Vec::with_capacity(100);
    for path in paths {
      if cancel_flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
      scanned += 1;
      let kind = classify_file(&path);
      let is_match = if let Some(duplicates) = duplicate_groups.as_ref() {
        duplicates.contains_key(&path)
      } else {
        matches_filter(filter, &kind)
      };
      if is_match {
        let name = path
          .file_name()
          .and_then(|name| name.to_str())
          .unwrap_or("Unknown")
          .to_string();
        let path_display = path.to_string_lossy().to_string();
        let metadata = fs::metadata(&path).ok();
        let size_bytes = metadata.as_ref().map(|meta| meta.len()).unwrap_or(0);
        let modified_ms = metadata
          .as_ref()
          .and_then(|meta| meta.modified().ok())
          .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
          .map(|duration| duration.as_millis() as u64);
        let mime = MimeGuess::from_path(&path)
          .first_or_octet_stream()
          .essence_str()
          .to_string();
        let id = Uuid::new_v4().to_string();
        let duplicate_group = duplicate_groups
          .as_ref()
          .and_then(|duplicates| duplicates.get(&path).cloned());
        map.insert(id.clone(), path);
        let entry = FileEntry {
          id,
          name,
          kind,
          path: path_display,
          size_bytes,
          modified_ms,
          mime,
          duplicate_group,
        };
        entries.push(entry.clone());
        batch.push(entry);
        matched += 1;
        if batch.len() >= 100 {
          let _ = window.emit(
            "scan_batch",
            ScanBatch {
              scan_id: scan_id.clone(),
              files: std::mem::take(&mut batch),
            },
          );
        }
      }
      if scanned.saturating_sub(last_emit) >= 200 {
        let _ = window.emit(
          "scan_progress",
          ScanProgress {
            scan_id: scan_id.clone(),
            scanned,
            matched,
            total,
            phase: "scanning".to_string(),
          },
        );
        last_emit = scanned;
      }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    if scanned != last_emit {
      let _ = window.emit(
        "scan_progress",
        ScanProgress {
          scan_id: scan_id.clone(),
          scanned,
          matched,
          total,
          phase: "scanning".to_string(),
        },
      );
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
fn trash_file(
  state: tauri::State<'_, AppState>,
  id: String,
  trash_mode: String,
) -> Result<TrashResult, String> {
  let mode = parse_trash_mode(&trash_mode);
  let mut map = state.map.lock().expect("map lock");
  let path = map.remove(&id).ok_or("File not found")?;
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
        return Err(error.to_string());
      }
      Ok(TrashResult {
        trash_path: Some(target_path.to_string_lossy().to_string()),
      })
    }
    TrashMode::Permanent => {
      fs::remove_file(&path).map_err(|error| error.to_string())?;
      Ok(TrashResult { trash_path: None })
    }
  }
}

#[tauri::command]
fn trash_folder(
  state: tauri::State<'_, AppState>,
  folder_path: String,
  files: Vec<FolderTrashEntry>,
  trash_mode: String,
) -> Result<TrashResult, String> {
  let mode = parse_trash_mode(&trash_mode);
  let source_path = PathBuf::from(folder_path);
  if !source_path.exists() {
    return Err("Folder not found".into());
  }
  if !source_path.is_dir() {
    return Err("Target is not a folder".into());
  }
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
        return Err(error.to_string());
      }
      let mut map = state.map.lock().expect("map lock");
      files.iter().for_each(|entry| {
        map.remove(&entry.id);
      });
      Ok(TrashResult {
        trash_path: Some(target_path.to_string_lossy().to_string()),
      })
    }
    TrashMode::Permanent => {
      fs::remove_dir_all(&source_path).map_err(|error| error.to_string())?;
      let mut map = state.map.lock().expect("map lock");
      files.iter().for_each(|entry| {
        map.remove(&entry.id);
      });
      Ok(TrashResult { trash_path: None })
    }
  }
}

#[tauri::command]
fn move_file(state: tauri::State<'_, AppState>, id: String) -> Result<MoveResult, String> {
  let destination = state
    .destination
    .lock()
    .expect("destination lock")
    .clone()
    .ok_or("Destination not set")?;

  let mut map = state.map.lock().expect("map lock");
  let source = map.remove(&id).ok_or("File not found")?;
  let file_name = source
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid file name")?;

  let target_path = unique_path(&destination, file_name);

  move_path(&source, &target_path)?;

  let new_name = target_path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid target name")?
    .to_string();

  Ok(MoveResult {
    new_name,
    target_path: target_path.to_string_lossy().to_string(),
  })
}

#[tauri::command]
fn restore_file(
  state: tauri::State<'_, AppState>,
  id: String,
  source: String,
  destination: String,
) -> Result<(), String> {
  let source_path = PathBuf::from(source);
  if !source_path.exists() {
    return Err("Source file not found.".into());
  }
  let destination_path = PathBuf::from(destination);
  if destination_path.exists() {
    return Err("Restore target already exists.".into());
  }
  if let Some(parent) = destination_path.parent() {
    if !parent.exists() {
      return Err("Restore folder no longer exists.".into());
    }
  }
  move_path(&source_path, &destination_path)?;
  let mut map = state.map.lock().expect("map lock");
  map.insert(id, destination_path);
  Ok(())
}

#[tauri::command]
fn restore_folder(
  state: tauri::State<'_, AppState>,
  source: String,
  destination: String,
  files: Vec<FolderTrashEntry>,
) -> Result<(), String> {
  let source_path = PathBuf::from(source);
  if !source_path.exists() {
    return Err("Source folder not found.".into());
  }
  let destination_path = PathBuf::from(destination);
  if destination_path.exists() {
    return Err("Restore target already exists.".into());
  }
  if let Some(parent) = destination_path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  move_dir(&source_path, &destination_path)?;
  let mut map = state.map.lock().expect("map lock");
  files.iter().for_each(|entry| {
    map.insert(entry.id.clone(), destination_path.join(&entry.relative_path));
  });
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

  if !cfg!(target_os = "macos") {
    return Err("Preview generation is only supported on macOS.".into());
  }

  let cache_dir = app.path().app_cache_dir().map_err(|error| error.to_string())?;
  let preview_root = cache_dir.join("previews");
  let session_dir = preview_root.join(Uuid::new_v4().to_string());
  let source_path_clone = source_path.clone();
  let preview_path = tauri::async_runtime::spawn_blocking(move || {
    fs::create_dir_all(&preview_root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;
    run_qlmanage_preview(&session_dir, &source_path_clone)
  })
  .await
  .map_err(|error| error.to_string())??;

  let preview_id = format!("preview:{}", Uuid::new_v4());
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
    Ok(status) => Err(format!("File manager exited with {}", status)),
    Err(error) => Err(error.to_string()),
  }
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
  let mut size_map: HashMap<u64, Vec<PathBuf>> = HashMap::new();
  for path in paths {
    if let Some(flag) = cancel_flag {
      if flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
    }
    if let Ok(metadata) = fs::metadata(path) {
      let size = metadata.len();
      if size < min_size_bytes {
        continue;
      }
      size_map.entry(size).or_default().push(path.clone());
    }
  }

  let mut duplicates = HashMap::new();
  for (size, group) in size_map {
    if let Some(flag) = cancel_flag {
      if flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
    }
    if group.len() < 2 {
      continue;
    }
    if use_hash {
      let mut hash_map: HashMap<String, Vec<PathBuf>> = HashMap::new();
      for path in &group {
        if let Some(flag) = cancel_flag {
          if flag.load(Ordering::Relaxed) {
            return Err("Scan cancelled".into());
          }
        }
        if let Ok(hash) = hash_file(path) {
          hash_map.entry(hash).or_default().push(path.clone());
        }
      }
      for (hash, files) in hash_map {
        if files.len() > 1 {
          for path in files {
            duplicates.insert(path.clone(), hash.clone());
          }
        }
      }
    } else {
      let group_key = format!("size-{}", size);
      for path in group {
        duplicates.insert(path.clone(), group_key.clone());
      }
    }
  }
  Ok(duplicates)
}

fn is_hidden_entry(path: &Path, root: &Path) -> bool {
  if path == root {
    return false;
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

  let timeout = Duration::from_secs(QLMANAGE_TIMEOUT_SECS);
  let start = Instant::now();
  loop {
    if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
      if !status.success() {
        return Err("Preview generation failed.".into());
      }
      break;
    }
    if start.elapsed() >= timeout {
      let _ = child.kill();
      let _ = child.wait();
      return Err("Preview generation timed out.".into());
    }
    std::thread::sleep(Duration::from_millis(QLMANAGE_POLL_MS));
  }

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
  let start = parts.next()?.trim().parse::<u64>().ok()?;
  let end = match parts.next().map(|value| value.trim()) {
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
  if start > end || start >= size {
    return None;
  }
  let end = std::cmp::min(end, size.saturating_sub(1));
  Some((start, end))
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
      let max_range_length = if content_type.starts_with("image/") {
        None
      } else {
        Some(MAX_RANGE_CHUNK_BYTES)
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
      fs::create_dir_all(&trash_dir).map_err(|error| error.to_string())?;
      fs::create_dir_all(&crash_dir).map_err(|error| error.to_string())?;
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
      update_heartbeat,
      scan_folder,
      cancel_scan,
      trash_file,
      trash_folder,
      move_file,
      restore_file,
      restore_folder,
      set_destination,
      list_archive_entries,
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
}
