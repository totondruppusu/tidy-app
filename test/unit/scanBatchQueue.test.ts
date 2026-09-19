import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScanBatchQueue,
  SCAN_BATCH_INTERVAL_MS,
} from "../../src/lib/scanBatchQueue";
import { createFile } from "../mocks/files";

afterEach(() => vi.useRealTimers());

describe("streamed scan batch queue", () => {
  it("coalesces arrivals and ignores duplicates within and across publications", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const queue = createScanBatchQueue(publish);
    const first = createFile({ id: "first", path: "/root/a" });
    const duplicate = createFile({ id: "duplicate", path: "/root/a" });
    const second = createFile({ id: "second", path: "" });
    queue.enqueue([first, duplicate]);
    queue.enqueue([second, second]);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SCAN_BATCH_INTERVAL_MS);
    expect(publish).toHaveBeenCalledExactlyOnceWith([first, second]);
    queue.enqueue([duplicate, second]);
    vi.advanceTimersByTime(SCAN_BATCH_INTERVAL_MS);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("discards pending work on reset and allows the next scan to reuse paths", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const queue = createScanBatchQueue(publish);
    const file = createFile();
    queue.enqueue([file]);
    queue.reset();
    vi.runAllTimers();
    expect(publish).not.toHaveBeenCalled();
    queue.enqueue([file]);
    vi.runAllTimers();
    expect(publish).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it("bounds updates for continuous input without waiting for the scan to stop", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const queue = createScanBatchQueue(publish);
    for (let i = 0; i < 100; i++) {
      queue.enqueue([createFile({ id: `${i}`, path: `/root/${i}` })]);
      vi.advanceTimersByTime(10);
    }
    expect(publish).toHaveBeenCalledTimes(10);
    expect(publish.mock.calls.flatMap(([files]) => files)).toHaveLength(100);
  });
});
