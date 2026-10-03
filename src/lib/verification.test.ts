import { describe, expect, it } from "vitest";
import type { VerificationProfile } from "@/types/verification";
import {
  addEvidenceArtifact,
  createEvidenceManifest,
  evidenceStatus,
  finalizeEvidenceManifest,
  upsertEvidenceCheck,
  validateVerificationProfile,
} from "./verification";

const PROFILE: VerificationProfile = {
  schemaVersion: 1,
  id: "desktop-baseline",
  name: "Desktop baseline",
  gates: [
    {
      id: "typecheck",
      label: "TypeScript typecheck",
      kind: "build",
      required: true,
      approval: "none",
      executor: {
        type: "process",
        program: "npm",
        args: ["run", "typecheck"],
        cwd: "workspace",
      },
    },
    {
      id: "hardware-smoke",
      label: "Hardware smoke",
      kind: "hardware",
      required: false,
      approval: "human",
      executor: {
        type: "adapter",
        adapter: "hardware",
        action: "smoke",
      },
    },
  ],
};

describe("verification profile and evidence manifest", () => {
  it("accepts structured process and adapter gates", () => {
    expect(validateVerificationProfile(PROFILE)).toBe(PROFILE);
  });

  it("rejects duplicate gate ids", () => {
    expect(() =>
      validateVerificationProfile({
        ...PROFILE,
        gates: [...PROFILE.gates, PROFILE.gates[0]],
      }),
    ).toThrow("Duplicate verification gate id 'typecheck'.");
  });

  it("keeps a run not-run until all required gates have evidence", () => {
    expect(evidenceStatus(PROFILE, [])).toBe("not_run");
  });

  it("builds and finalizes a manifest without treating optional hardware as required", () => {
    let manifest = createEvidenceManifest({
      runId: "run-1",
      profile: PROFILE,
      workspaceRoot: "D:/Project/virtuallab",
      repositoryHeadSha: "abc123",
      startedAtMs: 10,
    });
    manifest = upsertEvidenceCheck(manifest, {
      gateId: "typecheck",
      status: "pass",
      detail: "tsc completed",
      startedAtMs: 11,
      finishedAtMs: 12,
      exitCode: 0,
    });
    manifest = addEvidenceArtifact(manifest, {
      id: "typecheck-log",
      kind: "log",
      path: ".virtuallab/evidence/run-1/typecheck.log",
    });
    manifest = finalizeEvidenceManifest(manifest, PROFILE, 20);

    expect(manifest.status).toBe("pass");
    expect(manifest.finishedAtMs).toBe(20);
    expect(manifest.artifacts).toHaveLength(1);
  });

  it("downgrades optional gate failures to a warning instead of hiding them", () => {
    expect(
      evidenceStatus(PROFILE, [
        {
          gateId: "typecheck",
          status: "pass",
          detail: "tsc passed",
          startedAtMs: 1,
          finishedAtMs: 2,
          exitCode: 0,
        },
        {
          gateId: "hardware-smoke",
          status: "fail",
          detail: "bench unavailable",
          startedAtMs: 1,
          finishedAtMs: 2,
          exitCode: 1,
        },
      ]),
    ).toBe("warn");
  });

  it("rejects evidence for gates outside the selected profile", () => {
    expect(() =>
      evidenceStatus(PROFILE, [
        {
          gateId: "unknown",
          status: "pass",
          detail: "invalid evidence",
          startedAtMs: 1,
          finishedAtMs: 2,
          exitCode: 0,
        },
      ]),
    ).toThrow("unknown verification gate 'unknown'");
  });

  it("fails a run when a required gate fails", () => {
    expect(
      evidenceStatus(PROFILE, [
        {
          gateId: "typecheck",
          status: "fail",
          detail: "tsc failed",
          startedAtMs: 1,
          finishedAtMs: 2,
          exitCode: 2,
        },
      ]),
    ).toBe("fail");
  });
});
