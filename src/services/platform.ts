import { isDesktopRuntime } from "../lib/desktopBridge";

export const isAndroidRuntime = () =>
  typeof navigator !== "undefined" &&
  isDesktopRuntime() &&
  /android/i.test(navigator.userAgent);

export const isWindowsDesktop = () =>
  typeof navigator !== "undefined" &&
  isDesktopRuntime() &&
  /windows/i.test(navigator.userAgent);

export const ANDROID_FOLDER_PICKER_HINT =
  "Android will ask for all files access first, then open an in-app folder browser so you can choose what to scan. Protected app-private folders may still be blocked by Android.";
