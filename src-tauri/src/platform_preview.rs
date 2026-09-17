//! Native preview adapters.
use super::*;

fn wait_for_child(child: &mut Child, timeout_secs: u64) -> Result<(), String> {
  let timeout = Duration::from_secs(timeout_secs);
  let start = Instant::now();
  loop {
    if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
      if !status.success() {
        return Err("Preview generation failed.".into());
      }
      return Ok(());
    }
    if start.elapsed() >= timeout {
      let _ = child.kill();
      let _ = child.wait();
      return Err("Preview generation timed out.".into());
    }
    std::thread::sleep(Duration::from_millis(QLMANAGE_POLL_MS));
  }
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

  wait_for_child(&mut child, QLMANAGE_TIMEOUT_SECS)?;

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

fn file_url_from_path(path: &Path) -> String {
  tauri::Url::from_file_path(path)
    .map(|url| url.to_string())
    .unwrap_or_default()
}

pub(super) fn detect_windows_libreoffice() -> Option<PathBuf> {
  let mut candidates = Vec::new();
  if let Some(program_files) = std::env::var_os("ProgramFiles") {
    candidates.push(
      PathBuf::from(&program_files)
        .join("LibreOffice")
        .join("program")
        .join("soffice.exe"),
    );
    candidates.push(
      PathBuf::from(&program_files)
        .join("LibreOffice")
        .join("program")
        .join("soffice.com"),
    );
  }
  if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
    candidates.push(
      PathBuf::from(&program_files_x86)
        .join("LibreOffice")
        .join("program")
        .join("soffice.exe"),
    );
    candidates.push(
      PathBuf::from(&program_files_x86)
        .join("LibreOffice")
        .join("program")
        .join("soffice.com"),
    );
  }
  if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.exists()) {
    return Some(candidate);
  }

  let discovered = Command::new("where")
    .arg("soffice.exe")
    .output()
    .ok()
    .filter(|output| output.status.success())
    .and_then(|output| {
      let stdout = String::from_utf8_lossy(&output.stdout);
      stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
    });
  if discovered.is_some() {
    return discovered;
  }

  Command::new("where")
    .arg("soffice.com")
    .output()
    .ok()
    .filter(|output| output.status.success())
    .and_then(|output| {
      let stdout = String::from_utf8_lossy(&output.stdout);
      stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
    })
}

fn run_windows_libreoffice_preview(
  session_dir: &Path,
  source_path: &Path,
  cached_preview_path: &Path,
) -> Result<PathBuf, String> {
  let soffice_path = detect_windows_libreoffice()
    .ok_or("LibreOffice not found. Install LibreOffice to enable Office previews.".to_string())?;
  let profile_dir = session_dir.join("lo-profile");
  fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;
  let user_installation = file_url_from_path(&profile_dir);

  let mut command = Command::new(&soffice_path);
  command
    .arg("--headless")
    .arg("--nologo")
    .arg("--nodefault")
    .arg("--norestore")
    .arg("--nolockcheck")
    .arg(format!("-env:UserInstallation={}", user_installation))
    .arg("--convert-to")
    .arg("pdf")
    .arg("--outdir")
    .arg(session_dir)
    .arg(source_path)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(target_os = "windows")]
  command.creation_flags(CREATE_NO_WINDOW);
  let mut child = command.spawn().map_err(|error| {
    if soffice_path
      .as_os_str()
      .to_string_lossy()
      .contains("soffice.")
    {
      format!(
        "Failed to start LibreOffice: {}. Install LibreOffice or add it to PATH.",
        error
      )
    } else {
      error.to_string()
    }
  })?;

  wait_for_child(&mut child, WINDOWS_OFFICE_PREVIEW_TIMEOUT_SECS)?;

  let source_stem = source_path
    .file_stem()
    .and_then(|value| value.to_str())
    .ok_or("Preview file name is invalid".to_string())?;
  let converted_preview = session_dir.join(format!("{}.pdf", source_stem));
  let preview_path = if converted_preview.exists() {
    converted_preview
  } else {
    fs::read_dir(session_dir)
      .map_err(|error| error.to_string())?
      .filter_map(|entry| entry.ok())
      .map(|entry| entry.path())
      .find(|path| {
        path
          .extension()
          .and_then(|ext| ext.to_str())
          .map(|ext| ext.eq_ignore_ascii_case("pdf"))
          .unwrap_or(false)
      })
      .ok_or("Preview file not found".to_string())?
  };

  fs::copy(&preview_path, cached_preview_path).map_err(|error| error.to_string())?;
  Ok(cached_preview_path.to_path_buf())
}

pub(super) fn run_platform_preview(
  session_dir: &Path,
  source_path: &Path,
  cached_preview_path: Option<&Path>,
) -> Result<PathBuf, String> {
  if cfg!(target_os = "macos") {
    return run_qlmanage_preview(session_dir, source_path);
  }
  if cfg!(target_os = "windows") {
    let cached_preview_path =
      cached_preview_path.ok_or("Preview cache path missing".to_string())?;
    return run_windows_libreoffice_preview(session_dir, source_path, cached_preview_path);
  }
  Err("Preview generation is not supported on this platform.".into())
}
