import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AlertTriangle, CircleStop, Play, ShieldAlert } from "lucide-react";
import { getHarnessAdapter } from "@/lib/agentHarness";
import { AgentApprovalBroker, type ProtectedAction } from "@/lib/agentSafety";
import { WorkspaceAgentService } from "@/lib/workspaceAgent";
import { agentWorkspaceKey, useAgentSessionStore } from "@/stores/agentSessions";
import { BUILTIN_ROLES, buildAgentPrompt, useAgentConfiguration } from "@/stores/agentConfiguration";
import type {
  AgentEvent, AgentHarnessCapabilities, AgentHarnessKind, AgentSessionBinding,
} from "@/types/agent";

interface Props { workspaceRoot: string; enabled: boolean }
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

export function AgentWorkspace({ workspaceRoot, enabled }: Props) {
  const key = agentWorkspaceKey(workspaceRoot);
  const binding = useAgentSessionStore((s) => s.bindings[key]);
  const setBinding = useAgentSessionStore((s) => s.setBinding);
  const config = useAgentConfiguration();
  const selection = config.selections[key] ?? { roleId: "general", skillIds: [] };
  const roles = [...BUILTIN_ROLES, ...config.roles];
  const role = roles.find((v) => v.id === selection.roleId) ?? BUILTIN_ROLES[0];
  const skills = config.skills.filter((v) => selection.skillIds.includes(v.id));
  const [harness, setHarness] = useState<AgentHarnessKind>(binding?.harness ?? "codex");
  const [capabilities, setCapabilities] = useState<AgentHarnessCapabilities | null>(emptyCapabilities);
  const [attached, setAttached] = useState(false);
  const [turn, setTurn] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [roleName, setRoleName] = useState("");
  const [rolePrompt, setRolePrompt] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillPrompt, setSkillPrompt] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [action, setAction] = useState<ProtectedAction>("motion");
  const [approvalMessage, setApprovalMessage] = useState("");
  const broker = useRef(new AgentApprovalBroker());
  const adapter = useMemo(() => getHarnessAdapter(harness), [harness]);

  useEffect(() => {
    setHarness(useAgentSessionStore.getState().bindings[agentWorkspaceKey(workspaceRoot)]?.harness ?? "codex");
    setEvents([]); setAttached(false); setTurn(null); setCapabilities(null); setError("");
  }, [workspaceRoot]);

  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    let stop: UnlistenFn | undefined;
    void listen<AgentEvent>("agent://event", (event) => {
      const item = event.payload;
      if (!item || agentWorkspaceKey(item.workspaceRoot) !== key) return;
      // Provider-specific events are emitted only by the attached workspace runtime.
      if (item.eventType === "agent.session_binding") {
        const data = item.payload as { binding?: AgentSessionBinding } | undefined;
        if (data?.binding && data.binding.workspaceRoot
          && agentWorkspaceKey(data.binding.workspaceRoot) === key) {
          setBinding(data.binding);
        }
      }
      if (item.eventType === "agent.turn_completed" || item.method === "turn/completed"
        || item.eventType === "agent.process_exited") {
        setTurn(null);
      }
      setEvents((prev) => [...prev.slice(-299), item]);
    }).then((unlisten) => { if (dead) unlisten(); else stop = unlisten; })
      .catch((cause) => setError(String(cause)));
    return () => { dead = true; stop?.(); };
  }, [enabled, key, setBinding]);

  async function run(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const check = () => run(async () => { setCapabilities(await adapter.capabilities()); });
  const attach = () => run(async () => {
    const status = await adapter.capabilities();
    setCapabilities(status);
    if (!status.available) throw new Error(status.detail);
    const result = await new WorkspaceAgentService(adapter).attach(workspaceRoot);
    setBinding(result);
    setAttached(true);
  });
  const send = () => run(async () => {
    if (!attached || !prompt.trim()) return;
    const input = buildAgentPrompt(prompt, role, skills);
    const current = useAgentSessionStore.getState().bindings[key];
    if (!current || current.harness !== harness) throw new Error("Attach this harness first.");
    const result = await adapter.startTurn({
      workspaceRoot, threadId: current.threadId, text: input,
    });
    setTurn(result.turnId);
    setPrompt("");
  });
  const interrupt = () => run(async () => {
    const current = useAgentSessionStore.getState().bindings[key];
    if (!turn || !current) return;
    await adapter.interruptTurn({ workspaceRoot, threadId: current.threadId, turnId: turn });
    setTurn(null);
  });
  const stop = () => run(async () => {
    await adapter.stopSession(workspaceRoot);
    setAttached(false); setTurn(null);
  });
  const forget = () => run(async () => {
    if (!window.confirm("Forget the saved thread association for this workspace? This cannot be undone.")) return;
    await adapter.stopSession(workspaceRoot);
    useAgentSessionStore.getState().clearBinding(workspaceRoot);
    setAttached(false); setTurn(null);
  });
  const changeHarness = (value: AgentHarnessKind) => {
    if (attached || turn) {
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
  const requestApproval = () => {
    try {
      const stamp = Date.now();
      const id = "approval-" + stamp;
      broker.current.request({
        id, workspaceRoot, resourceId: resourceId.trim(), action,
        reason: "Explicit user-initiated control-plane request",
        createdAtMs: stamp, expiresAtMs: stamp + 60_000,
      });
      if (!window.confirm("Record a human acknowledgement for this protected action? This does NOT authorize device access.")) {
        broker.current.decide(id, "denied", true);
        setApprovalMessage("Human decision recorded: denied. No operation executed.");
        return;
      }
      broker.current.decide(id, "approved-by-human", true);
      void broker.current.authorize(id)
        .then(() => setApprovalMessage("External provider returned an enforced lease."))
        .catch((cause) => setApprovalMessage("Fail closed: " + String(cause)));
    } catch (cause) { setApprovalMessage(String(cause)); }
  };

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-4 text-sm" data-testid="agent-workspace">
      <div className="rounded-xl border border-orange-400/20 bg-black/25 p-4">
        <h2 className="text-base font-semibold text-white">Workspace agents</h2>
        <p className="mt-1 text-xs text-stone-400">One attached runtime per workspace. Sessions follow the worktree, not a global chat. Commands requiring elevation and hardware access do not receive automatic approval.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-xs text-stone-300">
            Harness
            <select aria-label="Harness" className="ml-2 rounded border border-white/15 bg-stone-900 px-2 py-2"
              value={harness} onChange={(e) => changeHarness(e.target.value as AgentHarnessKind)}>
              {HARNESS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void check()} disabled={!enabled || busy} className="rounded border border-white/20 px-3 py-2 text-xs">Check availability</button>
          <button type="button" onClick={() => void attach()} disabled={!enabled || busy || attached} className="rounded bg-orange-500 px-3 py-2 text-xs font-medium text-black">Attach / resume</button>
          <button type="button" onClick={() => void stop()} disabled={!enabled || busy || !attached} className="rounded border border-white/20 px-3 py-2 text-xs">Stop runtime</button>
          <button type="button" onClick={() => void forget()} disabled={!enabled || busy || !binding} className="text-xs text-stone-400 underline">Forget thread</button>
        </div>
        <div className="mt-2 text-xs text-stone-400">{HARNESS.find((entry) => entry.id === harness)?.detail}</div>
        {capabilities && <p className="mt-2 text-xs" role="status">{capabilities.available ? "Available" : "Unavailable"} · {capabilities.version ?? "n/a"} · {capabilities.detail}</p>}
        {binding && <p className="mt-2 break-all font-mono text-[11px] text-stone-400">Saved: {binding.harness} / {binding.threadId}</p>}
        {!enabled && <p className="mt-2 text-xs text-amber-300">Native desktop runtime required; this is a UI preview.</p>}
        {error && <p role="alert" className="mt-2 flex gap-1 text-xs text-rose-300"><AlertTriangle size={14}/>{error}</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
        <section className="rounded-xl border border-white/10 bg-black/20 p-4">
          <h3 className="font-semibold">Agent turn</h3>
          <textarea aria-label="Agent message" value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask this agent to inspect or work within the current workspace..." rows={6}
            className="mt-3 w-full rounded border border-white/15 bg-stone-900 p-3 text-xs" />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void send()} disabled={!enabled || busy || !attached || !prompt.trim() || !!turn}
              className="flex items-center gap-2 rounded bg-orange-500 px-4 py-2 text-xs font-semibold text-black">
              <Play size={14}/>Start turn</button>
            <button type="button" onClick={() => void interrupt()} disabled={!enabled || busy || !turn}
              className="flex items-center gap-2 rounded border border-rose-400/30 px-3 py-2 text-xs text-rose-300">
              <CircleStop size={14}/>Interrupt</button>
          </div>
          <p className="mt-2 text-xs text-stone-400">{turn ? "Turn active · " + turn : attached ? "Ready for the next turn" : "Attach a provider to enable turns."}</p>
          <p className="mt-2 text-xs text-stone-500">Claude/OpenCode start in provider plan/read-only modes; Codex/DeepSeek use workspace-write with approvalPolicy=never. These controls do not substitute for OS sandboxing or a physical interlock.</p>
        </section>
      </div>

      <section className="rounded-xl border border-white/10 bg-black/20 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Structured event timeline <span className="text-xs font-normal text-stone-500">({events.length}/300)</span></h3>
          <button type="button" onClick={() => setEvents([])} className="text-xs text-stone-400 underline">Clear timeline</button>
        </div>
        <div role="log" aria-label="Agent event timeline" className="mt-3 max-h-80 space-y-2 overflow-y-auto font-mono text-xs">
          {!events.length && <p className="text-stone-500">No events received for this workspace.</p>}
          {events.map((event, idx) => (
            <div key={idx} className="rounded border border-white/5 bg-stone-950/60 p-2">
              <div className="mb-1 text-orange-300">{timeLabel(event.timestampMs)} · {event.method ?? event.eventType}</div>
              <pre className="whitespace-pre-wrap break-all text-stone-300">{describe(event)}</pre>
            </div>
          ))}
        </div>
      </section>
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
          <button type="button" disabled={!enabled || !resourceId.trim()} onClick={requestApproval}
            className="rounded border border-amber-400/30 px-3 py-2 text-xs">Request human acknowledgement</button>
        </div>
        {approvalMessage && <p role="status" className="mt-2 text-xs text-amber-300">{approvalMessage}</p>}
        <p className="mt-2 text-xs text-stone-500">No hardware provider is installed or bundled. Default decision: DENY.</p>
      </section>
    </div>
  );
}
