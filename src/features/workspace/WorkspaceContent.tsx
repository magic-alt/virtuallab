import {
  Activity,
  CheckCircle2,
  CircleDot,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  History,
  ListChecks,
  MonitorDot,
  PlayCircle,
  TerminalSquare,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ProcessRunner } from "@/features/execution/ProcessRunner";
import { TerminalWorkspace } from "@/features/terminal/TerminalWorkspace";
import { isDesktopRuntime } from "@/lib/backend";
import { repositoryCheckResults } from "@/lib/checks";
import { cn, compactPath, formatCommitTime } from "@/lib/utils";
import type {
  RepositorySnapshot,
  WorkspaceTab,
} from "@/types/workbench";

interface Props {
  snapshot: RepositorySnapshot;
  profileRepositoryRoot: string;
  tab: WorkspaceTab;
  isPreview: boolean;
  onTabChange: (tab: WorkspaceTab) => void;
}

const tabs: Array<{
  id: WorkspaceTab;
  label: string;
  icon: React.ReactNode;
  counter?: (snapshot: RepositorySnapshot) => number | null;
}> = [
  { id: "overview", label: "Overview", icon: <Activity size={14} /> },
  {
    id: "changes",
    label: "Changes",
    icon: <FileCode2 size={14} />,
    counter: (snapshot) => snapshot.dirtyCount || null,
  },
  { id: "terminal", label: "Terminal", icon: <TerminalSquare size={14} /> },
  { id: "run", label: "Run", icon: <PlayCircle size={14} /> },
  { id: "checks", label: "Checks", icon: <ListChecks size={14} /> },
  { id: "history", label: "History", icon: <History size={14} /> },
];

export function WorkspaceContent({
  snapshot,
  profileRepositoryRoot,
  tab,
  isPreview,
  onTabChange,
}: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="vl-tabs flex h-11 shrink-0 items-end gap-1 border-b px-5">
        {tabs.map((item) => {
          const active = item.id === tab;
          const counter = item.counter?.(snapshot) ?? null;
          return (
            <button
              key={item.id}
              className={cn(
                "relative flex h-10 items-center gap-2 px-3 text-xs font-medium transition",
                active ? "text-slate-100" : "text-slate-500 hover:text-slate-300",
              )}
              onClick={() => onTabChange(item.id)}
              type="button"
            >
              {item.icon}
              {item.label}
              {counter !== null && (
                <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[10px] text-slate-400">
                  {counter}
                </span>
              )}
              {active && (
                <span className="absolute inset-x-2 bottom-0 h-px bg-orange-400 shadow-[0_0_18px_rgba(251,146,60,0.78)]" />
              )}
            </button>
          );
        })}
      </nav>

      <main className="vl-main surface-grid scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
        {tab === "overview" && <Overview snapshot={snapshot} isPreview={isPreview} />}
        {tab === "changes" && <Changes snapshot={snapshot} />}
        {tab === "terminal" && (
          <TerminalWorkspace cwd={snapshot.root} enabled={!isPreview && isDesktopRuntime()} />
        )}
        {tab === "run" && (
          <ProcessRunner
            cwd={snapshot.root}
            repositoryRoot={profileRepositoryRoot}
            enabled={!isPreview && isDesktopRuntime()}
          />
        )}
        {tab === "checks" && <Checks snapshot={snapshot} isPreview={isPreview} />}
        {tab === "history" && <HistoryView snapshot={snapshot} />}
      </main>
    </div>
  );
}

