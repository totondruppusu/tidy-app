use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use serde::de::DeserializeOwned;
use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};
#[cfg(target_os = "android")]
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Manager,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.tidy.app.files";

#[cfg(target_os = "android")]
pub struct AndroidFilesPlugin<R: Runtime>(pub PluginHandle<R>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySelection {
  pub token: String,
  pub label: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDocumentEntry {
  pub document_uri: String,
  pub tree_uri: String,
  pub relative_path: String,
  pub parent_relative_path: String,
  pub name: String,
  pub mime_type: Option<String>,
  pub size_bytes: u64,
  pub modified_ms: Option<u64>,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidMoveResult {
  pub document_uri: String,
  pub new_name: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidImportResult {
  pub document_uri: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectorySelectionResponse {
  token: String,
  label: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListDirectoryResponse {
  files: Vec<AndroidDocumentEntry>,
}

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveDocumentResponse {
  document_uri: String,
  new_name: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportFileResponse {
  document_uri: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListDirectoryPayload<'a> {
  tree_uri: &'a str,
  include_subfolders: bool,
  include_hidden: bool,
}

#[cfg(target_os = "android")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyDocumentToPathPayload<'a> {
  document_uri: &'a str,
  target_path: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteDocumentPayload<'a> {
  document_uri: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveDocumentPayload<'a> {
  document_uri: &'a str,
  target_tree_uri: &'a str,
  target_parent_relative_path: &'a str,
  file_name: &'a str,
  mime_type: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreCachedFilePayload<'a> {
  source_path: &'a str,
  target_tree_uri: &'a str,
  target_parent_relative_path: &'a str,
  file_name: &'a str,
  mime_type: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreDocumentPayload<'a> {
  source_uri: &'a str,
  target_tree_uri: &'a str,
  target_parent_relative_path: &'a str,
  file_name: &'a str,
  mime_type: &'a str,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("android-files")
    .setup(|_app, _api| {
      #[cfg(target_os = "android")]
      {
        let handle = register_plugin(_app, _api)?;
        _app.manage(handle);
      }
      Ok(())
    })
    .build()
}

#[cfg(target_os = "android")]
fn register_plugin<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> Result<AndroidFilesPlugin<R>, Box<dyn std::error::Error>> {
  let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "TidyFilesPlugin")?;
  Ok(AndroidFilesPlugin(handle))
}

#[cfg(target_os = "android")]
fn plugin_handle<R: Runtime>(app: &AppHandle<R>) -> Result<PluginHandle<R>, String> {
  Ok(app.state::<AndroidFilesPlugin<R>>().0.clone())
}

#[cfg(target_os = "android")]
fn run_plugin<R: Runtime, T: DeserializeOwned, P: Serialize>(
  app: &AppHandle<R>,
  command: &str,
  payload: P,
) -> Result<T, String> {
  plugin_handle(app)?
    .run_mobile_plugin(command, payload)
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub fn pick_directory<R: Runtime>(app: &AppHandle<R>) -> Result<DirectorySelection, String> {
  let response: DirectorySelectionResponse = run_plugin(app, "requestAllFilesAccess", ())?;
  Ok(DirectorySelection {
    token: response.token,
    label: response.label,
  })
}

#[cfg(target_os = "android")]
pub fn list_directory<R: Runtime>(
  app: &AppHandle<R>,
  tree_uri: &str,
  include_subfolders: bool,
  include_hidden: bool,
) -> Result<Vec<AndroidDocumentEntry>, String> {
  let response: ListDirectoryResponse = run_plugin(
    app,
    "listDirectory",
    ListDirectoryPayload {
      tree_uri,
      include_subfolders,
      include_hidden,
    },
  )?;
  Ok(response.files)
}

#[cfg(target_os = "android")]
pub fn copy_document_to_path<R: Runtime>(
  app: &AppHandle<R>,
  document_uri: &str,
  target_path: &str,
) -> Result<(), String> {
  let _: serde_json::Value = run_plugin(
    app,
    "copyDocumentToPath",
    CopyDocumentToPathPayload {
      document_uri,
      target_path,
    },
  )?;
  Ok(())
}

#[cfg(target_os = "android")]
pub fn delete_document<R: Runtime>(app: &AppHandle<R>, document_uri: &str) -> Result<(), String> {
  let _: serde_json::Value =
    run_plugin(app, "deleteDocument", DeleteDocumentPayload { document_uri })?;
  Ok(())
}

#[cfg(target_os = "android")]
pub fn move_document<R: Runtime>(
  app: &AppHandle<R>,
  document_uri: &str,
  target_tree_uri: &str,
  target_parent_relative_path: &str,
  file_name: &str,
  mime_type: &str,
) -> Result<AndroidMoveResult, String> {
  let response: MoveDocumentResponse = run_plugin(
    app,
    "moveDocument",
    MoveDocumentPayload {
      document_uri,
      target_tree_uri,
      target_parent_relative_path,
      file_name,
      mime_type,
    },
  )?;
  Ok(AndroidMoveResult {
    document_uri: response.document_uri,
    new_name: response.new_name,
  })
}

#[cfg(target_os = "android")]
pub fn restore_cached_file<R: Runtime>(
  app: &AppHandle<R>,
  source_path: &str,
  target_tree_uri: &str,
  target_parent_relative_path: &str,
  file_name: &str,
  mime_type: &str,
) -> Result<AndroidImportResult, String> {
  let response: ImportFileResponse = run_plugin(
    app,
    "restoreCachedFile",
    RestoreCachedFilePayload {
      source_path,
      target_tree_uri,
      target_parent_relative_path,
      file_name,
      mime_type,
    },
  )?;
  Ok(AndroidImportResult {
    document_uri: response.document_uri,
  })
}

#[cfg(target_os = "android")]
pub fn restore_document<R: Runtime>(
  app: &AppHandle<R>,
  source_uri: &str,
  target_tree_uri: &str,
  target_parent_relative_path: &str,
  file_name: &str,
  mime_type: &str,
) -> Result<AndroidImportResult, String> {
  let response: ImportFileResponse = run_plugin(
    app,
    "restoreDocument",
    RestoreDocumentPayload {
      source_uri,
      target_tree_uri,
      target_parent_relative_path,
      file_name,
      mime_type,
    },
  )?;
  Ok(AndroidImportResult {
    document_uri: response.document_uri,
  })
}
