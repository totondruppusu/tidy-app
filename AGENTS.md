# AGENTS.md

## Shell commands: use `rtk`

Always prefix shell commands with `rtk` to reduce token output.

```bash
rtk git status
rtk npm run build
rtk npm test
rtk cargo test
```

Meta commands:

- `rtk gain` — token savings analytics
- `rtk gain --history` — recent savings history
- `rtk proxy <cmd>` — run raw command without filtering

## Project map (kept intentionally short)

Local-first desktop file organizer. React front-end (`src/`) + Tauri/Rust shell (`src-tauri/`).

- `src/app/App.tsx` — composition/root component; routes data to panels and modals. It should stay a thin orchestrator: no new business logic here.
- `src/components/` — UI components (panels, modals, virtual list).
- `src/hooks/` — React hooks owning state and behavior (`useScanController`, `useScanWorkflow`, `useMutationController`, `usePreviewController`, `useSuggestionsController`, `useSwipeGestureController`, `useUndoController`, `useConfirmation`, `useAppSettings`, `useFileOperations`, `useExtensionFilter`, `useDesktopEnvironment`, `useKeyboardShortcuts`, `useAndroidFolderPicker`).
- `src/services/` — external/platform and command wrappers (`platform.ts`, `fileManagerService.ts`, `suggestionsService.ts`, `directoryService.ts`, `previewService.ts`).
- `src/lib/` — pure testable helpers (files, path, tree, grouping, sorting, format, media, markdown, code preview, virtual scroll, settings, dom).
- `src/constants/` — configuration values (app constants + suggestion options).
- `src/types/index.ts` — shared domain types.

## Architecture conventions

- Keep `App.tsx` as a high-level composition root. Its main responsibilities: wiring hooks, passing data to panels/modals, and owning `App`-level UI states (open/closed modals, sidebar collapse).
- Put behavior in focused hooks that receive explicit dependencies (callbacks, settings, refs) and return cohesive, named callbacks.
- Pure/derivable logic belongs in `src/lib/` so it can be unit-tested without React.
- Platform-specific behavior only when the desktop vs Android flow actually differs; otherwise share code and branch behind `src/services/platform.ts`.
- Preserve all existing functionality. The on-disk app behavior is the source of truth.

## Validation

- `rtk npm run build` (typecheck + production build)
- `rtk npm test` (unit + integration tests)
- `rtk npm run test:e2e` (Playwright UI regressions)
- `rtk npm run test:rust` (Cargo tests)

Run the full suite when refactoring the app layer.
