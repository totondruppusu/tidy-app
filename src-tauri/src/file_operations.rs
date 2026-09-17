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
    copy_file_contents(&mut input, &mut output)?;
    output.set_permissions(metadata.permissions())?;
    let mut times = fs::FileTimes::new();
    if let Ok(time) = metadata.modified() {
      times = times.set_modified(time);
    }
    if let Ok(time) = metadata.accessed() {
      times = times.set_accessed(time);
    }
    output.set_times(times)?;
    output.sync_all()
  })();
  drop(output);
  if result.is_err() {
    let _ = fs::remove_file(target);
  }
  result
}

#[cfg(target_os = "macos")]
fn copy_file_contents(input: &mut File, output: &mut File) -> std::io::Result<()> {
  use std::os::fd::AsRawFd;
  extern "C" {
    fn fcopyfile(from: i32, to: i32, state: *mut std::ffi::c_void, flags: u32) -> i32;
  }
  // COPYFILE_ALL preserves extended attributes, resource forks and ACLs as well
  // as the data fork; byte-only copies could silently lose macOS file data.
  if unsafe {
    fcopyfile(
      input.as_raw_fd(),
      output.as_raw_fd(),
      std::ptr::null_mut(),
      0x0f,
    )
  } == 0
  {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error())
  }
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
  match rename_exclusive(source, target) {
    Ok(()) => Ok(()),
    Err(error) if is_cross_device(&error) => copy_then_remove(source, target),
    Err(error) => Err(error.to_string()),
  }
}

fn copy_then_remove(source: &Path, target: &Path) -> Result<(), String> {
  // Copy on the target volume, then publish atomically. Partial copies are never
  // mistaken for completed moves, and a concurrent destination is not replaced.
  let parent = target.parent().ok_or("Destination has no parent")?;
  let stage = parent.join(format!(".tidy-transfer-{}", Uuid::new_v4()));
  if let Err(error) = copy_entry_exclusive(source, &stage) {
    let _ = remove_entry(&stage);
    return Err(error);
  }
  if let Err(error) = rename_exclusive(&stage, target) {
    let _ = remove_entry(&stage);
    return Err(error.to_string());
  }
  if let Err(error) = remove_entry(source) {
    // Keep the complete destination: directory removal may have partially succeeded.
    return Err(format!(
      "Copied to {}, but could not remove source: {}. Both locations may contain files.",
      target.display(),
      error
    ));
  }
  Ok(())
}

pub(super) fn restore_path(source: &Path, target: &Path, allow_unsafe: bool) -> Result<(), String> {
  ensure_existing_path(source, allow_unsafe)?;
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
  ensure_existing_path(source, allow_unsafe)?;
  match operation {
    LocalOperation::Move(target) => {
      ensure_destination_writable(target, allow_unsafe)?;
      move_path(source, target)?;
      Ok(Some(target.to_path_buf()))
    }
    LocalOperation::Trash => backup_and_trash(source, backup_dir, move_to_system_trash).map(Some),
    LocalOperation::Delete => {
      if !allow_unsafe {
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
