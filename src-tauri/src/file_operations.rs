//! Filesystem mutations shared by single-file commands, batches and undo.
//! Destinations are never replaced, including dangling symlinks.
use super::*;

#[cfg(target_os = "macos")]
fn rename_exclusive(source: &Path, target: &Path) -> std::io::Result<()> {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;
  extern "C" {
    fn renamex_np(from: *const std::ffi::c_char, to: *const std::ffi::c_char, flags: u32) -> i32;
  }
  let source = CString::new(source.as_os_str().as_bytes())?;
  let target = CString::new(target.as_os_str().as_bytes())?;
  // RENAME_EXCL: atomic failure when the destination already exists.
  if unsafe { renamex_np(source.as_ptr(), target.as_ptr(), 0x00000004) } == 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error())
  }
}

#[cfg(target_os = "windows")]
fn rename_exclusive(source: &Path, target: &Path) -> std::io::Result<()> {
  use std::os::windows::ffi::OsStrExt;
  #[link(name = "kernel32")]
  extern "system" {
    fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
  }
  let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
  let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
  if source[..source.len() - 1].contains(&0) || target[..target.len() - 1].contains(&0) {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidInput,
      "Path contains a NUL",
    ));
  }
  // Neither REPLACE_EXISTING nor COPY_ALLOWED: cross-volume copies use our staging path.
  if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } != 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error())
  }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_exclusive(source: &Path, target: &Path) -> std::io::Result<()> {
  use std::ffi::CString;
  use std::os::unix::ffi::OsStrExt;
  let source = CString::new(source.as_os_str().as_bytes())?;
  let target = CString::new(target.as_os_str().as_bytes())?;
  let result = unsafe {
    libc::syscall(
      libc::SYS_renameat2,
      libc::AT_FDCWD,
      source.as_ptr(),
      libc::AT_FDCWD,
      target.as_ptr(),
      libc::RENAME_NOREPLACE,
    )
  };
  if result == 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error())
  }
}

#[cfg(not(any(
  target_os = "macos",
  target_os = "windows",
  target_os = "linux",
  target_os = "android"
)))]
fn rename_exclusive(_source: &Path, _target: &Path) -> std::io::Result<()> {
  Err(std::io::Error::new(
    std::io::ErrorKind::Unsupported,
    "Atomic exclusive rename is unsupported on this platform",
  ))
}

fn is_cross_device(error: &std::io::Error) -> bool {
  #[cfg(target_os = "windows")]
  {
    error.raw_os_error() == Some(17)
  }
  #[cfg(not(target_os = "windows"))]
  {
    error.raw_os_error() == Some(18)
  }
}

pub(super) fn remove_entry(path: &Path) -> std::io::Result<()> {
  let metadata = fs::symlink_metadata(path)?;
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::fs::FileTypeExt;
    if metadata.file_type().is_symlink_dir() {
      return fs::remove_dir(path);
    }
  }
  if metadata.is_dir() && !metadata.file_type().is_symlink() {
    fs::remove_dir_all(path)
  } else {
    fs::remove_file(path)
  }
}

pub(super) fn copy_entry_exclusive(source: &Path, target: &Path) -> Result<(), String> {
  let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
  if metadata.file_type().is_symlink() {
    let link = fs::read_link(source).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(link, target).map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    {
      use std::os::windows::fs::{symlink_dir, symlink_file, FileTypeExt};
      if metadata.file_type().is_symlink_dir() {
        symlink_dir(link, target)
      } else {
        symlink_file(link, target)
      }
      .map_err(|error| error.to_string())?;
    }
    return Ok(());
  }
  if metadata.is_dir() {
    return copy_dir_recursive(source, target);
  }
  copy_regular_file(source, target, &metadata).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn copy_regular_file(
  source: &Path,
  target: &Path,
  _metadata: &fs::Metadata,
) -> std::io::Result<()> {
  use std::os::windows::ffi::OsStrExt;
  #[link(name = "kernel32")]
  extern "system" {
    fn CopyFileW(from: *const u16, to: *const u16, fail_if_exists: i32) -> i32;
  }
  let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
  let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
  if source[..source.len() - 1].contains(&0) || target[..target.len() - 1].contains(&0) {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidInput,
      "Path contains a NUL",
    ));
  }
  // Native copying retains alternate data streams and Windows attributes.
  if unsafe { CopyFileW(source.as_ptr(), target.as_ptr(), 1) } != 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error())
  }
}

