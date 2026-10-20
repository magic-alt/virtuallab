import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  readTerminalFontSize,
  setTerminalFontSize,
  readTerminalScrollback,
  setTerminalScrollback,
  readTerminalCursorBlink,
  setTerminalCursorBlink,
} from "./terminalAppearance";

describe("terminal font preferences", () => {
  it('keeps current preferences responsive when storage is readable but full', () => {
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {throw new Error('quota exceeded');});
    setTerminalFontSize(18);
    setTerminalScrollback(16000);
    setTerminalCursorBlink(false);
    expect(readTerminalFontSize()).toBe(18);
    expect(readTerminalScrollback()).toBe(16000);
    expect(readTerminalCursorBlink()).toBe(false);
    write.mockRestore();
    setTerminalFontSize(15);setTerminalScrollback(8000);setTerminalCursorBlink(true);
  });
  it('validates new appearance preferences and persists safe values', () => {
    expect(readTerminalScrollback()).toBe(8000);
    expect(readTerminalCursorBlink()).toBe(true);
    localStorage.setItem('virtuallab.terminal.scrollback', 'bad');
    localStorage.setItem('virtuallab.terminal.cursorBlink', 'bad');
    expect(readTerminalScrollback()).toBe(8000);
    expect(readTerminalCursorBlink()).toBe(true);
    localStorage.setItem('virtuallab.terminal.scrollback', '1500');
    expect(readTerminalScrollback()).toBe(8000);
    setTerminalScrollback(99000);
    expect(readTerminalScrollback()).toBe(50000);
    setTerminalScrollback(-1);
    expect(readTerminalScrollback()).toBe(1000);
    setTerminalScrollback(Number.NaN);
    expect(readTerminalScrollback()).toBe(8000);
    setTerminalCursorBlink(false);
    expect(readTerminalCursorBlink()).toBe(false);
    expect(localStorage.getItem('virtuallab.terminal.cursorBlink')).toBe('false');
  });
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
