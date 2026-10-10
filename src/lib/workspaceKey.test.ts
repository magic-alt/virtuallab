import { describe, expect, it } from "vitest";
import { workspaceKey } from "./workspaceKey";

describe("cross-platform workspace identity", () => {
  it("normalizes Windows drive and UNC paths without losing their identity", () => {
    expect(workspaceKey("D:\\Project\\VirtualLab\\")).toBe("d:/project/virtuallab");
    expect(workspaceKey("d:/project/virtuallab/")).toBe("d:/project/virtuallab");
    expect(workspaceKey("\\\\Server\\Share\\Repo")).toBe("//server/share/repo");
  });
  it("never merges case-distinct Unix workspaces", () => {
    expect(workspaceKey("/Users/dev/Project")).not.toBe(workspaceKey("/Users/dev/project"));
    expect(workspaceKey("/tmp/ALPHA")).not.toBe(workspaceKey("/tmp/alpha"));
    expect(workspaceKey("/")).toBe("/");
    expect(workspaceKey("")).toBe("");
  });
  it("preserves Unicode spelling", () => {
    expect(workspaceKey("/tmp/软件/工作区")).toBe("/tmp/软件/工作区");
  });
});