#[cfg(not(target_os = "windows"))]
fn copy_regular_file(source: &Path, target: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
  let mut input = File::open(source)?;
  let mut output = OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(target)?;
  let result = (|| -> std::io::Result<()> {
    copy_file_contents(&mut input, &mut output).map_err(|error| {
      std::io::Error::new(error.kind(), format!("Copy file data/metadata: {error}"))
    })?;
    output
      .set_permissions(metadata.permissions())
      .map_err(|error| {
        std::io::Error::new(error.kind(), format!("Set restored permissions: {error}"))
      })?;
    sync_copied_file(&output)
  })();
  drop(output);
  let result = result.and_then(|()| {
    // SMB can update mtime when the last writable handle closes. Set the saved
    // timestamps afterward through a read handle, so close cannot undo them.
    let restored = File::open(target)?;
    let mut times = fs::FileTimes::new();
    if let Ok(time) = metadata.modified() {
      times = times.set_modified(time);
    }
    if let Ok(time) = metadata.accessed() {
      times = times.set_accessed(time);
    }
    restored.set_times(times).map_err(|error| {
      std::io::Error::new(error.kind(), format!("Set restored timestamps: {error}"))
    })
  });
  if result.is_err() {
    let _ = fs::remove_file(target);
  }
  result
}

#[cfg(target_os = "macos")]
fn copy_file_contents(input: &mut File, output: &mut File) -> std::io::Result<()> {
  use std::ffi::{c_char, c_void, CStr};
  use std::os::fd::AsRawFd;
  extern "C" {
    fn fcopyfile(from: i32, to: i32, state: *mut c_void, flags: u32) -> i32;
    fn copyfile_state_alloc() -> *mut c_void;
    fn copyfile_state_free(state: *mut c_void) -> i32;
    fn copyfile_state_set(state: *mut c_void, flag: u32, value: *const c_void) -> i32;
    fn copyfile_state_get(state: *mut c_void, flag: u32, value: *mut c_void) -> i32;
  }
  const COPYFILE_ALL: u32 = 0x0f;
  const STATE_STATUS_CALLBACK: u32 = 6;
  const STATE_XATTR_NAME: u32 = 9;
  const COPY_XATTR: i32 = 5;
  const STAGE_START: i32 = 1;
  const STAGE_ERROR: i32 = 3;
  const CONTINUE: i32 = 0;
  const SKIP: i32 = 1;
  const QUIT: i32 = 2;
  extern "C" fn copy_status(
    what: i32,
    stage: i32,
    state: *mut c_void,
    _: *const c_char,
    _: *const c_char,
    _: *mut c_void,
  ) -> i32 {
    // COPYFILE_COPY_XATTR / COPYFILE_START. macOS adds provenance to local
    // backups, but SMB rejects replaying that OS-managed attribute. Keep all
    // user data, resource forks, Finder metadata and quarantine attributes.
    if what == COPY_XATTR && stage == STAGE_START {
      let mut name: *const c_char = std::ptr::null();
      if unsafe {
        copyfile_state_get(
          state,
          STATE_XATTR_NAME,
          (&mut name as *mut *const c_char).cast(),
        )
      } == 0
        && !name.is_null()
        && unsafe { CStr::from_ptr(name) }.to_bytes() == b"com.apple.provenance"
      {
        return SKIP;
      }
    }
    if stage == STAGE_ERROR {
      QUIT
    } else {
      CONTINUE
    } // Fail other errors rather than retry forever.
  }
  struct CopyState(*mut c_void);
  impl Drop for CopyState {
    fn drop(&mut self) {
      unsafe {
        copyfile_state_free(self.0);
      }
    }
  }
  let state = CopyState(unsafe { copyfile_state_alloc() });
  if state.0.is_null() {
    return Err(std::io::Error::last_os_error());
  }
  if unsafe { copyfile_state_set(state.0, STATE_STATUS_CALLBACK, copy_status as *const c_void) }
    != 0
  {
    return Err(std::io::Error::last_os_error());
  }
  // COPYFILE_ALL retains ACLs and payload metadata, with only provenance omitted.
  if unsafe { fcopyfile(input.as_raw_fd(), output.as_raw_fd(), state.0, COPYFILE_ALL) } == 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error())
  }
}

