import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: native.confirm, open: vi.fn() }));
import { cleanupMergedAfterConfirmation, type CleanupPlan } from "./gitCleanup";

const plan: CleanupPlan = {
  repositoryRoot: "/repo 工程", selectedWorkspace: "/repo 工程", baseRef: "refs/heads/main", baseSha: "a".repeat(40), originUrl: null, pushUrl: null, originDefaultBranch: null, originDefaultSha: null,
  targets: [{ branch: "feat/done", localSha: "b".repeat(40), remoteSha: null, worktreePath: "/lane 工程" }], skipped: ["feat/keep: not merged"],
};

describe("merged cleanup native boundary", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.resetAllMocks();
    native.invoke.mockResolvedValueOnce(plan).mockResolvedValue({ removed: ["local feat/done"], failed: [] });
    native.listen.mockResolvedValue(native.unlisten);
  });
  afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

  it("shows exact targets and waits for approval before invoking deletion", async () => {
    let approve!: (answer: boolean) => void;
    native.confirm.mockReturnValue(new Promise<boolean>(resolve => { approve = resolve; }));
    const pending = cleanupMergedAfterConfirmation(plan.repositoryRoot, plan.selectedWorkspace);
    await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledOnce());
    expect(native.confirm.mock.calls[0][0]).toContain("Worktree: /lane 工程");
    expect(native.confirm.mock.calls[0][0]).toContain("feat/keep: not merged");
    expect(native.invoke).toHaveBeenCalledTimes(1);
    approve(true);
    await expect(pending).resolves.toEqual({ removed: ["local feat/done"], failed: [] });
    expect(native.invoke).toHaveBeenLastCalledWith("git_cleanup_merged", { plan, operationId: expect.any(String) });
    expect(native.unlisten).toHaveBeenCalledOnce();
  });

  it("cancellation never deletes", async () => {
    native.confirm.mockResolvedValue(false);
    await expect(cleanupMergedAfterConfirmation("/repo 工程", "/repo 工程")).resolves.toBeNull();
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.listen).not.toHaveBeenCalled();
  });

  it("an empty preview never requests deletion", async () => {
    native.invoke.mockReset().mockResolvedValue({ ...plan, targets: [] });
    native.confirm.mockResolvedValue(true);
    await expect(cleanupMergedAfterConfirmation("/repo 工程", "/repo 工程")).resolves.toBeNull();
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("propagates stale rejection and releases its progress listener", async () => {
    native.invoke.mockReset().mockResolvedValueOnce(plan).mockRejectedValueOnce(new Error("Preview is stale"));
    native.confirm.mockResolvedValue(true);
    await expect(cleanupMergedAfterConfirmation("/repo 工程", "/repo 工程")).rejects.toThrow("stale");
    expect(native.unlisten).toHaveBeenCalledOnce();
  });

  it("fails closed if the native confirmation is unavailable", async () => {
    native.confirm.mockRejectedValue(new Error("dialog denied"));
    await expect(cleanupMergedAfterConfirmation("/repo 工程", "/repo 工程")).rejects.toThrow("dialog denied");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
