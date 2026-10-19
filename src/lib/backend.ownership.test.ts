import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ confirm: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: native.confirm, open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { inspectRepository } from "./backend";

const path = "D:/Work/工程 repo";
const ownershipError = "fatal: detected dubious ownership in repository";

describe("repository ownership recovery", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.resetAllMocks();
  });
  afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

  it("keeps background inspection read-only", async () => {
    native.invoke.mockRejectedValue(ownershipError);
    await expect(inspectRepository(path)).rejects.toBe(ownershipError);
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("trusts only the requested path after confirmation and retries inspection", async () => {
    native.invoke.mockRejectedValueOnce(ownershipError).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ root: path });
    native.confirm.mockResolvedValue(true);
    await expect(inspectRepository(path, { confirmOwnership: true })).resolves.toEqual({ root: path });
    expect(native.confirm).toHaveBeenCalledWith(expect.stringContaining(path), expect.objectContaining({ kind: "warning" }));
    expect(native.invoke).toHaveBeenNthCalledWith(2, "trust_repository_directory", { path });
    expect(native.invoke).toHaveBeenNthCalledWith(3, "inspect_repository", { path });
  });

  it("preserves the error and configuration on cancellation", async () => {
    native.invoke.mockRejectedValue(new Error(ownershipError));
    native.confirm.mockResolvedValue(false);
    await expect(inspectRepository(path, { confirmOwnership: true })).rejects.toThrow(ownershipError);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not offer trust for unrelated errors", async () => {
    native.invoke.mockRejectedValue("not a git repository");
    await expect(inspectRepository(path, { confirmOwnership: true })).rejects.toBe("not a git repository");
    expect(native.confirm).not.toHaveBeenCalled();
  });
});
