import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  readTerminalFontSize,
  setTerminalFontSize,
} from "./terminalAppearance";

describe("terminal font preferences", () => {
  it("starts at a readable 15px and ignores invalid stored preferences", () => {
    expect(readTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    localStorage.setItem("virtuallab.terminal.fontSize", "invalid");
    expect(readTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    localStorage.setItem("virtuallab.terminal.fontSize", "17.5");
    expect(readTerminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("clamps zoom bounds and saves an integer value for future workspaces", () => {
    expect(clampTerminalFontSize(5)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(99)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);

    setTerminalFontSize(99);
    expect(readTerminalFontSize()).toBe(MAX_TERMINAL_FONT_SIZE);
    setTerminalFontSize(10);
    expect(readTerminalFontSize()).toBe(MIN_TERMINAL_FONT_SIZE);
    setTerminalFontSize(17);
    expect(localStorage.getItem("virtuallab.terminal.fontSize")).toBe("17");
  });
});
