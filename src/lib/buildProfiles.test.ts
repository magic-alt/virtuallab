import { describe, expect, it } from "vitest";
import { formatStep, profileFromSuggestion, stepsForProfile, suggestionActionLabel } from "./buildProfiles";

describe("build profiles", () => {
  it("distinguishes full Tauri builds from web-only npm builds", () => {
    const base = { tool: "npm", description: "test", supported: true, steps: [] };
    expect(suggestionActionLabel({ ...base, id: "npm-tauri-package", name: "Tauri", kind: "package" }))
      .toBe("Build desktop app");
    expect(suggestionActionLabel({ ...base, id: "npm-build", name: "Vite", kind: "build" }))
      .toBe("Build frontend");
    expect(suggestionActionLabel({ ...base, id: "cmake-configure-build", name: "Qt", kind: "build" }))
      .toBe("Build now");
  });

  it("preserves a legacy repository-scoped single-command profile", () => {
    const profile = {
      id: "old", name: "Build", kind: "build" as const,
      repositoryRoot: "D:/repo", program: "npm", args: ["run", "build"],
    };
    expect(stepsForProfile(profile)).toEqual([{ name: "Build", program: "npm", args: ["run", "build"] }]);
  });

  it("converts a detected CMake workflow to worktree-independent structured steps", () => {
    const suggestion = {
      id: "cmake-configure-build",
      name: "Qt / CMake · Build",
      kind: "build" as const,
      tool: "Qt", description: "Configure and compile", supported: true,
      steps: [
        { name: "Configure", program: "cmake", args: ["-S", ".", "-B", "build/virtuallab"] },
        { name: "Compile", program: "cmake", args: ["--build", "build/virtuallab"] },
      ],
    };
    const profile = profileFromSuggestion(suggestion, "C:/Project/sample");
    expect(profile.repositoryRoot).toBe("C:/Project/sample");
    expect(stepsForProfile(profile)).toHaveLength(2);
    expect(profile.program).toBe("cmake");
    expect(formatStep(stepsForProfile(profile)[1])).toBe("cmake --build build/virtuallab");
  });
});
