use super::*;
use crate::tasks::{new_id, TaskAttempt, TaskPlanRequest};
use std::fs;

fn git(root: &Path, args: &[&str]) -> String {
    let result = crate::process::background_command("git").args(args).current_dir(root).output().unwrap();
    assert!(result.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&result.stderr));
    String::from_utf8(result.stdout).unwrap().trim_end().into()
}

struct Fixture {
    directory: PathBuf,
    repository: PathBuf,
    worktree: PathBuf,
    manager: TaskManager,
    task: TaskRecord,
    remote_base: String,
    branch: String,
}
impl Fixture {
    fn new() -> Self { Self::configured(None, false) }
    fn configured(base: Option<&str>, inherited_outside_scope: bool) -> Self {
        let directory = std::env::temp_dir().join(format!("vl-pr-delivery-{}", new_id()));
        let repository = directory.join("仓库 with spaces");
        let worktree = directory.join("任务 worktree");
        fs::create_dir_all(repository.join("src")).unwrap();
        fs::create_dir_all(repository.join("docs")).unwrap();
        fs::write(repository.join("src/source.txt"), "original\n").unwrap();
        fs::write(repository.join("docs/readme.md"), "documentation\n").unwrap();
        git(&repository, &["init", "-q"]);
        git(&repository, &["config", "user.name", "Delivery fixture"]);
        git(&repository, &["config", "user.email", "delivery@invalid.example"]);
        git(&repository, &["add", "--", "src/source.txt", "docs/readme.md"]);
        git(&repository, &["commit", "-qm", "initial"]);
        git(&repository, &["branch", "-M", "trunk"]);
        git(&repository, &["remote", "add", "origin", "https://github.com/example-org/example-project.git"]);
        let remote_base = git(&repository, &["rev-parse", "HEAD"]);
        if inherited_outside_scope {
            fs::write(repository.join("docs/readme.md"), "unrelated inherited edit\n").unwrap();
            git(&repository, &["add", "--", "docs/readme.md"]);
            git(&repository, &["commit", "-qm", "unrelated feature work"]);
        }
        let base_sha = git(&repository, &["rev-parse", "HEAD"]);
        let manager = TaskManager::open(directory.join("state/tasks.json")).unwrap();
        let request: TaskPlanRequest = serde_json::from_value(json!({
            "repositoryRoot":repository,"expectedHeadSha":base_sha,
            "tasks":[{"key":"one","title":"A reviewable source change","goal":"Update the scoped source file.",
                "scope":["src/source.txt"],"kind":"implementation","dependencyKeys":[],"profile":null,
                "autoCommit":true,"autoDraftPr":true,"prBaseBranch":base}]
        })).unwrap();
        let task = manager.accept_plan(request).unwrap().remove(0);
        let branch = format!("task/reviewable-source-{}", task.id);
        git(&repository, &["worktree", "add", "-q", "-b", &branch, worktree.to_str().unwrap(), &base_sha]);
        fs::create_dir_all(manager.storage_dir().join("task-preparations")).unwrap();
        fs::write(manager.storage_dir().join("task-preparations").join(format!("{}.json", task.id)),
            serde_json::to_vec(&json!({"schemaVersion":1,"taskId":task.id,"repositoryRoot":task.repository_root,
                "baseSha":task.base_sha,"branch":branch,"targetPath":worktree,"createdAtMs":now_ms(),"failureObserved":false})).unwrap()).unwrap();
        fs::write(worktree.join("src/source.txt"), "approved candidate\n").unwrap();
        git(&worktree, &["add", "--", "src/source.txt"]);
        git(&worktree, &["commit", "-qm", "sealed candidate fixture"]);
        let candidate = git(&worktree, &["rev-parse", "HEAD"]);
        let task = manager.update(&task.id, |record| {
            record.workspace_root = Some(worktree.to_string_lossy().into_owned());
            record.attempts.push(TaskAttempt {
                id: new_id(), state: "succeeded".into(), phase: "review".into(), execution: None,
                candidate_sha: Some(candidate), failure: None, evidence: None,
                started_at_ms: now_ms(), ended_at_ms: Some(now_ms()),
            });
            Ok(())
        }).unwrap();
        Self { directory, repository, worktree, manager, task, remote_base, branch }
    }
    fn io(&self) -> FakeIo {
        FakeIo {
            base: self.task.pr_base_branch.clone().unwrap_or("trunk".into()), base_sha: self.remote_base.clone(),
            branch: self.branch.clone(), candidate: self.task.attempts.last().unwrap().candidate_sha.clone().unwrap(),
            remote_branch: None, prs: Vec::new(), push_count: 0, create_count: 0, commands: Vec::new(),
            request_body: None, deny_auth: false, fail_read_after_push: false,
            lose_create_response: false, hide_created_pr: false, cancel_after_push: false,
        }
    }
    fn deliver(&self, io: &mut FakeIo) -> TaskRecord {
        deliver_with(&self.manager, &self.task.id, io, &|_| Ok(()), &|| {}).unwrap()
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.directory); } }

