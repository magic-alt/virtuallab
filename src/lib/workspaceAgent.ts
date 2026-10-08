import type { HarnessAdapter } from "./agentHarness";
import { getHarnessAdapter } from "./agentHarness";
import { agentWorkspaceKey, useAgentSessionStore } from "@/stores/agentSessions";
import type { AgentSessionBinding } from "@/types/agent";

export class WorkspaceAgentService {
  constructor(private readonly adapter: HarnessAdapter = getHarnessAdapter("codex")) {}

  async attach(workspaceRoot: string): Promise<AgentSessionBinding> {
    const root = workspaceRoot.trim();
    if (!root) {
      throw new Error("Workspace root must not be empty.");
    }

    const key = agentWorkspaceKey(root);
    const saved = useAgentSessionStore.getState().bindings[key];
    if (saved && saved.harness !== this.adapter.kind) {
      throw new Error("Stop and forget the previous harness binding before switching providers.");
    }
    const binding = await this.adapter.startOrResumeSession({
      workspaceRoot: root,
      harness: this.adapter.kind,
      threadId: saved?.harness === this.adapter.kind ? saved.threadId : null,
    });

    if (agentWorkspaceKey(binding.workspaceRoot) !== key) {
      await this.adapter.stopSession(root).catch(() => undefined);
      throw new Error("Agent harness returned a binding for a different workspace.");
    }
    if (binding.harness !== this.adapter.kind) {
      await this.adapter.stopSession(root).catch(() => undefined);
      throw new Error("Agent harness returned an unexpected harness kind.");
    }
    if (saved?.harness === this.adapter.kind && saved.threadId !== binding.threadId) {
      await this.adapter.stopSession(root).catch(() => undefined);
      throw new Error("Agent harness resumed a different thread than the persisted workspace binding.");
    }

    useAgentSessionStore.getState().setBinding(binding);
    return binding;
  }

  async stop(workspaceRoot: string): Promise<void> {
    await this.adapter.stopSession(workspaceRoot);
  }

  forget(workspaceRoot: string): void {
    useAgentSessionStore.getState().clearBinding(workspaceRoot);
  }
}

export const workspaceAgentService = new WorkspaceAgentService();
