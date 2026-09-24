import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CRASH_REPORT_ISSUES_URL,
  HEARTBEAT_INTERVAL_MS,
} from "../constants/appConstants";
import {
  getDesktopWindow,
  invokeCommand,
  isDesktopRuntime,
} from "../lib/desktopBridge";
import { buildCrashEmailBody, formatCrashReport } from "../lib/format";
import type { ActivitySnapshot, CrashReport, ThemeMode } from "../types";

type UseDesktopEnvironmentOptions = {
  buildActivitySnapshot: () => ActivitySnapshot;
  theme: ThemeMode;
  isAndroidApp: boolean;
  isWindowsDesktop: boolean;
};

type UseDesktopEnvironmentResult = {
  isWindowsDesktop: boolean;
  isAndroidApp: boolean;
  isNarrowLayout: boolean;
  isWindowFullscreen: boolean;
  isWindowMaximized: boolean;
  handleMinimizeWindow: () => void;
  handleToggleMaximizeWindow: () => void;
  handleCloseWindow: () => void;
  crashReport: CrashReport | null;
  crashReportText: string;
  isCrashReportOpen: boolean;
  handleDismissCrashReport: () => void;
  handleSendCrashReport: () => void;
  handleRevealCrashReport: () => void;
  handleCopyCrashReport: () => void;
};

export function useDesktopEnvironment({
  buildActivitySnapshot,
  theme,
  isAndroidApp,
  isWindowsDesktop: isWindowsDesktopPlatform,
}: UseDesktopEnvironmentOptions): UseDesktopEnvironmentResult {
  const [isNarrowLayout, setIsNarrowLayout] = useState(false);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [crashReport, setCrashReport] = useState<CrashReport | null>(null);
  const [isCrashReportOpen, setIsCrashReportOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const handleChange = () => setIsNarrowLayout(mediaQuery.matches);
    handleChange();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let isMounted = true;
    const appWindow = getDesktopWindow();
    let unlistenResize: (() => void) | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const syncWindowState = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (isMounted) {
          setIsWindowFullscreen(fullscreen);
        }
      } catch {
        // Ignore unsupported window APIs in non-desktop runtimes.
      }
      try {
        const maximized = await appWindow.isMaximized();
        if (isMounted) {
          setIsWindowMaximized(maximized);
        }
      } catch {
        // Ignore unsupported window APIs in non-desktop runtimes.
      }
    };
    void syncWindowState();
    void appWindow
      .onResized(() => {
        if (resizeTimeout) {
          clearTimeout(resizeTimeout);
        }
        resizeTimeout = setTimeout(() => {
          resizeTimeout = null;
          void syncWindowState();
        }, 120);
      })
      .then((unlisten) => {
        if (!isMounted) {
          unlisten();
          return;
        }
        unlistenResize = unlisten;
      })
      .catch(() => {});
    return () => {
      isMounted = false;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      if (unlistenResize) {
        unlistenResize();
      }
    };
  }, []);

  const handleMinimizeWindow = useCallback(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void getDesktopWindow()
      .minimize()
      .catch(() => {});
  }, []);

  const handleToggleMaximizeWindow = useCallback(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void getDesktopWindow()
      .toggleMaximize()
      .then(async () => {
        try {
          const maximized = await getDesktopWindow().isMaximized();
          setIsWindowMaximized(maximized);
        } catch {
          // Ignore unsupported window APIs in non-desktop runtimes.
        }
      })
      .catch(() => {});
  }, []);

  const handleCloseWindow = useCallback(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void getDesktopWindow()
      .close()
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let isMounted = true;
    invokeCommand<CrashReport | null>("get_crash_report")
      .then((report) => {
        if (!isMounted || !report) {
          return;
        }
        setCrashReport(report);
        setIsCrashReportOpen(true);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    const handleError = (event: ErrorEvent) => {
      void invokeCommand("log_client_error", {
        message: event.message || "Unhandled error",
        stack: event.error?.stack ?? null,
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason =
        event.reason instanceof Error
          ? event.reason.message
          : typeof event.reason === "string"
            ? event.reason
            : "Unhandled promise rejection";
      const stack = event.reason instanceof Error ? event.reason.stack : null;
      void invokeCommand("log_client_error", { message: reason, stack });
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    let active = true;
    const tick = () => {
      if (!active) {
        return;
      }
      const activity = buildActivitySnapshot();
      void invokeCommand("update_heartbeat", { activity }).catch(() => {});
    };
    tick();
    const interval = window.setInterval(tick, HEARTBEAT_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [buildActivitySnapshot]);

  useEffect(() => {
    const applyWindowTheme = async () => {
      if (!isDesktopRuntime()) {
        return;
      }
      try {
        await getDesktopWindow().setTheme(
          theme === "light" || theme === "high-contrast" ? "light" : "dark",
        );
      } catch (error) {
        console.warn("Failed to sync window theme.", error);
      }
    };
    void applyWindowTheme();
  }, [theme]);

  const crashReportText = useMemo(
    () => (crashReport ? formatCrashReport(crashReport) : ""),
    [crashReport],
  );

  const handleDismissCrashReport = useCallback(() => {
    setIsCrashReportOpen(false);
    setCrashReport(null);
    if (isDesktopRuntime()) {
      void invokeCommand("clear_crash_report");
    }
  }, []);

  const handleSendCrashReport = useCallback(() => {
    if (!crashReport) {
      return;
    }
    const title = `Tidy crash report (${new Date(crashReport.createdMs).toLocaleString()})`;
    const body = buildCrashEmailBody(crashReport);
    const issueUrl = `${CRASH_REPORT_ISSUES_URL}/new?title=${encodeURIComponent(
      title,
    )}&body=${encodeURIComponent(body)}`;
    window.location.href = issueUrl;
  }, [crashReport]);

  const handleRevealCrashReport = useCallback(() => {
    if (!crashReport || !isDesktopRuntime()) {
      return;
    }
    void invokeCommand("reveal_in_file_manager", {
      path: crashReport.reportPath,
      reveal: true,
    });
  }, [crashReport]);

  const handleCopyCrashReport = useCallback(() => {
    if (!crashReportText) {
      return;
    }
    void navigator.clipboard.writeText(crashReportText);
  }, [crashReportText]);

  return {
    isWindowsDesktop: isWindowsDesktopPlatform,
    isAndroidApp,
    isNarrowLayout,
    isWindowFullscreen,
    isWindowMaximized,
    handleMinimizeWindow,
    handleToggleMaximizeWindow,
    handleCloseWindow,
    crashReport,
    crashReportText,
    isCrashReportOpen,
    handleDismissCrashReport,
    handleSendCrashReport,
    handleRevealCrashReport,
    handleCopyCrashReport,
  };
}
