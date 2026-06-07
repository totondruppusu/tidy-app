# Tidy App

<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Tidy App icon" width="128" height="128">
</p>

Tidy App is a desktop file-triage tool built with Tauri, React, TypeScript, and Rust. It helps you scan folders, inspect clutter quickly, preview common file formats, detect duplicates, and clean up files with safety controls and undo support.

The project is designed for local-first cleanup workflows. Scanning, preview generation, duplicate analysis, and cleanup actions run on the machine where the app is installed.

## Highlights

- Fast folder scanning for top-level folders or recursive scans.
- File-type filters for images, screenshots/memes, videos, audio, documents, text, archives, executables, binaries, and duplicates.
- Tree and list browsing modes with sorting, grouping, extension filtering, and density controls.
- Preview support for images, video, audio, text, PDF, archives, and Office documents.
- Duplicate detection with optional hash-based verification and minimum-size thresholds.
- One-click move actions via saved destination slots.
- Trash, permanent delete, folder trash, and undo flows with guardrails.
- Cleanup suggestions with dry-run batch previews before applying actions.
- Cached scans, hash caching, and crash-report recovery.

## Feature Overview

### Scanning and Browsing

- Select a folder and scan only the current level or include subfolders.
- Optionally include hidden files and hidden directories.
- Reuse cached scans when the folder and scan options match a previous run.
- Switch between:
  - `tree` view for folder-oriented browsing
  - `list` view for flat triage workflows
- Sort by name, size, date, type, or extension.
- Group by type, extension, or duplicate set.
- Filter by remembered or common extensions.

### Preview and Review

- Image preview with zoom, pan, and reset controls.
- Video and audio preview with keyboard playback shortcuts.
- Text and PDF preview in-app.
- Archive preview for supported compressed formats by listing entries.
- Office preview:
  - Rich preview on macOS when Quick Look rendering is available
  - Text fallback extraction for supported Office document formats on other platforms
- Reveal files in the system file manager or open them in the default app.

### Cleanup Actions

- Save up to 5 destination slots for fast file moves.
- Move files into chosen destinations.
- Send files to the system trash with undo support.
- Permanently delete files when enabled in settings.
- Trash folders directly from tree view.
- Restore recent actions from a persisted undo stack of up to 20 entries.
- Review paged operation history stored locally for auditability.

### Duplicate Detection and Suggestions

- Duplicate scan mode groups matching files together.
- Optional hash-based duplicate confirmation improves accuracy.
- Configurable minimum file size threshold avoids wasting time on tiny files.
- TODO Built-in cleanup suggestions identify:
  - duplicate files
  - stale large downloads/installers
  - temporary or cache-like files
  - empty folders
- TODO Suggestion batches support dry-run previews before real changes are applied.
- TODO Suggestion presets can be saved locally and reused.

### Reliability and Safety

- Protected-path checks block destructive actions in sensitive locations by default.
- Crash reports are persisted locally and surfaced on next launch after recovery.
- Heartbeat and activity snapshots help diagnose unclean shutdowns.
- Large previews can be skipped to reduce memory and rendering cost.

## Technical Details

### Stack

- Desktop shell: Tauri 2
- Frontend: React 18, TypeScript, Vite
- Backend/native layer: Rust
- Virtualized rendering: `react-window`
- Testing: Vitest, Testing Library, Playwright, Rust unit tests

### Architecture

- `src/app/App.tsx`
  Main application shell and UI state management.
- `src/components/`
  Modal and UI subcomponents such as settings and help.
- `src/lib/`
  Frontend helpers for grouping, tree building, formatting, settings, bridge access, and utility logic.
- `src-tauri/src/main.rs`
  Native commands for scanning, preview generation, duplicate detection, journaling, undo, suggestions, and file operations.
- `test/`
  Unit, integration, and end-to-end test coverage for the web/desktop bridge behavior.

### Native Behavior

The Rust backend is responsible for:

- filesystem traversal with `walkdir`
- parallel scan/index work with `rayon`
- MIME/type guessing
- duplicate detection with optional SHA-256 hashing
- archive inspection for supported formats
- preview generation and platform-specific integration
- journaling, undo persistence, crash recovery, and batch action execution

### Local Data and Persistence

Tidy App stores settings and workflow metadata locally:

- UI settings and presets are stored in browser/Tauri webview local storage.
- App data files are stored in the platform app-data directory.
- Persisted files include:
  - `operation-history.jsonl`
  - `undo-actions.json`
  - `hash-cache.json`
  - cached scan files under `scan-cache/`
  - batch records under `applied-batches/`
  - crash reports under `crash-reports/`

No remote service is required for core functionality.

## Supported Workflows

- Clean a folder by scanning recursively and reviewing stale large files.
- Find screenshots or memes using image analysis.
- Find duplicate media or files.
- Triage archives, Office files, and PDFs without constantly switching apps.
- TODO Batch-apply conservative cleanup suggestions after validating them in dry-run mode.

## Getting Started

### Prerequisites

#### macOS

- Node.js 18+
- Rust stable toolchain
- Xcode Command Line Tools

Install Xcode CLI tools if needed:

```bash
xcode-select --install
```

#### Windows

- Node.js 18+
- Rust stable toolchain
- Microsoft C++ Build Tools
- WebView2 Runtime

### Install Dependencies

```bash
npm install
```

### Run in Development

Web UI only:

```bash
npm run dev
```

Desktop app with Tauri:

```bash
npm run tauri dev
```

## Build

Build the frontend bundle:

```bash
npm run build
```

Build the desktop application:

```bash
npm run tauri build
```

Tauri is configured to run `npm run build` before packaging, so `npm run tauri build` is the normal release build path.

## Test Suite

Run frontend unit and integration tests:

```bash
npm run test
```

Run coverage:

```bash
npm run test:coverage
```

Run Playwright smoke tests:

```bash
npm run test:e2e
```

Run Rust tests:

```bash
npm run test:rust
```

Run the full local gate:

```bash
npm run test:all
```

## Contributor Notes

### Development Expectations

- Keep behavior local-first and conservative around destructive actions.
- Prefer explicit review flows over automation that hides file mutations.
- Preserve cross-platform behavior where possible; document platform-specific fallbacks when not.
- Add or update tests for meaningful scan, cleanup, preview, or persistence changes.

### Repo Workflow

1. Create a branch for the change.
2. Make the smallest coherent change that solves the problem.
3. Run the relevant tests locally.
4. Open a pull request with:
   - a clear user-facing summary
   - risk notes for destructive or filesystem-touching changes
   - test coverage notes

### Areas That Deserve Extra Care

- File deletion, trash, restore, and batch-action behavior
- Duplicate detection accuracy and performance
- Cached scan correctness
- Platform-specific preview behavior
- Crash-report and recovery logic

### Testing Guidance

- Use `npm run test` for frontend changes.
- Use `npm run test:e2e` when UI workflows or bridge behavior change.
- Use `npm run test:rust` when touching Tauri commands, scan logic, previews, or filesystem actions.
- Use `npm run test:all` before merging larger changes.

## License

This project is licensed under the GNU Affero General Public License v3. See [LICENSE](/Users/simone/Documents/software_projects/tidy-app/LICENSE).