function Overview({
  snapshot,
  isPreview,
}: {
  snapshot: RepositorySnapshot;
  isPreview: boolean;
}) {
  const clean = snapshot.dirtyCount === 0;

  return (
    <div className="mx-auto max-w-[1320px] space-y-5">
      <div className="grid grid-cols-4 gap-3">
        <Metric
          label="Working tree"
          value={clean ? "Clean" : `${snapshot.dirtyCount} changes`}
          detail={clean ? "No local modifications" : `${snapshot.stagedCount} staged · ${snapshot.untrackedCount} untracked`}
          tone={clean ? "green" : "amber"}
        />
        <Metric
          label="Active branch"
          value={snapshot.currentBranch}
          detail={`HEAD ${snapshot.headSha}`}
          mono
        />
        <Metric
          label="Worktrees"
          value={String(snapshot.worktrees.length)}
          detail="Parallel workspace lanes"
        />
        <Metric
          label="Runtime"
          value={isPreview ? "Preview" : "Native"}
          detail={isPreview ? "Connect a local repository" : "Tauri + local Git"}
          tone={isPreview ? "amber" : "green"}
        />
      </div>

      <div className="grid grid-cols-[1.15fr_0.85fr] gap-4">
        <Panel
          title="Workspace topology"
          subtitle="Git worktrees are the substrate for isolated engineering lanes."
          icon={<Workflow size={16} />}
        >
          <div className="space-y-2">
            {snapshot.worktrees.map((worktree, index) => (
              <div
                key={`${worktree.path}-${index}`}
                className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-3"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-[#120d09] text-orange-300">
                  <GitBranch size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-200">
                    {worktree.branch ?? (worktree.detached ? "Detached HEAD" : "Workspace")}
                  </div>
                  <div className="mono mt-1 truncate text-[10px] text-slate-600" title={worktree.path}>
                    {compactPath(worktree.path, 74)}
                  </div>
                </div>
                <Badge tone={index === 0 ? "orange" : "neutral"}>
                  {index === 0 ? "primary" : "isolated"}
                </Badge>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Recent activity"
          subtitle="Latest repository commits."
          icon={<GitCommitHorizontal size={16} />}
        >
          <div className="relative space-y-1">
            <div className="absolute bottom-3 left-[7px] top-3 w-px bg-white/[0.07]" />
            {snapshot.recentCommits.slice(0, 6).map((commit) => (
              <div key={commit.sha} className="relative flex gap-3 py-2">
                <span className="mt-1.5 size-[15px] shrink-0 rounded-full border-[4px] border-[#15100c] bg-slate-600" />
                <div className="min-w-0">
                  <div className="truncate text-xs text-slate-300">{commit.subject}</div>
                  <div className="mono mt-1 text-[10px] text-slate-600">
                    {commit.sha} · {formatCommitTime(commit.timestamp)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel
        title="Control plane"
        subtitle="V0.2 separates interactive PTY, structured processes and reversible worktree mutation behind typed native commands."
        icon={<MonitorDot size={16} />}
      >
        <div className="grid grid-cols-3 gap-3">
          <CapabilityCard
            icon={<CheckCircle2 size={16} />}
            title="Repository inventory"
            description="Native Git status, branch, worktree and recent commit inspection."
            state="available"
          />
          <CapabilityCard
            icon={<CheckCircle2 size={16} />}
            title="Workspace execution"
            description="Embedded PTY, process profiles, worktree lanes and filesystem refresh are active."
            state="available"
          />
          <CapabilityCard
            icon={<CircleDot size={16} />}
            title="Agent harness"
            description="Claude/Codex attach to a workspace later; they do not own it."
            state="planned"
          />
        </div>
      </Panel>
    </div>
  );
}

function Changes({ snapshot }: { snapshot: RepositorySnapshot }) {
  return (
    <div className="mx-auto max-w-[1120px]">
      <Panel
        title="Local changes"
        subtitle="Read-only Git porcelain view. Staging and review actions arrive after the workspace write boundary is defined."
        icon={<FileCode2 size={16} />}
      >
        {snapshot.changes.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={19} />}
            title="Working tree is clean"
            text="There are no local modifications in this repository."
          />
        ) : (
          <div className="divide-y divide-white/[0.055]">
            {snapshot.changes.map((change, index) => (
              <div
                key={`${change.path}-${index}`}
                className="flex items-center gap-3 py-3"
              >
                <ChangeMark kind={change.kind} />
                <div className="mono min-w-0 flex-1 truncate text-xs text-slate-300" title={change.path}>
                  {change.path}
                </div>
                <div className="mono flex items-center gap-1.5 text-[10px] text-slate-600">
                  <span className="rounded border border-white/[0.07] bg-white/[0.025] px-1.5 py-1">
                    I:{change.indexStatus === " " ? "·" : change.indexStatus}
                  </span>
                  <span className="rounded border border-white/[0.07] bg-white/[0.025] px-1.5 py-1">
                    W:{change.worktreeStatus === " " ? "·" : change.worktreeStatus}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Checks({
  snapshot,
  isPreview,
}: {
  snapshot: RepositorySnapshot;
  isPreview: boolean;
}) {
  const checks = repositoryCheckResults(snapshot, isPreview);

  return (
    <div className="mx-auto max-w-[980px]">
      <Panel
        title="Local readiness checks"
        subtitle="Normalized V0.2 check results; durable evidence and release gates arrive in V0.4."
        icon={<ListChecks size={16} />}
      >
        <div className="space-y-2">
          {checks.map((check) => {
            const passing = check.status === "pass";
            const warning = check.status === "warn";
            const failing = check.status === "fail";

            return (
              <div
                key={check.id}
                className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3"
              >
                <div
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-lg",
                    passing
                      ? "bg-emerald-400/10 text-emerald-300"
                      : warning
                        ? "bg-amber-400/10 text-amber-300"
                        : failing
                          ? "bg-rose-400/10 text-rose-300"
                          : "bg-white/[0.04] text-slate-600",
                  )}
                >
                  {passing ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-slate-200">{check.label}</div>
                    <Badge
                      tone={
                        passing
                          ? "green"
                          : warning
                            ? "orange"
                            : failing
                              ? "red"
                              : "neutral"
                      }
                    >
                      {check.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-slate-600" title={check.detail}>
                    {check.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function HistoryView({ snapshot }: { snapshot: RepositorySnapshot }) {
  return (
    <div className="mx-auto max-w-[980px]">
      <Panel
        title="Recent commits"
        subtitle="Repository-local commit history."
        icon={<History size={16} />}
      >
        <div className="divide-y divide-white/[0.055]">
          {snapshot.recentCommits.map((commit) => (
            <div key={commit.sha} className="flex items-center gap-4 py-3">
              <div className="mono w-20 shrink-0 text-[11px] text-orange-300">{commit.sha}</div>
              <div className="min-w-0 flex-1 truncate text-xs text-slate-300">{commit.subject}</div>
              <div className="shrink-0 text-[10px] text-slate-600">
                {formatCommitTime(commit.timestamp)}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  mono,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  mono?: boolean;
  tone?: "neutral" | "green" | "amber";
}) {
  return (
    <div className="soft-shadow rounded-2xl border border-white/[0.07] bg-[#15100c]/92 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-slate-600">
        {label}
      </div>
      <div
        className={cn(
          "mt-3 truncate text-lg font-semibold tracking-[-0.02em]",
          mono && "mono text-[14px]",
          tone === "green"
            ? "text-emerald-300"
            : tone === "amber"
              ? "text-amber-300"
              : "text-slate-100",
        )}
        title={value}
      >
        {value}
      </div>
      <div className="mt-1.5 truncate text-[10px] text-slate-600" title={detail}>
        {detail}
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="soft-shadow rounded-2xl border border-white/[0.07] bg-[#15100c]/92">
      <div className="flex items-start gap-3 border-b border-white/[0.06] px-4 py-3.5">
        <div className="mt-0.5 text-slate-500">{icon}</div>
        <div>
          <div className="text-sm font-medium text-slate-200">{title}</div>
          <div className="mt-1 text-[11px] text-slate-600">{subtitle}</div>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function CapabilityCard({
  icon,
  title,
  description,
  state,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  state: "available" | "next" | "planned";
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.022] p-3.5">
      <div className="flex items-center justify-between">
        <span className={state === "available" ? "text-emerald-300" : "text-slate-600"}>
          {icon}
        </span>
        <Badge tone={state === "available" ? "green" : state === "next" ? "orange" : "neutral"}>
          {state}
        </Badge>
      </div>
      <div className="mt-4 text-xs font-medium text-slate-200">{title}</div>
      <p className="mb-0 mt-2 text-[11px] leading-5 text-slate-600">{description}</p>
    </div>
  );
}

function ChangeMark({ kind }: { kind: string }) {
  const map: Record<string, { text: string; classes: string }> = {
    added: { text: "A", classes: "bg-emerald-400/10 text-emerald-300 border-emerald-400/15" },
    modified: { text: "M", classes: "bg-orange-400/10 text-orange-300 border-orange-400/15" },
    deleted: { text: "D", classes: "bg-rose-400/10 text-rose-300 border-rose-400/15" },
    renamed: { text: "R", classes: "bg-violet-400/10 text-violet-300 border-violet-400/15" },
    untracked: { text: "?", classes: "bg-amber-400/10 text-amber-300 border-amber-400/15" },
    conflicted: { text: "!", classes: "bg-rose-400/10 text-rose-300 border-rose-400/15" },
  };
  const item = map[kind] ?? {
    text: "·",
    classes: "bg-white/[0.04] text-slate-500 border-white/[0.07]",
  };

  return (
    <span
      className={cn(
        "mono flex size-7 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold",
        item.classes,
      )}
    >
      {item.text}
    </span>
  );
}

function EmptyState({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center text-center">
      <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300">
        {icon}
      </div>
      <div className="mt-3 text-sm font-medium text-slate-300">{title}</div>
      <div className="mt-1 text-xs text-slate-600">{text}</div>
    </div>
  );
}
