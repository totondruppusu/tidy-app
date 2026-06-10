import { invokeCommand } from "../lib/desktopBridge";
import type { ActionBatch, ActionBatchResult, SuggestionSet } from "../types";

type BuildCleanupSuggestionsRequest = {
  folderPath: string;
  includeSubfolders: boolean;
  includeHidden: boolean;
  staleDays: number;
  maxResults: number;
  minLargeFileBytes: number;
};

export const buildCleanupSuggestions = (
  request: BuildCleanupSuggestionsRequest,
) =>
  invokeCommand<SuggestionSet>("build_cleanup_suggestions", {
    request,
  });

export const runActionBatch = (request: ActionBatch) =>
  invokeCommand<ActionBatchResult>("apply_action_batch", { request });
