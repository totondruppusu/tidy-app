import type { ScanProgress } from "../types";

export function describeScanProgress(
  progress: ScanProgress | null,
  cancelling: boolean,
) {
  if (cancelling)
    return {
      title: "Stopping scan…",
      detail:
        "Waiting for the current file operation to stop. Partial results will be discarded.",
      percent: null,
    };
  if (progress?.phase === "duplicates")
    return {
      title: "Checking duplicates",
      detail: `${progress.total.toLocaleString()} files discovered. Comparing files for duplicates. Large files can take longer.`,
      percent: null,
    };
  if (progress?.phase === "finalizing")
    return {
      title: "Preparing results",
      detail: "Organizing the file list and saving the scan. Almost ready.",
      percent: null,
    };
  const count = progress?.scanned ?? 0;
  // Discovery and metadata inspection overlap; their totals are not a whole-scan percentage.
  return {
    title: "Scanning folder",
    detail: count
      ? `${count.toLocaleString()} files checked. Finding files and reading their details…`
      : "Finding files and reading their details…",
    percent: null,
  };
}
