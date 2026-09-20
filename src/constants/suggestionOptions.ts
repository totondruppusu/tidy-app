import type { SuggestionActionFilter, SuggestionSortMode, SuggestionsMode } from "../types";

export const SUGGESTIONS_MODE_OPTIONS: { value: SuggestionsMode; label: string }[] = [
  { value: "review", label: "Review & Apply" },
  { value: "advanced", label: "Advanced" },
];

export const SUGGESTION_ACTION_FILTER_OPTIONS: {
  value: SuggestionActionFilter;
  label: string;
}[] = [
  { value: "all", label: "All actions" },
  { value: "trash", label: "Move to trash" },
  { value: "remove-empty-folder", label: "Remove empty folder" },
  { value: "move", label: "Move file" },
  { value: "delete", label: "Delete permanently" },
];

export const SUGGESTION_SORT_OPTIONS: { value: SuggestionSortMode; label: string }[] = [
  { value: "largest_first", label: "Largest first" },
  { value: "safest_first", label: "Safest first" },
  { value: "path_asc", label: "Path A-Z" },
];

export const SUGGESTION_MIN_LARGE_FILE_OPTIONS = [
  { value: 100 * 1024 * 1024, label: "100 MB+" },
  { value: 250 * 1024 * 1024, label: "250 MB+" },
  { value: 500 * 1024 * 1024, label: "500 MB+" },
  { value: 1024 * 1024 * 1024, label: "1 GB+" },
  { value: 2 * 1024 * 1024 * 1024, label: "2 GB+" },
];
