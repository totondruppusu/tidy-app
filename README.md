# Tidy-app

Tidy-app is a desktop file triage tool built with Tauri, React, and Vite. It scans folders, previews files, and helps you move or delete clutter quickly.

## Functionalities

- Scan a folder (optionally including subfolders and hidden items).
- Filter by file type (images, videos, audio, docs, text, compressed, executables, binary).
- Sort by name, size, date, type, or extension.
- Group by type, extension, or duplicate sets.
- Detect duplicates (optionally using hashes and minimum size thresholds).
- Preview images, video, audio, text, PDF, Office documents, and archives.
- Tree and list views with adjustable density.
- One-click move to saved destination slots.
- Trash items or delete permanently, with undo support for recent actions.
- Keyboard shortcuts and configurable settings (theme, auto-scan, autoplay, etc.).

## Installation

### macOS

Prerequisites:
- Node.js 18+ (or the version you use for Vite)
- Rust toolchain (stable) and Cargo
- Xcode Command Line Tools (`xcode-select --install`)

Steps:
```bash
npm install
```

Run the desktop app:
```bash
npm run tauri dev
```

Run the web UI only:
```bash
npm run dev
```

### Windows

Prerequisites:
- Node.js 18+ (or the version you use for Vite)
- Rust toolchain (stable) and Cargo
- Microsoft C++ Build Tools (Visual Studio Build Tools)
- WebView2 Runtime

Steps:
```powershell
npm install
```

Run the desktop app:
```powershell
npm run tauri dev
```

Run the web UI only:
```powershell
npm run dev
```

## Build

### macOS

Build the web assets:
```bash
npm run build
```

Build the desktop app:
```bash
npm run tauri build
```

### Windows

Build the web assets:
```powershell
npm run build
```

Build the desktop app:
```powershell
npm run tauri build
```

## Notes

- Tauri uses `npm run build` before packaging (`src-tauri/tauri.conf.json`), so `npm run tauri build` is usually all you need for release builds.
- The app uses a local settings store to remember filters, destinations, and UI preferences per machine.
