export type VerificationGateKind =
  | "build"
  | "unit"
  | "hil"
  | "hardware"
  | "soak"
  | "evidence";

export type VerificationApproval = "none" | "human";

export type VerificationExecutor =
  | {
      type: "process";
      program: string;
      args: string[];
      cwd: "workspace" | "repository";
      timeoutMs?: number | null;
    }
  | {
      type: "adapter";
      adapter: "hil" | "hardware";
      action: string;
      parameters?: Record<string, string | number | boolean>;
    };

export interface VerificationGate {
  id: string;
  label: string;
  kind: VerificationGateKind;
  required: boolean;
  approval: VerificationApproval;
  executor: VerificationExecutor;
}

export interface VerificationProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  gates: VerificationGate[];
}

export type EvidenceStatus = "pass" | "warn" | "fail" | "running" | "not_run" | "blocked" | "cancelled";

export interface EvidenceCheck {
  gateId: string;
  status: EvidenceStatus;
  detail: string;
  startedAtMs: number;
  finishedAtMs?: number | null;
  exitCode?: number | null;
}

export interface EvidenceArtifact {
  id: string;
  kind: "log" | "junit" | "trace" | "waveform" | "image" | "report" | "other";
  path: string;
  sha256?: string | null;
  sizeBytes?: number | null;
}

export interface EvidenceManifestMetadata {
  firmwareSha?: string | null;
  bitstreamSha?: string | null;
  dutId?: string | null;
  hardwareRevision?: string | null;
}

export interface EvidenceManifest {
  schemaVersion: 1;
  runId: string;
  profileId: string;
  workspaceRoot: string;
  repositoryHeadSha: string;
  startedAtMs: number;
  finishedAtMs?: number | null;
  status: EvidenceStatus;
  checks: EvidenceCheck[];
  artifacts: EvidenceArtifact[];
  metadata: EvidenceManifestMetadata;
}
