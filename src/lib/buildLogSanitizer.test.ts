import { describe, expect, it } from "vitest";
import { BuildLogSanitizer } from "./buildLogSanitizer";

describe("BuildLogSanitizer", () => {
  it("removes Vite color sequences without losing text", () => {
    const sanitizer = new BuildLogSanitizer();
    expect(sanitizer.write("\x1b[32m✓\x1b[0m built \x1b[36m2,002\x1b[0m modules"))
      .toBe("✓ built 2,002 modules");
    expect(sanitizer.finish()).toBe("");
  });

  it("handles escape sequences split across independent pipe reads", () => {
    const sanitizer = new BuildLogSanitizer();
    expect(sanitizer.write("begin\x1b[3")).toBe("begin");
    expect(sanitizer.write("1mred\x1b[")).toBe("red");
    expect(sanitizer.write("0m done")).toBe(" done");
  });

  it("normalizes Windows newlines and carriage-return progress updates", () => {
    const sanitizer = new BuildLogSanitizer();
    expect(sanitizer.write("start\r")).toBe("start");
    expect(sanitizer.write("\n50%\r")).toBe("\n50%");
    expect(sanitizer.write("100%\rcomplete")).toBe("\n100%\ncomplete");
    expect(sanitizer.finish()).toBe("");
    expect(sanitizer.write("one\r")).toBe("one");
    expect(sanitizer.finish()).toBe("\n");
  });

  it("removes OSC hyperlinks and control characters, preserving Chinese diagnostics", () => {
    const sanitizer = new BuildLogSanitizer();
    expect(sanitizer.write("\x1b]8;;https://example.org\x1b\\打开错误")).toBe("打开错误");
    expect(sanitizer.write("\x1b]8;;\x07\x1b[?25l\x00 message\tOK")).toBe(" message\tOK");
    expect(sanitizer.finish()).toBe("");
  });

  it("never leaks interrupted ANSI fragments into a subsequent run", () => {
    const sanitizer = new BuildLogSanitizer();
    expect(sanitizer.write("first\x1b[38;")).toBe("first");
    expect(sanitizer.finish()).toBe("");
    expect(sanitizer.write("second")).toBe("second");
  });
});
