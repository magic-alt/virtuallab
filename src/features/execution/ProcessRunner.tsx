import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Hammer,
  Package,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Square,
  TestTube2,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  buildWorkflowCancel,
  buildWorkflowDiscover,
  buildWorkflowStart,
  confirmDeploymentWorkflow,
  listRuns,
  processSpawn,
  processStop,
} from "@/lib/backend";
import { formatStep, profileFromSuggestion, stepsForProfile, suggestionActionLabel } from "@/lib/buildProfiles";
import { BuildLogSanitizer } from "@/lib/buildLogSanitizer";
import { processCheckResult } from "@/lib/checks";
import { useWorkbenchStore } from "@/stores/workbench";
import type {
  BuildStep,
  BuildSuggestion,
  BuildWorkflowEvent,
  CheckResult,
  ProcessProfile,
  ProcessProfileKind,
  WorkbenchEvent,
} from "@/types/workbench";

const OUTPUT_FLUSH_MS = 40;
const OUTPUT_LIMIT = 180_000;

interface RunRecord {
  id: string;
  profileId: string;
  startedAt?: number;
  profileName: string;
  profileKind: ProcessProfileKind;
  isWorkflow: boolean;
  status: "running" | "stopping" | "passed" | "failed" | "stopped";
  stepName?: string;
  output: string;
  exitCode?: number | null;
  checkResult: CheckResult;
}

