//! Tauri mutation commands: filesystem service, index commits and undo records.
use super::*;

#[tauri::command]
pub(crate) fn trash_file(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  id: String,
  trash_mode: String,
  allow_unsafe: Option<bool>,
) -> Result<TrashResult, String> {
  let allow_unsafe = allow_unsafe.unwrap_or(false);
  let mode = parse_trash_mode(&trash_mode);
  let mut map = state.map.lock().expect("map lock");
  let source = map.get(&id).cloned().ok_or("File not found")?;
  match source {
    ManagedFileSource::LocalPath(path) => {
      let operation = match mode {
        TrashMode::System => LocalOperation::Trash,
        TrashMode::Permanent => LocalOperation::Delete,
      };
      let outcome = execute_local_operation(&path, operation, &state.trash_dir, allow_unsafe);
      let _ = append_operation_journal(
        &app_handle,
        "trash_file",
        if outcome.is_ok() { "success" } else { "error" },
        Some(trash_mode),
        Some(path.to_string_lossy().into_owned()),
        outcome.as_ref().ok().and_then(|path| {
          path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
        }),
        Some("safe".into()),
        outcome.as_ref().err().cloned(),
        None,
      );
      let backup = outcome?;
      map.remove(&id);
      state.index.lock().expect("index lock").remove(&id);
      Ok(TrashResult {
        trash_path: backup.map(|path| path.to_string_lossy().into_owned()),
        restore_destination: None,
      })
    }
    #[cfg(target_os = "android")]
    ManagedFileSource::AndroidDocument(source) => {
      let restore_destination = serialize_android_restore_target(&AndroidRestoreTarget {
        tree_uri: source.tree_uri.clone(),
        parent_relative_path: source.parent_relative_path.clone(),
      });
      match mode {
        TrashMode::System => {
          fs::create_dir_all(&state.trash_dir).map_err(|error| error.to_string())?;
          let target_path = unique_path(&state.trash_dir, &source.name);
          if let Err(error) = android_files::copy_document_to_path(
            &app_handle,
            &source.document_uri,
            &target_path.to_string_lossy(),
          ) {
            map.insert(id, ManagedFileSource::AndroidDocument(source.clone()));
            return Err(error);
          }
          if let Err(error) = android_files::delete_document(&app_handle, &source.document_uri) {
            let _ = fs::remove_file(&target_path);
            map.insert(id, ManagedFileSource::AndroidDocument(source.clone()));
            return Err(error);
          }
          map.remove(&id);
          state.index.lock().expect("index lock").remove(&id);
          Ok(TrashResult {
            trash_path: Some(target_path.to_string_lossy().to_string()),
            restore_destination: Some(restore_destination),
          })
        }
        TrashMode::Permanent => {
          if !allow_unsafe {
            map.insert(id, ManagedFileSource::AndroidDocument(source.clone()));
            return Err("Permanent delete requires advanced override.".into());
          }
          android_files::delete_document(&app_handle, &source.document_uri)?;
          map.remove(&id);
          state.index.lock().expect("index lock").remove(&id);
          Ok(TrashResult {
            trash_path: None,
            restore_destination: None,
          })
        }
      }
    }
  }
}

#[tauri::command]
pub(crate) fn trash_folder(
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
  let operation = match mode {
    TrashMode::System => LocalOperation::Trash,
    TrashMode::Permanent => LocalOperation::Delete,
  };
  let backup = execute_local_operation(&source_path, operation, &state.trash_dir, allow_unsafe)?;
  let mut map = state.map.lock().expect("map lock");
  map.retain(|_, source| {
    !local_source_path(source)
      .map(|path| path.starts_with(&source_path))
      .unwrap_or(false)
  });
  state
    .index
    .lock()
    .expect("index lock")
    .remove_subtree(&source_path);
  let _ = files;
  let _ = append_operation_journal(
    &app_handle,
    "trash_folder",
    "success",
    Some(trash_mode),
    Some(folder_path),
    backup
      .as_ref()
      .map(|path| path.to_string_lossy().into_owned()),
    Some("safe".into()),
    None,
    None,
  );
  Ok(TrashResult {
    trash_path: backup.map(|path| path.to_string_lossy().into_owned()),
    restore_destination: None,
  })
}