struct FakeIo {
    base: String,
    base_sha: String,
    branch: String,
    candidate: String,
    remote_branch: Option<String>,
    prs: Vec<Value>,
    push_count: usize,
    create_count: usize,
    commands: Vec<Vec<String>>,
    request_body: Option<Value>,
    deny_auth: bool,
    fail_read_after_push: bool,
    lose_create_response: bool,
    hide_created_pr: bool,
    cancel_after_push: bool,
}
impl FakeIo {
    fn pr(&self, body: &str) -> Value {
        json!({"number":42,"html_url":"https://github.com/example-org/example-project/pull/42","state":"open","draft":true,
            "body":body,"head":{"ref":self.branch,"sha":self.candidate,"repo":{"full_name":"example-org/example-project"}},
            "base":{"ref":self.base,"sha":self.base_sha,"repo":{"full_name":"example-org/example-project"}}})
    }
}
impl DeliveryIo for FakeIo {
    fn check(&self) -> Result<(), String> {
        if self.cancel_after_push && self.push_count > 0 { Err("delivery cancelled".into()) } else { Ok(()) }
    }
    fn git(&mut self, root: &Path, args: &[&str]) -> Result<String, String> {
        self.commands.push(args.iter().map(|arg| (*arg).into()).collect());
        match args.first().copied() {
            Some("ls-remote") => {
                assert_eq!(args[3], "https://github.com/example-org/example-project.git");
                let reference = args.last().unwrap();
                if *reference == format!("refs/heads/{}", self.base) { Ok(format!("{}\t{reference}\n", self.base_sha)) }
                else if *reference == format!("refs/heads/{}", self.branch) {
                    Ok(self.remote_branch.as_ref().map(|sha| format!("{sha}\t{reference}\n")).unwrap_or_default())
                } else { panic!("Unexpected remote branch {args:?}") }
            }
            Some("push") => {
                let expected = create_only_push_arguments("https://github.com/example-org/example-project.git", &self.branch, &self.candidate);
                assert_eq!(args, expected.iter().map(String::as_str).collect::<Vec<_>>());
                self.push_count += 1;
                self.remote_branch = Some(self.candidate.clone());
                Ok("pushed exact candidate".into())
            }
            _ => crate::task_inputs::git(root, args),
        }
    }
    fn gh(&mut self, _root: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Value, String> {
        self.commands.push(args.iter().map(|arg| (*arg).into()).collect());
        assert_eq!(&args[..4], &["api", "--hostname", "github.com", "--method"]);
        let method = args[4];
        let endpoint = args[5];
        if endpoint == "repos/example-org/example-project" {
            assert_eq!(method, "GET");
            return Ok(json!({"full_name":"example-org/example-project","default_branch":"trunk","permissions":{"push":true}}));
        }
        assert_eq!(endpoint, "repos/example-org/example-project/pulls");
        if method == "GET" {
            assert!(input.is_none());
            if self.fail_read_after_push && self.push_count > 0 {
                self.fail_read_after_push = false;
                return Err("temporary GitHub PR lookup failure after push".into());
            }
            return Ok(json!(self.prs));
        }
        assert_eq!(method, "POST");
        assert_eq!(&args[6..], &["--input", "-"]);
        let request: Value = serde_json::from_slice(input.unwrap()).unwrap();
        assert_eq!(request["draft"], true);
        assert_eq!(request["head"], self.branch);
        assert_eq!(request["base"], self.base);
        self.create_count += 1;
        let pr = self.pr(request["body"].as_str().unwrap());
        self.request_body = Some(request);
        if !self.hide_created_pr { self.prs.push(pr.clone()); }
        if self.lose_create_response { Err("response lost after server request".into()) } else { Ok(pr) }
    }
    fn qualify(&mut self, _root: &Path, repository: &str) -> Result<(), String> {
        assert_eq!(repository, "example-org/example-project");
        if self.deny_auth { Err("GitHub CLI is installed but authentication is unavailable".into()) } else { Ok(()) }
    }
}

#[test]
fn automatic_delivery_uses_default_branch_and_marks_no_profile_unverified() {
    let fixture = Fixture::new();
    let before = fixture.task.attempts.clone();
    let mut io = fixture.io();
    let saved = fixture.deliver(&mut io);
    let receipt = saved.delivery.unwrap();
    assert_eq!(receipt.status, "delivered");
    assert_eq!(receipt.base_branch.as_deref(), Some("trunk"));
    assert_eq!(receipt.remote_base_sha.as_deref(), Some(fixture.remote_base.as_str()));
    assert_eq!(receipt.pull_request_number, Some(42));
    assert_eq!(io.push_count, 1);
    assert_eq!(io.create_count, 1);
    let body = io.request_body.as_ref().unwrap()["body"].as_str().unwrap();
    assert!(body.contains("Unverified: no formal verification profile"));
    assert!(body.contains(&marker(&fixture.task)));
    assert_eq!(saved.attempts, before);
    assert!(saved.review.is_none() && saved.acceptance.is_none());
    let empty_lease = format!("--force-with-lease=refs/heads/{}:", fixture.branch);
    assert!(io.commands.iter().flatten().all(|arg| (!arg.starts_with("--force") || arg == &empty_lease) && arg != "merge" && arg != "commit"));
}

#[test]
fn configured_base_is_used_instead_of_repository_default() {
    let fixture = Fixture::configured(Some("release/current"), false);
    let mut io = fixture.io();
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().base_branch.as_deref(), Some("release/current"));
    assert_eq!(io.request_body.unwrap()["base"], "release/current");
}