function nextId(prefix: string) {
  return globalThis.crypto?.randomUUID?.() ??
    prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function KindIcon({ kind }: { kind: ProcessProfileKind }) {
  if (kind === "package") return <Package size={15} />;
  if (kind === "deploy") return <Rocket size={15} />;
  if (kind === "test") return <TestTube2 size={15} />;
  return <Hammer size={15} />;
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
  const [suggestions, setSuggestions] = useState<BuildSuggestion[]>([]);
  const [discoveryPending, setDiscoveryPending] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [scanRevision, setScanRevision] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // undefined closes the editor, null opens a new empty profile.
  const [editorProfile, setEditorProfile] = useState<ProcessProfile | null | undefined>(undefined);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const pendingOutputRef = useRef(new Map<string, string>());
  const sanitizerRef = useRef(new Map<string, BuildLogSanitizer>());
  const outputFlushTimerRef = useRef<number | undefined>(undefined);
  const startingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    if (!enabled) {
      setSuggestions([]);
      setDiscoveryPending(false);
      setDiscoveryError(null);
      return;
    }
    setSuggestions([]);
    setDiscoveryPending(true);
    setDiscoveryError(null);
    void buildWorkflowDiscover(cwd)
      .then((items) => { if (!disposed) setSuggestions(items); })
      .catch((error) => { if (!disposed) setDiscoveryError(readableError(error)); })
      .finally(() => { if (!disposed) setDiscoveryPending(false); });
    return () => { disposed = true; };
  }, [cwd, enabled, scanRevision]);

  useEffect(() => {
    let unlistenProcess: UnlistenFn | undefined;
    let unlistenBuild: UnlistenFn | undefined;
    let disposed = false;

    const flushPendingOutput = () => {
      outputFlushTimerRef.current = undefined;
      if (pendingOutputRef.current.size === 0) return;
      const batch = new Map(pendingOutputRef.current);
      pendingOutputRef.current.clear();
      setRuns((items) =>
        items.map((run) => {
          const chunk = batch.get(run.id);
          return chunk ? { ...run, output: (run.output + chunk).slice(-OUTPUT_LIMIT) } : run;
        }),
      );
    };

    const queueOutput = (id: string, chunk: string, stream = "system") => {
      // Keep a distinct ANSI parser per process/stream so an escape sequence
      // split across native read() calls is not shown as junk in the log.
      const key = id + "\u0000" + stream;
      let sanitizer = sanitizerRef.current.get(key);
      if (!sanitizer) {
        sanitizer = new BuildLogSanitizer();
        sanitizerRef.current.set(key, sanitizer);
      }
      const text = sanitizer.write(chunk);
      if (!text) return;
      const current = pendingOutputRef.current.get(id) ?? "";
      pendingOutputRef.current.set(id, (current + text).slice(-OUTPUT_LIMIT));
      if (outputFlushTimerRef.current === undefined) {
        outputFlushTimerRef.current = window.setTimeout(flushPendingOutput, OUTPUT_FLUSH_MS);
      }
    };

    const finishOutput = (id: string, output: string) => {
      let trailing = "";
      for (const [key, sanitizer] of sanitizerRef.current) {
        if (key.startsWith(id + "\u0000")) {
          trailing += sanitizer.finish();
          sanitizerRef.current.delete(key);
        }
      }
      const pending = pendingOutputRef.current.get(id) ?? "";
      pendingOutputRef.current.delete(id);
      return (output + pending + trailing).slice(-OUTPUT_LIMIT);
    };

    void Promise.resolve(listen<WorkbenchEvent>("workbench://event", ({ payload }) => {
      if (!payload.eventType.startsWith("process.")) return;
      if (payload.eventType === "process.output" || payload.eventType === "process.error") {
        queueOutput(payload.id, payload.data ?? "", payload.stream ?? "system");
        return;
      }
      setRuns((items) =>
        items.map((run) => {
          if (run.id !== payload.id || run.isWorkflow) return run;
          const output = finishOutput(run.id, run.output);
          if (payload.eventType === "process.exited") {
            if ((run.status === "stopped" || run.status === "stopping")) return { ...run, status: "stopped", output, exitCode: payload.exitCode, checkResult: processCheckResult({ id: run.id, label: run.profileName, kind: run.profileKind, stopped: true, exitCode: payload.exitCode }) };
            const checkResult = processCheckResult({
              id: run.id, label: run.profileName, kind: run.profileKind,
              exitCode: payload.exitCode ?? -1, observedAtMs: payload.timestampMs,
            });
            return {
              ...run, output,
              status: checkResult.status === "pass" ? "passed" : "failed",
              exitCode: payload.exitCode, checkResult,
            };
          }
          if (payload.eventType === "process.stop_requested") {
            return {
              ...run, output, status: "stopping",
              checkResult: processCheckResult({
                id: run.id, label: run.profileName, kind: run.profileKind,
                exitCode: null, observedAtMs: payload.timestampMs,
              }),
            };
          }
          return { ...run, output };
        }),
      );
    })).then((fn) => {
      if (typeof fn !== "function") return;
      if (disposed) fn(); else unlistenProcess = fn;
    }).catch(() => undefined);

    void Promise.resolve(listen<BuildWorkflowEvent>("build://event", ({ payload }) => {
      if (payload.eventType === "build.output") {
        queueOutput(payload.id, payload.data ?? "", payload.stream ?? "system");
        return;
      }
      if (payload.eventType === "build.step_started") {
        queueOutput(payload.id, "\n[VirtualLab] Step " +
          String((payload.stepIndex ?? 0) + 1) + ": " + (payload.stepName ?? "Build") + "\n");
      }
      setRuns((items) =>
        items.map((run) => {
          if (!run.isWorkflow || run.id !== payload.id) return run;
          if (payload.eventType === "build.step_started") {
            return { ...run, stepName: payload.stepName ?? undefined };
          }
          if (payload.eventType !== "build.finished") return run;
          const stopped = payload.result === "stopped";
          const exitCode = stopped ? null : (payload.exitCode ?? -1);
          const checkResult = processCheckResult({
            id: run.id, label: run.profileName, kind: run.profileKind,
            exitCode, stopped, observedAtMs: payload.timestampMs,
          });
          return {
            ...run, output: finishOutput(run.id, run.output), exitCode,
            status: stopped ? "stopped" : exitCode === 0 ? "passed" : "failed",
            checkResult,
          };
        }),
      );
    })).then((fn) => {
      if (typeof fn !== "function") return;
      if (disposed) fn(); else unlistenBuild = fn;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      if (outputFlushTimerRef.current !== undefined) {
        window.clearTimeout(outputFlushTimerRef.current);
        outputFlushTimerRef.current = undefined;
      }
      pendingOutputRef.current.clear();
      sanitizerRef.current.clear();
      unlistenProcess?.();
      unlistenBuild?.();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const attach = async () => {
      const requestedAt = Date.now();
      try {
        const snapshots = await listRuns(cwd);
        if (disposed) return;
        setRuns((items) => [...snapshots.map((snapshot) => {
          const existing = items.find((item) => item.id === snapshot.id);
          const sanitizer = new BuildLogSanitizer();
          const output = sanitizer.write(snapshot.output) + sanitizer.finish();
          const label = existing?.profileName ?? snapshot.presentation?.profileName ?? snapshot.label;
          const kind = existing?.profileKind ?? snapshot.presentation?.profileKind ?? "build";
          return {
            id: snapshot.id, profileId: existing?.profileId ?? snapshot.presentation?.profileId ?? snapshot.id,
            profileName: label, profileKind: kind, isWorkflow: snapshot.isWorkflow,
            status: snapshot.status, stepName: snapshot.stepName ?? undefined,
            output, exitCode: snapshot.exitCode,
            checkResult: processCheckResult({ id: snapshot.id, label, kind,
              exitCode: snapshot.status === "running" || snapshot.status === "stopping" ? null : snapshot.exitCode,
              stopped: snapshot.status === "stopped" }),
          };
        }), ...items.filter((item) => !snapshots.some((snapshot) => snapshot.id === item.id)
          && (startingRef.current || item.status === "failed" || (item.startedAt ?? 0) >= requestedAt))]);
      } catch (error) {
        if (!disposed) setActionError(readableError(error));
      } finally {
        if (!disposed) timer = setTimeout(() => void attach(), 2000);
      }
    };
    void attach();
    return () => { disposed = true; clearTimeout(timer); };
  }, [cwd, enabled]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [runs, activeRunId]);

  const activeRun = useMemo(
    () => runs.find((item) => item.id === activeRunId) ?? runs.at(-1) ?? null,
    [activeRunId, runs],
  );
  const anyRunning = runs.some((run) => (run.status === "running" || run.status === "stopping"));

  const runProfile = async (profile: ProcessProfile) => {
    if (!enabled || startingRef.current || anyRunning) return;
    startingRef.current = true;
    setActionError(null);
    try {
      const steps = stepsForProfile(profile);
      if (steps.length === 0) throw new Error("Workflow has no steps.");
      if (profile.kind === "deploy") {
        const approved = await confirmDeploymentWorkflow(profile.name, steps);
        if (!approved) return;
      }
      const id = nextId("run");
      const isWorkflow = steps.length > 1;
      setRuns((items) => [
        ...items.slice(-19),
        {
          id,
          startedAt: Date.now(),
          profileId: profile.id,
          profileName: profile.name,
          profileKind: profile.kind,
          isWorkflow,
          status: "running",
          output: steps.map((step, i) =>
            (steps.length > 1 ? "[" + (i + 1) + "] " : "$ ") + formatStep(step),
          ).join("\n") + "\n",
          checkResult: processCheckResult({
            id, label: profile.name, kind: profile.kind, exitCode: null,
          }),
        },
      ]);
      setActiveRunId(id);
      try {
        if (isWorkflow) {
          await buildWorkflowStart({ id, cwd, steps, presentation: { profileId: profile.id, profileName: profile.name, profileKind: profile.kind } });
        } else {
          await processSpawn({ id, cwd, program: steps[0].program, args: steps[0].args, presentation: { profileId: profile.id, profileName: profile.name, profileKind: profile.kind } });
        }
      } catch (error) {
        setRuns((items) =>
          items.map((run) =>
            run.id === id
              ? {
                  ...run, status: "failed",
                  output: run.output + "\n[VirtualLab] " + readableError(error) + "\n",
                  checkResult: processCheckResult({
                    id: run.id, label: run.profileName, kind: run.profileKind, exitCode: -1,
                  }),
                }
              : run,
          ),
        );
      }
    } catch (error) {
      setActionError(readableError(error));
    } finally {
      startingRef.current = false;
    }
  };

  const stopRun = async (run: RunRecord) => {
    setRuns((items) => items.map((item) => item.id === run.id ? { ...item, status: "stopping" } : item));
    try {
      if (run.isWorkflow) await buildWorkflowCancel(run.id);
      else await processStop(run.id);
    } catch (error) {
      setActionError(readableError(error));
    }
  };

  return (
    <div className="mx-auto grid min-w-0 max-w-[1320px] grid-cols-1 gap-4 xl:grid-cols-[minmax(290px,380px)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <section className="overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d0b08]/95">
          <div className="flex items-start justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
            <div>
              <div className="text-sm font-medium text-slate-200">One-click project builds</div>
              <p className="mb-0 mt-1 text-[11px] text-slate-500">
                Recipes are detected from this worktree. Only explicitly selected builds run; no automatic flash or publish.
              </p>
            </div>
            <Button aria-label="Rescan build workflows" size="sm" variant="ghost"
              disabled={!enabled || discoveryPending}
              onClick={() => setScanRevision((revision) => revision + 1)}>
              <RefreshCw size={13} className={discoveryPending ? "animate-spin" : undefined} />
            </Button>
          </div>
          <div className="space-y-2 p-3">
            {discoveryPending && <div className="p-3 text-xs text-slate-500">Inspecting project files...</div>}
            {discoveryError && <div role="alert" className="p-3 text-xs text-rose-300">{discoveryError}</div>}
            {!discoveryPending && !discoveryError && suggestions.length === 0 && (
              <div className="rounded-lg border border-white/[0.05] p-3 text-xs text-slate-500">
                No preset detected. Add a custom workflow below for this project.
              </div>
            )}
            {suggestions.map((suggestion) => (
              <div key={suggestion.id} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                <div className="flex items-center gap-2">
                  <span className="text-orange-300"><KindIcon kind={suggestion.kind} /></span>
                  <div className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">
                    {suggestion.name}
                  </div>
                  <Badge tone="neutral">{suggestion.tool}</Badge>
                </div>
                <p className="mb-0 mt-2 text-[11px] leading-5 text-slate-500">{suggestion.description}</p>
                <div className="mono mt-2 break-all text-[10px] text-slate-600">
                  {suggestion.steps.map(formatStep).join(" → ")}
                </div>
                {!suggestion.supported && (
                  <div className="mt-2 text-[11px] text-amber-300">This preset requires a Windows host.</div>
                )}
                <div className="mt-3 flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={!enabled || anyRunning || !suggestion.supported}
                    onClick={() => void runProfile(profileFromSuggestion(suggestion, repositoryRoot))}
                    size="sm"
                  >
                    <Play size={11} />
                    {suggestionActionLabel(suggestion)}
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    onClick={() => setEditorProfile(profileFromSuggestion(suggestion, repositoryRoot))}
                    title="Save an editable repository-scoped copy"
                  >
                    <Pencil size={12} />
                    Customize
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0d0b08]/95">
          <div className="flex items-start justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Saved workflows</div>
              <div className="mt-1 text-[11px] text-slate-600">
                Repository-scoped Build, Test, Package and Deploy profiles.
              </div>
            </div>
            <Button onClick={() => setEditorProfile(null)} size="sm" variant="outline">
              <Plus size={13} /> Profile
            </Button>
          </div>
          <div className="space-y-2 p-3">
            {scopedProfiles.length === 0 && (
              <div className="border border-orange-300/25 bg-orange-950/20 p-4 text-xs leading-5 text-orange-100/80">
                <div className="font-semibold text-orange-100">No run profiles for this repository.</div>
                <div className="mt-1 text-orange-100/60">
                  Customize a detected preset or create a multi-step profile.
                  Deployment requires confirmation on every run.
                </div>
              </div>
            )}
            {scopedProfiles.map((profile) => {
              const runningRecord = [...runs].reverse().find(
                (run) => run.profileId === profile.id && (run.status === "running" || run.status === "stopping"),
              );
              const steps = stepsForProfile(profile);
              return (
                <div key={profile.id} className="rounded-xl border border-white/[0.06] bg-white/[0.022] p-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-400/10 text-orange-300">
                      <KindIcon kind={profile.kind} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-xs font-medium text-slate-200">{profile.name}</div>
                        <Badge tone={profile.kind === "deploy" ? "red" : profile.kind === "build" ? "orange" : "neutral"}>
                          {profile.kind}
                        </Badge>
                      </div>
                      <div className="mono mt-1.5 truncate text-[10px] text-slate-600"
                        title={steps.map(formatStep).join(" → ")}>
                        {steps.length > 1 ? steps.length + " steps · " : ""}
                        {steps.map(formatStep).join(" → ")}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    {runningRecord ? (
                      <Button className="flex-1" onClick={() => void stopRun(runningRecord)}
                        size="sm" variant="outline">
                        <Square size={11} /> Stop
                      </Button>
                    ) : (
                      <Button className="flex-1" disabled={!enabled || anyRunning}
                        onClick={() => void runProfile(profile)} size="sm">
                        <Play size={11} /> Run
                      </Button>
                    )}
                    <Button aria-label={"Edit " + profile.name} size="sm" variant="ghost"
                      onClick={() => setEditorProfile(profile)}>
                      <Pencil size={12} />
                    </Button>
                    <Button aria-label={"Remove " + profile.name} size="sm" variant="ghost"
                      disabled={Boolean(runningRecord)} onClick={() => removeProfile(profile.id)}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <section className="vl-editor-surface flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07]">
        <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2">
          <div className="text-xs font-medium text-slate-300">Build / package output</div>
          <div className="flex min-w-0 items-center gap-2">
            {runs.length > 1 && (
              <select aria-label="Run history" className="field max-w-40 py-1 text-xs"
                value={activeRunId ?? activeRun?.id ?? ""}
                onChange={(event) => setActiveRunId(event.target.value)}>
                {runs.map((run) => <option key={run.id} value={run.id}>{run.profileName}</option>)}
              </select>
            )}
            {activeRun && <RunStatus run={activeRun} />}
            {activeRun && (activeRun.status === "running" || activeRun.status === "stopping")
              && !scopedProfiles.some((profile) => profile.id === activeRun.profileId) && (
                <Button size="sm" variant="outline" onClick={() => void stopRun(activeRun)}>
                  <Square size={11} /> Stop active run
                </Button>
              )}
          </div>
        </div>
        {actionError && <div role="alert" className="border-b border-rose-400/15 px-4 py-2 text-xs text-rose-300">{actionError}</div>}
        {activeRun?.stepName && (activeRun.status === "running" || activeRun.status === "stopping") && (
          <div className="border-b border-white/[0.05] px-4 py-1.5 text-[11px] text-orange-300">
            Current step: {activeRun.stepName}
          </div>
        )}
        <pre className="mono scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-[11px] leading-5 text-slate-400"
          ref={outputRef}>
          {activeRun?.output ?? (enabled
            ? "Choose an auto-detected build or a saved workflow. Output, exit code and stop controls appear here."
            : "Process execution is available in the Tauri desktop runtime.")}
        </pre>
        <div className="mono truncate border-t border-white/[0.06] px-3 py-2 text-[10px] text-slate-600" title={cwd}>
          worktree cwd: {cwd}
        </div>
      </section>

      {editorProfile !== undefined && (
        <ProfileEditor
          key={editorProfile?.id ?? "new"}
          initial={editorProfile ?? undefined}
          repositoryRoot={repositoryRoot}
          onClose={() => setEditorProfile(undefined)}
          onSave={(profile) => {
            addProfile(profile);
            setEditorProfile(undefined);
          }}
        />
      )}
    </div>
  );
}

function RunStatus({ run }: { run: RunRecord }) {
  const tone =
    run.status === "passed" ? "green"
      : run.status === "failed" ? "red"
        : (run.status === "running" || run.status === "stopping") ? "orange" : "neutral";

  return (
    <Badge tone={tone}>
      {run.status}
      {run.exitCode !== undefined && run.exitCode !== null ? " · " + run.exitCode : ""}
    </Badge>
  );
}

interface StepDraft {
  name: string;
  program: string;
  argsText: string;
}

function newStep(): StepDraft {
  return { name: "Build", program: "", argsText: "" };
}

function ProfileEditor({
  repositoryRoot,
  initial,
  onClose,
  onSave,
}: {
  repositoryRoot: string;
  initial?: ProcessProfile;
  onClose: () => void;
  onSave: (profile: ProcessProfile) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<ProcessProfileKind>(initial?.kind ?? "build");
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    initial ? stepsForProfile(initial).map((entry) => ({
      name: entry.name,
      program: entry.program,
      argsText: entry.args.join("\n"),
    })) : [newStep()],
  );
  const valid = name.trim().length > 0 && steps.length > 0 &&
    steps.every((entry) => entry.name.trim() && entry.program.trim());

  const updateStep = (index: number, change: Partial<StepDraft>) =>
    setSteps((items) => items.map((item, i) => i === index ? { ...item, ...change } : item));

  const save = () => {
    if (!valid) return;
    const compiled: BuildStep[] = steps.map((entry) => ({
      name: entry.name.trim(),
      program: entry.program.trim(),
      args: entry.argsText.split("\n").map((arg) => arg.trim()).filter(Boolean),
    }));
    onSave({
      id: initial?.id ?? nextId("profile"),
      name: name.trim(), kind, repositoryRoot,
      program: compiled[0].program,
      args: compiled[0].args,
      steps: compiled.length > 1 ? compiled : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="vl-dialog my-auto max-h-[calc(100dvh-2rem)] w-full max-w-[620px] overflow-y-auto rounded-2xl border p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-base font-semibold text-slate-100">
              {initial ? "Edit run profile" : "New run profile"}
            </h2>
            <p className="mb-0 mt-1 text-xs text-slate-500">
              Steps execute sequentially. Every argument is a separate line, never a shell command.
            </p>
          </div>
          <button aria-label="Close profile editor" className="rounded-lg p-2 text-slate-600 hover:bg-white/[0.05]"
            onClick={onClose} type="button">
            <X size={15} />
          </button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)}
              placeholder="Firmware build" />
          </Field>
          <Field label="Kind">
            <select className="field" value={kind}
              onChange={(event) => setKind(event.target.value as ProcessProfileKind)}>
              <option value="build">Build</option>
              <option value="test">Test</option>
              <option value="package">Package</option>
              <option value="deploy">Deploy (confirm every run)</option>
            </select>
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Repository scope">
            <input className="field mono opacity-75" value={repositoryRoot} readOnly />
          </Field>
        </div>
        {kind === "deploy" && (
          <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">
            Deployment workflows are manually configured and require a native confirmation every time.
            Do not treat this as firmware or hardware authorization.
          </div>
        )}
        <div className="mt-4 space-y-3">
          {steps.map((entry, index) => (
            <div key={index} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">Step {index + 1}</span>
                {steps.length > 1 && (
                  <Button size="sm" variant="ghost" aria-label={"Remove step " + (index + 1)}
                    onClick={() => setSteps((items) => items.filter((_, i) => i !== index))}>
                    <Trash2 size={12} />
                  </Button>
                )}
              </div>
              <Field label={index === 0 ? "Step name" : "Step name · " + (index + 1)}>
                <input className="field" value={entry.name}
                  onChange={(event) => updateStep(index, { name: event.target.value })} />
              </Field>
              <div className="mt-3">
                <Field label={index === 0 ? "Program" : "Program · step " + (index + 1)}>
                  <input className="field" value={entry.program}
                    onChange={(event) => updateStep(index, { program: event.target.value })}
                    placeholder="cmake / npm / UV4.exe" />
                </Field>
              </div>
              <div className="mt-3">
                <Field label={index === 0 ? "Arguments · one argument per line" : "Arguments · step " + (index + 1)}>
                  <textarea className="field min-h-24 resize-y py-2" value={entry.argsText}
                    onChange={(event) => updateStep(index, { argsText: event.target.value })}
                    placeholder={"--build\nbuild\n--config\nRelease"} />
                </Field>
              </div>
            </div>
          ))}
        </div>
        <Button className="mt-3" size="sm" variant="outline"
          disabled={steps.length >= 12}
          onClick={() => setSteps((items) => [...items, { ...newStep(), name: "Step " + (items.length + 1) }])}>
          <Plus size={12} /> Add step
        </Button>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button disabled={!valid} onClick={save}>Save profile</Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
