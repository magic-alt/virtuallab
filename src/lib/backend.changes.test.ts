import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitLocalChangesRequest } from "@/types/workbench";

const native = vi.hoisted(() => ({ confirm: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: native.confirm, open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

import {
  confirmNativeAction, gitDiscardTrackedChanges, gitRemoveUntrackedChanges, gitStashLocalChanges,
} from "./backend";

const request: GitLocalChangesRequest = {
  repositoryRoot: "/repo", workspaceRoot: "/repo",
  expectedHeadSha: "abc1234567", expectedBranch: "main",
  expectedChanges: [{ path: "README.md", indexStatus: " ", worktreeStatus: "M", kind: "modified" }],
  path: null, oldPath: null,
};
describe("native Git changes commands and fail-closed dialogs", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    native.confirm.mockReset();
    native.invoke.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("passes immutable snapshot to the exact local command only when invoked", async () => {
    await gitDiscardTrackedChanges(request);
    await gitRemoveUntrackedChanges(request);
    native.invoke.mockResolvedValueOnce("stash@{0}");
    await expect(gitStashLocalChanges(request)).resolves.toBe("stash@{0}");
    expect(native.invoke.mock.calls).toEqual([
      ["git_discard_tracked_changes", { request }],
      ["git_remove_untracked_changes", { request }],
      ["git_stash_local_changes", { request }],
    ]);
  });

  it("allows a branded native warning but fails closed on cancellation", async () => {
    native.confirm.mockResolvedValueOnce(false);
    await expect(confirmNativeAction("Permanently delete a file?", {
      title: "Delete untracked entry", okLabel: "Delete selected",
    })).resolves.toBe(false);
    expect(native.confirm).toHaveBeenCalledWith(expect.any(String), {
      title: "Delete untracked entry", kind: "warning",
      okLabel: "Delete selected", cancelLabel: "Cancel",
    });
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("does not use window.confirm or execute a mutation if native dialog fails", async () => {
    native.confirm.mockRejectedValueOnce(new Error("dialog denied"));
    await expect(confirmNativeAction("Discard tracked?")).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("blocks both confirmation and backend commands in the web preview", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(confirmNativeAction("Delete?")).resolves.toBe(false);
    await expect(gitDiscardTrackedChanges(request)).rejects.toThrow("desktop runtime");
    await expect(gitRemoveUntrackedChanges(request)).rejects.toThrow("desktop runtime");
    await expect(gitStashLocalChanges(request)).rejects.toThrow("desktop runtime");
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
