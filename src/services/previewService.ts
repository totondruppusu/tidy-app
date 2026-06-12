import { invokeCommand } from "../lib/desktopBridge";
import type {
  ArchivePreview,
  OfficeFallbackPreview,
  PreviewCapabilities,
} from "../types";

export const getPreviewCapabilities = () =>
  invokeCommand<PreviewCapabilities>("get_preview_capabilities");

export const generateOfficePreview = (id: string) =>
  invokeCommand<string>("generate_preview", { id });

export const extractOfficeFallbackPreview = (id: string) =>
  invokeCommand<OfficeFallbackPreview>("extract_office_fallback_preview", {
    id,
  });

export const listArchiveEntries = (id: string) =>
  invokeCommand<ArchivePreview>("list_archive_entries", { id });
