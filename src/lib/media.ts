import { convertFileSrc } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./desktopBridge";

export const buildMediaUrl = (id: string) => {
  if (isDesktopRuntime()) {
    return convertFileSrc(id, "media");
  }
  return `media://localhost/${id}`;
};
