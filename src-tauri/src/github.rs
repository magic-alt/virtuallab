use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Component, Path};
use std::process::{Command, Output, Stdio};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCapabilities {
    installed: bool,
    authenticated: bool,
    repository: Option<String>,
    mode: String,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheck {
    name: String,
    status: String,
    conclusion: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCheckSummary {
    total: usize,
    success: usize,
    pending: usize,
    failure: usize,
    neutral: usize,
    checks: Vec<GithubCheck>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubChangedFile {
    path: String,
    additions: i64,
    deletions: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequest {
    number: u64,
    title: String,
    state: String,
    url: String,
    base_ref: String,
    head_ref: String,
    head_sha: String,
    is_draft: bool,
    author: Option<String>,
    changed_files: Vec<GithubChangedFile>,
    checks: GithubCheckSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssue {
    number: u64,
    title: String,
    state: String,
    url: String,
    author: Option<String>,
    labels: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubContext {
    capabilities: GithubCapabilities,
    reference: Option<String>,
    pull_request: Option<GithubPullRequest>,
    issue: Option<GithubIssue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubContextRequest {
    workspace_root: String,
    reference: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPostReviewCommentRequest {
    workspace_root: String,
    repository: String,
    pr_number: u64,
    commit_id: String,
    path: String,
    line: u32,
    side: String,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPostReviewCommentResponse {
    id: u64,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GithubReference {
    CurrentPr,
    PullRequest(u64),
    Issue(u64),
    Number(u64),
}

#[tauri::command]
pub async fn github_capabilities(workspace_root: String) -> Result<GithubCapabilities, String> {
    tauri::async_runtime::spawn_blocking(move || github_capabilities_blocking(&workspace_root))
        .await
        .map_err(|error| format!("GitHub capability task failed: {error}"))
}

#[tauri::command]
pub async fn github_context(request: GithubContextRequest) -> Result<GithubContext, String> {
    tauri::async_runtime::spawn_blocking(move || github_context_blocking(request))
        .await
        .map_err(|error| format!("GitHub context task failed: {error}"))?
}

#[tauri::command]
pub async fn github_post_review_comment(
    request: GithubPostReviewCommentRequest,
) -> Result<GithubPostReviewCommentResponse, String> {
    tauri::async_runtime::spawn_blocking(move || github_post_review_comment_blocking(request))
        .await
        .map_err(|error| format!("GitHub comment task failed: {error}"))?
}

fn github_capabilities_blocking(workspace_root: &str) -> GithubCapabilities {
    let repository = repository_from_workspace(workspace_root).ok().flatten();

    let version_probe = Command::new("gh").arg("--version").output();
    let installed = version_probe.as_ref().is_ok_and(|output| output.status.success());
    if !installed {
        let detail = match version_probe {
            Err(error) => format!("GitHub CLI is unavailable: {error}"),
            Ok(output) => failure_detail(&output, "GitHub CLI version probe failed"),
        };
        return capability_from_probes(false, false, repository, detail);
    }

    if repository.is_none() {
        return capability_from_probes(
            true,
            false,
            None,
            "Origin is not a GitHub repository; local review remains available.".to_string(),
        );
    }

    let auth = Command::new("gh")
        .args(["auth", "status", "--hostname", "github.com"])
        .current_dir(workspace_root)
        .output();

    match auth {
        Ok(output) if output.status.success() => capability_from_probes(
            true,
            true,
            repository,
            "GitHub CLI is authenticated using the existing local gh session.".to_string(),
        ),
        Ok(output) => capability_from_probes(
            true,
            false,
            repository,
            failure_detail(
                &output,
                "GitHub CLI is installed but authentication is unavailable or offline",
            ),
        ),
        Err(error) => capability_from_probes(
            true,
            false,
            repository,
            format!("GitHub authentication probe failed: {error}"),
        ),
    }
}

fn capability_from_probes(
    installed: bool,
    authenticated: bool,
    repository: Option<String>,
    detail: String,
) -> GithubCapabilities {
    GithubCapabilities {
        installed,
        authenticated,
        repository,
        mode: if installed && authenticated {
            "connected".to_string()
        } else {
            "local_only".to_string()
        },
        detail,
    }
}

fn github_context_blocking(request: GithubContextRequest) -> Result<GithubContext, String> {
    let capabilities = github_capabilities_blocking(&request.workspace_root);
    let reference_text = request
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if capabilities.mode != "connected" {
        return Ok(GithubContext {
            capabilities,
            reference: reference_text,
            pull_request: None,
            issue: None,
        });
    }

    let repository = capabilities
        .repository
        .as_deref()
        .ok_or_else(|| "The workspace origin is not a GitHub repository".to_string())?;
    let parsed = parse_reference(reference_text.as_deref(), repository)?;

    let (pull_request, issue) = match parsed {
        GithubReference::CurrentPr => (
            Some(load_pull_request(
                &request.workspace_root,
                repository,
                None,
            )?),
            None,
        ),
        GithubReference::PullRequest(number) => (
            Some(load_pull_request(
                &request.workspace_root,
                repository,
                Some(number),
            )?),
            None,
        ),
        GithubReference::Issue(number) => (
            None,
            Some(load_issue(
                &request.workspace_root,
                repository,
                number,
            )?),
        ),
        GithubReference::Number(number) => match load_pull_request(
            &request.workspace_root,
            repository,
            Some(number),
        ) {
            Ok(pr) => (Some(pr), None),
            Err(pr_error) => match load_issue(&request.workspace_root, repository, number) {
                Ok(issue) => (None, Some(issue)),
                Err(issue_error) => {
                    return Err(format!(
                        "Could not resolve #{number} as a PR ({pr_error}) or issue ({issue_error})"
                    ))
                }
            },
        },
    };

    Ok(GithubContext {
        capabilities,
        reference: reference_text,
        pull_request,
        issue,
    })
}

fn github_post_review_comment_blocking(
    request: GithubPostReviewCommentRequest,
) -> Result<GithubPostReviewCommentResponse, String> {
    let body = request.body.trim();
    if body.is_empty() {
        return Err("Review comment body is empty".to_string());
    }
    if body.len() > 65_536 {
        return Err("Review comment body exceeds the 64 KiB safety limit".to_string());
    }
    if request.line == 0 {
        return Err("Review comment line must be greater than zero".to_string());
    }
    if request.side != "LEFT" && request.side != "RIGHT" {
        return Err("Review comment side must be LEFT or RIGHT".to_string());
    }
    validate_relative_path(&request.path)?;

    let capabilities = github_capabilities_blocking(&request.workspace_root);
    if capabilities.mode != "connected" {
        return Err(capabilities.detail);
    }
    let repository = capabilities
        .repository
        .as_deref()
        .ok_or_else(|| "Workspace origin is not a GitHub repository".to_string())?;
    if !repository.eq_ignore_ascii_case(request.repository.trim()) {
        return Err(format!(
            "GitHub review target {} does not match workspace origin {}",
            request.repository, repository
        ));
    }

    let payload = json!({
        "body": body,
        "commit_id": request.commit_id,
        "path": request.path,
        "line": request.line,
        "side": request.side,
    });
    let endpoint = format!(
        "repos/{}/pulls/{}/comments",
        repository, request.pr_number
    );

    let mut child = Command::new("gh")
        .args(["api", "--method", "POST", endpoint.as_str(), "--input", "-"])
        .current_dir(&request.workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to launch gh api: {error}"))?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open gh stdin".to_string())?;
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| format!("Failed to write review comment request: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Failed to wait for gh api: {error}"))?;
    if !output.status.success() {
        return Err(failure_detail(&output, "GitHub review comment request failed"));
    }

    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid GitHub review-comment response: {error}"))?;
    let id = value
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "GitHub response is missing comment id".to_string())?;
    let url = value
        .get("html_url")
        .and_then(Value::as_str)
        .ok_or_else(|| "GitHub response is missing comment URL".to_string())?
        .to_string();

    Ok(GithubPostReviewCommentResponse { id, url })
}

fn load_pull_request(
    workspace_root: &str,
    repository: &str,
    number: Option<u64>,
) -> Result<GithubPullRequest, String> {
    let mut args = vec!["pr".to_string(), "view".to_string()];
    if let Some(number) = number {
        args.push(number.to_string());
    }
    args.extend([
        "--repo".to_string(),
        repository.to_string(),
        "--json".to_string(),
        "number,title,state,url,baseRefName,headRefName,headRefOid,isDraft,author,files,statusCheckRollup"
            .to_string(),
    ]);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = run_gh_json(workspace_root, &refs)?;
    parse_pull_request(&value)
}

fn load_issue(
    workspace_root: &str,
    repository: &str,
    number: u64,
) -> Result<GithubIssue, String> {
    let number_text = number.to_string();
    let args = [
        "issue",
        "view",
        number_text.as_str(),
        "--repo",
        repository,
        "--json",
        "number,title,state,url,author,labels",
    ];
    let value = run_gh_json(workspace_root, &args)?;
    parse_issue(&value)
}

fn run_gh_json(workspace_root: &str, args: &[&str]) -> Result<Value, String> {
    let output = Command::new("gh")
        .args(args)
        .current_dir(workspace_root)
        .output()
        .map_err(|error| format!("Failed to launch gh: {error}"))?;
    if !output.status.success() {
        return Err(failure_detail(&output, "GitHub CLI request failed"));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("GitHub CLI returned invalid JSON: {error}"))
}

fn parse_pull_request(value: &Value) -> Result<GithubPullRequest, String> {
    let changed_files = value
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    Some(GithubChangedFile {
                        path: file.get("path")?.as_str()?.to_string(),
                        additions: file.get("additions").and_then(Value::as_i64).unwrap_or(0),
                        deletions: file.get("deletions").and_then(Value::as_i64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let checks = summarize_checks(
        value
            .get("statusCheckRollup")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );

    Ok(GithubPullRequest {
        number: required_u64(value, "number")?,
        title: required_string(value, "title")?,
        state: required_string(value, "state")?,
        url: required_string(value, "url")?,
        base_ref: required_string(value, "baseRefName")?,
        head_ref: required_string(value, "headRefName")?,
        head_sha: required_string(value, "headRefOid")?,
        is_draft: value.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        author: value
            .get("author")
            .and_then(|author| author.get("login"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        changed_files,
        checks,
    })
}

fn parse_issue(value: &Value) -> Result<GithubIssue, String> {
    let labels = value
        .get("labels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|label| label.get("name").and_then(Value::as_str))
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();

    Ok(GithubIssue {
        number: required_u64(value, "number")?,
        title: required_string(value, "title")?,
        state: required_string(value, "state")?,
        url: required_string(value, "url")?,
        author: value
            .get("author")
            .and_then(|author| author.get("login"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        labels,
    })
}

fn summarize_checks(items: &[Value]) -> GithubCheckSummary {
    let mut summary = GithubCheckSummary {
        total: 0,
        success: 0,
        pending: 0,
        failure: 0,
        neutral: 0,
        checks: Vec::new(),
    };

    for item in items {
        let name = item
            .get("name")
            .or_else(|| item.get("context"))
            .and_then(Value::as_str)
            .unwrap_or("check")
            .to_string();
        let status = item
            .get("status")
            .or_else(|| item.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_uppercase();
        let conclusion = item
            .get("conclusion")
            .and_then(Value::as_str)
            .map(|value| value.to_uppercase());
        let url = item
            .get("detailsUrl")
            .or_else(|| item.get("targetUrl"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        let classification = conclusion.as_deref().unwrap_or(status.as_str());
        match classification {
            "SUCCESS" => summary.success += 1,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" | "STALE" | "ERROR" => summary.failure += 1,
            "NEUTRAL" | "SKIPPED" => summary.neutral += 1,
            "IN_PROGRESS" | "QUEUED" | "PENDING" | "EXPECTED" | "REQUESTED"
            | "WAITING" => summary.pending += 1,
            _ if status == "SUCCESS" => summary.success += 1,
            _ if status == "FAILURE" || status == "ERROR" => summary.failure += 1,
            _ => summary.pending += 1,
        }

        summary.total += 1;
        summary.checks.push(GithubCheck {
            name,
            status,
            conclusion,
            url,
        });
    }

    summary
}

fn parse_reference(reference: Option<&str>, repository: &str) -> Result<GithubReference, String> {
    let Some(reference) = reference.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(GithubReference::CurrentPr);
    };

    if reference.starts_with("https://github.com/") || reference.starts_with("http://github.com/") {
        let rest = reference
            .split_once("github.com/")
            .map(|(_, rest)| rest)
            .ok_or_else(|| "Invalid GitHub URL".to_string())?;
        let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
        if parts.len() < 4 {
            return Err("GitHub URL must point to an issue or pull request".to_string());
        }
        let url_repository = format!("{}/{}", parts[0], parts[1]);
        if !url_repository.eq_ignore_ascii_case(repository) {
            return Err(format!(
                "GitHub URL targets {url_repository}, but this workspace is {repository}"
            ));
        }
        let number = parts[3]
            .parse::<u64>()
            .map_err(|_| "GitHub URL has an invalid issue/PR number".to_string())?;
        return match parts[2] {
            "pull" | "pulls" => Ok(GithubReference::PullRequest(number)),
            "issues" => Ok(GithubReference::Issue(number)),
            _ => Err("GitHub URL must contain /pull/<n> or /issues/<n>".to_string()),
        };
    }

    for prefix in ["pr:", "pull:"] {
        if let Some(number) = reference.strip_prefix(prefix) {
            return parse_number(number).map(GithubReference::PullRequest);
        }
    }
    if let Some(number) = reference.strip_prefix("issue:") {
        return parse_number(number).map(GithubReference::Issue);
    }
    if let Some(number) = reference.strip_prefix('#') {
        return parse_number(number).map(GithubReference::Number);
    }
    if reference.chars().all(|ch| ch.is_ascii_digit()) {
        return parse_number(reference).map(GithubReference::Number);
    }

    Err("Use a GitHub PR/issue URL, pr:<n>, issue:<n>, #<n>, or leave blank for the current PR".to_string())
}

fn parse_number(value: &str) -> Result<u64, String> {
    value
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("Invalid GitHub issue/PR number: {value}"))
}

fn repository_from_workspace(workspace_root: &str) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|error| format!("Failed to inspect Git origin: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let remote = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(parse_github_remote(&remote))
}

fn parse_github_remote(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = if let Some(value) = trimmed.strip_prefix("https://github.com/") {
        value
    } else if let Some(value) = trimmed.strip_prefix("http://github.com/") {
        value
    } else if let Some(value) = trimmed.strip_prefix("git@github.com:") {
        value
    } else if let Some(value) = trimmed.strip_prefix("ssh://git@github.com/") {
        value
    } else {
        return None;
    };

    let mut parts = path.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn validate_relative_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Review-comment path must stay inside the repository".to_string());
    }
    Ok(())
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("GitHub JSON is missing {key}"))
}

fn required_u64(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("GitHub JSON is missing {key}"))
}

fn failure_detail(output: &Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_and_ssh_github_remotes() {
        assert_eq!(
            parse_github_remote("https://github.com/magic-alt/virtuallab.git"),
            Some("magic-alt/virtuallab".to_string())
        );
        assert_eq!(
            parse_github_remote("git@github.com:magic-alt/virtuallab.git"),
            Some("magic-alt/virtuallab".to_string())
        );
        assert_eq!(parse_github_remote("https://example.com/a/b.git"), None);
    }

    #[test]
    fn parses_reference_urls_and_rejects_cross_repository_urls() {
        assert_eq!(
            parse_reference(
                Some("https://github.com/magic-alt/virtuallab/pull/7"),
                "magic-alt/virtuallab"
            )
            .unwrap(),
            GithubReference::PullRequest(7)
        );
        assert_eq!(
            parse_reference(Some("issue:4"), "magic-alt/virtuallab").unwrap(),
            GithubReference::Issue(4)
        );
        assert!(parse_reference(
            Some("https://github.com/other/project/issues/1"),
            "magic-alt/virtuallab"
        )
        .is_err());
    }

    #[test]
    fn summarizes_check_rollup_states() {
        let items = vec![
            json!({"name":"unit","status":"COMPLETED","conclusion":"SUCCESS"}),
            json!({"name":"build","status":"IN_PROGRESS","conclusion":null}),
            json!({"name":"lint","status":"COMPLETED","conclusion":"FAILURE"}),
            json!({"context":"optional","state":"SUCCESS"}),
        ];
        let summary = summarize_checks(&items);
        assert_eq!(summary.total, 4);
        assert_eq!(summary.success, 2);
        assert_eq!(summary.pending, 1);
        assert_eq!(summary.failure, 1);
    }

    #[test]
    fn parses_pr_and_issue_json_fixtures() {
        let pr = parse_pull_request(&json!({
            "number": 7,
            "title": "Review",
            "state": "OPEN",
            "url": "https://github.com/magic-alt/virtuallab/pull/7",
            "baseRefName": "main",
            "headRefName": "feat/review",
            "headRefOid": "abcdef",
            "isDraft": false,
            "author": {"login":"magic-alt"},
            "files": [{"path":"src/a.ts","additions":4,"deletions":2}],
            "statusCheckRollup": []
        }))
        .unwrap();
        assert_eq!(pr.number, 7);
        assert_eq!(pr.changed_files[0].path, "src/a.ts");

        let issue = parse_issue(&json!({
            "number": 4,
            "title": "V0.3",
            "state": "OPEN",
            "url": "https://github.com/magic-alt/virtuallab/issues/4",
            "author": {"login":"magic-alt"},
            "labels": [{"name":"enhancement"}]
        }))
        .unwrap();
        assert_eq!(issue.labels, vec!["enhancement"]);
    }

    #[test]
    fn offline_or_unauthenticated_probe_is_local_only() {
        let missing = capability_from_probes(
            false,
            false,
            Some("magic-alt/virtuallab".to_string()),
            "gh missing".to_string(),
        );
        assert_eq!(missing.mode, "local_only");
        assert!(!missing.authenticated);

        let offline = capability_from_probes(
            true,
            false,
            Some("magic-alt/virtuallab".to_string()),
            "network unavailable".to_string(),
        );
        assert_eq!(offline.mode, "local_only");
        assert_eq!(offline.detail, "network unavailable");
    }
}
