//! File storage and lazily materialized query indexes.
use super::*;

#[derive(Default)]
pub(super) struct IndexStore {
  folder_path: Option<String>,
  files: Vec<FileEntry>,
  by_id: HashMap<String, usize>,
  sorted_ids_by_mode: HashMap<String, Vec<usize>>,
}

impl IndexStore {
  pub(super) fn replace(&mut self, folder_path: String, files: Vec<FileEntry>) {
    self.folder_path = Some(folder_path);
    self.files = files;
    self.rebuild_positions();
    self.sorted_ids_by_mode.clear();
  }

  pub(super) fn get(&self, id: &str) -> Option<&FileEntry> {
    self.by_id.get(id).map(|&position| &self.files[position])
  }

  fn rebuild_positions(&mut self) {
    self.by_id = self
      .files
      .iter()
      .enumerate()
      .map(|(position, file)| (file.id.clone(), position))
      .collect();
  }

  pub(super) fn remove(&mut self, id: &str) {
    self.remove_many(std::iter::once(id));
  }

  pub(super) fn remove_path(&mut self, path: &Path) {
    let path = path.to_string_lossy().to_string();
    let removed_ids = self
      .files
      .iter()
      .filter(|file| file.path == path)
      .map(|file| file.id.clone())
      .collect::<Vec<_>>();
    self.remove_many(removed_ids.iter().map(|id| id.as_str()));
  }

  pub(super) fn remove_subtree(&mut self, path: &Path) {
    let prefix = path.to_string_lossy().to_string();
    let nested_prefix = format!("{}/", prefix);
    let removed_ids = self
      .files
      .iter()
      .filter(|file| file.path == prefix || file.path.starts_with(&nested_prefix))
      .map(|file| file.id.clone())
      .collect::<Vec<_>>();
    self.remove_many(removed_ids.iter().map(|id| id.as_str()));
  }

  pub(super) fn remove_many<'a>(&mut self, ids: impl Iterator<Item = &'a str>) {
    let removed = ids
      .map(|id| id.to_string())
      .collect::<std::collections::HashSet<_>>();
    if removed.is_empty() {
      return;
    }
    self
      .files
      .retain(|file| !removed.contains(file.id.as_str()));
    self.rebuild_positions();
    self.sorted_ids_by_mode.clear();
  }

  pub(super) fn upsert(&mut self, file: FileEntry) {
    if let Some(&position) = self.by_id.get(&file.id) {
      self.files[position] = file;
    } else {
      self.by_id.insert(file.id.clone(), self.files.len());
      self.files.push(file);
    }
    self.sorted_ids_by_mode.clear();
  }

  pub(super) fn query(&mut self, request: QueryIndexRequest) -> QueryIndexResult {
    let filter = request.filter_mode.unwrap_or_else(|| "all".to_string());
    let sort = request.sort_mode.unwrap_or_else(|| "name_asc".to_string());
    let group = request.group_mode.unwrap_or_else(|| "none".to_string());
    let offset = request.offset.unwrap_or(0);
    let limit = request.limit.unwrap_or(200).clamp(1, 2_000);
    let selected_extensions = request.selected_extensions.map(|extensions| {
      extensions
        .into_iter()
        .collect::<std::collections::HashSet<_>>()
    });
    let sort = match sort.as_str() {
      "none" | "name_asc" | "name_desc" | "size_desc" | "size_asc" | "date_desc" | "date_asc"
      | "type_asc" | "type_desc" | "extension_asc" | "extension_desc" => sort,
      _ => "name_asc".to_string(),
    };
    let ids = self
      .sorted_ids_by_mode
      .entry(sort.clone())
      .or_insert_with(|| {
        let mut positions: Vec<usize> = (0..self.files.len()).collect();
        positions.sort_by(|&a, &b| compare_file_entries(&self.files[a], &self.files[b], &sort));
        positions
      });
    let mut files = Vec::with_capacity(limit.min(self.files.len()));
    let mut total = 0;
    let mut groups = HashMap::<String, usize>::new();
    for &position in ids.iter() {
      let file = &self.files[position];
      if filter == "duplicates" && file.duplicate_group.is_none() {
        continue;
      }
      if !matches_file_filter(&filter, &file.name, &file.path, &file.kind) {
        continue;
      }
      if let Some(extensions) = selected_extensions.as_ref() {
        if !extensions.contains(&get_extension(&file.name)) {
          continue;
        }
      }
      *groups.entry(index_group_key(&group, file)).or_insert(0) += 1;
      if total >= offset && files.len() < limit {
        files.push(file.clone());
      }
      total += 1;
    }
    let mut groups = groups
      .into_iter()
      .map(|(key, count)| GroupCount { key, count })
      .collect::<Vec<_>>();
    groups.sort_by(|a, b| a.key.cmp(&b.key));
    QueryIndexResult {
      files,
      total,
      offset,
      limit,
      groups,
    }
  }

  pub(super) fn stats(&self) -> IndexStats {
    let mut extensions = HashMap::<String, usize>::new();
    let mut duplicate_groups = std::collections::HashSet::<String>::new();
    for file in &self.files {
      *extensions.entry(get_extension(&file.name)).or_insert(0) += 1;
      if let Some(group) = file.duplicate_group.as_ref() {
        duplicate_groups.insert(group.clone());
      }
    }
    let mut extensions = extensions
      .into_iter()
      .map(|(key, count)| GroupCount { key, count })
      .collect::<Vec<_>>();
    extensions.sort_by(|a, b| a.key.cmp(&b.key));
    IndexStats {
      folder_path: self.folder_path.clone(),
      total: self.files.len(),
      extensions,
      duplicate_groups: duplicate_groups.len(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn file(id: &str, name: &str) -> FileEntry {
    FileEntry {
      id: id.into(),
      name: name.into(),
      path: format!("/root/{name}"),
      kind: FileKind::Text,
      size_bytes: 1,
      modified_ms: None,
      mime: "text/plain".into(),
      duplicate_group: None,
    }
  }
  fn request(offset: usize, limit: usize) -> QueryIndexRequest {
    QueryIndexRequest {
      filter_mode: None,
      selected_extensions: None,
      sort_mode: Some("name_asc".into()),
      group_mode: Some("extension".into()),
      offset: Some(offset),
      limit: Some(limit),
    }
  }
  #[test]
  fn lazy_indexes_are_invalidated_on_every_mutation_and_pages_keep_full_counts() {
    let mut index = IndexStore::default();
    index.replace(
      "/root".into(),
      vec![file("a", "z.txt"), file("b", "b.txt"), file("c", "c.txt")],
    );
    assert!(index.sorted_ids_by_mode.is_empty());
    let page = index.query(request(1, 1));
    assert_eq!(page.files[0].id, "c");
    assert_eq!(page.total, 3);
    assert_eq!(page.groups[0].count, 3);
    assert_eq!(index.sorted_ids_by_mode.len(), 1);
    index.upsert(file("a", "a.txt"));
    index.upsert(file("d", "d.txt"));
    assert!(index.sorted_ids_by_mode.is_empty());
    assert_eq!(index.query(request(0, 1)).files[0].id, "a");
    index.remove("b");
    assert!(index.get("b").is_none());
    assert_eq!(index.get("c").unwrap().name, "c.txt");
    index.remove_path(Path::new("/root/a.txt"));
    assert_eq!(index.query(request(0, 10)).total, 2);
    index.remove_subtree(Path::new("/root"));
    assert_eq!(index.query(request(0, 10)).total, 0);
  }
}
