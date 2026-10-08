import { beforeEach, describe, expect, it } from "vitest";
import { buildAgentPrompt, useAgentConfiguration } from "./agentConfiguration";
describe("repository-neutral roles and skills", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentConfiguration.setState({ roles: [], skills: [], selections: {} });
  });
  it("scopes selected skills by workspace", () => {
    const s = useAgentConfiguration.getState();
    s.addSkill({ id: "custom-1", name: "Evidence", instructions: "Show evidence." });
    s.toggleSkill("D:\\Repo\\A", "custom-1");
    expect(useAgentConfiguration.getState().selections["d:/repo/a"]?.skillIds).toEqual(["custom-1"]);
    expect(useAgentConfiguration.getState().selections["d:/repo/b"]).toBeUndefined();
  });
  it("injects only selected instructions and preserves the request", () => {
    expect(buildAgentPrompt(" fix", { id: "r", name: "Reviewer", instructions: "Review only." },
      [{ id: "custom-1", name: "Safety", instructions: "Avoid hardware." }])).toContain("User request:\nfix");
  });
});
