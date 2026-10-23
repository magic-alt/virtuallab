import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: native.confirm, open: vi.fn() }));
import { analyzeCleanup, cleanupSelectedAfterConfirmation, type CleanupPlan } from "./gitCleanup";
const plan: CleanupPlan = { repositoryRoot: "/repo", selectedWorkspace: "/repo", baseRef: "refs/heads/trunk", baseSha: "a".repeat(40), originDefaultBranch: "trunk", originDefaultSha: null, originUrl: null, pushUrl: null,
  targets: [{ branch: "feat/done", localSha: "b".repeat(40), remoteSha: "b".repeat(40), worktreePath: null }], skipped: [] };
describe("selected cleanup approval", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.resetAllMocks(); native.listen.mockResolvedValue(vi.fn());
  });
  it("confirms only selected local actions and never implies remote approval", async () => {
    native.confirm.mockResolvedValue(true); native.invoke.mockResolvedValue({ removed: ["local feat/done"], failed: [] });
    const selection = [{ branch: "feat/done", local: true, remote: false, worktree: false }];
    await cleanupSelectedAfterConfirmation(plan, selection);
    expect(native.confirm.mock.calls[0][0]).toContain("Local: feat/done");
    expect(native.confirm.mock.calls[0][0]).not.toContain("Remote: origin/feat/done");
    expect(native.invoke).toHaveBeenCalledWith("git_cleanup_selected", { plan, selection, operationId: expect.any(String) });
  });
  it("rejects empty or foreign selections before confirmation", async () => {
    await expect(cleanupSelectedAfterConfirmation(plan, [])).rejects.toThrow("Select");
    await expect(cleanupSelectedAfterConfirmation(plan, [{ branch: "other", local: true, remote: false, worktree: false }])).rejects.toThrow("selection");
    expect(native.confirm).not.toHaveBeenCalled(); expect(native.invoke).not.toHaveBeenCalled();
  });
  it("cancellation never invokes deletion", async () => {
    native.confirm.mockResolvedValue(false);
    await expect(cleanupSelectedAfterConfirmation(plan, [{ branch: "feat/done", local: true, remote: false, worktree: false }])).resolves.toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("rejects an obsolete workspace after native approval", async () => {
    native.confirm.mockResolvedValue(true);
    await expect(cleanupSelectedAfterConfirmation(plan, [{ branch: "feat/done", local: true, remote: false, worktree: false }], () => {}, () => false)).rejects.toThrow("selection changed");
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("never launches a cancelled analysis while its event listener is still attaching", async () => {
    let attach!: (listener: () => void) => void;
    native.listen.mockReturnValue(new Promise(resolve => { attach = resolve; }));
    const controller = new AbortController();
    const pending = analyzeCleanup("/repo", "/repo", "operation", null, () => {}, controller.signal);
    controller.abort(); attach(vi.fn());
    await expect(pending).rejects.toThrow("cancelled");
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
