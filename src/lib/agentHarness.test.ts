import { describe, expect, it } from "vitest";
import { CodexAppServerAdapter, DeepSeekCodexAdapter, getHarnessAdapter } from "./agentHarness";

describe("CodexAppServerAdapter", () => {
  it("exposes the Codex harness identity without starting a process", () => {
    expect(new CodexAppServerAdapter().kind).toBe("codex");
  });

  it("maps the DeepSeek provider separately from Codex", () => {
    expect(new DeepSeekCodexAdapter().kind).toBe("deepseek");
    expect(getHarnessAdapter("claude").kind).toBe("claude");
    expect(getHarnessAdapter("opencode").kind).toBe("opencode");
  });

  it("fails closed outside the Tauri desktop runtime", async () => {
    const adapter = new CodexAppServerAdapter();
    await expect(adapter.capabilities()).rejects.toThrow(
      "Agent harnesses require the Tauri desktop runtime.",
    );
  });
});
