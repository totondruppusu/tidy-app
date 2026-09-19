import type { FileEntry } from "../types";

export const SCAN_BATCH_INTERVAL_MS = 100;

/** Deduplicate arrivals once per scan and publish at most ten list updates/second. */
export function createScanBatchQueue(
  publish: (files: FileEntry[]) => void,
  intervalMs = SCAN_BATCH_INTERVAL_MS,
) {
  const seen = new Set<string>();
  let pending: FileEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length) publish(batch);
  };

  return {
    enqueue(files: FileEntry[]) {
      for (const file of files) {
        const key = file.path || file.id;
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push(file);
      }
      if (pending.length && timer === undefined)
        timer = setTimeout(flush, intervalMs);
    },
    reset() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
      seen.clear();
    },
  };
}
