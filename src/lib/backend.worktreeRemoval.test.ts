import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  confirm: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: native.confirm,
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
}));

import { removeWorktreeAfterConfirmation } from "./backend";

const repositoryRoot = "D:\\Project\\gd32_foe";
const worktreePath = "D:\\Project\\gd32_foe\\.worktrees\\joint17-brake";
const snapshot = {
  headSha: "0123456789abcdef",
  branch: "refs/heads/joint17-brake",
  statusHash: "e43b0c",
};
const dirty = { status: "needsForce", state: snapshot, trackedCount: 2, untrackedCount: 3 };

describe("worktree removal native confirmation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    native.confirm.mockReset();
    native.invoke.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("asks once and removes a clean worktree without force", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockResolvedValue({ status: "removed" });
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).resolves.toBe(true);
    expect(native.confirm).toHaveBeenCalledTimes(1);
    expect(native.confirm).toHaveBeenCalledWith(
      expect.stringContaining(worktreePath),
      expect.objectContaining({ title: "Remove Git worktree", kind: "warning" }),
    );
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("remove_worktree", {
      repositoryRoot, worktreePath, force: false, expectedState: null,
    });
  });

  it("never invokes Git before the initial dialog is accepted", async () => {
    let accept!: (value: boolean) => void;
    native.confirm.mockReturnValue(new Promise<boolean>((resolve) => { accept = resolve; }));
    native.invoke.mockResolvedValue({ status: "removed" });
    const operation = removeWorktreeAfterConfirmation(repositoryRoot, worktreePath);
    expect(native.invoke).not.toHaveBeenCalled();
    accept(true);
    await expect(operation).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("shows a separate irreversible-loss warning and reuses the exact native snapshot", async () => {
    let acceptForce!: (value: boolean) => void;
    native.confirm.mockResolvedValueOnce(true);
    native.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { acceptForce = resolve; }));
    native.invoke.mockResolvedValueOnce(dirty).mockResolvedValueOnce({ status: "removed" });

    const operation = removeWorktreeAfterConfirmation(repositoryRoot, worktreePath);
    await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledTimes(2));
    expect(native.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining("2 tracked change(s) and 3 untracked file(s)"),
      expect.objectContaining({ title: "Force remove dirty worktree", okLabel: "Force remove", kind: "warning" }),
    );
    expect(native.confirm.mock.calls[1][0]).toContain(worktreePath);
    expect(native.confirm.mock.calls[1][0]).toContain("This cannot be undone");
    expect(native.invoke).toHaveBeenCalledTimes(1);
    acceptForce(true);
    await expect(operation).resolves.toBe(true);
    expect(native.invoke).toHaveBeenNthCalledWith(2, "remove_worktree", {
      repositoryRoot, worktreePath, force: true, expectedState: snapshot,
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("cancellation of either dialog cannot force-delete", async () => {
    native.confirm.mockResolvedValueOnce(false);
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();

    native.confirm.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    native.invoke.mockResolvedValueOnce(dirty);
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).resolves.toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("remove_worktree", {
      repositoryRoot, worktreePath, force: false, expectedState: null,
    });
  });

  it("native dialog failures fail closed, including the force dialog", async () => {
    native.confirm.mockRejectedValueOnce(new Error("dialog permission denied"));
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath))
      .rejects.toThrow("dialog permission denied");
    expect(native.invoke).not.toHaveBeenCalled();

    native.confirm.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("force dialog unavailable"));
    native.invoke.mockResolvedValueOnce(dirty);
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath))
      .rejects.toThrow("force dialog unavailable");
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls[0][1].force).toBe(false);
  });

  it("does not offer force removal for an ordinary Git error", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValue(new Error("worktree is locked"));
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath))
      .rejects.toThrow("worktree is locked");
    expect(native.confirm).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not report success for a failed or stale force operation", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockResolvedValueOnce(dirty).mockRejectedValueOnce(
      new Error("Worktree changed since force-removal confirmation"),
    );
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath))
      .rejects.toThrow("Worktree changed");
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("fails closed outside Tauri", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath))
      .rejects.toThrow("desktop runtime");
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("stops only the target worktree terminals after an extra confirmation, then retries removal", async () => {
    let finishStop!: () => void;
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.")
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }))
      .mockResolvedValueOnce({ status: "removed" });
    const operation = removeWorktreeAfterConfirmation(repositoryRoot, worktreePath);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
    expect(native.confirm).toHaveBeenNthCalledWith(2,
      expect.stringContaining(worktreePath), expect.objectContaining({ title: "Stop worktree terminals", kind: "warning" }));
    expect(native.confirm.mock.calls[1][0]).toMatch(/commands|agent/i);
    expect(native.invoke).toHaveBeenNthCalledWith(2, "stop_worktree_terminals", { repositoryRoot, worktreePath });
    finishStop();
    await expect(operation).resolves.toBe(true);
    expect(native.invoke).toHaveBeenNthCalledWith(3, "remove_worktree", {
      repositoryRoot, worktreePath, force: false, expectedState: null,
    });
  });

  it("cancelling the terminal stop gate leaves terminals and the worktree unchanged", async () => {
    native.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    native.invoke.mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.");
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).resolves.toBe(false);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("remove_worktree", {
      repositoryRoot, worktreePath, force: false, expectedState: null,
    });
  });

  it("terminal stop failure never retries removal or offers force", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.")
      .mockRejectedValueOnce(new Error("Terminal cleanup failed"));
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).rejects.toThrow("Terminal cleanup failed");
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(native.confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps the exact force snapshot when stopping a terminal that appeared during the force dialog", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockResolvedValueOnce(dirty)
      .mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.")
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Worktree changed since force-removal confirmation"));
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).rejects.toThrow("Worktree changed");
    expect(native.invoke).toHaveBeenNthCalledWith(3, "stop_worktree_terminals", { repositoryRoot, worktreePath });
    expect(native.invoke).toHaveBeenNthCalledWith(4, "remove_worktree", {
      repositoryRoot, worktreePath, force: true, expectedState: snapshot,
    });
  });

  it("never repeatedly stops new terminals or automatically stops other writer kinds", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.");
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).rejects.toThrow(/retry/i);
    expect(native.invoke).toHaveBeenCalledTimes(3);
    expect(native.confirm).toHaveBeenCalledTimes(2);
    native.invoke.mockReset().mockRejectedValueOnce(new Error("Workspace is reserved by agent codex; wait for observed completion."));
    native.confirm.mockReset().mockResolvedValue(true);
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).rejects.toThrow(/agent codex/);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.confirm).toHaveBeenCalledTimes(1);
  });


  it("a dirty worktree discovered after terminal shutdown still requires force confirmation", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.")
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(dirty).mockResolvedValueOnce({ status: "removed" });
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).resolves.toBe(true);
    expect(native.confirm).toHaveBeenCalledTimes(3);
    expect(native.confirm.mock.calls[2][1].title).toBe("Force remove dirty worktree");
    expect(native.invoke).toHaveBeenNthCalledWith(4, "remove_worktree", {
      repositoryRoot, worktreePath, force: true, expectedState: snapshot,
    });
  });

  it("an unavailable terminal stop dialog cannot terminate a session", async () => {
    native.confirm.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("stop dialog unavailable"));
    native.invoke.mockRejectedValueOnce("Workspace is reserved by terminal; wait for observed completion.");
    await expect(removeWorktreeAfterConfirmation(repositoryRoot, worktreePath)).rejects.toThrow("stop dialog unavailable");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

});
