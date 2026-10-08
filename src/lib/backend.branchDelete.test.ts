import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  ask: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: native.ask,
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
}));

import { deleteLocalBranchAfterConfirmation } from "./backend";

describe("native local branch deletion confirmation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    native.ask.mockReset();
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("waits for the visible native dialog before requesting deletion", async () => {
    let resolveConfirmation!: (approved: boolean) => void;
    native.ask.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    }));

    const operation = deleteLocalBranchAfterConfirmation("/repo", "feat/merged");
    expect(native.ask).toHaveBeenCalledWith(
      expect.stringContaining('Delete the LOCAL branch "feat/merged"?'),
      expect.objectContaining({
        title: "Delete local Git branch",
        kind: "warning",
        okLabel: "Delete local",
        cancelLabel: "Cancel",
      }),
    );
    expect(native.invoke).not.toHaveBeenCalled();

    resolveConfirmation(true);
    await expect(operation).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("git_delete_local_branch", {
      repositoryRoot: "/repo",
      branch: "feat/merged",
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("does not invoke deletion when user cancels", async () => {
    native.ask.mockResolvedValue(false);
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/cancelled")).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("fails closed when the native dialog fails (including permission errors)", async () => {
    native.ask.mockRejectedValue(new Error("dialog:allow-ask denied"));
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/denied"))
      .rejects.toThrow("dialog:allow-ask denied");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("fails closed outside desktop runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/not-desktop"))
      .rejects.toThrow("desktop runtime");
    expect(native.ask).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("does not mask a Rust Git rejection after approval", async () => {
    native.ask.mockResolvedValue(true);
    native.invoke.mockRejectedValue(new Error("branch is not fully merged"));
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/unmerged"))
      .rejects.toThrow("branch is not fully merged");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
