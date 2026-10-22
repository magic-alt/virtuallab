import { confirmNativeAction, isDesktopRuntime } from "@/lib/backend";
import {
  agentJournalRecent, agentJournalRecover, agentJournalPurgeAll, unverifiedRecoveredTurns,
  type AgentRecoverySnapshot, type AgentJournalEntry,
} from "@/lib/agentJournal";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleStop, Play, ShieldAlert, Settings2, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getHarnessAdapter } from "@/lib/agentHarness";
import { latestCodexAnswer } from "@/lib/agentActivity";
import { AgentApprovalBroker, type ProtectedAction } from "@/lib/agentSafety";
import { WorkspaceAgentService } from "@/lib/workspaceAgent";
import { agentWorkspaceKey, useAgentSessionStore } from "@/stores/agentSessions";
import { useAgentPreferences } from "@/stores/agentPreferences";
import { useAgentTimeline } from "@/stores/agentTimeline";
import { BUILTIN_ROLES, buildAgentPrompt, useAgentConfiguration } from "@/stores/agentConfiguration";
import { contextRepositoriesKey, EMPTY_CONTEXT_REPOSITORIES } from '@/lib/workspaceContext';
import { ContextRepositoryList } from '@/features/workspace/RepositoryContextSelector';
import type { ContextRepository } from '@/types/workspaceContext';
import type {
  AgentEvent, AgentHarnessCapabilities, AgentHarnessKind,
} from "@/types/agent";

interface Props {
  workspaceRoot: string;
  enabled: boolean;
  visible?: boolean;
  disabledReason?: string;
  validateWorkspace?: () => Promise<void>;
  contextRepositories?: ContextRepository[];
}
const HARNESS: Array<{ id: AgentHarnessKind; name: string; detail: string }> = [
  { id: "codex", name: "Codex", detail: "App-server JSON-RPC" },
  { id: "deepseek", name: "DeepSeek", detail: "Codex + DeepSeek Responses API" },
  { id: "claude", name: "Claude Code", detail: "Read-only CLI plan mode" },
  { id: "opencode", name: "OpenCode", detail: "Read-only CLI plan agent" },
];
function describe(event: AgentEvent): string {
  const p = event.payload as Record<string, unknown> | undefined;
  const nested = p?.data as Record<string, unknown> | undefined;
  const delta = p?.delta as string | Record<string, unknown> | undefined;
  const dataDelta = nested?.delta as Record<string, unknown> | undefined;
  const message = nested?.message as Record<string, unknown> | undefined;
  const content = message?.content as Array<Record<string, unknown>> | undefined;
  const part = nested?.part as Record<string, unknown> | undefined;
  const found = [typeof delta === "string" ? delta : delta?.text, dataDelta?.text,
    part?.text, content?.[0]?.text, nested?.text, p?.detail];
  const text = found.find((value) => typeof value === "string" && value.trim()) as string | undefined;
  return (text ?? JSON.stringify(event.payload ?? {})).slice(0, 2400);
}
const timeLabel = (time: number) => new Date(time).toLocaleTimeString();
const emptyCapabilities: AgentHarnessCapabilities | null = null;
const EMPTY_EVENTS: AgentEvent[] = [];
function isCodexHarness(kind: AgentHarnessKind): boolean {
  return kind === "codex" || kind === "deepseek";
}
function eventTitle(event: AgentEvent): string {
  if (event.eventType === "agent.turn_started" || event.method === "turn/started") return "Task started";
  if (event.eventType === "agent.turn_completed" || event.method === "turn/completed") return "Task finished";
  if (event.eventType === "agent.session_started") return "Agent connected";
  if (event.eventType === "agent.session_stopped") return "Agent disconnected";
  if (event.eventType === "agent.protocol_error" || event.eventType === "agent.stderr") return "Diagnostic";
  return event.method ?? event.eventType.replace(/^agent\./, "");
}

