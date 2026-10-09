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

import { confirmNativeAction, deleteLocalBranchAfterConfirmation, deleteOriginBranchAfterConfirmation } from "./backend";

describe("native local branch deletion confirmation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    native.confirm.mockReset();
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("waits for the visible native dialog before requesting deletion", async () => {
    let resolveConfirmation!: (approved: boolean) => void;
    native.confirm.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    }));

    const operation = deleteLocalBranchAfterConfirmation("/repo", "feat/merged");
    expect(native.confirm).toHaveBeenCalledWith(
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
    native.confirm.mockResolvedValue(false);
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/cancelled")).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("fails closed when the native dialog fails (including permission errors)", async () => {
    native.confirm.mockRejectedValue(new Error("dialog:allow-message denied"));
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/denied"))
      .rejects.toThrow("dialog:allow-message denied");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("fails closed outside desktop runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/not-desktop"))
      .rejects.toThrow("desktop runtime");
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("does not mask a Rust Git rejection after approval", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValue(new Error("branch is not fully merged"));
    await expect(deleteLocalBranchAfterConfirmation("/repo", "feat/unmerged"))
      .rejects.toThrow("branch is not fully merged");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});


describe("native origin branch deletion confirmation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    native.confirm.mockReset();
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("does not contact origin until the user confirms its exact name", async () => {
    let respond!: (confirmed: boolean) => void;
    native.confirm.mockReturnValue(new Promise<boolean>((resolve) => { respond = resolve; }));
    const deletion = deleteOriginBranchAfterConfirmation("/repo", "feat/remote");

    expect(native.confirm).toHaveBeenCalledWith(
      expect.stringContaining('origin/feat/remote'),
      expect.objectContaining({
        title: "Delete origin Git branch",
        kind: "warning",
        okLabel: "Delete origin",
        cancelLabel: "Cancel",
      }),
    );
    expect(native.invoke).not.toHaveBeenCalled();
    respond(true);
    await expect(deletion).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke).toHaveBeenCalledWith("git_delete_origin_branch", {
      repositoryRoot: "/repo",
      branch: "feat/remote",
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("does nothing when the user cancels", async () => {
    native.confirm.mockResolvedValue(false);
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/cancelled")).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("fails closed when the dialog is unavailable", async () => {
    native.confirm.mockRejectedValue(new Error("native dialog unavailable"));
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/denied"))
      .rejects.toThrow("native dialog unavailable");
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("propagates rejected pushes instead of reporting deletion success", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValue(new Error("remote rejected: protected branch"));
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/protected"))
      .rejects.toThrow("protected branch");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses to invoke commands outside the desktop runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(deleteOriginBranchAfterConfirmation("/repo", "feat/web-preview"))
      .rejects.toThrow("desktop runtime");
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

 describe("shared native action gate", () => {
  it("fails closed outside desktop", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(confirmNativeAction("Remove workspace?")).resolves.toBe(false);
  });
  it("fails closed when dialog cannot open", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    native.confirm.mockRejectedValueOnce(new Error("dialog denied"));
    await expect(confirmNativeAction("Merge PR?")).resolves.toBe(false);
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
