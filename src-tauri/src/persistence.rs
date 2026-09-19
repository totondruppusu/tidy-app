//! Durable records and conservative garbage collection of undo backups.
use super::*;

pub(super) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
  atomic_write_with(path, |file| {
    file.write_all(contents).map_err(|error| error.to_string())
  })
}

fn atomic_write_with(
  path: &Path,
  write: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
  let parent = path.parent().ok_or("Record has no parent directory")?;
  fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  let temporary = parent.join(format!(".tidy-record-{}", Uuid::new_v4()));
  let result = (|| -> Result<(), String> {
    let mut file = OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&temporary)
      .map_err(|error| error.to_string())?;
    write(&mut file)?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|error| error.to_string())
  })();
  if result.is_err() {
    let _ = fs::remove_file(temporary);
  }
  result
}

// Check cancellation at buffered disk writes, rather than for every JSON token.
struct CancellableWriter<'a> {
  file: &'a mut File,
  cancelled: Option<&'a AtomicBool>,
}
impl Write for CancellableWriter<'_> {
  fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
    if self
      .cancelled
      .is_some_and(|flag| flag.load(Ordering::Relaxed))
    {
      return Err(std::io::Error::other("Scan cancelled"));
    }
    self.file.write(bytes)
  }
  fn flush(&mut self) -> std::io::Result<()> {
    self.file.flush()
  }
}

fn atomic_write_json(
  path: &Path,
  value: &impl Serialize,
  cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
  atomic_write_with(path, |file| {
    let mut writer =
      std::io::BufWriter::with_capacity(64 * 1024, CancellableWriter { file, cancelled });
    serde_json::to_writer(&mut writer, value).map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())?;
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
      return Err("Scan cancelled".into());
    }
    Ok(())
  })
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

pub(super) fn store_hash_cache(path: &Path, cache: &mut HashCache) -> Result<(), String> {
  if !cache.dirty {
    return Ok(());
  }
  atomic_write_json(path, cache, None)?;
  cache.dirty = false;
  Ok(())
}

pub(super) fn load_cached_scan(path: &Path) -> Option<CachedScan> {
  fs::read_to_string(path)
    .ok()
    .and_then(|contents| serde_json::from_str(&contents).ok())
}

pub(super) fn persist_scan_result(
  app_data_dir: &Path,
  request: ScanCacheRequest,
  result: &ScanResult,
  cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
  // A partial or cancelled scan must never replace the last complete cache.
  if !result.issues.is_empty() {
    return Ok(());
  }
  if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
    return Err("Scan cancelled".into());
  }
  let path = scan_cache_file_path(app_data_dir, &request);
  let cached = CachedScan {
    folder_path: request.folder_path,
    filter_mode: request.filter_mode,
    include_subfolders: request.include_subfolders,
    include_hidden: request.include_hidden,
    use_hash_for_duplicates: request.use_hash_for_duplicates,
    duplicate_min_size_bytes: request.duplicate_min_size_bytes,
    cached_at_ms: now_ms(),
    files: &result.files,
    total: result.total,
  };
  atomic_write_json(&path, &cached, cancelled)
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
  cache.dirty = true;
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

// Journal fields intentionally match the persisted audit record.
#[allow(clippy::too_many_arguments)]
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

#[cfg(test)]
mod scan_cache_tests {
  use super::*;

  #[test]
  fn streamed_cache_preserves_schema_and_never_replaces_good_data_with_partial_scans() {
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let request = ScanCacheRequest {
      folder_path: "/root".into(),
      filter_mode: "all".into(),
      include_subfolders: true,
      include_hidden: false,
      use_hash_for_duplicates: false,
      duplicate_min_size_bytes: 0,
    };
    let mut result = ScanResult {
      files: vec![FileEntry {
        id: "id".into(),
        path: "/root/a.txt".into(),
        name: "a.txt".into(),
        kind: FileKind::Text,
        size_bytes: 42,
        modified_ms: None,
        mime: "text/plain".into(),
        duplicate_group: None,
      }],
      total: 1,
      indexed: 1,
      issues: Vec::new(),
    };
    let cancelled = AtomicBool::new(false);
    persist_scan_result(&root, request.clone(), &result, Some(&cancelled)).unwrap();
    let path = scan_cache_file_path(&root, &request);
    let original = fs::read(&path).unwrap();
    let loaded = load_cached_scan(&path).unwrap();
    assert_eq!(loaded.files[0].name, "a.txt");
    assert_eq!(loaded.total, 1);
    assert_eq!(loaded.folder_path, "/root");
    result.issues.push(ScanIssue {
      code: "unreadable-entry".into(),
      path: None,
      message: "Denied".into(),
    });
    persist_scan_result(&root, request.clone(), &result, Some(&cancelled)).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    result.issues.clear();
    cancelled.store(true, Ordering::Relaxed);
    assert!(persist_scan_result(&root, request, &result, Some(&cancelled)).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn cancellation_during_json_serialization_preserves_record_and_removes_temporary_file() {
    struct CancelDuringSerialize<'a>(&'a AtomicBool);
    impl Serialize for CancelDuringSerialize<'_> {
      fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.store(true, Ordering::Relaxed);
        serializer.serialize_bytes(&vec![1; 128 * 1024])
      }
    }
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let path = root.join("cache.json");
    atomic_write(&path, b"previous").unwrap();
    let cancelled = AtomicBool::new(false);
    assert!(
      atomic_write_json(&path, &CancelDuringSerialize(&cancelled), Some(&cancelled)).is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), b"previous");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
  }
}

#[cfg(test)]
mod hash_cache_tests {
  use super::*;

  #[test]
  fn unchanged_caches_do_not_write_and_failed_saves_remain_retryable() {
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let path = root.join("hashes.json");
    let mut cache = HashCache::default();
    store_hash_cache(&path, &mut cache).unwrap();
    assert!(!path.exists());
    let candidate = DuplicateCandidate {
      path: "/root/a".into(),
      size_bytes: 3,
      modified_ms: Some(10),
    };
    insert_cached_full_hash(&candidate, "abc".into(), &mut cache);
    fs::write(&root, b"blocks parent directory").unwrap();
    assert!(store_hash_cache(&path, &mut cache).is_err());
    assert!(cache.dirty);
    fs::remove_file(&root).unwrap();
    store_hash_cache(&path, &mut cache).unwrap();
    assert!(!cache.dirty);
    let contents = fs::read_to_string(&path).unwrap();
    assert!(!contents.contains("dirty"));
    let mut loaded = load_hash_cache(&path);
    assert!(!loaded.dirty);
    assert_eq!(
      cached_full_hash(&candidate, &loaded).as_deref(),
      Some("abc")
    );
    fs::remove_file(&path).unwrap();
    store_hash_cache(&path, &mut loaded).unwrap();
    assert!(!path.exists(), "cache hits must not rewrite the hash cache");
    fs::remove_dir_all(root).unwrap();
  }
}

#[cfg(test)]
mod undo_policy_tests {
  use super::*;
  #[test]
  fn undo_history_preserves_protected_path_approval_and_loads_old_records() {
    let old = serde_json::json!({"kind": "trash-folder", "folderPath": "/Library/example", "trashPath": "/backup/example", "items": []});
    let action: UndoActionPayload = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(serde_json::to_value(action).unwrap()["allowUnsafe"], false);
    let mut approved = old;
    approved["allowUnsafe"] = serde_json::Value::Bool(true);
    let action: UndoActionPayload = serde_json::from_value(approved).unwrap();
    assert_eq!(serde_json::to_value(action).unwrap()["allowUnsafe"], true);
  }
}
