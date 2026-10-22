//! Shared JSON contract; runtime can update fields, validation owns literals.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskRecord {
    pub(crate) id: String,
    pub(crate) repository_root: String,
    pub(crate) title: String,
    pub(crate) goal: String,
    pub(crate) scope: Vec<String>,
    pub(crate) base_sha: String,
    pub(crate) kind: String,
    pub(crate) dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) context_repositories: Vec<crate::workspace_context::ContextRepository>,
    pub(crate) profile: Option<Value>,
    pub(crate) auto_commit: bool,
    pub(crate) revision: u64,
    pub(crate) workspace_root: Option<String>,
    pub(crate) attempts: Vec<TaskAttempt>,
    pub(crate) review: Option<TaskReview>,
    pub(crate) acceptance: Option<TaskAcceptance>,
    pub(crate) created_at_ms: u64,
    pub(crate) updated_at_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskAttempt {
    pub(crate) id: String,
    pub(crate) state: String,
    pub(crate) phase: String,
    #[serde(default)]
    pub(crate) execution: Option<Value>,
    pub(crate) candidate_sha: Option<String>,
    pub(crate) failure: Option<String>,
    pub(crate) started_at_ms: u64,
    pub(crate) ended_at_ms: Option<u64>,
    pub(crate) evidence: Option<TaskEvidence>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskEvidence {
    pub(crate) run_id: String,
    pub(crate) head_sha: String,
    pub(crate) profile_digest: String,
    pub(crate) input_digest: String,
    pub(crate) toolchain_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) manifest_digest: Option<String>,
    pub(crate) status: String,
    pub(crate) checks: Vec<Value>,
    pub(crate) artifacts: Vec<Value>,
    pub(crate) observed_at_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskReview {
    pub(crate) head_sha: String,
    pub(crate) input_digest: String,
    pub(crate) profile_digest: String,
    #[serde(default)]
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) toolchain_digest: Option<String>,
    pub(crate) approved: bool,
    pub(crate) note: String,
    pub(crate) created_at_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskAcceptance {
    pub(crate) head_sha: String,
    pub(crate) input_digest: String,
    pub(crate) profile_digest: String,
    #[serde(default)]
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) toolchain_digest: Option<String>,
    pub(crate) accepted_at_ms: u64,
    pub(crate) acknowledged_warnings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TaskDecision {
    Review {
        task_id: String,
        record: TaskReview,
    },
    Acceptance {
        task_id: String,
        record: TaskAcceptance,
    },
}
impl TaskDecision {
    pub(super) fn task_id(&self) -> &str {
        match self {
            Self::Review { task_id, .. } | Self::Acceptance { task_id, .. } => task_id,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskDraft {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) goal: String,
    pub(crate) scope: Vec<String>,
    pub(crate) kind: String,
    pub(crate) dependency_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) context_repositories: Vec<crate::workspace_context::ContextRepository>,
    pub(crate) profile: Option<Value>,
    pub(crate) auto_commit: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskPlanRequest {
    pub(crate) repository_root: String,
    pub(crate) expected_head_sha: String,
    pub(crate) tasks: Vec<TaskDraft>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskEvent {
    pub(crate) schema_version: u32,
    pub(crate) event_id: String,
    pub(crate) seq: u64,
    pub(crate) task_id: String,
    pub(crate) attempt_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) timestamp_ms: u64,
}
