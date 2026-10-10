import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLocalChangesAfterConfirmation } from "./backend";
import type { LocalChangesRequest } from "@/types/workbench";

const native = vi.hoisted(() => ({ confirm: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: native.confirm, open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const request: LocalChangesRequest = {
  repositoryRoot: "/repo", workspaceRoot: "/repo", expectedBranch: "fix/local",
  expectedHeadSha: "1234567890",
  expectedChanges: [
    { path: "hardware/revA.kicad_sch", kind: "modified", indexStatus: " ", worktreeStatus: "M" },
    { path: "hardware/.history/", kind: "untracked", indexStatus: "?", worktreeStatus: "?" },
  ],
  action: "stashAll", path: null,
};
describe("native local changes safety boundary", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    native.confirm.mockReset(); native.invoke.mockReset();
    native.confirm.mockResolvedValue(true); native.invoke.mockResolvedValue(undefined);
  });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("stashes tracked and untracked content only after native approval", async () => {
    let finish!: (ok: boolean) => void;
    native.confirm.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const promise = resolveLocalChangesAfterConfirmation(request);
    expect(native.confirm).toHaveBeenCalledWith(
      expect.stringContaining("1 tracked and 1 untracked"),
      expect.objectContaining({ kind: "warning", title: "Back up local changes to Git stash" }),
    );
    expect(native.invoke).not.toHaveBeenCalled();
    finish(true);
    await expect(promise).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledWith("git_local_changes", { request });
  });
  it("cancelling or failing native confirmation never invokes destructive Git", async () => {
    native.confirm.mockResolvedValueOnce(false);
    await expect(resolveLocalChangesAfterConfirmation({ ...request, action: "discardTrackedAll" })).resolves.toBe(false);
    native.confirm.mockRejectedValueOnce(new Error("native dialog unavailable"));
    await expect(resolveLocalChangesAfterConfirmation({ ...request, action: "deleteUntrackedSelected", path: "hardware/.history/" }))
      .rejects.toThrow("native dialog unavailable");
    expect(native.invoke).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });
  it("does not conflate untracked directory deletion with tracked restore", async () => {
    const one = { ...request, action: "discardTrackedSelected" as const, path: "hardware/revA.kicad_sch" };
    await resolveLocalChangesAfterConfirmation(one);
    expect(native.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining("Other files and untracked items remain"),
      expect.any(Object),
    );
    const untracked = { ...request, action: "deleteUntrackedSelected" as const, path: "hardware/.history/" };
    await resolveLocalChangesAfterConfirmation(untracked);
    expect(native.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining("DIRECTORY and its unignored contents"),
      expect.objectContaining({ okLabel: "Delete untracked" }),
    );
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });
  it("rejects contradictory or stale selections before opening native confirmation", async () => {
    await expect(resolveLocalChangesAfterConfirmation({ ...request, action: "discardTrackedSelected", path: "hardware/.history/" }))
      .rejects.toThrow("Invalid or stale");
    await expect(resolveLocalChangesAfterConfirmation({ ...request, action: "deleteUntrackedSelected", path: "hardware/revA.kicad_sch" }))
      .rejects.toThrow("Invalid or stale");
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("is unavailable in web preview", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(resolveLocalChangesAfterConfirmation(request)).rejects.toThrow("desktop runtime");
    expect(native.confirm).not.toHaveBeenCalled();
  });
});
