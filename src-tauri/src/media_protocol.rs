//! Bounded local-media responses.
use super::*;
const MAX_PREVIEW_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

fn parse_range(range: &str, size: u64, max_length: Option<u64>) -> Option<(u64, u64)> {
  if !range.starts_with("bytes=") || range.contains(',') {
    return None;
  }
  let range = range.trim_start_matches("bytes=");
  let mut parts = range.split('-');
  let start_part = parts.next()?.trim();
  let end_part = parts.next().map(|value| value.trim());
  let (start, end) = if start_part.is_empty() {
    let suffix_length = end_part?.parse::<u64>().ok()?;
    if suffix_length == 0 || size == 0 {
      return None;
    }
    let mut length = suffix_length.min(size);
    if let Some(max_length) = max_length {
      length = length.min(max_length);
    }
    let start = size.saturating_sub(length);
    (start, size.saturating_sub(1))
  } else {
    let start = start_part.parse::<u64>().ok()?;
    let end = match end_part {
      Some("") | None => {
        let mut end = size.saturating_sub(1);
        if let Some(max_length) = max_length {
          let capped = start.saturating_add(max_length.saturating_sub(1));
          end = std::cmp::min(capped, end);
        }
        end
      }
      Some(value) => value.parse::<u64>().ok()?,
    };
    (start, end)
  };
  if start > end || start >= size {
    return None;
  }
  if parts.next().is_some() {
    return None;
  }
  let mut end = std::cmp::min(end, size.saturating_sub(1));
  if let Some(limit) = max_length {
    if limit == 0 {
      return None;
    }
    end = end.min(start.saturating_add(limit - 1));
  }
  Some((start, end))
}

fn should_cap_range_requests(content_type: &str) -> bool {
  !(content_type.starts_with("image/") || content_type == "application/pdf")
}

fn build_response(
  status: StatusCode,
  headers: HeaderMap,
  body: Vec<u8>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
  let mut builder = Response::builder().status(status);
  for (name, value) in headers {
    if let Some(name) = name {
      builder = builder.header(name, value);
    }
  }
  Ok(builder.body(body)?)
}

pub(super) fn protocol_response(
  app: &AppHandle,
  request: tauri::http::Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
  let raw_id = request.uri().path().trim_start_matches('/').to_string();
  let id = percent_decode_str(&raw_id).decode_utf8_lossy().to_string();
  if id.is_empty() {
    return build_response(StatusCode::NOT_FOUND, HeaderMap::new(), Vec::new());
  }

  let state = app.state::<AppState>();
  let map = state.map.lock().expect("map lock");
  let source = match map.get(&id) {
    Some(source) => source.clone(),
    None => {
      return build_response(StatusCode::NOT_FOUND, HeaderMap::new(), Vec::new());
    }
  };
  drop(map);
  let path = managed_source_to_local_path(app, &source).map_err(|error| {
    Box::new(std::io::Error::new(std::io::ErrorKind::NotFound, error))
      as Box<dyn std::error::Error + Send + Sync>
  })?;

  file_response(&path, request)
}

