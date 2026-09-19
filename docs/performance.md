# Performance audit and refactor

## Architecture and priorities

The entry points are `src/main.tsx` → `src/app/App.tsx` and `src-tauri/src/main.rs` → `lib.rs::run`. This is a local-first React/Tauri application: the relevant data access is filesystem traversal, media reads, in-memory indexes, and JSON persistence, rather than a network API or database.

The main path is native traversal/metadata indexing → progress and 500-file batch events → React filtering/sorting → grouped/tree rows → selection and preview commands. Mutations update filesystem state, the native index, and undo records. Startup initializes persisted caches, crash reporting, backup/cache maintenance, and the UI.

The audit covered these paths plus duplicate hashing, bounded media responses, preview conversion, settings persistence, cancellation, and undo. Existing controls worth retaining include parallel scan metadata work, generation checks for stale scans, debounced previews, hash caching, bounded preview reads, and atomic record writes.

Priorities were: (1) bound mounted UI work, (2) remove eager/repeated native index rebuilds, (3) offload blocking native work, and (4) defer unused startup code and simplify lifecycle ownership. A database migration, new worker architecture, and general-purpose result caches were not needed for these improvements.

## Measurements

Measured locally on macOS with the same fixtures before/after. Browser timings use Chromium, Vite development mode, 10,000 synthetic files in reverse name order, and Playwright's assertion/polling overhead. They measure receipt of a mocked scan result to a selected rendered row, **not filesystem scan duration**. The unchanged source was run from an isolated baseline copy.

| Path | Before | After |
| --- | ---: | ---: |
| Scan result to rendered list | 864.5 ms | 55.6–70.3 ms across local runs |
| Mounted file buttons, initial viewport | 10,000 | 34 |
| Native index replacement, 10,000 files | 78.09 ms | 3.91–4.06 ms |
| Native index insertion, 100 more files | 27.24 s | 0.27–0.31 ms |
| Initial production JavaScript | 301.66 kB | 273.28 kB |
| Initial production JavaScript, gzip | 88.47 kB | 85.36 kB |

Native numbers are debug-build microbenchmarks, not release-build end-to-end timings. Insertion no longer sorts: the first request for a sort mode pays that cost. The final run measured a first sorted query at 10.05 ms and a cached query at 4.23 ms; the benchmark reports both to make the deferred cost visible. DOM counts and removal of duplicated native file storage establish reductions in retained objects; process RSS, energy, and actual native startup latency were not measured.

Reproduce:

```sh
npm run build
npx playwright test test/e2e/performance.spec.ts --workers=1
cargo test --manifest-path src-tauri/Cargo.toml benchmark_index_large_folder -- --ignored --nocapture
```

`TIDY_PERF_BASELINE=1` disables the virtualization-specific assertions so the browser fixture can run against the old source. Timing is diagnostic, not a brittle CI speed threshold; the normal regression test enforces a bounded mounted-row count.

## Changes and tradeoffs

- **Virtualized file views:** `fileListModel.ts` builds grouping, folder totals, collapse keys, and keyboard order once. `VirtualFileList.tsx` renders only visible file/folder/group rows plus overscan. Binary searches find the visible range; scroll/resize events coalesce into animation frames. Selection scrolls by model offsets, including unmounted rows. Collapsed files remain in keyboard navigation as before. Row heights are explicit for density and duplicate metadata; future row-layout changes must update the height model. Browser find-in-page and native tab traversal only see mounted rows; the application's arrow navigation covers the full collection.
- **Simpler React lifecycle:** removed duplicated tree/group traversal, all-row element references, imperative selection class changes, and obsolete render-count state. The list is memoized independently of preview animation state. Shared `useScrollHints` replaces three copies of observer code. Settings owns its observers, attaches them after lazy mounting, and calls hooks consistently when closed.
- **Sorting:** a shared `Intl.Collator` retains case-insensitive locale ordering without rebuilding comparison machinery per comparison. Extension keys are extracted once per extension sort. Source arrays remain unchanged.
- **Native index:** extracted `index.rs`; stores each file once, maps IDs to vector positions, and lazily caches only requested sort orders as integer positions. Inserts/updates no longer clone and sort the whole collection. All mutation paths invalidate cached orders. Paginated queries still compute accurate totals/group counts but clone only the requested page. The first sorted query and post-mutation query have a cold-cache cost; filtering/counting remains linear.
- **Background I/O:** media protocol reads, scan-cache loading/writing/hydration, index queries, cleanup suggestions, preview source materialization/conversion, and filesystem mutations run on blocking workers. Mutations remain serialized under a dedicated lock, and preview generation/cache checks share one lock to avoid duplicate concurrent conversions. Existing command names and IPC payloads remain compatible. Long operations can still delay another operation using the same lock, but their filesystem work no longer runs in the UI callback.
- **Startup:** backup and preview-cache maintenance run after state initialization on a worker, coordinated with mutation and preview locks. Crash/session initialization remains ordered. Dialog modules load on first use and stay mounted thereafter to retain local state; their first opening now includes module loading. Removed unused `react-window` dependency and its lockfile entry.

