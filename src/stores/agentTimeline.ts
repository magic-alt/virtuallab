import { create } from "zustand";
import { agentWorkspaceKey, useAgentSessionStore } from "./agentSessions";
import type { AgentEvent, AgentSessionBinding } from "@/types/agent";

interface TurnIdentity {
  turnId: string;
  threadId: string | null;
}

interface SessionState {
  threadId: string | null;
  revision: number;
  stopped: boolean;
}

function sameTurn(left: TurnIdentity, right: TurnIdentity) {
  return left.turnId === right.turnId && left.threadId === right.threadId;
}

function rememberTerminalTurn(turns: TurnIdentity[], identity: TurnIdentity) {
  return [...turns.filter((turn) => !sameTurn(turn, identity)), identity].slice(-300);
}

function stoppedSession(session: SessionState | undefined, stopped: string[], threadId: string | null) {
  return Boolean(session?.stopped && (session.threadId === null || session.threadId === threadId)) ||
    (threadId !== null && stopped.includes(threadId));
}

/** In-memory only. Never persist full model responses, prompts, or tool outputs. */
interface AgentTimelineState {
  entries: Record<string, AgentEvent[]>;
  activeTurns: Record<string, string>;
  activeTurnThreads: Record<string, string | null>;
  // Completed or replaced identities, independent of transcript clearing and
  // bounded to 300 per workspace.
  terminalTurns: Record<string, TurnIdentity[]>;
  sessionStates: Record<string, SessionState>;
  stoppedThreads: Record<string, string[]>;
  append: (event: AgentEvent) => void;
  setActiveTurn: (workspaceRoot: string, turnId: string | null, threadId?: string | null, sessionRevision?: number) => void;
  clear: (workspaceRoot: string) => void;
}
export const useAgentTimeline = create<AgentTimelineState>()((set) => ({
  entries: {}, activeTurns: {}, activeTurnThreads: {}, terminalTurns: {}, sessionStates: {}, stoppedThreads: {},
  append: (event) => {
    const key = agentWorkspaceKey(event.workspaceRoot);
    const previousBinding = useAgentSessionStore.getState().bindings[key];
    let binding: AgentSessionBinding | undefined;
    if (event.eventType === "agent.session_binding") {
      const candidate = (event.payload as { binding?: AgentSessionBinding } | null)?.binding;
      // Native CLI output can refine an attachment, but cannot restore one
      // that was explicitly forgotten while buffered output was in flight.
      if (candidate && previousBinding && agentWorkspaceKey(candidate.workspaceRoot) === key && candidate.threadId.trim()
        && previousBinding.harness === candidate.harness
        && previousBinding.createdAtMs === candidate.createdAtMs
        && previousBinding.updatedAtMs <= candidate.updatedAtMs) {
        binding = candidate;
        useAgentSessionStore.getState().setBinding(binding);
      }
    }
    const payloadText = JSON.stringify(event.payload ?? null);
    const boundedEvent = new TextEncoder().encode(payloadText).byteLength > 16_384
      ? { ...event, payload: { detail: payloadText.slice(0, 2000), truncated: true } }
      : event;
    set((s) => {
      const entries = { ...s.entries, [key]: [...(s.entries[key] ?? []).slice(-299), boundedEvent] };
      const activeTurns = { ...s.activeTurns };
      const activeTurnThreads = { ...s.activeTurnThreads };
      const terminalTurns = { ...s.terminalTurns };
      const sessionStates = { ...s.sessionStates };
      const stoppedThreads = { ...s.stoppedThreads };
      const identity = event.turnId ? { turnId: event.turnId, threadId: event.threadId ?? null } : null;
      const active = activeTurns[key]
        ? { turnId: activeTurns[key], threadId: activeTurnThreads[key] ?? null }
        : null;
      if (binding && previousBinding && identity && binding.threadId === identity.threadId
        && previousBinding.threadId !== binding.threadId) {
        // CLI sessions publish a provider ID after starting under a temporary
        // binding. This explicit same-session promotion also retires late
        // acknowledgements carrying the original thread ID.
        const previousIdentity = { turnId: identity.turnId, threadId: previousBinding.threadId };
        const currentThread = active?.threadId ?? sessionStates[key]?.threadId ?? previousBinding.threadId;
        if (currentThread === previousBinding.threadId && (!active || sameTurn(active, previousIdentity))) {
          const stopped = stoppedSession(sessionStates[key], stoppedThreads[key] ?? [], previousBinding.threadId)
            || stoppedSession(sessionStates[key], stoppedThreads[key] ?? [], identity.threadId);
          const ended = stopped || (terminalTurns[key] ?? []).some((turn) => sameTurn(turn, identity));
          terminalTurns[key] = rememberTerminalTurn(terminalTurns[key] ?? [], previousIdentity);
          delete activeTurns[key];
          delete activeTurnThreads[key];
          if (sessionStates[key]?.threadId === previousBinding.threadId) {
            sessionStates[key] = { ...sessionStates[key], threadId: binding.threadId };
          }
          if (stopped) {
            stoppedThreads[key] = [...(stoppedThreads[key] ?? []).filter((thread) => thread !== binding.threadId), binding.threadId].slice(-300);
          }
          if (ended) {
            terminalTurns[key] = rememberTerminalTurn(terminalTurns[key] ?? [], identity);
          } else {
            activeTurns[key] = identity.turnId;
            activeTurnThreads[key] = identity.threadId;
          }
        }
      }
      if (event.eventType === "agent.turn_started" || event.method === "turn/started") {
        // Notifications and invoke acknowledgements use independent transports;
        // either start acknowledgement can arrive after a completed fast turn.
        if (identity && !stoppedSession(sessionStates[key], stoppedThreads[key] ?? [], identity.threadId)
          && !(terminalTurns[key] ?? []).some((turn) => sameTurn(turn, identity))) {
          if (active && !sameTurn(active, identity)) {
            terminalTurns[key] = rememberTerminalTurn(terminalTurns[key] ?? [], active);
          }
          activeTurns[key] = identity.turnId;
          activeTurnThreads[key] = identity.threadId;
        }
      }
      if (identity && (event.eventType === "agent.turn_completed" || event.method === "turn/completed")) {
        terminalTurns[key] = rememberTerminalTurn(terminalTurns[key] ?? [], identity);
        if (active && sameTurn(active, identity)) {
          delete activeTurns[key];
          delete activeTurnThreads[key];
        }
      }
      if (event.eventType === "agent.session_started" && event.threadId) {
        stoppedThreads[key] = (stoppedThreads[key] ?? []).filter((thread) => thread !== event.threadId);
        sessionStates[key] = { threadId: event.threadId, revision: (sessionStates[key]?.revision ?? 0) + 1, stopped: false };
      }
      if (event.eventType === "agent.process_exited" || event.eventType === "agent.session_stopped") {
        const threadId = event.threadId ?? null;
        if (threadId) {
          stoppedThreads[key] = [...(stoppedThreads[key] ?? []).filter((thread) => thread !== threadId), threadId].slice(-300);
        }
        const currentThread = active?.threadId ?? sessionStates[key]?.threadId ??
          useAgentSessionStore.getState().bindings[key]?.threadId ?? null;
        // An exit without identity remains diagnostic evidence; never attribute
        // an old/unknown process to the current known thread.
        if (currentThread === null || currentThread === threadId) {
          sessionStates[key] = { threadId, revision: (sessionStates[key]?.revision ?? 0) + 1, stopped: true };
          if (active && active.threadId === threadId) {
            terminalTurns[key] = rememberTerminalTurn(terminalTurns[key] ?? [], active);
            delete activeTurns[key];
            delete activeTurnThreads[key];
          }
        }
      }
      return { entries, activeTurns, activeTurnThreads, terminalTurns, sessionStates, stoppedThreads };
    });
  },
  setActiveTurn: (root, turnId, threadId, sessionRevision) => set((s) => {
    const activeTurns = { ...s.activeTurns };
    const activeTurnThreads = { ...s.activeTurnThreads };
    const terminalTurns = { ...s.terminalTurns };
    const key = agentWorkspaceKey(root);
    const active = activeTurns[key]
      ? { turnId: activeTurns[key], threadId: activeTurnThreads[key] ?? null }
      : null;
    if (turnId) {
      const identity = { turnId, threadId: threadId ?? useAgentSessionStore.getState().bindings[key]?.threadId ?? null };
      if ((sessionRevision !== undefined && sessionRevision !== (s.sessionStates[key]?.revision ?? 0)) ||
        stoppedSession(s.sessionStates[key], s.stoppedThreads[key] ?? [], identity.threadId) ||
        (terminalTurns[key] ?? []).some((turn) => sameTurn(turn, identity)) ||
        (active && !sameTurn(active, identity))) return s;
      activeTurns[key] = turnId;
      activeTurnThreads[key] = identity.threadId;
    } else {
      if (active) terminalTurns[key] = rememberTerminalTurn(terminalTurns[key] ?? [], active);
      delete activeTurns[key];
      delete activeTurnThreads[key];
    }
    return { activeTurns, activeTurnThreads, terminalTurns };
  }),
  clear: (root) => set((s) => {
    const key = agentWorkspaceKey(root);
    const entries = { ...s.entries };
    delete entries[key];
    return { entries };
  }),
}));
