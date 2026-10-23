import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ confirm: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: native.confirm, open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { confirmNativeAction, deleteLocalBranchAfterConfirmation, deleteOriginBranchAfterConfirmation } from "./backend";
const local = { repositoryRoot: "/repo", branch: "feat/done", branchHeadSha: "a".repeat(40), comparisonRef: "refs/heads/trunk", comparisonHeadSha: "b".repeat(40) };
const remote = { repositoryRoot: "/repo", branch: "feat/done", branchHeadSha: "a".repeat(40), destination: "https://example.invalid/repo.git", defaultBranch: "trunk" };

describe("snapshot-bound Git deletion confirmations", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.resetAllMocks(); native.confirm.mockResolvedValue(true);
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "git_preview_local_branch_deletion") return local;
      if (command === "git_preview_origin_branch_deletion") return remote;
      return { status: "deleted" };
    });
  });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("previews read-only, displays exact SHA/base, then deletes the approved local snapshot", async () => {
    let approve!: (answer: boolean) => void;
    native.confirm.mockReturnValue(new Promise(resolve => { approve = resolve; }));
    const pending = deleteLocalBranchAfterConfirmation("/repo", "feat/done");
    await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledOnce());
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("git_preview_local_branch_deletion", { repositoryRoot: "/repo", branch: "feat/done" });
    expect(native.confirm.mock.calls[0][0]).toContain(local.branchHeadSha);
    expect(native.confirm.mock.calls[0][0]).toContain(local.comparisonRef);
    approve(true); await expect(pending).resolves.toBe(true);
    expect(native.invoke).toHaveBeenLastCalledWith("git_delete_local_branch", { repositoryRoot: "/repo", branch: "feat/done", force: false, expectedState: local });
  });

  it.each([deleteLocalBranchAfterConfirmation, deleteOriginBranchAfterConfirmation])("cancel only inspects and never mutates", async action => {
    native.confirm.mockResolvedValue(false);
    await expect(action("/repo", "feat/done")).resolves.toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([deleteLocalBranchAfterConfirmation, deleteOriginBranchAfterConfirmation])("fails closed when native confirmation fails", async action => {
    native.confirm.mockRejectedValue(new Error("dialog denied"));
    await expect(action("/repo", "feat/done")).rejects.toThrow("dialog denied");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("requires a second confirmation for an unmerged local branch", async () => {
    native.invoke.mockResolvedValueOnce(local).mockResolvedValueOnce({ status: "needsForce", state: local }).mockResolvedValueOnce({ status: "deleted" });
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/done")).resolves.toBe(true);
    expect(native.confirm).toHaveBeenCalledTimes(2);
    expect(native.confirm.mock.calls[1][0]).toContain(local.branchHeadSha);
    expect(native.invoke).toHaveBeenLastCalledWith("git_delete_local_branch", { repositoryRoot: "/repo", branch: "feat/done", force: true, expectedState: local });
  });

  it("never retries force deletion after cancellation or stale-state rejection", async () => {
    native.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    native.invoke.mockResolvedValueOnce(local).mockResolvedValueOnce({ status: "needsForce", state: local });
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/done")).resolves.toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("shows the remote destination and pins deletion to the approved remote SHA", async () => {
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/done")).resolves.toBe(true);
    expect(native.confirm.mock.calls[0][0]).toContain(remote.destination);
    expect(native.confirm.mock.calls[0][0]).toContain(remote.branchHeadSha);
    expect(native.invoke).toHaveBeenLastCalledWith("git_delete_origin_branch", { repositoryRoot: "/repo", branch: "feat/done", expectedState: remote });
  });

  it("propagates changed-state errors without retrying", async () => {
    native.invoke.mockResolvedValueOnce(remote).mockRejectedValueOnce(new Error("Remote branch changed"));
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/done")).rejects.toThrow("changed");
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not open confirmation or mutate when preview fails", async () => {
    native.invoke.mockRejectedValue(new Error("destination mismatch"));
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/done")).rejects.toThrow("destination mismatch");
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it("fails closed outside desktop runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/done")).rejects.toThrow("desktop runtime");
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/done")).rejects.toThrow("desktop runtime");
    await expect(confirmNativeAction("Delete?")).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
