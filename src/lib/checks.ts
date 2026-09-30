import type {
  CheckResult,
  ProcessProfileKind,
  RepositorySnapshot,
} from "@/types/workbench";

export function repositoryCheckResults(
  snapshot: RepositorySnapshot,
  isPreview: boolean,
  observedAtMs = Date.now(),
): CheckResult[] {
  return [
    {
      id: "repository-recognized",
      label: "Repository recognized",
      detail: isPreview
        ? "No native repository is attached in web preview."
        : "Git rev-parse resolved a repository root.",
      status: isPreview ? "not_run" : "pass",
      source: "repository",
      observedAtMs,
    },
    {
      id: "worktree-inventory",
      label: "Worktree inventory",
      detail: String(snapshot.worktrees.length) + " workspace lane(s) detected.",
      status: isPreview
        ? "not_run"
        : snapshot.worktrees.length > 0
          ? "pass"
          : "fail",
      source: "repository",
      observedAtMs,
    },
    {
      id: "origin-remote",
      label: "Origin remote",
      detail: snapshot.remoteUrl ?? "No origin remote configured.",
      status: isPreview
        ? "not_run"
        : snapshot.remoteUrl
          ? "pass"
          : "warn",
      source: "repository",
      observedAtMs,
    },
    {
      id: "working-tree",
      label: "Working tree",
      detail:
        snapshot.dirtyCount === 0
          ? "No local changes."
          : String(snapshot.dirtyCount) + " change(s) need review.",
      status: isPreview
        ? "not_run"
        : snapshot.dirtyCount === 0
          ? "pass"
          : "warn",
      source: "repository",
      observedAtMs,
    },
  ];
}

export function processCheckResult({
  id,
  label,
  kind,
  exitCode,
  stopped = false,
  observedAtMs = Date.now(),
}: {
  id: string;
  label: string;
  kind: ProcessProfileKind;
  exitCode: number | null | undefined;
  stopped?: boolean;
  observedAtMs?: number;
}): CheckResult {
  if (stopped) {
    return {
      id,
      label,
      detail: kind + " run stopped before completion.",
      status: "not_run",
      source: "process",
      observedAtMs,
      exitCode: exitCode ?? null,
    };
  }

  if (exitCode === undefined || exitCode === null) {
    return {
      id,
      label,
      detail: kind + " run is still active.",
      status: "running",
      source: "process",
      observedAtMs,
      exitCode: exitCode ?? null,
    };
  }

  return {
    id,
    label,
    detail:
      exitCode === 0
        ? kind + " run completed successfully."
        : kind + " run exited with code " + String(exitCode) + ".",
    status: exitCode === 0 ? "pass" : "fail",
    source: "process",
    observedAtMs,
    exitCode,
  };
}
