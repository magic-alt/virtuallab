import { describe, expect, it } from "vitest";
import { processCheckResult } from "./checks";

describe("check result normalization", () => {
  it("normalizes process exit codes and stops", () => {
    expect(
      processCheckResult({
        id: "run-1",
        label: "Build",
        kind: "build",
        exitCode: 0,
        observedAtMs: 30,
      }).status,
    ).toBe("pass");

    expect(
      processCheckResult({
        id: "run-2",
        label: "Tests",
        kind: "test",
        exitCode: 2,
        observedAtMs: 31,
      }).status,
    ).toBe("fail");

    expect(
      processCheckResult({
        id: "run-3",
        label: "Tests",
        kind: "test",
        exitCode: null,
        stopped: true,
        observedAtMs: 32,
      }).status,
    ).toBe("not_run");
  });
});
