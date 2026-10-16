import type {
  CheckResult,
  ProcessProfileKind,
} from "@/types/workbench";

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
