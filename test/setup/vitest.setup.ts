import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const localStorageStore = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    localStorageStore.delete(key);
  },
  clear: () => {
    localStorageStore.clear();
  },
};

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: ResizeObserverMock,
});

Object.defineProperty(globalThis, "requestAnimationFrame", {
  writable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
});

Object.defineProperty(globalThis, "cancelAnimationFrame", {
  writable: true,
  value: (id: number) => clearTimeout(id),
});

Object.defineProperty(globalThis, "crypto", {
  writable: true,
  value: {
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  },
});

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
});

Object.defineProperty(window, "scrollTo", { value: vi.fn(), writable: true });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  value: vi.fn(),
  writable: true,
});
Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
  value: vi.fn(),
  writable: true,
});
Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
  value: vi.fn(),
  writable: true,
});

Object.defineProperty(window, "prompt", {
  value: vi.fn().mockReturnValue("Preset"),
  writable: true,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorageMock.clear();
  delete window.__TIDY_DESKTOP_BRIDGE__;
});
