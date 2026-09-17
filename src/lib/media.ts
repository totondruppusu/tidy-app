import { convertDesktopFileSrc, isDesktopRuntime } from "./desktopBridge";

export const buildMediaUrl = (id: string) => {
  if (isDesktopRuntime()) {
    return convertDesktopFileSrc(id, "media");
  }
  return `media://localhost/${id}`;
};
