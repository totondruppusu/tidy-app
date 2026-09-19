//! Staged duplicate detection and cancellable content hashing.
use super::*;

pub(super) fn partial_hash_file(path: &Path) -> Result<String, String> {
  let mut file = File::open(path).map_err(|error| error.to_string())?;
  let metadata = file.metadata().map_err(|error| error.to_string())?;
  let size = metadata.len() as usize;
  let mut hasher = Sha256::new();

  let mut start_buf = vec![0u8; std::cmp::min(PARTIAL_HASH_BYTES, size)];
  if !start_buf.is_empty() {
    file
      .read_exact(&mut start_buf)
      .map_err(|error| error.to_string())?;
    hasher.update(&start_buf);
  }
  if size > PARTIAL_HASH_BYTES {
    let end_len = std::cmp::min(PARTIAL_HASH_BYTES, size - PARTIAL_HASH_BYTES);
    file
      .seek(SeekFrom::End(-(end_len as i64)))
      .map_err(|error| error.to_string())?;
    let mut end_buf = vec![0u8; end_len];
    file
      .read_exact(&mut end_buf)
      .map_err(|error| error.to_string())?;
    hasher.update(&end_buf);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

fn hash_file(path: &Path, cancelled: Option<&AtomicBool>) -> Result<String, String> {
  let file = File::open(path).map_err(|error| error.to_string())?;
  let mut reader = BufReader::new(file);
  hash_reader(&mut reader, cancelled)
}

fn hash_reader(reader: &mut impl Read, cancelled: Option<&AtomicBool>) -> Result<String, String> {
  let mut hasher = Sha256::new();
  let mut buffer = [0u8; 8192];
  loop {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
      return Err("Scan cancelled".into());
    }
    let read = reader
      .read(&mut buffer)
      .map_err(|error| error.to_string())?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

pub(super) fn find_duplicate_groups(
  paths: &[PathBuf],
  use_hash: bool,
  min_size_bytes: u64,
  cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<HashMap<PathBuf, String>, String> {
  let candidates = paths
    .iter()
    .filter_map(|path| {
      if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
          return None;
        }
      }
      fs::metadata(path).ok().map(|metadata| DuplicateCandidate {
        path: path.clone(),
        size_bytes: metadata.len(),
        modified_ms: modified_ms_from_metadata(&metadata),
      })
    })
    .collect::<Vec<_>>();
  if let Some(flag) = cancel_flag {
    if flag.load(Ordering::Relaxed) {
      return Err("Scan cancelled".into());
    }
  }
  find_duplicate_groups_from_candidates(&candidates, use_hash, min_size_bytes, cancel_flag)
}

pub(super) fn find_duplicate_groups_from_candidates(
  candidates: &[DuplicateCandidate],
  use_hash: bool,
  min_size_bytes: u64,
  cancel_flag: Option<&Arc<AtomicBool>>,
) -> Result<HashMap<PathBuf, String>, String> {
  find_duplicate_groups_from_candidates_with_cache(
    candidates,
    use_hash,
    min_size_bytes,
    cancel_flag,
    None,
  )
}

pub(super) fn find_duplicate_groups_from_candidates_with_cache(
  candidates: &[DuplicateCandidate],
  use_hash: bool,
  min_size_bytes: u64,
  cancel_flag: Option<&Arc<AtomicBool>>,
  mut hash_cache: Option<&mut HashCache>,
) -> Result<HashMap<PathBuf, String>, String> {
  let mut size_map: HashMap<u64, Vec<&DuplicateCandidate>> = HashMap::new();
  for candidate in candidates {
    if let Some(flag) = cancel_flag {
      if flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
    }
    if candidate.size_bytes < min_size_bytes {
      continue;
    }
    size_map
      .entry(candidate.size_bytes)
      .or_default()
      .push(candidate);
  }

  let mut duplicates = HashMap::new();
  for (size, group) in size_map.into_iter() {
    if let Some(flag) = cancel_flag {
      if flag.load(Ordering::Relaxed) {
        return Err("Scan cancelled".into());
      }
    }
    if group.len() < 2 {
      continue;
    }
    if use_hash {
      // Stage 2: partial hash (first/last chunks) to reduce full-hash work.
      let mut partial_map: HashMap<String, Vec<&DuplicateCandidate>> = HashMap::new();
      let partial_hashes = group
        .par_iter()
        .filter_map(|candidate| {
          if cancel_flag
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false)
          {
            return None;
          }
          partial_hash_file(&candidate.path)
            .ok()
            .map(|hash| (hash, *candidate))
        })
        .collect::<Vec<_>>();
      if let Some(flag) = cancel_flag {
        if flag.load(Ordering::Relaxed) {
          return Err("Scan cancelled".into());
        }
      }
      for (hash, path) in partial_hashes {
        partial_map.entry(hash).or_default().push(path);
      }

      // Stage 3: full hash only for remaining candidate groups with early termination.
      for partial_group in partial_map.into_values() {
        if partial_group.len() < 2 {
          continue;
        }
        let mut full_hash_map: HashMap<String, Vec<PathBuf>> = HashMap::new();
        let mut missing = Vec::new();
        if let Some(cache) = hash_cache.as_deref() {
          for candidate in &partial_group {
            if let Some(hash) = cached_full_hash(candidate, cache) {
              full_hash_map
                .entry(hash)
                .or_default()
                .push(candidate.path.clone());
            } else {
              missing.push(*candidate);
            }
          }
        } else {
          missing = partial_group.clone();
        }

        if !missing.is_empty() {
          let full_hashes = missing
            .par_iter()
            .filter_map(|candidate| {
              if cancel_flag
                .map(|flag| flag.load(Ordering::Relaxed))
                .unwrap_or(false)
              {
                return None;
              }
              hash_file(&candidate.path, cancel_flag.map(Arc::as_ref))
                .ok()
                .map(|hash| (hash, *candidate))
            })
            .collect::<Vec<_>>();
          if let Some(flag) = cancel_flag {
            if flag.load(Ordering::Relaxed) {
              return Err("Scan cancelled".into());
            }
          }
          for (hash, candidate) in full_hashes {
            if let Some(cache) = hash_cache.as_deref_mut() {
              insert_cached_full_hash(candidate, hash.clone(), cache);
            }
            full_hash_map
              .entry(hash)
              .or_default()
              .push(candidate.path.clone());
          }
        }

        for (hash, files) in full_hash_map.into_iter() {
          if files.len() > 1 {
            for path in files {
              duplicates.insert(path.clone(), hash.clone());
            }
          }
        }
      }
    } else {
      let group_key = format!("size-{}", size);
      for candidate in group {
        duplicates.insert(candidate.path.clone(), group_key.clone());
      }
    }
  }
  Ok(duplicates)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cancelled_hash_stops_after_one_chunk_instead_of_reading_the_whole_file() {
    struct CancelAfterRead<'a> {
      cancelled: &'a AtomicBool,
      reads: usize,
    }
    impl Read for CancelAfterRead<'_> {
      fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        self.reads += 1;
        assert_eq!(self.reads, 1, "hashing continued after cancellation");
        bytes.fill(1);
        self.cancelled.store(true, Ordering::Relaxed);
        Ok(bytes.len())
      }
    }
    let cancelled = AtomicBool::new(false);
    let mut reader = CancelAfterRead {
      cancelled: &cancelled,
      reads: 0,
    };
    assert_eq!(
      hash_reader(&mut reader, Some(&cancelled)).unwrap_err(),
      "Scan cancelled"
    );
    assert_eq!(reader.reads, 1);
  }

  #[test]
  fn hashing_keeps_standard_sha256_and_does_not_read_when_already_cancelled() {
    let cancelled = AtomicBool::new(false);
    let bytes = b"abc";
    assert_eq!(
      hash_reader(&mut bytes.as_slice(), Some(&cancelled)).unwrap(),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    cancelled.store(true, Ordering::Relaxed);
    let mut reader = std::io::Cursor::new(bytes);
    assert!(hash_reader(&mut reader, Some(&cancelled)).is_err());
    assert_eq!(reader.position(), 0);
  }
}
