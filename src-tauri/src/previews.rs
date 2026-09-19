//! Preview generation and bounded disk cache.
use super::*;

#[tauri::command]
pub(crate) async fn generate_preview(app: AppHandle, id: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || generate_preview_blocking(app, id))
    .await
    .map_err(|error| error.to_string())?
}

fn generate_preview_blocking(app: AppHandle, id: String) -> Result<String, String> {
  let state = app.state::<AppState>();
  let _job = state
    .preview_jobs
    .lock()
    .map_err(|error| error.to_string())?;
  let source = {
    let map = state.map.lock().expect("map lock");
    map.get(&id).cloned().ok_or("File not found")?
  };
  let source_path = managed_source_to_local_path(&app, &source)?;
  if !source_path.exists() {
    return Err("File not found".into());
  }

  let existing_id = {
    let preview_map = state.preview_map.lock().expect("preview map lock");
    preview_map.get(&id).cloned()
  };
  if let Some(existing_id) = existing_id {
    let map = state.map.lock().expect("map lock");
    if let Some(existing_path) = map.get(&existing_id).and_then(local_source_path) {
      if existing_path.exists() {
        return Ok(existing_id);
      }
    }
  }

  let cache_dir = app
    .path()
    .app_cache_dir()
    .map_err(|error| error.to_string())?;
  let preview_root = cache_dir.join("previews");
  let metadata = fs::metadata(&source_path).map_err(|error| error.to_string())?;
  let preview_cache_root = preview_root.join("office-cache");
  let cached_preview_path = preview_cache_root.join(format!(
    "{}.{}",
    preview_cache_key(
      &source_path,
      metadata.len(),
      modified_ms_from_metadata(&metadata),
    ),
    if cfg!(target_os = "macos") {
      "png"
    } else {
      "pdf"
    }
  ));
  if cached_preview_path.exists() {
    let extension = cached_preview_path
      .extension()
      .and_then(|value| value.to_str())
      .unwrap_or("bin");
    let preview_id = format!("preview:{}.{}", Uuid::new_v4(), extension);
    {
      let mut map = state.map.lock().expect("map lock");
      map.insert(
        preview_id.clone(),
        ManagedFileSource::LocalPath(cached_preview_path),
      );
    }
    state
      .preview_map
      .lock()
      .expect("preview map lock")
      .insert(id, preview_id.clone());
    return Ok(preview_id);
  }
  let session_dir = preview_root.join(Uuid::new_v4().to_string());
  let preview_path = (|| -> Result<PathBuf, String> {
    fs::create_dir_all(&preview_root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&preview_cache_root).map_err(|error| error.to_string())?;
    if cached_preview_path.exists() {
      return Ok(cached_preview_path);
    }
    fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;
    let _session = PreviewSession(session_dir.clone());
    let generated = run_platform_preview(
      &session_dir,
      &source_path,
      Some(&cached_preview_path),
    )?;
    if generated != cached_preview_path {
      fs::copy(&generated, &cached_preview_path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = trim_preview_cache(
      &preview_cache_root,
      &cached_preview_path,
      256 * 1024 * 1024,
    ) {
      let _ = fs::remove_file(&cached_preview_path);
      return Err(error);
    }
    Ok(cached_preview_path)
  })()?;

  let preview_extension = preview_path
    .extension()
    .and_then(|ext| ext.to_str())
    .unwrap_or("bin");
  let preview_id = format!("preview:{}.{}", Uuid::new_v4(), preview_extension);
  {
    let mut map = state.map.lock().expect("map lock");
    map.insert(
      preview_id.clone(),
      ManagedFileSource::LocalPath(preview_path),
    );
  }
  state
    .preview_map
    .lock()
    .expect("preview map lock")
    .insert(id, preview_id.clone());
  Ok(preview_id)
}

struct PreviewSession(PathBuf);
impl Drop for PreviewSession {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn trim_preview_cache(root: &Path, retained: &Path, budget: u64) -> Result<(), String> {
  let mut entries = Vec::new();
  let mut bytes = 0u64;
  for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    let metadata = entry.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
      continue;
    }
    bytes = bytes.saturating_add(metadata.len());
    entries.push((
      metadata.modified().unwrap_or(UNIX_EPOCH),
      entry.path(),
      metadata.len(),
    ));
  }
  entries.sort_by_key(|entry| entry.0);
  for (_, path, size) in entries {
    if bytes <= budget {
      break;
    }
    if path == retained {
      continue;
    }
    fs::remove_file(path).map_err(|error| error.to_string())?;
    bytes = bytes.saturating_sub(size);
  }
  if bytes > budget {
    return Err("Generated preview exceeds the disk cache limit.".into());
  }
  Ok(())
}

pub(super) fn cleanup_preview_sessions(root: &Path) -> Result<(), String> {
  if !root.exists() {
    return Ok(());
  }
  for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    if entry.file_name() == "office-cache" {
      trim_preview_cache(&entry.path(), Path::new(""), 256 * 1024 * 1024)?;
    } else {
      remove_entry(&entry.path()).map_err(|error| error.to_string())?;
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn cache_is_bounded_and_conversion_sessions_are_removed() {
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let cache = root.join("office-cache");
    fs::create_dir_all(&cache).unwrap();
    let old = cache.join("old.pdf");
    let current = cache.join("new.pdf");
    fs::write(&old, [0; 8]).unwrap();
    fs::write(&current, [1; 8]).unwrap();
    trim_preview_cache(&cache, &current, 8).unwrap();
    assert!(!old.exists());
    assert!(current.exists());
    let session = root.join("session");
    fs::create_dir(&session).unwrap();
    {
      let _guard = PreviewSession(session.clone());
      fs::write(session.join("result"), "temp").unwrap();
    }
    assert!(!session.exists());
    fs::create_dir(root.join("crashed-session")).unwrap();
    cleanup_preview_sessions(&root).unwrap();
    assert!(!root.join("crashed-session").exists());
    assert!(current.exists());
    fs::remove_dir_all(root).unwrap();
  }
}