export function AgentWorkspace({ workspaceRoot, enabled, visible = true, disabledReason, validateWorkspace, contextRepositories = EMPTY_CONTEXT_REPOSITORIES }: Props) {
  const key = agentWorkspaceKey(workspaceRoot);
  const binding = useAgentSessionStore((s) => s.bindings[key]);
  const setBinding = useAgentSessionStore((s) => s.setBinding);
  const events = useAgentTimeline((s) => s.entries[key] ?? EMPTY_EVENTS);
  const turn = useAgentTimeline((s) => s.activeTurns[key] ?? null);
  const session = useAgentTimeline((s) => s.sessionStates[key]);
  const setActiveTurn = useAgentTimeline((s) => s.setActiveTurn);
  const clearTimeline = useAgentTimeline((s) => s.clear);
  const config = useAgentConfiguration();
  const selection = config.selections[key] ?? { roleId: "general", skillIds: [] };
  const roles = [...BUILTIN_ROLES, ...config.roles];
  const role = roles.find((v) => v.id === selection.roleId) ?? BUILTIN_ROLES[0];
  const skills = config.skills.filter((v) => selection.skillIds.includes(v.id));
  const [harness, setHarness] = useState<AgentHarnessKind>(binding?.harness ?? "codex");
  const [capabilities, setCapabilities] = useState<AgentHarnessCapabilities | null>(emptyCapabilities);
  const codexPath = useAgentPreferences((s) => s.codexExecutablePath);
  const setCodexPath = useAgentPreferences((s) => s.setCodexExecutablePath);
  const [attached, setAttached] = useState(false);
  const [attachedReferenceKey, setAttachedReferenceKey] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [roleName, setRoleName] = useState("");
  const [rolePrompt, setRolePrompt] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillPrompt, setSkillPrompt] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [action, setAction] = useState<ProtectedAction>("motion");
  const [approvalMessage, setApprovalMessage] = useState("");
  const [journal, setJournal] = useState<AgentJournalEntry[]>([]);
  const [recovery, setRecovery] = useState<AgentRecoverySnapshot | null>(null);
  const [journalError, setJournalError] = useState("");
  const [journalBusy, setJournalBusy] = useState(false);
  const [journalRevision, setJournalRevision] = useState(0);
  const broker = useRef(new AgentApprovalBroker());
  const alive = useRef(true);
  const requesting = useRef(false);
  const referenceKey = contextRepositoriesKey(contextRepositories);
  const context = useRef({ key, enabled, visible, referenceKey });
  context.current = { key, enabled, visible, referenceKey };
  const interactive = enabled && visible;
  const adapter = useMemo(() => getHarnessAdapter(harness), [harness]);
  const latestAnswer = useMemo(() => latestCodexAnswer(events), [events]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setHarness(useAgentSessionStore.getState().bindings[agentWorkspaceKey(workspaceRoot)]?.harness ?? "codex");
    setAttached(false); setAttachedReferenceKey(null); setCapabilities(null); setError(""); setJournal([]); setRecovery(null);
  }, [workspaceRoot]);

  useEffect(() => {
    if (session?.stopped) { setAttached(false); setAttachedReferenceKey(null); }
  }, [session]);

  // Hydrate native metadata separately from live, unredacted session events.
  // Cancel an old response if the operator switches workspaces during read.
  useEffect(() => {
    if (!enabled || !visible) { setJournalBusy(false); return; }
    let cancelled = false;
    setJournalBusy(true);
    setJournalError("");
    void agentJournalRecover(workspaceRoot)
      .then(async (status) => {
        if (cancelled) return;
        const rows = await agentJournalRecent(workspaceRoot);
        if (!cancelled) { setRecovery(status); setJournal(rows); }
      })
      .catch((cause) => { if (!cancelled) setJournalError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setJournalBusy(false); });
    return () => { cancelled = true; };
  }, [workspaceRoot, enabled, visible, journalRevision]);

  const unresolved = unverifiedRecoveredTurns(recovery);
  const nativeRuntimeRegistered = recovery?.nativeSessionRegistered ?? false;
  const runtimePresent = attached || nativeRuntimeRegistered || !!turn;
  // Keep requested identity separate from Native's canonical effective paths.
  // Reattachment after reload lets Native compare aliases and active bindings.
  const referenceContextChanged = attached && attachedReferenceKey !== referenceKey;
  const unsupportedReferenceContext = contextRepositories.length > 0 && !isCodexHarness(harness);

  function assertActiveContext() {
    if (!alive.current || context.current.key !== key || !context.current.enabled || !context.current.visible || context.current.referenceKey !== referenceKey) {
      throw new Error("Return to this workspace session before continuing the request.");
    }
  }
  async function run(task: () => Promise<void>) {
    if (requesting.current || !interactive) return;
    requesting.current = true;
    setBusy(true); setError("");
    try { await task(); }
    catch (cause) { if (alive.current && context.current.key === key) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { requesting.current = false; if (alive.current && context.current.key === key) setBusy(false); }
  }
  const check = () => run(async () => {
    const status = await adapter.capabilities(isCodexHarness(harness) ? codexPath.trim() || undefined : undefined);
    assertActiveContext();
    setCapabilities(status);
  });
  // The first message can connect and start a turn in one explicit click. Use the binary
  // returned by the capability probe so check and app-server cannot diverge.
  async function ensureAttached() {
    assertActiveContext();
    if (referenceContextChanged) throw new Error('参考配置已变化；先停止当前会话，再重新连接以应用新的工作区。');
    if (unsupportedReferenceContext) throw new Error('此 Provider 暂不支持协作仓库。请选择 Codex / DeepSeek，或移除参考配置。');
    await validateWorkspace?.();
    assertActiveContext();
    const current = useAgentSessionStore.getState().bindings[key];
    if (current && current.harness !== harness) {
      throw new Error("This workspace remembers another provider. Stop and forget that thread before switching.");
    }
    if (attached && current) return current;
    const status = await adapter.capabilities(isCodexHarness(harness) ? codexPath.trim() || undefined : undefined);
    assertActiveContext();
    setCapabilities(status);
    if (!status.available) throw new Error(status.detail);
    const result = await new WorkspaceAgentService(adapter).attach(
      workspaceRoot, isCodexHarness(harness) ? status.executablePath ?? codexPath.trim() : undefined,
      contextRepositories,
    );
    setBinding(result);
    if (alive.current && context.current.key === key) { setAttachedReferenceKey(referenceKey); setAttached(true); }
    return result;
  }
  const attach = () => run(async () => { await ensureAttached(); });
  const send = () => run(async () => {
    if (!prompt.trim() || turn) return;
    const message = prompt;
    const current = await ensureAttached();
    assertActiveContext();
    if (useAgentTimeline.getState().activeTurns[key]) throw new Error("A turn is already running in this workspace.");
    const input = buildAgentPrompt(message, role, skills);
    const sessionRevision = useAgentTimeline.getState().sessionStates[key]?.revision ?? 0;
    const result = await adapter.startTurn({
      workspaceRoot, threadId: current.threadId, text: input,
    });
    setActiveTurn(workspaceRoot, result.turnId, result.threadId, sessionRevision);
    if (alive.current && context.current.key === key) setPrompt((draft) => draft === message ? "" : draft);
  });
  const chooseCodexPath = () => run(async () => {
    if (attached || turn || nativeRuntimeRegistered) throw new Error("Stop the attached runtime before changing the Codex executable.");
    const path = await open({ directory: false, multiple: false, title: "Choose codex executable or launcher" });
    assertActiveContext();
    if (typeof path !== "string") return;
    setCodexPath(path);
    setCapabilities(null);
  });
  const resetCodexPath = () => {
    if (!interactive || attached || turn || nativeRuntimeRegistered) return;
    setCodexPath("");
    setCapabilities(null);
  };
  const interrupt = () => run(async () => {
    const current = useAgentSessionStore.getState().bindings[key];
    if (!turn || !current) return;
    await adapter.interruptTurn({ workspaceRoot, threadId: current.threadId, turnId: turn });
    setActiveTurn(workspaceRoot, null);
  });
  const steer = () => run(async () => {
    if (!turn || !prompt.trim() || !capabilities?.features.steering) return;
    const current = useAgentSessionStore.getState().bindings[key];
    if (!current) return;
    const message = prompt;
    await adapter.steerTurn({ workspaceRoot, threadId: current.threadId, turnId: turn, text: message.trim() });
    if (alive.current && context.current.key === key) setPrompt((draft) => draft === message ? "" : draft);
  });
  const stop = () => run(async () => {
    // Tabs unmount this pane. The native runtime can still be alive when
    // attached=false; stop the saved owner rather than the selected dropdown.
    await getHarnessAdapter(binding?.harness ?? harness).stopSession(workspaceRoot);
    setAttached(false); setAttachedReferenceKey(null); setActiveTurn(workspaceRoot, null); setRecovery(null);
    setJournalRevision((value) => value + 1);
  });
  const forget = () => run(async () => {
    const expected = useAgentSessionStore.getState().bindings[key];
    if (!expected) throw new Error("The saved thread is no longer available.");
    const assertOriginalBinding = () => {
      const current = useAgentSessionStore.getState().bindings[key];
      if (!current || current.harness !== expected.harness || current.threadId !== expected.threadId
        || current.createdAtMs !== expected.createdAtMs) {
        throw new Error("The saved thread changed. Review the current session before forgetting it.");
      }
    };
    if (!await confirmNativeAction("Forget the saved thread association for this workspace? This cannot be undone.")) return;
    assertActiveContext();
    assertOriginalBinding();
    await getHarnessAdapter(expected.harness).stopSession(workspaceRoot);
    assertOriginalBinding();
    useAgentSessionStore.getState().clearBinding(workspaceRoot);
    setAttached(false); setAttachedReferenceKey(null); setActiveTurn(workspaceRoot, null); setRecovery(null);
    setJournalRevision((value) => value + 1);
  });
  const changeHarness = (value: AgentHarnessKind) => {
    if (attached || turn || nativeRuntimeRegistered) {
      setError("Stop the current session before changing harness.");
      return;
    }
    setHarness(value); setCapabilities(null); setError("");
  };
  const createRole = () => {
    if (!roleName.trim() || !rolePrompt.trim()) return;
    const id = "custom-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    config.addRole({ id, name: roleName, instructions: rolePrompt });
    config.setRole(workspaceRoot, id);
    setRoleName(""); setRolePrompt("");
  };
  const createSkill = () => {
    if (!skillName.trim() || !skillPrompt.trim()) return;
    const id = "custom-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    config.addSkill({ id, name: skillName, instructions: skillPrompt });
    config.toggleSkill(workspaceRoot, id);
    setSkillName(""); setSkillPrompt("");
  };
  const requestApproval = async () => {
    try {
      assertActiveContext();
      const stamp = Date.now();
      const id = "approval-" + stamp;
      broker.current.request({
        id, workspaceRoot, resourceId: resourceId.trim(), action,
        reason: "Explicit user-initiated control-plane request",
        createdAtMs: stamp, expiresAtMs: stamp + 60_000,
      });
      if (!await confirmNativeAction("Record a human acknowledgement for this protected action? This does NOT authorize device access.")) {
        broker.current.decide(id, "denied", true);
        setApprovalMessage("Human decision recorded: denied. No operation executed.");
        return;
      }
      assertActiveContext();
      broker.current.decide(id, "approved-by-human", true);
      void broker.current.authorize(id)
        .then(() => setApprovalMessage("External provider returned an enforced lease."))
        .catch((cause) => setApprovalMessage("Fail closed: " + String(cause)));
    } catch (cause) { setApprovalMessage(String(cause)); }
  };

  return (
    <div className="mx-auto flex min-w-0 max-w-[1040px] flex-col gap-4 text-sm" data-testid="agent-workspace">
      <section className="min-w-0 rounded-xl border border-orange-400/20 bg-black/25 p-4 sm:p-5">
        <h2 className="text-base font-semibold text-white">Workspace agent session</h2>
        <p className="mt-1 text-xs leading-5 text-stone-400">
          Send a message to a coding agent in the selected worktree. Choose a provider and describe your request.
          Connect &amp; send checks the CLI, attaches or resumes the workspace thread, and starts a turn.
        </p>

        <div className="mt-4 grid min-w-0 gap-2 border-t border-white/10 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block min-w-0 text-xs text-stone-300">
            <span className="font-semibold text-orange-300">1 · Provider</span>
            <select aria-label="Harness" className="mt-2 w-full rounded border border-white/15 bg-stone-900 px-3 py-2"
              value={harness} onChange={(e) => changeHarness(e.target.value as AgentHarnessKind)}>
              {HARNESS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void check()} disabled={!interactive || busy}
            className="rounded border border-white/20 px-3 py-2 text-xs">Check availability</button>
        </div>
        {capabilities && (
          <div className="mt-2 min-w-0 text-xs text-stone-400" role="status">
            <span className={capabilities.available ? "font-semibold text-emerald-300" : "font-semibold text-amber-300"}>
              {capabilities.available ? "Available" : "Unavailable"}
            </span>
            {" · " + (capabilities.version ?? "version unknown") + " · " + capabilities.detail}
            {capabilities.executablePath && (
              <div className="mt-1 break-all font-mono text-[11px] text-stone-500">
                Detected executable: {capabilities.executablePath}
              </div>
            )}
          </div>
        )}
        {unresolved.length > 0 && <p role="status" className="mt-2 text-xs text-amber-300">
          {unresolved.length} earlier turn(s) have unverified completion after restart. Review history before relying on their results.
        </p>}
        {binding && <p className="mt-2 break-all text-xs text-stone-500">
          Saved thread: {binding.harness} · {binding.threadId}
        </p>}
        <ContextRepositoryList references={binding?.contextRepositories} label={runtimePresent ? '当前会话参考工作区' : '上次会话参考工作区'}/>
        {referenceContextChanged && <p role="status" className="mt-2 text-xs text-amber-300">参考配置已变化；先停止当前会话，再重新连接以应用新的工作区。</p>}
        {unsupportedReferenceContext && <p role="status" className="mt-2 text-xs text-amber-300">此 Provider 暂不支持协作仓库。请选择 Codex / DeepSeek，或移除参考配置。</p>}
        {binding && binding.harness !== harness && <p className="mt-2 text-xs text-amber-300">
          A thread from {binding.harness} is saved here. Stop and forget it before using {harness}.
        </p>}
        {!enabled && <p className="mt-2 text-xs text-amber-300">{disabledReason ?? (isDesktopRuntime()
          ? "This workspace session is temporarily unavailable."
          : "Native desktop runtime required; this is a UI preview.")}</p>}
        {error && <p role="alert" className="mt-2 flex min-w-0 items-start gap-2 break-words text-xs text-rose-300">
          <AlertTriangle size={14} className="shrink-0"/>{error}
        </p>}

        <p className="mt-1 text-xs text-stone-500">{HARNESS.find((entry) => entry.id === harness)?.detail}</p>
        <label className="mt-5 block text-xs text-stone-300">
          <span className="font-semibold text-orange-300">2 · Describe your request</span>
          <span className="ml-2 text-stone-500">Role: {role.name}</span>
          <textarea aria-label="Agent message" value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="Example: Review the current worktree for a bug, propose a fix and explain which files changed."
            rows={5} className="mt-2 w-full min-w-0 rounded border border-white/15 bg-stone-900 p-3 text-sm" />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void send()}
            disabled={!interactive || busy || !prompt.trim() || !!turn || referenceContextChanged || unsupportedReferenceContext || !!(binding && binding.harness !== harness)}
            className="flex items-center gap-2 rounded bg-orange-500 px-4 py-2 text-xs font-semibold text-black">
            <Play size={14}/>{attached ? "Send message" : "Connect & send"}
          </button>
          <button type="button" onClick={() => void attach()}
            disabled={!interactive || busy || attached || referenceContextChanged || unsupportedReferenceContext || !!(binding && binding.harness !== harness)}
            className="rounded border border-white/20 px-3 py-2 text-xs">Attach / resume</button>
          {turn && capabilities?.features.steering && (
            <button type="button" onClick={() => void steer()}
              disabled={!interactive || busy || !prompt.trim() || referenceContextChanged}
              className="rounded border border-white/20 px-3 py-2 text-xs">
              Steer running turn
            </button>
          )}
          {turn && (
            <button type="button" onClick={() => void interrupt()} disabled={!interactive || busy}
              className="flex items-center gap-2 rounded border border-rose-400/30 px-3 py-2 text-xs text-rose-300">
              <CircleStop size={14}/>Interrupt turn
            </button>
          )}
          <button type="button" onClick={() => void stop()} disabled={!interactive || busy || (!attached && !binding && !nativeRuntimeRegistered)}
            className="rounded border border-white/20 px-3 py-2 text-xs">Stop runtime</button>
          {binding && <button type="button" onClick={() => void forget()}
            disabled={!interactive || busy} className="text-xs text-stone-400 underline">Forget saved thread</button>}
        </div>
        <p className="mt-2 text-xs text-stone-400" role="status">
          {busy ? "Processing request…" : turn ? "3 · Turn running; activity appears below." :
            attached ? "Ready for another message in this workspace." : "Ready to connect when you send a message."}
        </p>
        <p className="mt-1 text-xs text-stone-500">
          Codex/DeepSeek can write within the selected workspace; Claude Code/OpenCode are launched in plan mode.
          Check Changes before committing or merging. No automatic hardware approvals.
        </p>
      </section>

      <section className="min-w-0 rounded-xl border border-white/10 bg-black/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">3 · Agent activity</h3>
            <p className="mt-1 text-xs text-stone-500">Live output is temporary; the last 300 structured events are kept in memory, not as a chat transcript.</p>
          </div>
          <button type="button" onClick={() => clearTimeline(workspaceRoot)}
            className="text-xs text-stone-400 underline">Clear timeline</button>
        </div>
        {latestAnswer && (
          <div className="mt-3 min-w-0 rounded-lg border border-emerald-400/20 bg-emerald-950/10 p-3">
            <h4 className="text-xs font-semibold text-emerald-300">Latest Codex response</h4>
            <pre className="mt-2 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-stone-200">
              {latestAnswer}
            </pre>
            <p className="mt-2 text-[11px] text-stone-500">
              Reconstructed from recent in-memory events; long messages may be partial after the event limit.
            </p>
          </div>
        )}
        <div role="log" aria-label="Agent event timeline" className="mt-3 max-h-80 min-w-0 space-y-2 overflow-y-auto text-xs">
          {!events.length && <p className="text-stone-500">Send a message to see progress and responses here.</p>}
          {events.filter((event) => event.method !== "item/agentMessage/delta").slice(-12).map((event, idx) => (
            <div key={event.timestampMs + ":" + idx} className="min-w-0 rounded border border-white/5 bg-stone-950/60 p-3">
              <div className="font-medium text-orange-300">{timeLabel(event.timestampMs)} · {eventTitle(event)}</div>
              {(event.eventType === "agent.notification" || event.eventType === "agent.stderr" ||
                event.eventType === "agent.protocol_error" || event.eventType === "agent.turn_completed") && (
                <pre className="mt-1 max-w-full whitespace-pre-wrap break-all font-mono text-stone-300">{describe(event)}</pre>
              )}
            </div>
          ))}
        </div>
      </section>

      <details className="min-w-0 rounded-xl border border-white/10 bg-black/15">
        <summary className="flex cursor-pointer items-center gap-2 p-4 text-xs font-semibold text-stone-300">
          <Settings2 size={15}/> Role & optional skills · advanced
        </summary>
        <div className="px-3 pb-3">
                  <section className="rounded-xl border border-white/10 bg-black/20 p-4">
          <h3 className="font-semibold">Role and skills</h3>
          <p className="mb-3 mt-1 text-xs text-stone-400">Instructions are user-configured and repository-neutral, stored locally. Never include secrets.</p>
          <label className="block text-xs text-stone-300">Role
            <select aria-label="Agent role" className="mt-1 w-full rounded border border-white/15 bg-stone-900 p-2"
              value={role.id} onChange={(e) => config.setRole(workspaceRoot, e.target.value)}>
              {roles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
          <div className="mt-2 flex gap-2">
            <input aria-label="New role name" value={roleName} onChange={(e) => setRoleName(e.target.value)}
              placeholder="Custom role name" maxLength={80} className="min-w-0 flex-1 rounded border border-white/15 bg-stone-900 p-2 text-xs" />
            <button type="button" onClick={createRole} className="rounded border border-white/20 px-3 text-xs">Add role</button>
          </div>
          <textarea aria-label="New role instructions" value={rolePrompt} onChange={(e) => setRolePrompt(e.target.value)}
            placeholder="Role instructions..." maxLength={4000} rows={2} className="mt-2 w-full rounded border border-white/15 bg-stone-900 p-2 text-xs" />
          {config.roles.some((item) => item.id === role.id) && <button type="button"
            onClick={() => { config.removeRole(role.id); config.setRole(workspaceRoot, "general"); }}
            className="mb-2 text-xs text-rose-300">Delete selected custom role</button>}
          <h4 className="mt-2 text-xs font-semibold">Opt-in engineering skills</h4>
          {config.skills.length ? config.skills.map((skill) => (
            <label key={skill.id} className="mt-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={selection.skillIds.includes(skill.id)}
                onChange={() => config.toggleSkill(workspaceRoot, skill.id)}/>{skill.name}
              <button type="button" aria-label={"Delete skill " + skill.name} className="ml-auto text-stone-500"
                onClick={() => config.removeSkill(skill.id)}>×</button>
            </label>
          )) : <p className="my-2 text-xs text-stone-500">No bundled project skills. Add optional instructions below.</p>}
          <div className="mt-2 flex gap-2">
            <input aria-label="New skill name" value={skillName} onChange={(e) => setSkillName(e.target.value)}
              placeholder="Skill name" maxLength={80} className="min-w-0 flex-1 rounded border border-white/15 bg-stone-900 p-2 text-xs"/>
            <button type="button" onClick={createSkill} className="rounded border border-white/20 px-3 text-xs">Add skill</button>
          </div>
          <textarea aria-label="New skill instructions" value={skillPrompt} onChange={(e) => setSkillPrompt(e.target.value)}
            placeholder="Skill instructions..." maxLength={4000} rows={2} className="mt-2 w-full rounded border border-white/15 bg-stone-900 p-2 text-xs"/>
        </section>
        </div>
      </details>

      <details className="min-w-0 rounded-xl border border-white/10 bg-black/15">
        <summary className="cursor-pointer p-4 text-xs font-semibold text-stone-300">
          CLI diagnostics · executable selection
        </summary>
        <div className="space-y-3 border-t border-white/10 p-4 text-xs text-stone-400">
          <p>A GUI can inherit a different PATH from your terminal. Detection reports the exact executable used
            by the runtime; if its version is old, choose the executable installed for your terminal.
            This choice is stored locally and shared by Codex and DeepSeek.</p>
          <div className="break-all font-mono text-[11px]">Configured Codex executable: {codexPath || "Automatic (desktop PATH)"}</div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void chooseCodexPath()}
              disabled={!interactive || busy || attached || !!turn || nativeRuntimeRegistered || !isCodexHarness(harness)}
              className="flex items-center gap-2 rounded border border-white/20 px-3 py-2">
              <FolderOpen size={14}/>Choose Codex executable
            </button>
            <button type="button" onClick={resetCodexPath}
              disabled={!interactive || busy || attached || !!turn || nativeRuntimeRegistered || !codexPath}
              className="rounded border border-white/20 px-3 py-2">Use automatic PATH</button>
          </div>
          <p>Windows PowerShell: run <code className="text-stone-200">Get-Command codex -All</code> or
            <code className="ml-1 text-stone-200">where.exe codex</code> to locate installed versions.
            Choose a real codex.exe or codex.cmd launcher. Stop a connected runtime before changing it.</p>
        </div>
      </details>

      <details className="min-w-0 rounded-xl border border-white/10 bg-black/15">
        <summary className="cursor-pointer p-4 text-xs font-semibold text-stone-300">
          Full structured event timeline · diagnostic
        </summary>
        <div className="max-h-80 min-w-0 space-y-2 overflow-y-auto border-t border-white/10 p-3 font-mono text-xs">
          {events.map((event, idx) => (
            <div key={idx} className="min-w-0 rounded border border-white/5 bg-stone-950/60 p-2">
              <div className="text-orange-300">{timeLabel(event.timestampMs)} · {event.method ?? event.eventType}</div>
              <pre className="mt-1 whitespace-pre-wrap break-all text-stone-300">{describe(event)}</pre>
            </div>
          ))}
          {!events.length && <p className="text-stone-500">No events in memory.</p>}
        </div>
      </details>

      <details className="min-w-0 rounded-xl border border-white/10 bg-black/15">
        <summary className="cursor-pointer p-4 text-xs font-semibold text-stone-300">
          Session recovery & privacy metadata · advanced
        </summary>
        <div className="px-3 pb-3">
                <section className="rounded-xl border border-white/10 bg-black/20 p-4" data-testid="agent-journal-history">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">Recovered lifecycle metadata</h3>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={!interactive || journalBusy}
              onClick={() => setJournalRevision((value) => value + 1)}
              className="shrink-0 text-xs text-stone-400 underline">Refresh history</button>
            <button type="button" disabled={!interactive || journalBusy}
              onClick={() => void run(async () => {
                if (!await confirmNativeAction("Delete ALL retained Agent lifecycle metadata for every workspace? This does not stop agents or delete provider threads. This cannot be undone.")) return;
                assertActiveContext();
                await agentJournalPurgeAll();
                setRecovery(null);
                setJournal([]);
                setJournalRevision((value) => value + 1);
              })}
              className="shrink-0 text-xs text-rose-300 underline">Purge metadata</button>
          </div>
        </div>
        <p className="mt-1 text-xs text-stone-500">Native bounded metadata segments; prompts, model output and stderr are not saved. Thread/turn IDs are hashed. A stored start event is not proof of a running process after restart.</p>
        {journalError && <p role="alert" className="mt-2 text-xs text-rose-300">{journalError}</p>}
        {unresolved.length > 0 && <p role="status" className="mt-2 text-xs text-amber-300">{unresolved.length} turn(s) are not verified completed. Restart never resumes them automatically; inspect the provider thread and run fresh checks before relying on their results.</p>}
        {recovery && <p className="mt-2 text-xs text-stone-500">Native ownership: {recovery.nativeSessionRegistered ? "registered (turn status not assumed)" : "no runtime registered"} · Retained events: {recovery.retainedEvents}</p>}
        <div role="list" aria-label="Agent metadata history" className="mt-3 max-h-48 space-y-1 overflow-y-auto font-mono text-[11px]">
          {journal.map((entry) => (
            <div role="listitem" key={entry.eventId} className="break-words border-b border-white/5 py-1 text-stone-400">
              {timeLabel(entry.timestampMs)} · {entry.harness} · {entry.eventKind} · {entry.outcome}
              {entry.turnKey ? " · turn " + entry.turnKey.slice(0, 10) : ""}
            </div>
          ))}
          {!journal.length && <p className="text-stone-500">{journalBusy ? "Loading..." : "No retained lifecycle events for this workspace."}</p>}
        </div>
      </section>
        </div>
      </details>

      <details className="min-w-0 rounded-xl border border-white/10 bg-black/15">
        <summary className="cursor-pointer p-4 text-xs font-semibold text-stone-300">
          Hardware approval policy · no provider installed
        </summary>
        <div className="px-3 pb-3">
                <section className="rounded-xl border border-amber-400/20 bg-black/20 p-4">
        <h3 className="flex items-center gap-2 font-semibold"><ShieldAlert size={16}/>Protected operations · fail-closed approval broker</h3>
        <p className="mt-1 text-xs text-stone-400">Motion, power, flashing and release always require an independent device-side lease provider. Recording human acknowledgement here never enables hardware I/O.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input aria-label="Hardware resource ID" value={resourceId} onChange={(e) => setResourceId(e.target.value)}
            placeholder="Optional-provider resource ID" className="min-w-0 flex-1 rounded border border-white/15 bg-stone-900 p-2 text-xs"/>
          <select aria-label="Protected action" value={action}
            onChange={(e) => setAction(e.target.value as ProtectedAction)}
            className="rounded border border-white/15 bg-stone-900 p-2 text-xs">
            {(["motion", "power", "flash", "release"] as const).map((item) => <option key={item}>{item}</option>)}
          </select>
          <button type="button" disabled={!interactive || !resourceId.trim()} onClick={requestApproval}
            className="rounded border border-amber-400/30 px-3 py-2 text-xs">Request human acknowledgement</button>
        </div>
        {approvalMessage && <p role="status" className="mt-2 text-xs text-amber-300">{approvalMessage}</p>}
        <p className="mt-2 text-xs text-stone-500">No hardware provider is installed or bundled. Default decision: DENY.</p>
      </section>
        </div>
      </details>
    </div>
  );
}
