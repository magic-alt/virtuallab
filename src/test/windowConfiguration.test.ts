import { describe, expect, it } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";

describe("desktop startup window", () => {
  it("starts maximized to the available monitor work area and allows a smaller restored window", () => {
    const window = tauriConfig.app.windows[0];
    expect(window.maximized).toBe(true);
    expect(window.resizable).toBe(true);
    expect(window.minWidth).toBeLessThanOrEqual(640);
    expect(window.minHeight).toBeLessThanOrEqual(360);
  });
});