#[test]
fn delivered_retry_is_idempotent_and_does_not_reexecute_provider_or_github() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    let first = fixture.deliver(&mut io);
    let command_count = io.commands.len();
    let second = fixture.deliver(&mut io);
    assert_eq!(first.delivery, second.delivery);
    assert_eq!(first.attempts, second.attempts);
    assert_eq!(io.commands.len(), command_count);
    assert_eq!(io.create_count, 1);
    assert_eq!(io.push_count, 1);
}

#[test]
fn historical_delivered_candidate_is_not_reported_as_delivery_of_a_new_attempt() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    fixture.deliver(&mut io);
    fs::write(fixture.worktree.join("src/source.txt"), "follow-up candidate\n").unwrap();
    git(&fixture.worktree, &["add", "--", "src/source.txt"]);
    git(&fixture.worktree, &["commit", "-qm", "follow-up"]);
    let next = git(&fixture.worktree, &["rev-parse", "HEAD"]);
    fixture.manager.update(&fixture.task.id, |record| {
        let mut attempt = record.attempts.last().unwrap().clone();
        attempt.id = new_id(); attempt.candidate_sha = Some(next); attempt.started_at_ms = now_ms(); attempt.ended_at_ms = Some(now_ms());
        record.attempts.push(attempt); Ok(())
    }).unwrap();
    let error = deliver_with(&fixture.manager, &fixture.task.id, &mut io, &|_| Ok(()), &|| {}).unwrap_err();
    assert!(error.contains("new result has not been published"));
    assert_eq!((io.push_count, io.create_count), (1, 1));
    assert_eq!(fixture.manager.get(&fixture.task.id).unwrap().delivery.unwrap().candidate_sha, io.candidate);
}

