import { isDesktopRuntime } from "./desktopBridge";

export const buildMediaUrl = (id: string) => {
  if (isDesktopRuntime() && /windows/i.test(navigator.userAgent)) {
    return `http://media.localhost/${id}`;
  }
  return `media://localhost/${id}`;
};