#[cfg(not(target_os = "windows"))]
fn sync_copied_file(file: &File) -> std::io::Result<()> {
  match file.sync_all() {
    Ok(()) => Ok(()),
    // Some SMB servers explicitly do not implement flush. All write failures
    // still propagate; do not discard a valid copy solely for unsupported fsync.
    Err(error) if filesystem_operation_unsupported(&error) => Ok(()),
    Err(error) => Err(error),
  }
}

fn filesystem_operation_unsupported(error: &std::io::Error) -> bool {
  if error.kind() == std::io::ErrorKind::Unsupported {
    return true;
  }
  #[cfg(target_os = "macos")]
  if matches!(error.raw_os_error(), Some(45 | 102)) {
    return true;
  }
  false
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn copy_file_contents(input: &mut File, output: &mut File) -> std::io::Result<()> {
  std::io::copy(input, output).map(|_| ())
}

pub(super) fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
  // Reserve the destination before copying. Never merge into another directory.
  fs::create_dir(target).map_err(|error| error.to_string())?;
  let result = (|| -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
      let entry = entry.map_err(|error| error.to_string())?;
      copy_entry_exclusive(&entry.path(), &target.join(entry.file_name()))?;
    }
    fs::set_permissions(
      target,
      fs::metadata(source)
        .map_err(|error| error.to_string())?
        .permissions(),
    )
    .map_err(|error| error.to_string())
  })();
  if result.is_err() {
    let _ = fs::remove_dir_all(target);
  }
  result
}

pub(super) fn move_path(source: &Path, target: &Path) -> Result<(), String> {
  move_path_with_rename(source, target, rename_exclusive)
}

fn move_path_with_rename(
  source: &Path,
  target: &Path,
  rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
  match rename(source, target) {
    Ok(()) => Ok(()),
    Err(error) if is_cross_device(&error) => copy_then_remove_with_rename(source, target, rename),
    // SMB may support ordinary rename but not RENAME_EXCL. Do not downgrade to
    // an overwriting rename: create_new / create_dir still reserve the target.
    Err(error) if filesystem_operation_unsupported(&error) => {
      copy_exclusive_then_remove(source, target)
    }
    Err(error) => Err(format!(
      "Cannot move {} to {}: {error}",
      source.display(),
      target.display()
    )),
  }
}

#[cfg(test)]
fn copy_then_remove(source: &Path, target: &Path) -> Result<(), String> {
  copy_then_remove_with_rename(source, target, rename_exclusive)
}

fn copy_then_remove_with_rename(
  source: &Path,
  target: &Path,
  rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
  let parent = target.parent().ok_or("Destination has no parent")?;
  let stage = parent.join(format!(".tidy-transfer-{}", Uuid::new_v4()));
  if let Err(error) = copy_entry_exclusive(source, &stage) {
    let _ = remove_entry(&stage);
    return Err(format!(
      "Cannot copy restore data to {}: {error}",
      target.display()
    ));
  }
  if let Err(error) = rename(&stage, target) {
    let _ = remove_entry(&stage);
    if filesystem_operation_unsupported(&error) {
      // Keep the original backup through the entire fallback. The target can be
      // visible while copying on these servers, but is never allowed to replace
      // an existing file, and incomplete copies are removed on failure.
      return copy_exclusive_then_remove(source, target);
    }
    return Err(format!(
      "Cannot publish restored file at {}: {error}",
      target.display()
    ));
  }
  remove_copied_source(source, target)
}

fn copy_exclusive_then_remove(source: &Path, target: &Path) -> Result<(), String> {
  copy_entry_exclusive(source, target)?;
  remove_copied_source(source, target)
}

fn remove_copied_source(source: &Path, target: &Path) -> Result<(), String> {
  remove_entry(source).map_err(|error| {
    format!(
      "Copied to {}, but could not remove source: {}. Both locations may contain files.",
      target.display(),
      error
    )
  })
}