#[test]
fn auth_failure_is_visible_retryable_and_preserves_successful_execution() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    io.deny_auth = true;
    let failed = fixture.deliver(&mut io);
    assert_eq!(failed.attempts, fixture.task.attempts);
    let delivery = failed.delivery.unwrap();
    assert_eq!(delivery.status, "failed");
    assert!(delivery.error.unwrap().contains("authentication"));
    assert_eq!((io.push_count, io.create_count), (0, 0));
    io.deny_auth = false;
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "delivered");
}

#[test]
fn push_success_and_pr_lookup_failure_retry_without_second_push() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    io.fail_read_after_push = true;
    let partial = fixture.deliver(&mut io);
    assert_eq!(partial.delivery.as_ref().unwrap().status, "reconcile_required");
    assert_eq!((io.push_count, io.create_count), (1, 0));
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "delivered");
    assert_eq!((io.push_count, io.create_count), (1, 1));
}

#[test]
fn lost_create_response_reconciles_existing_pr_without_second_post() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    io.lose_create_response = true;
    let result = fixture.deliver(&mut io);
    assert_eq!(result.delivery.unwrap().status, "delivered");
    fixture.deliver(&mut io);
    assert_eq!((io.push_count, io.create_count), (1, 1));
}

#[test]
fn unknown_create_outcome_never_replays_post_until_exact_pr_can_be_reconciled() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    io.lose_create_response = true;
    io.hide_created_pr = true;
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "reconcile_required");
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "reconcile_required");
    assert_eq!(io.create_count, 1);
    io.prs.push(io.pr(&marker(&fixture.task)));
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "delivered");
    assert_eq!((io.push_count, io.create_count), (1, 1));
}

#[test]
fn startup_recovers_running_write_receipt_without_touching_attempt_or_network() {
    let fixture = Fixture::new();
    let mut task = begin(&fixture.manager, &fixture.task.id, &|| {}).unwrap();
    let mut receipt = task.delivery.take().unwrap();
    receipt.branch = Some(fixture.branch.clone());
    receipt.base_branch = Some("trunk".into());
    receipt.remote_base_sha = Some(fixture.remote_base.clone());
    receipt.stage = "create_pr".into();
    save(&fixture.manager, &fixture.task.id, &receipt, &|| {}).unwrap();
    let reopened = TaskManager::open(fixture.directory.join("state/tasks.json")).unwrap();
    let recovered = reopened.get(&fixture.task.id).unwrap();
    assert_eq!(recovered.attempts, fixture.task.attempts);
    assert_eq!(recovered.delivery.unwrap().status, "reconcile_required");
    let mut io = fixture.io();
    io.remote_branch = Some(io.candidate.clone());
    io.prs.push(io.pr(&marker(&fixture.task)));
    let completed = deliver_with(&reopened, &fixture.task.id, &mut io, &|_| Err("stale formal evidence after restart".into()), &|| {}).unwrap();
    assert_eq!(completed.delivery.unwrap().status, "delivered");
    assert_eq!((io.push_count, io.create_count), (0, 0));
}

#[test]
fn stale_formal_qualification_blocks_every_new_write() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    let saved = deliver_with(&fixture.manager, &fixture.task.id, &mut io, &|_| Err("Formal verification inputs changed".into()), &|| {}).unwrap();
    assert_eq!(saved.delivery.as_ref().unwrap().status, "failed");
    assert!(saved.delivery.unwrap().error.unwrap().contains("verification inputs changed"));
    assert_eq!((io.push_count, io.create_count), (0, 0));
}

