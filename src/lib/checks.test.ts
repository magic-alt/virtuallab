import { describe, expect, it } from "vitest";
import { PREVIEW_SNAPSHOT } from "@/data/preview";
import { processCheckResult, repositoryCheckResults } from "./checks";

describe("check result normalization", () => {
  it("normalizes preview repository checks as not-run", () => {
    const results = repositoryCheckResults(PREVIEW_SNAPSHOT, true, 10);
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.status === "not_run")).toBe(true);
    expect(results.every((result) => result.observedAtMs === 10)).toBe(true);
  });

  it("normalizes a dirty native repository as a warning", () => {
    const results = repositoryCheckResults(
      {
        ...PREVIEW_SNAPSHOT,
        remoteUrl: "https://github.com/example-org/sample-repo.git",
        dirtyCount: 2,
      },
      false,
      20,
    );

    expect(results.find((item) => item.id === "repository-recognized")?.status).toBe("pass");
    expect(results.find((item) => item.id === "origin-remote")?.status).toBe("pass");
    expect(results.find((item) => item.id === "working-tree")?.status).toBe("warn");
  });

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
