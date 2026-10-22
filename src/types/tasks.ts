import type { EvidenceArtifact, EvidenceCheck, EvidenceStatus, VerificationProfile } from './verification';
import type { ContextRepository } from './workspaceContext';

/** Task-specific controlled input/output declarations. Native validates qualification. */
export type TaskVerificationProfile = VerificationProfile & { outputPaths?: string[]; sourcePaths?: string[]; toolchainPrograms?: string[] };
export type TaskKind = 'implementation' | 'integration';
export type TaskAttemptState = 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskEvidence {
  manifestDigest?: string | null;
  runId: string; headSha: string; profileDigest: string; inputDigest: string; toolchainDigest: string;
  status: EvidenceStatus; checks: EvidenceCheck[]; artifacts: EvidenceArtifact[]; observedAtMs: number;
}
export interface TaskExecution {
  harness: string;
  executablePath: string | null;
  version: string | null;
  threadId: string | null;
  turnId: string | null;
}
export interface TaskAttempt {
  execution?: TaskExecution;
  id: string; state: TaskAttemptState; phase: 'implementation' | 'sealing' | 'integration' | 'verification' | 'review';
  candidateSha: string | null; failure: string | null; startedAtMs: number; endedAtMs: number | null; evidence: TaskEvidence | null;
}
export interface TaskReview {runId?: string | null; toolchainDigest?: string | null; headSha: string; inputDigest: string; profileDigest: string; approved: boolean; note: string; createdAtMs: number}
export interface TaskAcceptance {runId?: string | null; toolchainDigest?: string | null; headSha: string; inputDigest: string; profileDigest: string; acceptedAtMs: number; acknowledgedWarnings: boolean}
export interface TaskRecord {
  contextRepositories?: ContextRepository[];
  id: string; repositoryRoot: string; title: string; goal: string; scope: string[]; baseSha: string; kind: TaskKind;
  dependencies: string[]; profile: TaskVerificationProfile | null; autoCommit: boolean; revision: number; workspaceRoot: string | null;
  attempts: TaskAttempt[]; review: TaskReview | null; acceptance: TaskAcceptance | null; createdAtMs: number; updatedAtMs: number;
}
export interface TaskReadiness {
  status: 'ready' | 'warning' | 'blocked' | 'unverified'; blockers: string[]; warnings: string[];
  candidateSha: string | null; reviewCurrent: boolean; acceptanceCurrent: boolean;
}
export interface TaskDraft {key: string; title: string; goal: string; scope: string[]; kind: TaskKind; dependencyKeys: string[]; profile: TaskVerificationProfile | null; autoCommit: boolean; contextRepositories?: ContextRepository[]}
export interface TaskPlanRequest {repositoryRoot: string; expectedHeadSha: string; tasks: TaskDraft[]}
export interface TaskLaunchRequest {requestId: string; plan: TaskPlanRequest; executablePath: string | null}
export interface TaskLaunchResult {task: TaskRecord; launchError: string | null}
export interface TaskLaunchFailure {requestId: string; acceptance: 'rejected' | 'unknown'; message: string}
export interface TaskReportEntry {
  sequence: number; timestampMs: number;
  kind: 'assistant' | 'command' | 'fileChange' | 'status' | 'problem';
  text: string;
}
export interface TaskReportProblem {source: 'native' | 'provider' | 'verification'; message: string}
export interface TaskAttemptReport {
  schemaVersion: 1; taskId: string; attemptId: string; status: TaskAttemptState;
  summary: string | null; entries: TaskReportEntry[]; problems: TaskReportProblem[];
  truncated: boolean; updatedAtMs: number;
}
export interface TaskReportEvent {taskId: string; attemptId: string; sequence: number}
export interface TaskEvent {schemaVersion: 1; eventId: string; seq: number; taskId: string; attemptId: string | null; kind: string; timestampMs: number}
export interface IntegrationPreview {planId: string; taskId: string; repositoryRoot: string; workspaceRoot: string; targetHeadSha: string; sourceCommits: string[]; expiresAtMs: number}
export interface TaskWorkspaceRequest {taskId: string; branch: string; targetPath: string | null}
export interface TaskReviewRequest {taskId: string; expectedHeadSha: string; note: string; approved: boolean}
export interface TaskAcceptanceRequest {taskId: string; expectedHeadSha: string; acknowledgedWarnings: boolean}

export type TaskDetailTab = '概览'|'执行'|'变更与审查'|'证据'|'交付';