#[test]
fn dirty_candidate_and_detached_or_switched_branch_fail_before_push() {
    for change in ["dirty", "detached", "switched", "moved"] {
        let fixture = Fixture::new();
        let mut io = fixture.io();
        match change {
            "dirty" => fs::write(fixture.worktree.join("src/source.txt"), "unsaved change\n").unwrap(),
            "detached" => { git(&fixture.worktree, &["checkout", "--detach", "-q"]); }
            "switched" => { git(&fixture.worktree, &["checkout", "-q", "-b", "unapproved-branch"]); }
            _ => {
                fs::write(fixture.worktree.join("src/source.txt"), "another committed candidate\n").unwrap();
                git(&fixture.worktree, &["add", "--", "src/source.txt"]);
                git(&fixture.worktree, &["commit", "-qm", "unexpected committed candidate"]);
            }
        }
        let saved = fixture.deliver(&mut io);
        assert_eq!(saved.delivery.unwrap().status, "failed", "{change}");
        assert_eq!((io.push_count, io.create_count), (0, 0), "{change}");
    }
}

#[test]
fn changed_or_multiple_origin_targets_are_rejected() {
    for change in ["changed", "multiple"] {
        let fixture = Fixture::new();
        let mut io = fixture.io();
        if change == "changed" { git(&fixture.repository, &["remote", "set-url", "origin", "https://github.com/another-owner/other-project.git"]); }
        else { git(&fixture.repository, &["remote", "set-url", "--add", "--push", "origin", "https://github.com/example-org/example-project.git"]); git(&fixture.repository, &["remote", "set-url", "--add", "--push", "origin", "https://github.com/another-owner/other-project.git"]); }
        assert!(approved_repository(&fixture.repository).is_err() || change == "changed");
        assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "failed");
        assert_eq!((io.push_count, io.create_count), (0, 0));
    }
}

#[test]
fn remote_branch_collision_and_existing_pr_mismatch_never_overwrite_or_duplicate() {
    for conflict in ["branch", "pr", "closed"] {
        let fixture = Fixture::new();
        let mut io = fixture.io();
        if conflict == "branch" { io.remote_branch = Some(fixture.remote_base.clone()); }
        else {
            let mut pr = io.pr(if conflict == "pr" { "foreign task" } else { "" });
            if conflict == "closed" { pr["body"] = json!(marker(&fixture.task)); pr["state"] = json!("closed"); }
            io.prs.push(pr);
        }
        assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "failed");
        assert_eq!((io.push_count, io.create_count), (0, 0));
    }
}

#[test]
fn full_pr_diff_rejects_unrelated_inherited_feature_commits() {
    let fixture = Fixture::configured(None, true);
    let mut io = fixture.io();
    let saved = fixture.deliver(&mut io);
    assert_eq!(saved.delivery.as_ref().unwrap().status, "failed");
    assert!(saved.delivery.unwrap().error.unwrap().contains("approved scope"));
    assert_eq!((io.push_count, io.create_count), (0, 0));
}

#[test]
fn unknown_or_advanced_remote_base_never_fetches_or_creates_pr() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    io.base_sha = "a".repeat(40);
    let saved = fixture.deliver(&mut io);
    assert!(saved.delivery.unwrap().error.unwrap().contains("available ancestor"));
    assert_eq!((io.push_count, io.create_count), (0, 0));
    assert!(io.commands.iter().all(|args| !matches!(args[0].as_str(), "fetch" | "merge" | "checkout")));
}

#[test]
fn cancellation_after_push_retains_receipt_and_does_not_create_pr() {
    let fixture = Fixture::new();
    let mut io = fixture.io();
    io.cancel_after_push = true;
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "reconcile_required");
    assert_eq!((io.push_count, io.create_count), (1, 0));
    io.cancel_after_push = false;
    assert_eq!(fixture.deliver(&mut io).delivery.unwrap().status, "delivered");
    assert_eq!((io.push_count, io.create_count), (1, 1));
}

