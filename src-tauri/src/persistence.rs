//! Durable records and conservative garbage collection of undo backups.
use super::*;

pub(super) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
  let parent = path.parent().ok_or("Record has no parent directory")?;
  fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  let temporary = parent.join(format!(".tidy-record-{}", Uuid::new_v4()));
  let result = (|| -> std::io::Result<()> {
    let mut file = OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&temporary)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    Ok(())
  })();
  if result.is_err() {
    let _ = fs::remove_file(temporary);
  }
  result.map_err(|error| error.to_string())
}

pub(super) fn cleanup_unreferenced_backups(
  app: &AppHandle,
  trash_dir: &Path,
) -> Result<(), String> {
  // A damaged record must not cause its backups to be deleted. Skip collection
  // entirely when references cannot be read; records remain available for recovery.
  let result = (|| -> Result<(), String> {
    let mut referenced = Vec::new();
    for action in load_recent_undo_actions(app)? {
      match action {
        UndoActionPayload::Trash { trash_path, .. }
        | UndoActionPayload::TrashFolder { trash_path, .. } => {
          referenced.push(PathBuf::from(trash_path))
        }
        _ => {}
      }
    }
    for entry in fs::read_dir(batch_record_dir(app)?).map_err(|error| error.to_string())? {
      let entry = entry.map_err(|error| error.to_string())?;
      if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
        continue;
      }
      let record: UndoBatchRecord =
        serde_json::from_slice(&fs::read(entry.path()).map_err(|error| error.to_string())?)
          .map_err(|error| error.to_string())?;
      referenced.extend(
        record
          .actions
          .iter()
          .filter(|action| action.action_type == "trash")
          .filter_map(|action| action.rollback_source.as_ref().map(PathBuf::from)),
      );
    }
    collect_backup_garbage(
      trash_dir,
      &referenced,
      SystemTime::now(),
      Duration::from_secs(7 * 24 * 60 * 60),
    )
  })();
  if let Err(error) = result {
    eprintln!("Skipped undo backup cleanup: {}", error);
  }
  Ok(())
}

fn collect_backup_garbage(
  directory: &Path,
  referenced: &[PathBuf],
  now: SystemTime,
  grace: Duration,
) -> Result<(), String> {
  for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    if referenced.iter().any(|path| path.starts_with(entry.path())) {
      continue;
    }
    let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
    let age = metadata
      .modified()
      .ok()
      .and_then(|modified| now.duration_since(modified).ok());
    if age.map(|age| age >= grace).unwrap_or(false) {
      remove_entry(&entry.path()).map_err(|error| error.to_string())?;
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn backups_referenced_by_undo_survive_cleanup_and_orphans_expire() {
    let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
    fs::create_dir(&dir).unwrap();
    let retained = dir.join("retained");
    let orphan = dir.join("orphan");
    fs::write(&retained, "backup").unwrap();
    fs::write(&orphan, "orphan").unwrap();
    collect_backup_garbage(
      &dir,
      &[retained.clone()],
      SystemTime::now(),
      Duration::from_secs(60),
    )
    .unwrap();
    assert!(orphan.exists());
    collect_backup_garbage(
      &dir,
      &[retained.clone()],
      SystemTime::now() + Duration::from_secs(120),
      Duration::from_secs(60),
    )
    .unwrap();
    assert!(retained.exists());
    assert!(!orphan.exists());
    fs::remove_dir_all(dir).unwrap();
  }
  #[test]
  fn record_replacement_is_complete_and_leaves_no_temporary_files() {
    let dir = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let path = dir.join("undo.json");
    atomic_write(&path, b"old").unwrap();
    atomic_write(&path, b"new").unwrap();
    assert_eq!(fs::read(path).unwrap(), b"new");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
  }
}

pub(super) fn history_file_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
  app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|dir| dir.join(OPERATION_HISTORY_FILE))
}

pub(super) fn undo_actions_file_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
  app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|dir| dir.join(UNDO_ACTIONS_FILE))
}

pub(super) fn batch_record_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
  app_handle
    .path()
    .app_data_dir()
    .map_err(|error| error.to_string())
    .map(|dir| dir.join(APPLIED_BATCHES_DIR))
}

pub(super) fn hash_cache_file_path(app_data_dir: &Path) -> PathBuf {
  app_data_dir.join(HASH_CACHE_FILE)
}

pub(super) fn scan_cache_dir(app_data_dir: &Path) -> PathBuf {
  app_data_dir.join(SCAN_CACHE_DIR)
}

pub(super) fn scan_cache_key(request: &ScanCacheRequest) -> String {
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

pub(super) fn scan_cache_file_path(app_data_dir: &Path, request: &ScanCacheRequest) -> PathBuf {
  scan_cache_dir(app_data_dir).join(format!("{}.json", scan_cache_key(request)))
}

pub(super) fn load_hash_cache(path: &Path) -> HashCache {
  fs::read_to_string(path)
    .ok()
    .and_then(|data| serde_json::from_str(&data).ok())
    .unwrap_or_default()
}

pub(super) fn store_hash_cache(path: &Path, cache: &HashCache) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string(cache).map_err(|error| error.to_string())?;
  atomic_write(&path, serialized.as_bytes())
}

pub(super) fn load_cached_scan(path: &Path) -> Option<CachedScan> {
  fs::read_to_string(path)
    .ok()
    .and_then(|contents| serde_json::from_str(&contents).ok())
}

pub(super) fn store_cached_scan(path: &Path, cached_scan: &CachedScan) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let serialized = serde_json::to_string(cached_scan).map_err(|error| error.to_string())?;
  atomic_write(&path, serialized.as_bytes())
}

pub(super) fn modified_ms_from_metadata(metadata: &fs::Metadata) -> Option<u64> {
  metadata
    .modified()
    .ok()
    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis() as u64)
}

pub(super) fn hash_cache_key(path: &Path, size_bytes: u64, modified_ms: Option<u64>) -> String {
  format!(
    "{}|{}|{}",
    path.to_string_lossy(),
    size_bytes,
    modified_ms.unwrap_or(0)
  )
}

pub(super) fn preview_cache_key(path: &Path, size_bytes: u64, modified_ms: Option<u64>) -> String {
  let mut hasher = Sha256::new();
  hasher.update(hash_cache_key(path, size_bytes, modified_ms).as_bytes());
  format!("{:x}", hasher.finalize())
}

pub(super) fn cached_full_hash(
  candidate: &DuplicateCandidate,
  cache: &HashCache,
) -> Option<String> {
  let key = hash_cache_key(&candidate.path, candidate.size_bytes, candidate.modified_ms);
  let entry = cache.entries.get(&key)?;
  if entry.size_bytes == candidate.size_bytes && entry.modified_ms == candidate.modified_ms {
    return Some(entry.hash.clone());
  }
  None
}

pub(super) fn insert_cached_full_hash(
  candidate: &DuplicateCandidate,
  hash: String,
  cache: &mut HashCache,
) {
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

pub(super) fn append_operation_journal(
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

pub(super) fn load_operation_history(
  app_handle: &AppHandle,
) -> Result<Vec<OperationJournalEntry>, String> {
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

pub(super) fn load_recent_undo_actions(
  app_handle: &AppHandle,
) -> Result<Vec<UndoActionPayload>, String> {
  let path = undo_actions_file_path(app_handle)?;
  if !path.exists() {
    return Ok(Vec::new());
  }
  let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
  serde_json::from_str(&contents).map_err(|error| error.to_string())
}

pub(super) fn store_recent_undo_actions_internal(
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
  atomic_write(&path, serialized.as_bytes())
}
