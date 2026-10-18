import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ confirm: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: native.confirm, open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { detachRepositoryAfterConfirmation } from "./backend";

describe("repository detach native gate", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    native.confirm.mockReset();
    native.invoke.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
  it("waits for approval before native retirement", async () => {
    let respond!: (approved: boolean) => void;
    native.confirm.mockReturnValue(new Promise<boolean>((resolve) => { respond = resolve; }));
    const operation = detachRepositoryAfterConfirmation("/repos/工作 tree");
    expect(native.invoke).not.toHaveBeenCalled();
    respond(true);
    await expect(operation).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledWith("repository_detach", { repositoryRoot: "/repos/工作 tree" });
  });
  it("preserves native registration on cancellation", async () => {
    native.confirm.mockResolvedValue(false);
    await expect(detachRepositoryAfterConfirmation("/repo")).resolves.toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("fails closed when the dialog is unavailable", async () => {
    native.confirm.mockRejectedValue(new Error("dialog denied"));
    await expect(detachRepositoryAfterConfirmation("/repo")).rejects.toThrow("dialog denied");
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("propagates active native owner errors", async () => {
    native.confirm.mockResolvedValue(true);
    native.invoke.mockRejectedValue(new Error("Workspace is reserved by terminal"));
    await expect(detachRepositoryAfterConfirmation("/repo")).rejects.toThrow("reserved by terminal");
  });
  it("rejects a browser preview before opening a dialog", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(detachRepositoryAfterConfirmation("/repo")).rejects.toThrow("desktop runtime");
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
