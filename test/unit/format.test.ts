import { describe, expect, it } from "vitest";
import {
  buildCrashEmailBody,
  formatActivityDetails,
  formatActivitySummary,
  formatBytes,
  formatCrashReport,
  formatDuplicateGroupMeta,
  formatExtensionLabel,
  formatGroupTitle,
  formatKindLabel,
  formatPathLabel,
  formatTimestamp,
} from "../../src/lib/format";
import type { CrashReport } from "../../src/types";
import { createFile } from "../mocks/files";

describe("format", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(Number.NaN)).toBe("Unknown");
  });

  it("formats timestamps and labels", () => {
    expect(formatTimestamp(null)).toBe("Unknown");
    expect(formatKindLabel("docs")).toBe("Docs");
    expect(formatExtensionLabel("none")).toBe("No extension");
    expect(formatPathLabel("/a/b/file.txt")).toBe("file.txt");
  });

  it("formats activity summary and details", () => {
    expect(formatActivitySummary(null)).toBe("Unavailable");
    expect(formatActivitySummary({ timestampMs: 1, isLoading: false, isMutating: false, isCancellingScan: false })).toBe("Idle");
    const details = formatActivityDetails({
      timestampMs: 1,
      status: "Scanning",
      isLoading: true,
      isMutating: false,
      isCancellingScan: false,
      scanId: "scan-1",
      scanPhase: "indexing",
      scanScanned: 5,
      scanMatched: 2,
      scanTotal: 10,
      currentFolder: "/tmp",
    });
    expect(details.join("\n")).toContain("Scan ID: scan-1");
  });

  it("formats crash reports and truncates email body", () => {
    const report: CrashReport = {
      id: "c1",
      createdMs: Date.now(),
      message: "boom",
      appName: "tidy",
      appVersion: "1.0.0",
      os: "mac",
      arch: "arm",
      reportPath: "/tmp/report",
      backtrace: "x".repeat(5000),
    };
    const full = formatCrashReport(report);
    expect(full).toContain("Message: boom");
    const body = buildCrashEmailBody(report);
    expect(body.length).toBeLessThan(full.length + 10);
  });

  it("formats grouping metadata", () => {
    const files = [
      createFile({ id: "1", name: "a.txt", kind: "text", sizeBytes: 2048 }),
      createFile({ id: "2", name: "b.txt", kind: "text", sizeBytes: 2048 }),
    ];
    expect(formatGroupTitle("extension", "txt", files)).toBe(".txt");
    expect(formatGroupTitle("duplicates", "dup", files)).toBe("Duplicate set");
    expect(formatDuplicateGroupMeta(files)).toContain("2 names");
  });
});