pub(super) fn restore_path(source: &Path, target: &Path, allow_unsafe: bool) -> Result<(), String> {
  ensure_existing_path(source, allow_unsafe)?;
  // Do not recreate an absent mount point as an ordinary local folder. Keep the
  // recovery source untouched until the original parent is available again.
  let parent = target.parent().ok_or("Restore destination has no parent")?;
  let metadata = fs::metadata(parent).map_err(|error| format!(
    "Original folder {} is unavailable. Reconnect the NAS or external drive, or restore the folder, then retry. Recovery source kept at {}. {error}",
    parent.display(), source.display()
  ))?;
  if !metadata.is_dir() {
    return Err("Restore destination parent is not a folder.".into());
  }
  ensure_destination_writable(target, allow_unsafe)?;
  move_path(source, target)
}

#[cfg(test)]
mod tests {
  use super::*;
  struct Temp(PathBuf);
  impl Temp {
    fn new() -> Self {
      let path = std::env::temp_dir().join(Uuid::new_v4().to_string());
      fs::create_dir(&path).unwrap();
      Self(path)
    }
  }
  impl Drop for Temp {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[cfg(target_os = "macos")]
  #[test]
  #[ignore = "requires an explicitly selected mounted SMB share; only creates isolated test files"]
  fn smb_delete_and_undo_roundtrip() {
    let mount = std::env::var_os("TIDY_SMB_TEST_ROOT")
      .expect("Set TIDY_SMB_TEST_ROOT to a mounted SMB share");
    let remote_path = PathBuf::from(mount).join(format!("tidy-undo-check-{}", Uuid::new_v4()));
    fs::create_dir(&remote_path).unwrap();
    let remote = Temp(remote_path);
    let local = Temp::new();
    let original = remote.0.join("sample.txt");
    let content = b"Tidy isolated SMB undo verification. No user files are used.\n";
    fs::write(&original, content).unwrap();
    fs::write(original.join("..namedfork/rsrc"), b"resource fork payload").unwrap();
    assert!(std::process::Command::new("/usr/bin/xattr")
      .args(["-w", "com.tidy.undo-test", "retained"])
      .arg(&original)
      .status()
      .unwrap()
      .success());
    let modified = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    File::open(&original)
      .unwrap()
      .set_times(fs::FileTimes::new().set_modified(modified))
      .unwrap();
    assert_eq!(
      fs::metadata(&original).unwrap().modified().unwrap(),
      modified,
      "test fixture modified time"
    );
    let backup = backup_and_trash(&original, &local.0, move_to_system_trash)
      .expect("SMB trash and local undo backup");
    assert!(!original.exists());
    assert_eq!(fs::read(&backup).unwrap(), content);
    assert_eq!(
      fs::metadata(&backup).unwrap().modified().unwrap(),
      modified,
      "backup modified time"
    );
    restore_path(&backup, &original, false).expect("restore local backup to SMB");
    assert_eq!(fs::read(&original).unwrap(), content);
    assert_eq!(
      fs::read(original.join("..namedfork/rsrc")).unwrap(),
      b"resource fork payload"
    );
    let attribute = std::process::Command::new("/usr/bin/xattr")
      .args(["-p", "com.tidy.undo-test"])
      .arg(&original)
      .output()
      .unwrap();
    assert!(attribute.status.success());
    assert_eq!(
      String::from_utf8_lossy(&attribute.stdout).trim(),
      "retained"
    );
    assert_eq!(
      fs::metadata(&original).unwrap().modified().unwrap(),
      modified
    );
    assert!(!backup.exists());

    // A newly-created destination must survive Undo; the backup stays retryable.
    fs::write(&backup, b"saved version").unwrap();
    assert!(restore_path(&backup, &original, false).is_err());
    assert_eq!(fs::read(&original).unwrap(), content);
    assert_eq!(fs::read(&backup).unwrap(), b"saved version");
    fs::remove_file(&original).unwrap();
    restore_path(&backup, &original, false).unwrap();
    assert_eq!(fs::read(&original).unwrap(), b"saved version");

    let folder = remote.0.join("nested-folder");
    fs::create_dir_all(folder.join("child")).unwrap();
    let binary: Vec<u8> = (0..256)
      .cycle()
      .take(256 * 1024)
      .map(|value| value as u8)
      .collect();
    fs::write(folder.join("child/payload.bin"), &binary).unwrap();
    let folder_backup = backup_and_trash(&folder, &local.0, move_to_system_trash).unwrap();
    assert!(!folder.exists());
    restore_path(&folder_backup, &folder, false).expect("restore folder backup to SMB");
    assert_eq!(fs::read(folder.join("child/payload.bin")).unwrap(), binary);
    assert!(!folder_backup.exists());
    assert!(fs::read_dir(&remote.0).unwrap().all(|entry| !entry
      .unwrap()
      .file_name()
      .to_string_lossy()
      .starts_with(".tidy-transfer-")));
    println!("SMB trash/undo verified: file bytes, resource fork, extended attribute, modified time, collision/retry, and nested folder bytes.");
  }