#[test]
fn branch_and_remote_validation_rejects_revision_syntax_and_unsafe_urls() {
    for value in ["", "-x", "@{-1}", "refs/heads/main", "main..other", "main\nother", "main:other", "main.lock", "a//b", "HEAD", "../main"] {
        assert!(validate_branch_name(value).is_err(), "{value}");
    }
    for value in ["http://github.com/a/b.git", "https://token@github.com/a/b.git", "https://github.com.evil.test/a/b.git", "https://github.com/a/b?redirect=x", "file:///tmp/repo", "ext::helper", "https://github.com/a/b.git.git"] {
        assert!(remote_repository(value).is_err(), "{value}");
    }
    assert!(validate_policy(true, false, "implementation", None).is_err());
    assert!(validate_policy(true, true, "integration", None).is_err());
    assert!(validate_policy(false, true, "implementation", Some("main")).is_err());
    assert_eq!(remote_repository("git@github.com:example-org/example-project.git").unwrap(), "example-org/example-project");
}

#[test]
fn nested_git_url_rewrites_are_rejected_before_any_remote_read_or_write() {
    for rule in ["insteadOf", "pushInsteadOf"] {
        let fixture = Fixture::new();
        let mut io = fixture.io();
        let redirect = fixture.directory.join("redirect.git");
        git(&fixture.repository, &["init", "--bare", "-q", redirect.to_str().unwrap()]);
        git(&fixture.repository, &["remote", "set-url", "origin", "approved-alias:example-project.git"]);
        git(&fixture.repository, &["config", "url.https://github.com/example-org/.insteadOf", "approved-alias:"]);
        git(&fixture.repository, &["config", &format!("url.{}.{rule}", redirect.to_string_lossy()), "https://github.com/example-org/example-project.git"]);
        // get-url's first expansion looks approved; another expansion of that
        // result would send the actual network command to the local bare repo.
        assert_eq!(git(&fixture.repository, &["remote", "get-url", "origin"]), "https://github.com/example-org/example-project.git");
        assert!(approved_repository(&fixture.repository).unwrap_err().contains("rewritten again"));
        let result = fixture.deliver(&mut io);
        assert!(result.delivery.unwrap().error.unwrap().contains("rewritten again"));
        assert_eq!((io.push_count, io.create_count), (0, 0));
        assert!(io.commands.iter().all(|args| !matches!(args[0].as_str(), "ls-remote" | "push" | "api")));
    }
}

#[test]
fn empty_expected_lease_refuses_a_branch_created_at_an_ancestor_after_preflight() {
    let fixture = Fixture::new();
    let remote = fixture.directory.join("competing.git");
    git(&fixture.repository, &["init", "--bare", "-q", remote.to_str().unwrap()]);
    let remote_ref = format!("refs/heads/{}", fixture.branch);
    assert!(git(&fixture.worktree, &["ls-remote", "--heads", "--", remote.to_str().unwrap(), &remote_ref]).is_empty());
    // Another publisher wins after our absent observation, at an ancestor that
    // an ordinary non-force push would silently fast-forward.
    git(&fixture.worktree, &["push", "-q", "--", remote.to_str().unwrap(), &format!("{}:{remote_ref}", fixture.remote_base)]);
    let candidate = fixture.task.attempts[0].candidate_sha.as_deref().unwrap();
    let args = create_only_push_arguments(remote.to_str().unwrap(), &fixture.branch, candidate);
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    assert!(run_command(&fixture.worktree, "git", &refs, None, &|| Ok(())).is_err());
    assert_eq!(git(&remote, &["rev-parse", &remote_ref]), fixture.remote_base);
    // The same narrow command can create a genuinely absent task branch.
    let absent = format!("{}-new", fixture.branch);
    let args = create_only_push_arguments(remote.to_str().unwrap(), &absent, candidate);
    let refs: Vec<_> = args.iter().map(String::as_str).collect();
    run_command(&fixture.worktree, "git", &refs, None, &|| Ok(())).unwrap();
    assert_eq!(git(&remote, &["rev-parse", &format!("refs/heads/{absent}")]), candidate);
}
