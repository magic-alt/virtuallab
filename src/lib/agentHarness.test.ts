import { describe, expect, it } from "vitest";
import { CodexAppServerAdapter } from "./agentHarness";

describe("CodexAppServerAdapter", () => {
  it("exposes the Codex harness identity without starting a process", () => {
    expect(new CodexAppServerAdapter().kind).toBe("codex");
  });

  it("fails closed outside the Tauri desktop runtime", async () => {
    const adapter = new CodexAppServerAdapter();
    await expect(adapter.capabilities()).rejects.toThrow(
      "Agent harnesses require the Tauri desktop runtime.",
    );
  });
});
