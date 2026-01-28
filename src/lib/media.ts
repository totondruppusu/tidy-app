import { isTauri } from "@tauri-apps/api/core";

export const buildMediaUrl = (id: string) => {
  if (isTauri() && /windows/i.test(navigator.userAgent)) {
    return `http://media.localhost/${id}`;
  }
  return `media://localhost/${id}`;
};