fn file_response(
  path: &Path,
  request: tauri::http::Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
  let mut file = File::open(path)?;
  let metadata = file.metadata()?;
  let size = metadata.len();

  let content_type = MimeGuess::from_path(path)
    .first_or_octet_stream()
    .essence_str()
    .to_string();

  let mut headers = HeaderMap::new();
  headers.insert(
    HeaderName::from_static("content-type"),
    HeaderValue::from_str(&content_type)
      .unwrap_or(HeaderValue::from_static("application/octet-stream")),
  );
  headers.insert(
    HeaderName::from_static("accept-ranges"),
    HeaderValue::from_static("bytes"),
  );

  if request.method() == tauri::http::Method::HEAD {
    headers.insert(
      HeaderName::from_static("content-length"),
      HeaderValue::from_str(&size.to_string())?,
    );
    return build_response(StatusCode::OK, headers, Vec::new());
  }
  if request.method() != tauri::http::Method::GET {
    return build_response(StatusCode::METHOD_NOT_ALLOWED, headers, Vec::new());
  }
  if let Some(range_value) = request.headers().get("range") {
    if let Ok(range_str) = range_value.to_str() {
      let max_range_length = if should_cap_range_requests(&content_type) {
        Some(MAX_RANGE_CHUNK_BYTES)
      } else {
        Some(MAX_PREVIEW_RESPONSE_BYTES)
      };
      if let Some((start, end)) = parse_range(range_str, size, max_range_length) {
        let length = end - start + 1;
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = vec![0u8; length as usize];
        file.read_exact(&mut buffer)?;
        headers.insert(
          HeaderName::from_static("content-range"),
          HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, size))
            .unwrap_or(HeaderValue::from_static("bytes 0-0/0")),
        );
        headers.insert(
          HeaderName::from_static("content-length"),
          HeaderValue::from_str(&length.to_string()).unwrap_or(HeaderValue::from_static("0")),
        );
        return build_response(StatusCode::PARTIAL_CONTENT, headers, buffer);
      }
    }
    headers.insert(
      HeaderName::from_static("content-range"),
      HeaderValue::from_str(&format!("bytes */{}", size))?,
    );
    return build_response(StatusCode::RANGE_NOT_SATISFIABLE, headers, Vec::new());
  }

  // Tauri protocol responses own a Vec, so an unbounded 200 response cannot be
  // streamed. Range-capable media use chunks; other oversized requests fail
  // explicitly rather than returning a truncated file or exhausting memory.
  if size > MAX_PREVIEW_RESPONSE_BYTES {
    return build_response(StatusCode::PAYLOAD_TOO_LARGE, headers, Vec::new());
  }
  let mut buffer = Vec::with_capacity(size as usize);
  file
    .take(MAX_PREVIEW_RESPONSE_BYTES + 1)
    .read_to_end(&mut buffer)?;
  if buffer.len() as u64 > MAX_PREVIEW_RESPONSE_BYTES {
    return build_response(StatusCode::PAYLOAD_TOO_LARGE, headers, Vec::new());
  }
  headers.insert(
    HeaderName::from_static("content-length"),
    HeaderValue::from_str(&buffer.len().to_string()).unwrap_or(HeaderValue::from_static("0")),
  );
  build_response(StatusCode::OK, headers, buffer)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn parse_range_handles_standard_and_capped_ranges() {
    assert_eq!(parse_range("bytes=0-9", 100, None), Some((0, 9)));
    assert_eq!(parse_range("bytes=10-", 100, Some(5)), Some((10, 14)));
    assert_eq!(parse_range("bytes=-10", 100, None), Some((90, 99)));
    assert_eq!(parse_range("bytes=-10", 100, Some(4)), Some((96, 99)));
    assert_eq!(parse_range("bytes=90-200", 100, None), Some((90, 99)));
    assert_eq!(parse_range("bytes=101-200", 100, None), None);
    assert_eq!(parse_range("items=0-9", 100, None), None);
  }

  #[test]
  fn range_capping_skips_images_and_pdfs() {
    assert!(!should_cap_range_requests("image/png"));
    assert!(!should_cap_range_requests("application/pdf"));
    assert!(should_cap_range_requests("text/plain"));
  }

  #[test]
  fn explicit_ranges_are_capped_and_malformed_ranges_rejected() {
    assert_eq!(
      parse_range("bytes=0-999999999", 100_000_000, Some(1024)),
      Some((0, 1023))
    );
    assert_eq!(parse_range("bytes=0-1-2", 100, None), None);
    assert_eq!(parse_range("bytes=0-1,4-5", 100, None), None);
    assert_eq!(parse_range("bytes=0-", 0, None), None);
  }
  #[test]
  fn oversized_files_support_head_and_ranges_without_whole_file_allocation() {
    let path = std::env::temp_dir().join(format!("{}.mp4", Uuid::new_v4()));
    File::create(&path)
      .unwrap()
      .set_len(MAX_PREVIEW_RESPONSE_BYTES + 1)
      .unwrap();
    let request = || tauri::http::Request::builder().body(Vec::new()).unwrap();
    assert_eq!(
      file_response(&path, request()).unwrap().status(),
      StatusCode::PAYLOAD_TOO_LARGE
    );
    let response = file_response(
      &path,
      tauri::http::Request::builder()
        .method("HEAD")
        .body(Vec::new())
        .unwrap(),
    )
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.body().is_empty());
    let response = file_response(
      &path,
      tauri::http::Request::builder()
        .header("range", "bytes=0-999999999")
        .body(Vec::new())
        .unwrap(),
    )
    .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.body().len(), MAX_RANGE_CHUNK_BYTES as usize);
    let response = file_response(
      &path,
      tauri::http::Request::builder()
        .header("range", "bytes=999999999-")
        .body(Vec::new())
        .unwrap(),
    )
    .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert!(response.body().is_empty());
    fs::remove_file(path).unwrap();
  }
}