  #[test]
  fn unsupported_exclusive_rename_falls_back_without_overwriting() {
    let temp = Temp::new();
    let source = temp.0.join("backup");
    let target = temp.0.join("restored");
    fs::write(&source, b"saved").unwrap();
    fs::write(&target, b"newer").unwrap();
    let unsupported =
      |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::Unsupported));
    assert!(move_path_with_rename(&source, &target, unsupported).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"saved");
    assert_eq!(fs::read(&target).unwrap(), b"newer");
    fs::remove_file(&target).unwrap();
    copy_then_remove_with_rename(&source, &target, unsupported).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"saved");
    assert!(!source.exists());
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
  }

  #[test]
  fn unsupported_flush_is_distinguished_from_lost_data_errors() {
    assert!(filesystem_operation_unsupported(&std::io::Error::from(
      std::io::ErrorKind::Unsupported
    )));
    assert!(!filesystem_operation_unsupported(&std::io::Error::from(
      std::io::ErrorKind::PermissionDenied
    )));
    assert!(!filesystem_operation_unsupported(&std::io::Error::from(
      std::io::ErrorKind::WriteZero
    )));
    #[cfg(target_os = "macos")]
    assert!(filesystem_operation_unsupported(
      &std::io::Error::from_raw_os_error(45)
    ));
  }

  #[test]
  fn move_and_undo_never_replace_existing_files() {
    let temp = Temp::new();
    let source = temp.0.join("source");
    let target = temp.0.join("target");
    fs::write(&source, "original").unwrap();
    fs::write(&target, "newer").unwrap();
    assert!(move_path(&source, &target).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "newer");
    assert_eq!(fs::read_to_string(&source).unwrap(), "original");
    fs::remove_file(&target).unwrap();
    move_path(&source, &target).unwrap();
    fs::write(&source, "replacement").unwrap();
    assert!(restore_path(&target, &source, false).is_err());
    assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
  }

  #[test]
  fn undo_with_missing_parent_keeps_backup_and_can_be_retried() {
    let temp = Temp::new();
    let backup = temp.0.join("backup.txt");
    let parent = temp.0.join("unavailable-share");
    let original = parent.join("original.txt");
    fs::write(&backup, b"recoverable").unwrap();
    let error = restore_path(&backup, &original, false).unwrap_err();
    assert!(error.contains("Reconnect the NAS"));
    assert!(!parent.exists());
    assert_eq!(fs::read(&backup).unwrap(), b"recoverable");
    fs::create_dir(&parent).unwrap();
    restore_path(&backup, &original, false).unwrap();
    assert_eq!(fs::read(&original).unwrap(), b"recoverable");
    assert!(!backup.exists());
  }

  #[test]
  fn cross_volume_fallback_copies_and_preserves_collisions() {
    let temp = Temp::new();
    let source = temp.0.join("source");
    let target = temp.0.join("target");
    fs::write(&source, "original").unwrap();
    fs::write(&target, "newer").unwrap();
    assert!(copy_then_remove(&source, &target).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "newer");
    assert!(source.exists());
    fs::remove_file(&target).unwrap();
    copy_then_remove(&source, &target).unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read_to_string(target).unwrap(), "original");
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
  }

  #[test]
  fn permanent_delete_authorization_does_not_bypass_protected_paths() {
    let temp = Temp::new();
    let source = temp.0.join("regular");
    fs::write(&source, "keep until confirmed").unwrap();
    assert!(execute_authorized_local_operation(
      &source,
      LocalOperation::Delete,
      &temp.0,
      false,
      false
    )
    .is_err());
    assert!(source.exists());
    execute_authorized_local_operation(&source, LocalOperation::Delete, &temp.0, false, true)
      .unwrap();
    assert!(!source.exists());
    let protected = temp.0.join(".Trash");
    fs::create_dir(&protected).unwrap();
    let source = protected.join("file");
    fs::write(&source, "protected").unwrap();
    assert!(execute_authorized_local_operation(
      &source,
      LocalOperation::Delete,
      &temp.0,
      false,
      true
    )
    .is_err());
    assert!(source.exists());
    execute_authorized_local_operation(&source, LocalOperation::Delete, &temp.0, true, true)
      .unwrap();
    assert!(!source.exists());
  }

  #[test]
  fn failed_trash_keeps_source_and_cleans_backup() {
    let temp = Temp::new();
    let source = temp.0.join("source");
    let backups = temp.0.join("backups");
    fs::write(&source, "original").unwrap();
    assert!(
      backup_and_trash(&source, &backups, |_| Err("Recycle bin unavailable".into())).is_err()
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "original");
    assert_eq!(fs::read_dir(backups).unwrap().count(), 0);
    assert!(execute_local_operation(&source, LocalOperation::Delete, &temp.0, false).is_err());
    assert!(source.exists());
  }

  #[test]
  fn detects_platform_cross_device_error() {
    let code = if cfg!(windows) { 17 } else { 18 };
    assert!(is_cross_device(&std::io::Error::from_raw_os_error(code)));
    assert!(!is_cross_device(&std::io::Error::from_raw_os_error(5)));
  }

  #[test]
  fn directories_are_not_merged() {
    let temp = Temp::new();
    let source = temp.0.join("source");
    let target = temp.0.join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(source.join("keep"), "original").unwrap();
    assert!(move_path(&source, &target).is_err());
    assert!(copy_dir_recursive(&source, &target).is_err());
    assert!(source.join("keep").exists());
  }

  #[cfg(unix)]
  #[test]
  fn copies_file_directory_and_dangling_links_as_links() {
    let temp = Temp::new();
    let source = temp.0.join("source");
    let target = temp.0.join("target");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file"), "data").unwrap();
    fs::create_dir(source.join("dir")).unwrap();
    for (name, link) in [
      ("file-link", "file"),
      ("dir-link", "dir"),
      ("dangling", "missing"),
    ] {
      std::os::unix::fs::symlink(link, source.join(name)).unwrap();
    }
    copy_dir_recursive(&source, &target).unwrap();
    for name in ["file-link", "dir-link", "dangling"] {
      assert!(fs::symlink_metadata(target.join(name))
        .unwrap()
        .file_type()
        .is_symlink());
      assert_eq!(
        fs::read_link(source.join(name)).unwrap(),
        fs::read_link(target.join(name)).unwrap()
      );
    }
    assert!(move_path(&source.join("file"), &target.join("dangling")).is_err());
  }
}

