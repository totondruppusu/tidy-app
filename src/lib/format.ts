import { MAX_CRASH_EMAIL_BODY } from "../constants/appConstants";
import type { CrashReport, FileEntry, GroupMode } from "../types";

export const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) {
    return "Unknown";
  }
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  const display = value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${display} ${units[index]}`;
};

export const formatTimestamp = (timestamp: number | null) => {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return "Unknown";
  }
  return new Date(timestamp).toLocaleString();
};

export const formatKindLabel = (kind: FileEntry["kind"]) => {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "docs":
      return "Docs";
    case "text":
      return "Text";
    case "compressed":
      return "Compressed";
    case "executable":
      return "Executable";
    case "binary":
      return "Binary";
    default:
      return "Other";
  }
};

export const formatGroupLabel = (kind: FileEntry["kind"]) => {
  switch (kind) {
    case "image":
      return "Images";
    case "video":
      return "Videos";
    case "audio":
      return "Audio";
    case "docs":
      return "Docs";
    case "text":
      return "Text files";
    case "compressed":
      return "Compressed";
    case "executable":
      return "Executables";
    case "binary":
      return "Binary";
    default:
      return "Other files";
  }
};

export const formatCrashReport = (report: CrashReport) => {
  const lines = [
    `App: ${report.appName}`,
    `Version: ${report.appVersion}`,
    `OS: ${report.os} (${report.arch})`,
    `Time: ${new Date(report.createdMs).toISOString()}`,
    `Message: ${report.message}`,
    `Location: ${report.location ?? "Unknown"}`,
    `Thread: ${report.thread ?? "Unknown"}`,
    `Report path: ${report.reportPath}`,
    "",
    "Backtrace:",
    report.backtrace ?? "Unavailable",
  ];
  return lines.join("\n");
};

export const buildCrashEmailBody = (report: CrashReport) => {
  const body = formatCrashReport(report);
  if (body.length <= MAX_CRASH_EMAIL_BODY) {
    return body;
  }
  return `${body.slice(0, MAX_CRASH_EMAIL_BODY)}\n\n[Report truncated for email. Full report saved on disk.]`;
};

export const formatPathLabel = (path: string | null) => {
  if (!path) {
    return "Not set";
  }
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

export const formatExtensionLabel = (extension: string) => {
  if (extension === "none") {
    return "No extension";
  }
  return `.${extension}`;
};

export const formatGroupTitle = (mode: GroupMode, key: string, groupFiles?: FileEntry[]) => {
  if (mode === "duplicates") {
    if (!groupFiles || groupFiles.length === 0) {
      return "Duplicate set";
    }
    const nameSet = new Set(groupFiles.map((file) => file.name));
    return nameSet.size === 1 ? groupFiles[0].name : "Duplicate set";
  }
  if (mode === "extension") {
    return formatExtensionLabel(key);
  }
  return formatGroupLabel(key as FileEntry["kind"]);
};

export const formatDuplicateGroupMeta = (groupFiles: FileEntry[]) => {
  if (groupFiles.length === 0) {
    return null;
  }
  const sizeLabel = formatBytes(groupFiles[0].sizeBytes);
  const nameCount = new Set(groupFiles.map((file) => file.name)).size;
  const parts = [`${sizeLabel} each`];
  if (nameCount > 1) {
    parts.unshift(`${nameCount} names`);
  }
  return parts.join(" · ");
};
