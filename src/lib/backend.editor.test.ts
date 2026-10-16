import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  open: vi.fn(),
}));

import { openWorkspaceInEditor } from "./backend";

describe("external IDE native adapter", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    native.invoke.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("passes a structured selected worktree path and IDE enum", async () => {
    const repository = "D:\\Project\\servo_host";
    const worktree = "D:\\Project\\servo_host\\.worktrees\\关节 参数";
    await openWorkspaceInEditor(repository, worktree, "zed");
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("open_workspace_in_editor", {
      repositoryRoot: repository, workspaceRoot: worktree, editor: "zed",
    });
  });

  it("rejects web preview without invoking native launching", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(openWorkspaceInEditor("/repo", "/repo/worktree", "auto"))
      .rejects.toThrow("desktop runtime");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("surfaces a Rust worktree validation or missing CLI error", async () => {
    native.invoke.mockRejectedValueOnce(new Error("Worktree is not registered"));
    await expect(openWorkspaceInEditor("/repo", "/elsewhere", "cursor"))
      .rejects.toThrow("not registered");
  });
});
