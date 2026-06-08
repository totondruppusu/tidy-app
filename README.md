# Tidy App

<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Tidy App icon" width="128" height="128">
</p>

<p align="center">
  <strong>Find clutter. Review files faster. Reclaim storage safely.</strong>
</p>

Tidy App is a free, open-source desktop file organizer and cleanup tool built with Tauri, React, TypeScript, and Rust.

It helps you scan folders, preview files, find duplicates, organize content, and clean up storage with safety controls and undo support.

Everything runs locally on your machine. No cloud service is required, and your files stay on your computer.

## Why Tidy App?

- ⚡ Fast folder scanning with cached results
- 👀 Built-in previews for common file types
- 🔍 Duplicate detection with optional hash verification
- 🌳 Tree and list views for flexible file review
- 🚀 One-click organization using saved destinations
- 🛡️ Trash, delete, undo, and operation history
- 🔒 Protected-path checks for safer cleanup
- 💻 Local-first design with no subscription or remote service

## Features

### Smart Scanning

Quickly inspect folders and understand what is taking up space.

- Scan only the current folder or include subfolders
- Include hidden files and directories when needed
- Reuse cached scans when scan options match
- Sort by name, size, date, type, or extension
- Group files by type, extension, or duplicate set
- Filter by remembered or common extensions

### File Preview

Review files without constantly switching apps.

Supported previews include:

- Images
- Videos
- Audio files
- Text files
- PDFs
- Archives
- Office documents

Additional preview tools include image zoom, pan controls, media shortcuts, file reveal, and opening files in the default system app.

### Duplicate Finder

Find wasted storage caused by copied or repeated files.

- Group matching duplicate files
- Use optional SHA-256 hash verification for stronger accuracy
- Configure minimum file-size thresholds
- Review duplicate groups before taking action

### Fast Organization

Move files where they belong with fewer clicks.

- Save up to 5 destination slots
- Move files into saved destinations
- Use tree or list workflows depending on the cleanup task
- Track actions in local operation history

### Safe Cleanup

Tidy App is designed to make cleanup safer and more reviewable.

- Send files to the system trash
- Permanently delete only when enabled in settings
- Trash folders from tree view
- Undo recent actions from a persisted undo stack
- Keep up to 20 recent undo entries
- Block destructive actions in protected paths by default
- Store operation history locally for auditability

### Cleanup Suggestions

Tidy App includes cleanup-oriented workflows for identifying likely clutter, such as:

- Duplicate files
- Large stale downloads or installers
- Temporary or cache-like files
- Empty folders

Suggestion batches can be reviewed before changes are applied.

## Privacy First

Tidy App is local-first by design.

Scanning, preview generation, duplicate analysis, file operations, caching, undo history, and crash recovery all run on the machine where the app is installed.

No account, cloud backend, subscription, or remote service is required for core functionality.

## Supported Workflows

Tidy App is useful when you want to:

- Clean a messy Downloads folder
- Find duplicate files and media
- Review large folders quickly
- Organize screenshots, memes, documents, archives, and videos
- Preview PDFs, Office files, archives, and media from one interface
- Free up storage without blindly deleting files
- Keep cleanup actions reversible where possible

## Getting Started

### Prerequisites

#### macOS

- Node.js 18+
- Rust stable toolchain
- Xcode Command Line Tools

Install Xcode Command Line Tools if needed:

bash xcode-select --install 

#### Windows

- Node.js 18+
- Rust stable toolchain
- Microsoft C++ Build Tools
- WebView2 Runtime

#### Linux

- Node.js 18+
- Rust stable toolchain
- Native libraries required by Tauri

Install common Linux dependencies:

bash sudo apt-get update sudo apt-get install -y \   pkg-config \   libglib2.0-dev \   libgtk-3-dev \   libwebkit2gtk-4.1-dev \   libayatana-appindicator3-dev \   librsvg2-dev \   patchelf 

## Install Dependencies

bash npm install 

## Run in Development

Run the web UI only:

bash npm run dev 

Run the desktop app with Tauri:

bash npm run tauri dev 

## Build

Build the frontend bundle:

bash npm run build 

Build the desktop application:

bash npm run tauri build 

Tauri is configured to run the frontend build before packaging, so this is the normal release build command:

bash npm run tauri build 

## Test Suite

Run frontend unit and integration tests:

bash npm run test 

Run coverage:

bash npm run test:coverage 

Run Playwright smoke tests:

bash npm run test:e2e 

Run Rust tests:

bash npm run test:rust 

Run the full local test gate:

bash npm run test:all 

## Contributing

Contributions are welcome.

Please keep changes conservative around file operations and destructive actions. Tidy App should always favor clear review flows, predictable behavior, and user control.

Recommended workflow:

1. Create a branch for your change.
2. Make the smallest coherent change that solves the problem.
3. Run the relevant tests locally.
4. Open a pull request with:
   - a clear user-facing summary
   - risk notes for filesystem or destructive-action changes
   - test coverage notes

Areas that deserve extra care:

- File deletion, trash, restore, and batch actions
- Duplicate detection accuracy and performance
- Cached scan correctness
- Platform-specific preview behavior
- Crash recovery and undo persistence

## Technical Details

### Stack

- Desktop shell: Tauri 2
- Frontend: React 18, TypeScript, Vite
- Backend/native layer: Rust
- Virtualized rendering: react-window
- Testing: Vitest, Testing Library, Playwright, Rust unit tests

### Architecture

text src/   app/     App.tsx   components/   lib/  src-tauri/   src/     main.rs  test/ 

Key areas:

- src/app/App.tsx  
  Main application shell and UI state management.

- src/components/  
  UI components, modals, settings, and help interfaces.

- src/lib/  
  Frontend helpers for grouping, tree building, formatting, settings, bridge access, and utility logic.

- src-tauri/src/main.rs  
  Native commands for scanning, previews, duplicate detection, journaling, undo, suggestions, and file operations.

- test/  
  Unit, integration, and end-to-end coverage for frontend and desktop bridge behavior.

### Native Backend Responsibilities

The Rust backend handles:

- Filesystem traversal with walkdir
- Parallel scan and indexing work with rayon
- MIME and file-type guessing
- Duplicate detection
- Optional SHA-256 hash verification
- Archive inspection
- Preview generation
- Platform-specific integrations
- Journaling and undo persistence
- Crash recovery
- Batch action execution

### Local Data and Persistence

Tidy App stores settings and workflow metadata locally.

UI settings and presets are stored in browser/Tauri webview local storage.

App data files are stored in the platform app-data directory.

Persisted files include:

text operation-history.jsonl undo-actions.json hash-cache.json scan-cache/ applied-batches/ crash-reports/ 

No remote service is required for core functionality.

## License

This project is licensed under the GNU Affero General Public License v3. See LICENSE.
