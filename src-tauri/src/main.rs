use mime_guess::MimeGuess;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::http::header::{HeaderMap, HeaderName, HeaderValue};
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum FileKind {
  Image,
  Video,
  Other,
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
}

struct AppState {
  map: Mutex<HashMap<String, PathBuf>>,
  destination: Mutex<Option<PathBuf>>,
  trash_dir: PathBuf,
}

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
  trash_path: String,
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

#[tauri::command]
fn set_destination(state: tauri::State<'_, AppState>, destination: String) {
  let mut dest = state.destination.lock().expect("destination lock");
  *dest = Some(PathBuf::from(destination));
}

#[tauri::command]
async fn scan_folder(
  window: tauri::Window,
  folder_path: String,
  filter_mode: String,
  include_subfolders: bool,
  scan_id: String,
) -> Result<ScanResult, String> {
  let app_handle = window.app_handle().clone();
  let window = window.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let state = app_handle.state::<AppState>();
    let mut entries = Vec::new();
    let mut map = state.map.lock().expect("map lock");
    map.clear();

    let folder = PathBuf::from(&folder_path);
    if !folder.exists() {
      return Err("Folder not found".into());
    }

    let iterator: Box<dyn Iterator<Item = PathBuf>> = if include_subfolders {
      Box::new(
        WalkDir::new(&folder)
          .follow_links(false)
          .into_iter()
          .filter_map(|entry| entry.ok())
          .filter(|entry| entry.file_type().is_file())
          .map(|entry| entry.path().to_path_buf()),
      )
    } else {
      Box::new(
        fs::read_dir(&folder)
          .map_err(|error| error.to_string())?
          .filter_map(|entry| entry.ok())
          .filter(|entry| entry.file_type().map(|ft| ft.is_file()).unwrap_or(false))
          .map(|entry| entry.path()),
      )
    };

    let filter = filter_mode.as_str();
    let mut paths = Vec::new();
    let mut scanned = 0usize;
    let mut last_emit = 0usize;
    for path in iterator {
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
    scanned = 0;
    last_emit = 0;
    let mut matched = 0usize;
    let mut batch = Vec::with_capacity(100);
    for path in paths {
      scanned += 1;
      let kind = classify_file(&path);
      if matches_filter(filter, &kind) {
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
        map.insert(id.clone(), path);
        let entry = FileEntry {
          id,
          name,
          kind,
          path: path_display,
          size_bytes,
          modified_ms,
          mime,
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
fn trash_file(state: tauri::State<'_, AppState>, id: String) -> Result<TrashResult, String> {
  let mut map = state.map.lock().expect("map lock");
  let path = map.remove(&id).ok_or("File not found")?;
  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid file name")?;
  fs::create_dir_all(&state.trash_dir).map_err(|error| error.to_string())?;
  let target_path = unique_path(&state.trash_dir, file_name);
  move_path(&path, &target_path)?;
  Ok(TrashResult {
    trash_path: target_path.to_string_lossy().to_string(),
  })
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

fn classify_file(path: &Path) -> FileKind {
  let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
  if is_image_extension(extension) {
    return FileKind::Image;
  }
  if is_video_extension(extension) {
    return FileKind::Video;
  }
  FileKind::Other
}

fn matches_filter(filter: &str, kind: &FileKind) -> bool {
  match filter {
    "images" => matches!(kind, FileKind::Image),
    "videos" => matches!(kind, FileKind::Video),
    "images_videos" => matches!(kind, FileKind::Image | FileKind::Video),
    _ => true,
  }
}

fn is_image_extension(extension: &str) -> bool {
  matches!(
    extension.to_lowercase().as_str(),
    "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "heic" | "heif"
  )
}

fn is_video_extension(extension: &str) -> bool {
  matches!(
    extension.to_lowercase().as_str(),
    "mp4" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "m4v" | "mpeg" | "mpg"
  )
}

fn parse_range(range: &str, size: u64) -> Option<(u64, u64)> {
  if !range.starts_with("bytes=") {
    return None;
  }
  let range = range.trim_start_matches("bytes=");
  let mut parts = range.split('-');
  let start = parts.next()?.trim().parse::<u64>().ok()?;
  let end = parts
    .next()
    .and_then(|value| value.trim().parse::<u64>().ok())
    .unwrap_or_else(|| std::cmp::min(start + 1_048_576, size).saturating_sub(1));
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
      if let Some((start, end)) = parse_range(range_str, size) {
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
  tauri::Builder::default()
    .setup(|app| {
      let trash_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("trash");
      fs::create_dir_all(&trash_dir).map_err(|error| error.to_string())?;
      app.manage(AppState {
        map: Mutex::new(HashMap::new()),
        destination: Mutex::new(None),
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
      scan_folder,
      trash_file,
      move_file,
      restore_file,
      set_destination,
      reveal_in_file_manager
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
