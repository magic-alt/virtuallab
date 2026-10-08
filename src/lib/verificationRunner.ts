import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./backend";
import type { EvidenceManifest, VerificationProfile } from "@/types/verification";

export interface VerificationRunRequest {
  runId: string;
  workspaceRoot: string;
  profile: VerificationProfile;
}

export interface EvidenceArtifactImportRequest {
  workspaceRoot: string;
  runId: string;
  filePath: string;
  kind: "junit" | "trace" | "waveform" | "image" | "report" | "other";
}

function desktopOnly() {
  if (!isDesktopRuntime()) throw new Error("Verification requires the Tauri desktop runtime.");
}

export async function runVerification(request: VerificationRunRequest): Promise<EvidenceManifest> {
  desktopOnly();
  return invoke<EvidenceManifest>("verification_run", {request});
}

export async function cancelVerification(runId: string): Promise<void> {
  desktopOnly();
  await invoke("verification_cancel", {runId});
}

export async function importVerificationArtifact(request: EvidenceArtifactImportRequest): Promise<EvidenceManifest> {
  desktopOnly();
  return invoke<EvidenceManifest>("verification_import_artifact", {request});
}
