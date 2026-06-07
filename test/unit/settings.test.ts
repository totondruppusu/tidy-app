import { describe, expect, it, vi } from "vitest";
import {
  getInitialTheme,
  getStoredSettings,
  isExtensionFilterMode,
  isFilterMode,
  isGroupMode,
  isSortMode,
  normalizeDestinationSlots,
} from "../../src/lib/settings";
import { SETTINGS_KEY } from "../../src/constants/appConstants";

describe("settings", () => {
  it("returns stored theme when available", () => {
    window.localStorage.setItem("tidy-theme", "dark");
    expect(getInitialTheme()).toBe("dark");
  });

  it("falls back to light when no preference", () => {
    window.localStorage.removeItem("tidy-theme");
    expect(getInitialTheme()).toBe("light");
  });

  it("normalizes destination slots", () => {
    expect(normalizeDestinationSlots(["/a", 3, null, "/b"])).toEqual(["/a", null, null, "/b"]);
    expect(normalizeDestinationSlots("bad")).toBeNull();
  });

  it("parses stored settings and drops invalid values", () => {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        filterMode: "images",
        includeSubfolders: true,
        sortMode: "name_asc",
        groupMode: "type",
        extensionFilterMode: "remember",
        destinationSlots: ["/tmp/a", 1],
        suggestionStaleDays: 7,
        suggestionSortMode: "largest_first",
        suggestionPresets: [
          {
            id: "p1",
            name: "Cleanup",
            staleDays: 10,
            minLargeFileBytes: 100,
            maxResults: 20,
            safetyFilter: "safe",
            actionFilter: "all",
            sortMode: "path_asc",
          },
          { id: "", name: "bad" },
        ],
      })
    );

    const settings = getStoredSettings();
    expect(settings.filterMode).toBe("images");
    expect(settings.includeSubfolders).toBe(true);
    expect(settings.sortMode).toBe("name_asc");
    expect(settings.groupMode).toBe("type");
    expect(settings.extensionFilterMode).toBe("remember");
    expect(settings.destinationSlots).toEqual(["/tmp/a", null]);
    expect(settings.suggestionPresets).toHaveLength(1);
    expect(settings.suggestionPresets?.[0].id).toBe("p1");
  });

  it("returns empty settings when json is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.localStorage.setItem(SETTINGS_KEY, "{");
    expect(getStoredSettings()).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("validates mode helpers", () => {
    expect(isFilterMode("all")).toBe(true);
    expect(isFilterMode("x")).toBe(false);
    expect(isSortMode("name_asc")).toBe(true);
    expect(isSortMode("x")).toBe(false);
    expect(isGroupMode("none")).toBe(true);
    expect(isGroupMode("x")).toBe(false);
    expect(isExtensionFilterMode("common")).toBe(true);
    expect(isExtensionFilterMode("x")).toBe(false);
  });
});
