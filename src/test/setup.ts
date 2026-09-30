import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }

  getItem(key: string) {
    return this.items.get(String(key)) ?? null;
  }

  key(index: number) {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.items.delete(String(key));
  }

  setItem(key: string, value: string) {
    this.items.set(String(key), String(value));
  }
}

const testStorage = new MemoryStorage();

// Node 26 exposes an experimental global localStorage accessor that is unusable
// without --localstorage-file. Vitest/jsdom can inherit that accessor instead of
// jsdom's Storage object, so install one deterministic Storage instance for tests.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: testStorage,
});

Object.defineProperty(window, "localStorage", {
  configurable: true,
  writable: true,
  value: testStorage,
});

beforeEach(() => {
  testStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: TestResizeObserver,
});

Object.defineProperty(window, "confirm", {
  configurable: true,
  writable: true,
  value: vi.fn(() => true),
});
