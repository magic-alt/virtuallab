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
  readonly kind = "codex" as const;

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

export const codexAppServerAdapter = new CodexAppServerAdapter();
