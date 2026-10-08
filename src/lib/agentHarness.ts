import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./backend";
import type {
  AgentHarnessCapabilities,
  AgentHarnessKind,
  AgentSessionBinding,
  AgentSessionStartRequest,
  AgentTurnInterruptRequest,
  AgentTurnStartRequest,
  AgentTurnStartResult,
  AgentTurnSteerRequest,
} from "@/types/agent";

export interface HarnessAdapter {
  readonly kind: AgentHarnessKind;
  capabilities(): Promise<AgentHarnessCapabilities>;
  startOrResumeSession(request: AgentSessionStartRequest): Promise<AgentSessionBinding>;
  startTurn(request: AgentTurnStartRequest): Promise<AgentTurnStartResult>;
  steerTurn(request: AgentTurnSteerRequest): Promise<void>;
  interruptTurn(request: AgentTurnInterruptRequest): Promise<void>;
  stopSession(workspaceRoot: string): Promise<void>;
}

function requireDesktop() {
  if (!isDesktopRuntime()) {
    throw new Error("Agent harnesses require the Tauri desktop runtime.");
  }
}

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly kind: AgentHarnessKind = "codex";

  async capabilities(): Promise<AgentHarnessCapabilities> {
    requireDesktop();
    return invoke<AgentHarnessCapabilities>("agent_harness_capabilities", {
      harness: this.kind,
    });
  }

  async startOrResumeSession(
    request: AgentSessionStartRequest,
  ): Promise<AgentSessionBinding> {
    requireDesktop();
    if (request.harness !== this.kind) {
      throw new Error(`Codex adapter cannot start harness '${request.harness}'.`);
    }
    return invoke<AgentSessionBinding>("agent_session_start", { request });
  }

  async startTurn(request: AgentTurnStartRequest): Promise<AgentTurnStartResult> {
    requireDesktop();
    return invoke<AgentTurnStartResult>("agent_turn_start", { request });
  }

  async steerTurn(request: AgentTurnSteerRequest): Promise<void> {
    requireDesktop();
    return invoke("agent_turn_steer", { request });
  }

  async interruptTurn(request: AgentTurnInterruptRequest): Promise<void> {
    requireDesktop();
    return invoke("agent_turn_interrupt", { request });
  }

  async stopSession(workspaceRoot: string): Promise<void> {
    requireDesktop();
    return invoke("agent_session_stop", { workspaceRoot });
  }
}


export class DeepSeekCodexAdapter extends CodexAppServerAdapter {
  override readonly kind: AgentHarnessKind = "deepseek";
  override async capabilities(): Promise<AgentHarnessCapabilities> {
    requireDesktop();
    return invoke<AgentHarnessCapabilities>("agent_harness_capabilities", { harness: this.kind });
  }
  override async startOrResumeSession(request: AgentSessionStartRequest): Promise<AgentSessionBinding> {
    requireDesktop();
    if (request.harness !== this.kind) throw new Error("DeepSeek adapter requires a deepseek session.");
    return invoke<AgentSessionBinding>("agent_session_start", { request });
  }
}

class CliHarnessAdapter implements HarnessAdapter {
  constructor(readonly kind: "claude" | "opencode") {}
  async capabilities(): Promise<AgentHarnessCapabilities> {
    requireDesktop();
    return invoke<AgentHarnessCapabilities>("agent_cli_capabilities", { harness: this.kind });
  }
  async startOrResumeSession(request: AgentSessionStartRequest): Promise<AgentSessionBinding> {
    requireDesktop();
    if (request.harness !== this.kind) throw new Error("CLI harness mismatch.");
    return invoke<AgentSessionBinding>("agent_cli_session_start", { request });
  }
  async startTurn(request: AgentTurnStartRequest): Promise<AgentTurnStartResult> {
    requireDesktop();
    return invoke<AgentTurnStartResult>("agent_cli_turn_start", { request });
  }
  async steerTurn(): Promise<void> {
    throw new Error("This harness does not support live turn steering.");
  }
  async interruptTurn(request: AgentTurnInterruptRequest): Promise<void> {
    requireDesktop();
    return invoke("agent_cli_turn_interrupt", { request });
  }
  async stopSession(workspaceRoot: string): Promise<void> {
    requireDesktop();
    return invoke("agent_cli_session_stop", { workspaceRoot });
  }
}

export const codexAppServerAdapter = new CodexAppServerAdapter();
export const deepSeekCodexAdapter = new DeepSeekCodexAdapter();
export const claudeCodeAdapter = new CliHarnessAdapter("claude");
export const openCodeAdapter = new CliHarnessAdapter("opencode");

export function getHarnessAdapter(kind: AgentHarnessKind): HarnessAdapter {
  switch (kind) {
    case "codex": return codexAppServerAdapter;
    case "deepseek": return deepSeekCodexAdapter;
    case "claude": return claudeCodeAdapter;
    case "opencode": return openCodeAdapter;
  }
}

