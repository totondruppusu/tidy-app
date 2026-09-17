//! Scan orchestration, traversal policy, cancellation and diagnostics.
use super::*;

#[tauri::command]
pub(crate) fn cancel_scan(
  state: tauri::State<'_, AppState>,
  scan_id: String,
) -> Result<(), String> {
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
    Self {
      app_handle,
      scan_id,
    }
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
pub(crate) async fn scan_folder(
  window: tauri::Window,
  folder_path: String,
  folder_label: Option<String>,
  filter_mode: String,
  include_subfolders: bool,
  include_hidden: bool,
  use_hash_for_duplicates: bool,
  duplicate_min_size_bytes: u64,
  scan_id: String,
) -> Result<ScanResult, String> {
  #[cfg(not(target_os = "android"))]
  let _ = &folder_label;
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
    let _scan_job = state.scan_jobs.lock().map_err(|error| error.to_string())?;
    if cancel_flag.load(Ordering::Relaxed) {
      return Err("Scan cancelled".into());
    }

    #[cfg(target_os = "android")]
    if is_android_content_uri(&folder_path) {
      if filter_mode == "duplicates" {
        return Err("Duplicate scan is not supported on Android yet.".into());
      }

      let folder_label = folder_label
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Selected folder".to_string());
      let listed = android_files::list_directory(
        &app_handle,
        &folder_path,
        include_subfolders,
        include_hidden,
      )?;
      let total = listed.len();
      emit_scan_progress(&window, &scan_id, 0, 0, total, "indexing");

      let filter = filter_mode.as_str();
      let mut next_map = HashMap::new();
      let mut scanned = 0usize;
      let mut matched = 0usize;
      let mut batch = Vec::with_capacity(500);

      for listed_entry in listed {
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }

        let source = android_document_from_entry(listed_entry);
        let id = Uuid::new_v4().to_string();
        let entry = file_entry_from_android_source(id.clone(), &folder_label, &source);
        scanned += 1;
        if matches_candidate_filter(
          filter,
          &IndexedCandidate {
            path: PathBuf::from(&entry.name),
            path_display: entry.path.clone(),
            name: entry.name.clone(),
            kind: entry.kind.clone(),
            size_bytes: entry.size_bytes,
            modified_ms: entry.modified_ms,
            mime: Some(entry.mime.clone()),
          },
        ) {
          matched += 1;
          next_map.insert(id, ManagedFileSource::AndroidDocument(source));
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

        if scanned % 128 == 0 || scanned == total {
          emit_scan_progress(&window, &scan_id, scanned, matched, total, "scanning");
        }
      }

      entries.sort_by_cached_key(|entry| entry.name.to_lowercase());
      {
        let mut map = state.map.lock().expect("map lock");
        *map = next_map;
      }
      {
        let mut index = state.index.lock().expect("index lock");
        index.replace(folder_label.clone(), entries.clone());
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

      return Ok(ScanResult {
        total: entries.len(),
        files: entries,
        indexed: scanned,
        issues: Vec::new(),
      });
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
    let mut issues = Vec::new();
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
        let indexed_chunk: Vec<IndexedCandidate> = chunk_paths
          .into_par_iter()
          .map(index_scan_candidate)
          .collect();
        indexed += chunk_len;
        emit_scan_progress(&window, &scan_id, indexed, 0, discovered_total, "indexing");

        if is_duplicate_scan {
          candidates.extend(indexed_chunk);
          return Ok(());
        }

        let chunk_results =
          build_scan_entries_for_candidates(&indexed_chunk, filter, None, &cancel_flag);
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }

        scanned += indexed_chunk.len();
        matched += chunk_results.len();
        for (entry, path) in chunk_results {
          next_map.insert(entry.id.clone(), ManagedFileSource::LocalPath(path));
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

    issues.extend(visit_scan_files(
      &folder,
      include_subfolders,
      include_hidden,
      &cancel_flag,
      |path| {
        pending_paths.push(path);
        discovered += 1;
        if pending_paths.len() >= index_chunk_size {
          flush_index_chunk(&mut pending_paths, 0)?;
        }
        Ok(())
      },
    )?);
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
        let chunk_results =
          build_scan_entries_for_candidates(chunk, filter, duplicate_groups.as_ref(), &cancel_flag);
        if cancel_flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }

        scanned += chunk.len();
        matched += chunk_results.len();
        for (entry, path) in chunk_results {
          next_map.insert(entry.id.clone(), ManagedFileSource::LocalPath(path));
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

    if cancel_flag.load(Ordering::Relaxed) {
      return Err("Scan cancelled".into());
    }
    entries.sort_by_cached_key(|entry| entry.name.to_lowercase());
    state.preview_map.lock().expect("preview map lock").clear();
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
    Ok(ScanResult {
      files: entries,
      total,
      indexed,
      issues,
    })
  })
  .await
  .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn scan_folder_v2(
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
    None,
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
      indexed: result.indexed,
      matched: result.files.len(),
      duplicate_groups,
      duration_ms: started.elapsed().as_millis() as u64,
    },
    files: result.files,
    issues: result.issues,
  })
}

fn visit_scan_files(
  root: &Path,
  recursive: bool,
  hidden: bool,
  cancelled: &AtomicBool,
  mut visit: impl FnMut(PathBuf) -> Result<(), String>,
) -> Result<Vec<ScanIssue>, String> {
  let mut issues = Vec::new();
  for entry in WalkDir::new(root)
    .follow_links(false)
    .max_depth(if recursive { usize::MAX } else { 1 })
    .into_iter()
    .filter_entry(|entry| hidden || !is_hidden_entry(entry.path(), root))
  {
    if cancelled.load(Ordering::Relaxed) {
      return Err("Scan cancelled".into());
    }
    match entry {
      Ok(entry) if entry.file_type().is_file() => visit(entry.path().to_path_buf())?,
      Ok(_) => {}
      Err(error) => issues.push(ScanIssue {
        code: "unreadable-entry".into(),
        path: error.path().map(|path| path.to_string_lossy().into_owned()),
        message: error.to_string(),
      }),
    }
  }
  Ok(issues)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn traversal_reports_failures_and_honors_hidden_and_depth_settings() {
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let cancelled = AtomicBool::new(false);
    let issues = visit_scan_files(&root, true, false, &cancelled, |_| Ok(())).unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].path.as_deref(), root.to_str());
    fs::create_dir_all(root.join(".hidden")).unwrap();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join(".hidden/a.txt"), "hidden").unwrap();
    fs::write(root.join("nested/b.txt"), "nested").unwrap();
    fs::write(root.join("c.txt"), "root").unwrap();
    for (recursive, hidden, count) in [(true, false, 2), (true, true, 3), (false, true, 1)] {
      let mut files = Vec::new();
      assert!(
        visit_scan_files(&root, recursive, hidden, &cancelled, |path| {
          files.push(path);
          Ok(())
        })
        .unwrap()
        .is_empty()
      );
      assert_eq!(files.len(), count);
    }
    cancelled.store(true, Ordering::Relaxed);
    assert!(visit_scan_files(&root, true, true, &cancelled, |_| Ok(())).is_err());
    fs::remove_dir_all(root).unwrap();
  }
}
