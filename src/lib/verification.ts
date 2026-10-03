import type {
  EvidenceArtifact,
  EvidenceCheck,
  EvidenceManifest,
  EvidenceManifestMetadata,
  EvidenceStatus,
  VerificationGate,
  VerificationProfile,
} from "@/types/verification";

function nonEmpty(value: string) {
  return value.trim().length > 0;
}

function validateGate(gate: VerificationGate, index: number) {
  if (!nonEmpty(gate.id)) throw new Error(`Verification gate ${index} has an empty id.`);
  if (!nonEmpty(gate.label)) throw new Error(`Verification gate '${gate.id}' has an empty label.`);

  if (gate.executor.type === "process") {
    if (!nonEmpty(gate.executor.program)) {
      throw new Error(`Verification gate '${gate.id}' has an empty process program.`);
    }
    if (gate.executor.timeoutMs != null && gate.executor.timeoutMs <= 0) {
      throw new Error(`Verification gate '${gate.id}' timeout must be positive.`);
    }
  } else if (!nonEmpty(gate.executor.action)) {
    throw new Error(`Verification gate '${gate.id}' has an empty adapter action.`);
  }
}

export function validateVerificationProfile(profile: VerificationProfile) {
  if (profile.schemaVersion !== 1) {
    throw new Error(`Unsupported verification profile schema: ${profile.schemaVersion}.`);
  }
  if (!nonEmpty(profile.id)) throw new Error("Verification profile id must not be empty.");
  if (!nonEmpty(profile.name)) throw new Error("Verification profile name must not be empty.");
  if (profile.gates.length === 0) throw new Error("Verification profile must contain at least one gate.");

  const ids = new Set<string>();
  profile.gates.forEach((gate, index) => {
    validateGate(gate, index);
    if (ids.has(gate.id)) {
      throw new Error(`Duplicate verification gate id '${gate.id}'.`);
    }
    ids.add(gate.id);
  });
  return profile;
}

export function createEvidenceManifest({
  runId,
  profile,
  workspaceRoot,
  repositoryHeadSha,
  startedAtMs = Date.now(),
  metadata = {},
}: {
  runId: string;
  profile: VerificationProfile;
  workspaceRoot: string;
  repositoryHeadSha: string;
  startedAtMs?: number;
  metadata?: EvidenceManifestMetadata;
}): EvidenceManifest {
  validateVerificationProfile(profile);
  if (!nonEmpty(runId)) throw new Error("Evidence run id must not be empty.");
  if (!nonEmpty(workspaceRoot)) throw new Error("Evidence workspace root must not be empty.");
  if (!nonEmpty(repositoryHeadSha)) throw new Error("Evidence repository HEAD must not be empty.");

  return {
    schemaVersion: 1,
    runId,
    profileId: profile.id,
    workspaceRoot,
    repositoryHeadSha,
    startedAtMs,
    finishedAtMs: null,
    status: "not_run",
    checks: [],
    artifacts: [],
    metadata,
  };
}

export function upsertEvidenceCheck(
  manifest: EvidenceManifest,
  check: EvidenceCheck,
): EvidenceManifest {
  return {
    ...manifest,
    status: check.status === "fail" ? "fail" : manifest.status,
    checks: [...manifest.checks.filter((item) => item.gateId !== check.gateId), check],
  };
}

export function addEvidenceArtifact(
  manifest: EvidenceManifest,
  artifact: EvidenceArtifact,
): EvidenceManifest {
  if (!nonEmpty(artifact.id) || !nonEmpty(artifact.path)) {
    throw new Error("Evidence artifacts require non-empty id and path.");
  }
  return {
    ...manifest,
    artifacts: [
      ...manifest.artifacts.filter((item) => item.id !== artifact.id),
      artifact,
    ],
  };
}

export function evidenceStatus(
  profile: VerificationProfile,
  checks: EvidenceCheck[],
): EvidenceStatus {
  validateVerificationProfile(profile);
  const byGate = new Map(checks.map((check) => [check.gateId, check]));
  const required = profile.gates.filter((gate) => gate.required);

  if (required.some((gate) => byGate.get(gate.id)?.status === "fail")) return "fail";
  if (required.some((gate) => byGate.get(gate.id)?.status === "running")) return "running";
  if (required.some((gate) => !byGate.has(gate.id) || byGate.get(gate.id)?.status === "not_run")) {
    return "not_run";
  }
  if (required.some((gate) => byGate.get(gate.id)?.status === "warn")) return "warn";
  return "pass";
}

export function finalizeEvidenceManifest(
  manifest: EvidenceManifest,
  profile: VerificationProfile,
  finishedAtMs = Date.now(),
): EvidenceManifest {
  if (manifest.profileId !== profile.id) {
    throw new Error(
      `Evidence manifest profile '${manifest.profileId}' does not match '${profile.id}'.`,
    );
  }
  return {
    ...manifest,
    finishedAtMs,
    status: evidenceStatus(profile, manifest.checks),
  };
}
