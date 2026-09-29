import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

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