#[tauri::command]
pub(crate) fn move_file(
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
  let source = map.get(&id).cloned().ok_or("File not found")?;
  match (source, destination) {
    (ManagedFileSource::LocalPath(source), ManagedDirectory::LocalPath(destination)) => {
      if let Err(error) = ensure_existing_path(&source, allow_unsafe) {
        map.insert(id.clone(), ManagedFileSource::LocalPath(source));
        return Err(error);
      }
      let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file name")?;

      let target_path = unique_path(&destination, file_name);
      if let Err(error) = ensure_destination_writable(&target_path, allow_unsafe) {
        map.insert(id.clone(), ManagedFileSource::LocalPath(source));
        return Err(error);
      }

      if let Err(error) = execute_local_operation(
        &source,
        LocalOperation::Move(&target_path),
        &state.trash_dir,
        allow_unsafe,
      ) {
        map.insert(id, ManagedFileSource::LocalPath(source));
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

      map.remove(&id);
      state.index.lock().expect("index lock").remove(&id);

      Ok(MoveResult {
        new_name,
        target_path: target_path.to_string_lossy().to_string(),
        restore_source: Some(target_path.to_string_lossy().to_string()),
        restore_destination: Some(source.to_string_lossy().to_string()),
      })
    }
    #[cfg(target_os = "android")]
    (ManagedFileSource::AndroidDocument(source), ManagedDirectory::AndroidTree(destination)) => {
      let moved = android_files::move_document(
        &app_handle,
        &source.document_uri,
        &destination.tree_uri,
        "",
        &source.name,
        &source.mime_type,
      )?;
      map.remove(&id);
      state.index.lock().expect("index lock").remove(&id);
      Ok(MoveResult {
        new_name: moved.new_name.clone(),
        target_path: format!("{}/{}", destination.label, moved.new_name),
        restore_source: Some(moved.document_uri),
        restore_destination: Some(serialize_android_restore_target(&AndroidRestoreTarget {
          tree_uri: source.tree_uri,
          parent_relative_path: source.parent_relative_path,
        })),
      })
    }
    #[cfg(target_os = "android")]
    (source, _) => {
      map.insert(id, source);
      Err("Moving between desktop and Android storage is not supported.".into())
    }
  }
}

#[tauri::command]
pub(crate) fn restore_file(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  id: String,
  source: String,
  destination: String,
  file_name: Option<String>,
  mime_type: Option<String>,
  display_path: Option<String>,
  size_bytes: Option<u64>,
  modified_ms: Option<u64>,
  allow_unsafe: Option<bool>,
) -> Result<(), String> {
  let allow_unsafe = allow_unsafe.unwrap_or(false);
  #[cfg(not(target_os = "android"))]
  let _ = (
    &file_name,
    &mime_type,
    &display_path,
    &size_bytes,
    &modified_ms,
  );
  #[cfg(target_os = "android")]
  if let Some(target) = parse_android_restore_target(&destination) {
    let file_name = file_name.ok_or("Missing file name for Android restore.")?;
    let mime_type = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());
    let restored = if is_android_content_uri(&source) {
      android_files::restore_document(
        &app_handle,
        &source,
        &target.tree_uri,
        &target.parent_relative_path,
        &file_name,
        &mime_type,
      )?
    } else {
      let source_path = PathBuf::from(&source);
      ensure_existing_path(&source_path, allow_unsafe)?;
      let restored = android_files::restore_cached_file(
        &app_handle,
        &source,
        &target.tree_uri,
        &target.parent_relative_path,
        &file_name,
        &mime_type,
      )?;
      let _ = fs::remove_file(&source_path);
      restored
    };
    let relative_path = if target.parent_relative_path.is_empty() {
      file_name.clone()
    } else {
      format!("{}/{}", target.parent_relative_path, file_name)
    };
    let restored_source = AndroidDocumentSource {
      document_uri: restored.document_uri,
      tree_uri: target.tree_uri.clone(),
      relative_path,
      parent_relative_path: target.parent_relative_path.clone(),
      name: file_name.clone(),
      mime_type: mime_type.clone(),
      size_bytes: size_bytes.unwrap_or(0),
      modified_ms,
    };
    let display_path = display_path.unwrap_or_else(|| file_name.clone());
    let mut map = state.map.lock().expect("map lock");
    map.insert(
      id.clone(),
      ManagedFileSource::AndroidDocument(restored_source.clone()),
    );
    state.index.lock().expect("index lock").upsert(FileEntry {
      id,
      name: file_name,
      kind: classify_file(Path::new(&display_path)),
      path: display_path.clone(),
      size_bytes: size_bytes.unwrap_or(0),
      modified_ms,
      mime: mime_type,
      duplicate_group: None,
    });
    let _ = append_operation_journal(
      &app_handle,
      "restore_file",
      "success",
      Some("restore".to_string()),
      Some(source.clone()),
      Some(display_path),
      Some("safe".to_string()),
      None,
      None,
    );
    return Ok(());
  }

  let source_path = PathBuf::from(source);
  ensure_existing_path(&source_path, allow_unsafe)?;
  let destination_path = PathBuf::from(destination);
  if destination_path.exists() {
    return Err("Restore target already exists.".into());
  }
  restore_path(&source_path, &destination_path, allow_unsafe)?;
  let destination_display = destination_path.to_string_lossy().to_string();
  let mut map = state.map.lock().expect("map lock");
  map.insert(
    id.clone(),
    ManagedFileSource::LocalPath(destination_path.clone()),
  );
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
pub(crate) fn restore_folder(
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
  restore_path(&source_path, &destination_path, allow_unsafe)?;
  let mut map = state.map.lock().expect("map lock");
  let mut restored_files = Vec::new();
  files.iter().for_each(|entry| {
    let path = destination_path.join(&entry.relative_path);
    map.insert(entry.id.clone(), ManagedFileSource::LocalPath(path.clone()));
    restored_files.push(file_entry_from_path(entry.id.clone(), &path));
  });
  {
    let mut index = state.index.lock().expect("index lock");
    restored_files
      .into_iter()
      .for_each(|file| index.upsert(file));
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

pub(super) fn batch_record_file_path(
  app_handle: &AppHandle,
  batch_id: &str,
) -> Result<PathBuf, String> {
  let directory = batch_record_dir(app_handle)?;
  fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
  Ok(directory.join(format!("{}.json", batch_id)))
}

pub(super) fn store_batch_record(
  app_handle: &AppHandle,
  record: &UndoBatchRecord,
) -> Result<(), String> {
  let path = batch_record_file_path(app_handle, &record.batch_id)?;
  let serialized = serde_json::to_string_pretty(record).map_err(|error| error.to_string())?;
  atomic_write(&path, serialized.as_bytes())
}

pub(super) fn load_batch_record(
  app_handle: &AppHandle,
  batch_id: &str,
) -> Result<UndoBatchRecord, String> {
  let path = batch_record_file_path(app_handle, batch_id)?;
  let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
  serde_json::from_str(&contents).map_err(|error| error.to_string())
}

pub(super) fn remove_batch_record(app_handle: &AppHandle, batch_id: &str) -> Result<(), String> {
  let path = batch_record_file_path(app_handle, batch_id)?;
  if path.exists() {
    fs::remove_file(path).map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
pub(crate) fn apply_action_batch(
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

    let source_is_dir = source.is_dir();
    let operation_outcome = (|| -> Result<(bool, String), String> {
      match action.action_type.as_str() {
        "move" => {
          let destination = match action.destination_path.as_ref() {
            Some(path) => PathBuf::from(path),
            None => return Err("Move action requires destinationPath.".to_string()),
          };
          execute_local_operation(
            &source,
            LocalOperation::Move(&destination),
            &state.trash_dir,
            allow_unsafe,
          )?;
          undo_actions.push(UndoBatchAction {
            action_type: "move".to_string(),
            source_path: destination.to_string_lossy().to_string(),
            rollback_source: Some(source.to_string_lossy().to_string()),
          });
          Ok((true, destination.to_string_lossy().to_string()))
        }
        "trash" => {
          let backup_path = execute_local_operation(
            &source,
            LocalOperation::Trash,
            &state.trash_dir,
            allow_unsafe,
          )?
          .ok_or("Missing trash backup")?;
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
          // Explicit permanent-delete authorization is separate from protected-path override.
          ensure_existing_path(&source, allow_unsafe)?;
          execute_local_operation(&source, LocalOperation::Delete, &state.trash_dir, true)?;
          Ok((false, String::new()))
        }
        _ => Err("Unsupported action type.".to_string()),
      }
    })();

    match operation_outcome {
      Ok((undoable, destination)) => {
        if undoable {
          store_batch_record(
            &app_handle,
            &UndoBatchRecord {
              batch_id: batch_id.clone(),
              created_ms: now_ms(),
              actions: undo_actions.clone(),
            },
          )?;
        }
        applied += 1;
        {
          let mut index = state.index.lock().expect("index lock");
          match action.action_type.as_str() {
            "move" | "trash" | "delete" => {
              if source_is_dir {
                index.remove_subtree(&source);
              } else {
                index.remove_path(&source);
              }
            }
            "remove-empty-folder" => index.remove_subtree(&source),
            _ => {}
          }
        }
        state.map.lock().expect("map lock").retain(|_, value| {
          local_source_path(value)
            .map(|path| {
              if source_is_dir {
                !path.starts_with(&source)
              } else {
                path != source
              }
            })
            .unwrap_or(true)
        });
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
    store_batch_record(&app_handle, &record)?;
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
pub(crate) fn undo_action_batch(
  app_handle: AppHandle,
  state: tauri::State<'_, AppState>,
  batch_id: String,
) -> Result<UndoBatchResult, String> {
  let mut record = load_batch_record(&app_handle, &batch_id)?;
  let mut restored = 0usize;
  let mut failed = 0usize;
  let mut messages = Vec::new();

  let (restored_count, failed_count, undo_messages) = restore_batch_record(
    &mut record,
    |record| store_batch_record(&app_handle, record),
    |path| {
      let mapped = {
        let mut index = state.index.lock().expect("index lock");
        upsert_index_path_or_tree(&mut index, path)
      };
      let mut map = state.map.lock().expect("map lock");
      for (id, path) in mapped {
        map.insert(id, ManagedFileSource::LocalPath(path));
      }
    },
  )?;
  restored += restored_count;
  failed += failed_count;
  messages.extend(undo_messages);
  if failed == 0 {
    remove_batch_record(&app_handle, &batch_id)?;
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

fn restore_batch_record(
  record: &mut UndoBatchRecord,
  mut persist: impl FnMut(&UndoBatchRecord) -> Result<(), String>,
  mut on_restored: impl FnMut(&Path),
) -> Result<(usize, usize, Vec<String>), String> {
  let mut restored = 0;
  let mut failed = 0;
  let mut messages = Vec::new();
  for index in (0..record.actions.len()).rev() {
    let action = record.actions[index].clone();
    let result = (|| -> Result<PathBuf, String> {
      let rollback = action
        .rollback_source
        .as_ref()
        .ok_or("Missing rollback path")?;
      let (source, target) = match action.action_type.as_str() {
        "move" => (Path::new(&action.source_path), Path::new(rollback)),
        "trash" => (Path::new(rollback), Path::new(&action.source_path)),
        _ => return Err("Unsupported undo operation".into()),
      };
      restore_path(source, target, false)?;
      Ok(target.to_path_buf())
    })();
    match result {
      Ok(path) => {
        record.actions.remove(index);
        persist(record)?;
        on_restored(&path);
        restored += 1;
        messages.push(format!("Restored {}", path.display()));
      }
      Err(error) => {
        failed += 1;
        messages.push(format!(
          "Failed to restore {}: {}",
          action.source_path, error
        ));
      }
    }
  }
  Ok((restored, failed, messages))
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn partial_undo_persists_only_pending_actions_and_retry_finishes() {
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    fs::create_dir(&root).unwrap();
    let mut actions = Vec::new();
    for name in ["one", "two"] {
      let backup = root.join(format!("{}-backup", name));
      fs::write(&backup, name).unwrap();
      actions.push(UndoBatchAction {
        action_type: "trash".into(),
        source_path: root.join(name).to_string_lossy().into_owned(),
        rollback_source: Some(backup.to_string_lossy().into_owned()),
      });
    }
    fs::write(root.join("one"), "newer file").unwrap();
    let path = root.join("record.json");
    let mut record = UndoBatchRecord {
      batch_id: "test".into(),
      created_ms: 0,
      actions,
    };
    let persist =
      |record: &UndoBatchRecord| atomic_write(&path, &serde_json::to_vec(record).unwrap());
    let (restored, failed, _) = restore_batch_record(&mut record, persist, |_| {}).unwrap();
    assert_eq!((restored, failed), (1, 1));
    assert_eq!(fs::read_to_string(root.join("one")).unwrap(), "newer file");
    let mut reloaded: UndoBatchRecord = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(reloaded.actions.len(), 1);
    fs::remove_file(root.join("one")).unwrap();
    let (restored, failed, _) = restore_batch_record(&mut reloaded, persist, |_| {}).unwrap();
    assert_eq!((restored, failed), (1, 0));
    assert!(reloaded.actions.is_empty());
    assert_eq!(fs::read_to_string(root.join("two")).unwrap(), "two");
    fs::remove_dir_all(root).unwrap();
  }
}
