import { describe, expect, it } from "vitest";
import { classifyOsc9, MONITORED_CODEX_COMMAND, TerminalAlertParser } from "./terminalAlerts";

const bytes = (value: string) => Array.from(new TextEncoder().encode(value));

describe("terminal agent notification framing", () => {
  it("detects OSC 9 across PTY chunks and does not mistake its BEL terminator for an alert", () => {
    const parser = new TerminalAlertParser();
    expect(parser.feed(bytes("\x1b]9;Task "))).toEqual([]);
    expect(parser.feed(bytes("finished\x07"))).toEqual([{ kind: "osc9", message: "Task finished" }]);
  });
  it("supports ST terminator and excludes OSC progress, titles and OSC 8 links", () => {
    const parser = new TerminalAlertParser();
    expect(parser.feed(bytes("\x1b]9;4;3\x07\x1b]0;Title\x07\x1b]8;;https://example.org\x07"))).toEqual([]);
    expect(parser.feed(bytes("\x1b]9;Build done\x1b\\"))).toEqual([{ kind: "osc9", message: "Build done" }]);
  });
  it("handles bare BEL as an attention signal, not a completion signal", () => {
    expect(new TerminalAlertParser().feed(bytes("processing\x07"))).toEqual([{ kind: "bell" }]);
  });
  it("bounds malformed OSC text and recovers on terminator", () => {
    const parser = new TerminalAlertParser();
    expect(parser.feed(bytes("\x1b]9;" + "x".repeat(3000) + "\x07"))).toEqual([]);
    expect(parser.feed(bytes("\x1b]9;recovered\x07"))).toEqual([{ kind: "osc9", message: "recovered" }]);
  });
  it("distinguishes Codex requests from ordinary turn completion and uses per-launch overrides", () => {
    expect(classifyOsc9("Approval requested: git status")).toBe("attention");
    expect(classifyOsc9("Plan mode prompt: choose a task")).toBe("attention");
    expect(classifyOsc9("Question: choose a strategy")).toBe("attention");
    expect(classifyOsc9("Completed the code changes")).toBe("complete");
    expect(MONITORED_CODEX_COMMAND).toContain("notification_method=osc9");
    expect(MONITORED_CODEX_COMMAND).toContain("notification_condition=always");
  });
});