## Verification

- 77 frontend unit/integration tests pass, including new sorting, hierarchy, collapse, and offset-boundary cases.
- 13 Chromium browser tests pass: 10,000-file scrolling/navigation, groups/tree collapse, settings reopening, scan, trash/undo, and mobile gestures. Inspected the large-folder screenshot.
- 48 Rust tests pass; the manual benchmark and explicit SMB integration test are ignored in normal runs. The SMB test also passed separately on a mounted NAS share. New index tests cover paging/counts and invalidation after insert, update, remove, subtree removal, and path removal.
- Production build and TypeScript checks pass. Existing coverage thresholds pass; their configured scope is limited and is not whole-application coverage.
- Strict library Clippy and whitespace checks pass. Legacy flat IPC arguments and audit-record fields have narrow documented argument-count exceptions.

## Follow-up: scan pipeline and cancellation

The follow-up targets intermediate scan work and persistence, rather than only the final render. Reproduce its isolated JavaScript benchmark with:

```sh
node scripts/benchmark-scan-pipeline.mjs
```

For 50,000 synthetic files arriving in 100 batches, repeated local samples measured **210–262 ms** for the old accumulate-and-rededuplicate loop versus **9.6–17 ms** for the new incremental queue. Both versions publish the same number of times in this benchmark, so this isolates deduplication and array construction rather than claiming a whole-scan speedup. In the application, updates additionally coalesce to at most ten publications per second. The tradeoff is up to 100 ms of delay for intermediate rows; final results remain immediate and authoritative.

The same fixture previously required a **7,311,758-byte** cache-save upload from JavaScript back to Rust, costing roughly 19–25 ms just for local JSON stringification. That upload is removed entirely: an optional `cacheResult` argument lets the scan worker persist its existing result. Existing callers can omit the argument, and the legacy cache command remains available. Scan and hash caches serialize through a 64 KiB buffered atomic writer rather than allocating a complete JSON string first. Partial/cancelled scans never replace a good cache; serialization failures clean up temporary files. Cache-write failures remain nonfatal to successful scans and are logged natively.

Additional changes:

- Moved duplicate detection into `hashing.rs` and retain candidate references between stages instead of repeatedly cloning paths/metadata. Full hashing checks cancellation before every 8 KiB read. A deterministic reader test proves it stops after the first read that sets cancellation, rather than consuming the remaining input. An operating-system read already in progress can still block.
- Hash caches load only when verified duplicate scanning first needs them. Size-only duplicate scans do not load them. A nonserialized dirty flag avoids rewriting unchanged caches, and failed writes retain the dirty flag for retry. This removes startup I/O structurally; native startup time was not benchmarked.
- Preview work pauses while scanned file IDs are not yet registered in the native index. Cancelled/failed scans clear uncommitted streamed entries instead of exposing unusable actions.
- Single-file and folder removal share one selection path. Removing files filters the already-sorted order instead of sorting it a second time; it also reuses the ID-index map for membership checks.
- Cleanup suggestions cache modification-time sort keys instead of issuing filesystem metadata calls inside comparisons, and reuse metadata for age checks.
- Added regression coverage for queue coalescing/reset/deduplication, native cache opt-in without file upload, cancelled scans, cancellable hashing, cache schema compatibility, atomic cache cancellation, and hash-cache retry/no-write behavior. Fixed the portable screenshot callback in the large-folder browser fixture.

## Popup and sidebar follow-up