/// Shared policy for single-item and batch commands. The caller commits index
/// changes only after this returns successfully.
pub(super) enum LocalOperation<'a> {
  Move(&'a Path),
  Trash,
  Delete,
}

pub(super) fn execute_local_operation(
  source: &Path,
  operation: LocalOperation<'_>,
  backup_dir: &Path,
  allow_unsafe: bool,
) -> Result<Option<PathBuf>, String> {
  execute_authorized_local_operation(source, operation, backup_dir, allow_unsafe, false)
}

pub(super) fn execute_authorized_local_operation(
  source: &Path,
  operation: LocalOperation<'_>,
  backup_dir: &Path,
  allow_unsafe: bool,
  allow_permanent_delete: bool,
) -> Result<Option<PathBuf>, String> {
  ensure_existing_path(source, allow_unsafe)?;
  match operation {
    LocalOperation::Move(target) => {
      ensure_destination_writable(target, allow_unsafe)?;
      move_path(source, target)?;
      Ok(Some(target.to_path_buf()))
    }
    LocalOperation::Trash => backup_and_trash(source, backup_dir, move_to_system_trash).map(Some),
    LocalOperation::Delete => {
      if !allow_unsafe && !allow_permanent_delete {
        return Err("Permanent delete requires advanced override.".into());
      }
      remove_entry(source).map_err(|error| error.to_string())?;
      Ok(None)
    }
  }
}

fn backup_and_trash(
  source: &Path,
  backup_dir: &Path,
  trash: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
  fs::create_dir_all(backup_dir).map_err(|error| error.to_string())?;
  let name = source
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or("Invalid file name")?;
  let target = unique_path(backup_dir, name);
  copy_entry_exclusive(source, &target)?;
  if let Err(error) = trash(source) {
    let _ = remove_entry(&target);
    return Err(error);
  }
  Ok(target)
}
