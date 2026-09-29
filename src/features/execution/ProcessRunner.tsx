import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Hammer,
  Play,
  Plus,
  Square,
  TestTube2,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { processSpawn, processStop } from "@/lib/backend";
import { useWorkbenchStore } from "@/stores/workbench";
import type {
  ProcessProfile,
  ProcessProfileKind,
  WorkbenchEvent,
} from "@/types/workbench";

interface RunRecord {
  id: string;
  profileId: string;
  status: "running" | "passed" | "failed" | "stopped";
  output: string;
  exitCode?: number | null;
}

export function ProcessRunner({
  cwd,
  repositoryRoot,
  enabled,
}: {
  cwd: string;
  repositoryRoot: string;
  enabled: boolean;
}) {
  const { profiles, addProfile, removeProfile } = useWorkbenchStore();
  const scopedProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          normalizePath(profile.repositoryRoot) === normalizePath(repositoryRoot),
      ),
    [profiles, repositoryRoot],
  );
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const outputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    void Promise.resolve(listen<WorkbenchEvent>("workbench://event", ({ payload }) => {
      if (!payload.eventType.startsWith("process.")) return;

      setRuns((items) =>
        items.map((run) => {
          if (run.id !== payload.id) return run;

          if (payload.eventType === "process.output") {
            const prefix = payload.stream === "stderr" ? "[stderr] " : "";
            const output = (run.output + prefix + (payload.data ?? "")).slice(-180_000);
            return { ...run, output };
          }

          if (payload.eventType === "process.exited") {
            return {
              ...run,
              status: payload.exitCode === 0 ? "passed" : "failed",
              exitCode: payload.exitCode,
            };
          }

          if (payload.eventType === "process.stop_requested") {
            return { ...run, status: "stopped" };
          }

          return run;
        }),
      );
    })).then((fn) => {
      if (typeof fn !== "function") return;
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [runs, activeRunId]);

  const activeRun = useMemo(
    () => runs.find((item) => item.id === activeRunId) ?? runs.at(-1) ?? null,
    [activeRunId, runs],
  );

  const runProfile = async (profile: ProcessProfile) => {
    if (!enabled) return;
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setRuns((items) => [
      ...items,
      {
        id,
        profileId: profile.id,
        status: "running",
        output: `$ ${profile.program} ${profile.args.join(" ")}\n\n`,
      },
    ]);
    setActiveRunId(id);

    try {
      await processSpawn({
        id,
        cwd,
        program: profile.program,
        args: profile.args,
      });
    } catch (err) {
      setRuns((items) =>
        items.map((run) =>
          run.id === id
            ? {
                ...run,
                status: "failed",
                output:
                  run.output +
                  `\n[VirtualLab] ${err instanceof Error ? err.message : String(err)}\n`,
              }
            : run,
        ),
      );
    }
  };

  return (
    <div className="mx-auto grid max-w-[1320px] grid-cols-[360px_1fr] gap-4">
      <section className="overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d0b08]/95">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <div>
            <div className="text-sm font-medium text-slate-200">Build & test profiles</div>
            <div className="mt-1 text-[11px] text-slate-600">
              Structured program + argument execution; no implicit shell.
            </div>
          </div>
          <Button onClick={() => setShowEditor(true)} size="sm" variant="outline">
            <Plus size={13} />
            Profile
          </Button>
        </div>

        <div className="space-y-2 p-3">
          {scopedProfiles.length === 0 && (
            <div className="border border-orange-300/25 bg-orange-950/20 p-4 text-xs leading-5 text-orange-100/80">
              <div className="font-semibold text-orange-100">No run profiles for this repository.</div>
              <div className="mt-1 text-orange-100/60">
                Create a repository-scoped Build/Test profile. Profiles from another repository are never executed here.
              </div>
            </div>
          )}
          {scopedProfiles.map((profile) => {
            const running = runs.some(
              (run) => run.profileId === profile.id && run.status === "running",
            );
            const runningRecord = [...runs]
              .reverse()
              .find(
                (run) => run.profileId === profile.id && run.status === "running",
              );

            return (
              <div
                key={profile.id}
                className="rounded-xl border border-white/[0.06] bg-white/[0.022] p-3"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-400/10 text-orange-300">
                    {profile.kind === "build" ? <Hammer size={15} /> : <TestTube2 size={15} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-xs font-medium text-slate-200">
                        {profile.name}
                      </div>
                      <Badge tone={profile.kind === "build" ? "orange" : "neutral"}>
                        {profile.kind}
                      </Badge>
                    </div>
                    <div className="mono mt-1.5 truncate text-[10px] text-slate-600">
                      {profile.program} {profile.args.join(" ")}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  {running && runningRecord ? (
                    <Button
                      className="flex-1"
                      onClick={() => void processStop(runningRecord.id)}
                      size="sm"
                      variant="outline"
                    >
                      <Square size={11} />
                      Stop
                    </Button>
                  ) : (
                    <Button
                      className="flex-1"
                      disabled={!enabled}
                      onClick={() => void runProfile(profile)}
                      size="sm"
                    >
                      <Play size={11} />
                      Run
                    </Button>
                  )}
                  <Button
                    aria-label={`Remove ${profile.name}`}
                    onClick={() => removeProfile(profile.id)}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="vl-editor-surface flex min-h-[520px] flex-col overflow-hidden rounded-2xl border border-white/[0.07]">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
          <div className="text-xs font-medium text-slate-300">Process output</div>
          {activeRun && <RunStatus run={activeRun} />}
        </div>
        <pre
          className="mono scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-[11px] leading-5 text-slate-400"
          ref={outputRef}
        >
          {activeRun?.output ??
            (enabled
              ? "Select a build/test profile and press Run."
              : "Process execution is available in the Tauri desktop runtime.")}
        </pre>
        <div className="mono border-t border-white/[0.06] px-3 py-2 text-[10px] text-slate-600">
          cwd: {cwd}
        </div>
      </section>

      {showEditor && (
        <ProfileEditor
          repositoryRoot={repositoryRoot}
          onClose={() => setShowEditor(false)}
          onSave={(profile) => {
            addProfile(profile);
            setShowEditor(false);
          }}
        />
      )}
    </div>
  );
}

function RunStatus({ run }: { run: RunRecord }) {
  const tone =
    run.status === "passed"
      ? "green"
      : run.status === "failed"
        ? "red"
        : run.status === "running"
          ? "orange"
          : "neutral";

  return (
    <Badge tone={tone}>
      {run.status}
      {run.exitCode !== undefined && run.exitCode !== null ? ` · ${run.exitCode}` : ""}
    </Badge>
  );
}

function ProfileEditor({
  repositoryRoot,
  onClose,
  onSave,
}: {
  repositoryRoot: string;
  onClose: () => void;
  onSave: (profile: ProcessProfile) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProcessProfileKind>("build");
  const [program, setProgram] = useState("");
  const [args, setArgs] = useState("");

  const save = () => {
    if (!name.trim() || !program.trim()) return;
    onSave({
      id:
        globalThis.crypto?.randomUUID?.() ??
        `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: name.trim(),
      kind,
      repositoryRoot,
      program: program.trim(),
      args: args
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="vl-dialog w-[520px] rounded-2xl border p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="m-0 text-base font-semibold text-slate-100">New run profile</h2>
            <p className="mb-0 mt-1 text-xs text-slate-600">
              Arguments are stored separately from the executable.
            </p>
          </div>
          <button aria-label="Close profile editor" className="rounded-lg p-2 text-slate-600 hover:bg-white/[0.05]" onClick={onClose} type="button">
            <X size={15} />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Firmware build" />
          </Field>
          <Field label="Kind">
            <select className="field" value={kind} onChange={(event) => setKind(event.target.value as ProcessProfileKind)}>
              <option value="build">Build</option>
              <option value="test">Test</option>
            </select>
          </Field>
        </div>

        <div className="mt-3">
          <Field label="Repository scope">
            <input className="field mono opacity-75" value={repositoryRoot} readOnly />
          </Field>
        </div>

        <div className="mt-3">
          <Field label="Program">
            <input className="field" value={program} onChange={(event) => setProgram(event.target.value)} placeholder="cmake" />
          </Field>
        </div>

        <div className="mt-3">
          <Field label="Arguments · one argument per line">
            <textarea className="field min-h-28 resize-y py-2" value={args} onChange={(event) => setArgs(event.target.value)} placeholder={"--build\nbuild\n--config\nRelease"} />
          </Field>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button disabled={!name.trim() || !program.trim()} onClick={save}>Save profile</Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}


function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
