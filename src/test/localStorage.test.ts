import { describe, expect, it } from "vitest";

describe("test localStorage fixture", () => {
  it("provides deterministic Storage semantics on Node 26 and jsdom", () => {
    expect(window.localStorage).toBeDefined();
    expect(globalThis.localStorage).toBe(window.localStorage);

    window.localStorage.setItem("fixture", "ok");
    expect(window.localStorage.getItem("fixture")).toBe("ok");
    expect(window.localStorage.length).toBe(1);

    window.localStorage.clear();
    expect(window.localStorage.getItem("fixture")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});