- All application popups now share `Modal.tsx`: consistent surfaces, bounded scrolling, focus containment/restoration, and Escape/backdrop dismissal. In-app confirmations use `useConfirmation.tsx`, default to Cancel, and block application deletion/navigation shortcuts. Protected-path warnings show the target and native policy reason, including canonical/symlink resolution; confirming authorizes only that operation. Permanent deletion always asks, independently of the ordinary trash-confirmation preference. Native permanent-delete authorization is separate from protected-path overrides.
- Scan progress no longer alternates between indexing/scanning labels or shows a misleading completion percentage while discovery continues. Native stages distinguish discovery, duplicate checking, and final preparation; cancellation and cached-scan hydration have distinct explanations. Simple sort/group/view/theme changes no longer flash a blocking popup.
- Sidebar rows have explicit line heights and enough space for folder metadata; long folder names truncate while keeping the trash control accessible. Windows drive-case differences, UNC paths, and extended-length prefixes no longer create phantom tree ancestors. The virtualizer keeps stable scroll/resize subscriptions, uses additional overscan (34 initial mounted file rows in the 10,000-file fixture), and avoids revealing the selected row on every unrelated layout update. Hiding/reopening the sidebar preserves scroll position. Removed its 600 ms fade/scale entrance and backdrop blur, which made reopened rows look dim or missing and added compositing work.
- Added browser checks for Windows-style paths, long names, resize, density changes, hide/reopen, scan stages/cancellation, and protected deletion. Verified popup screenshots and keyboard focus. Native Windows/WebView2 and fractional-DPI hardware rendering still require validation on Windows; Chromium tests on macOS are not a substitute for that.

## macOS SMB undo: reproduced and fixed

An isolated test on a mounted SMB NAS reproduced a successful trash/local backup followed by a failed restore. The first failure was `Permission denied` copying extended attributes. After addressing that, the share rejected `fsync` and atomic exclusive rename with `Operation not supported` (errno 45). The expanded test also exposed SMB resetting modification time when a writable file handle closed.

`file_operations.rs` now omits only macOS's internal `com.apple.provenance` attribute during native copying; resource forks, other extended attributes, and ACL/stat copying remain enabled. Explicit unsupported-flush errors are distinguished from real write failures. If the filesystem rejects exclusive rename, exclusive creation/copy provides a no-overwrite fallback. The original backup is retained until the copy succeeds. Missing restore parents are reported instead of being recreated, avoiding accidental local replacement of an absent mount path. Restored timestamps are set after closing the writable handle.

Tradeoffs: servers without exclusive rename can expose the destination during fallback copying (rather than only after atomic publication), and may require an extra copy after a failed staged publication. Partial copies are cleaned up on reported errors. A server without flush support cannot provide the same crash-durability guarantee as a local fsync-capable filesystem; permission, disconnect, and write errors still propagate.

The real-share test verifies file contents, a resource fork, a custom extended attribute, modification time, destination collision without overwrite, successful retry, and a nested folder containing a 256 KiB binary payload. It creates uniquely named test files and does not operate on existing NAS files. It is opt-in:

```sh
TIDY_SMB_TEST_ROOT=/Volumes/your-share cargo test --manifest-path src-tauri/Cargo.toml smb_delete_and_undo_roundtrip -- --ignored --nocapture
```

The UI now shows failed Undo operations in the shared dialog, including recovery/destination paths and a Retry action; failed actions stay in history. Approved protected-path deletion records retain their override for restoring to the same location, including persisted history. Folder undo publishes restored files in one update instead of sorting the growing list once per file; controller/browser tests cover batches of 1,000/3,000 files.

## Remaining work

- Very large scans still retain full results on both sides of IPC. Loading a saved scan still sends its files back for hydration. Filtering/sorting runs per coalesced update; a native paging subscription and native cache hydration are candidates for workloads beyond the tested interactive 10,000-file and isolated 50,000-file cases.
- Duplicate hashing, image classification, and Office conversion remain dependent on file size, storage throughput, and external tools. Cancellation of a queued preview conversion and bounded media-read concurrency deserve device-level profiling before adding more scheduling machinery.
- Histories and JSON caches could need bounds/compaction at larger scales. The broad App/native root modules still own substantial orchestration, although list/index responsibilities are now separated.
- Validate native UI latency and memory on Windows, Android, slow/network-mounted storage, and very large real folders. This pass ran native Rust checks on macOS and browser tests in Chromium; it does not establish performance on every platform.
