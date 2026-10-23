use super::*;

fn draft_with_context(key: &str, repository: &str, workspace: &str) -> TaskDraft {
    let mut value = serde_json::to_value(draft(key, &[])).unwrap();
    value["contextRepositories"] = serde_json::json!([
        {"repositoryRoot": repository, "workspaceRoot": workspace}
    ]);
    serde_json::from_value(value).expect("task drafts must accept explicit companion repositories")
}

#[test]
fn context_repository_is_preserved_and_immutable_after_acceptance() {
    let primary = Fixture::new();
    let companion = Fixture::new();
    let manager = primary.manager();
    let task = manager.accept_plan(primary.request(vec![draft_with_context(
        "with-context", &companion.repo, &companion.repo,
    )])).unwrap().remove(0);
    let saved = serde_json::to_value(&task).unwrap();
    let canonical = fs::canonicalize(&companion.repo).unwrap().to_string_lossy().into_owned();
    assert_eq!(saved["contextRepositories"][0]["workspaceRoot"], canonical);
    assert_eq!(saved["scope"], serde_json::json!(["src"]));
    assert!(manager.update(&task.id, |record| {
        let mut value = serde_json::to_value(&*record).unwrap();
        value["contextRepositories"] = serde_json::json!([]);
        *record = serde_json::from_value(value).unwrap();
        Ok(())
    }).unwrap_err().contains("immutable"));
    assert_eq!(serde_json::to_value(manager.get(&task.id).unwrap()).unwrap()["contextRepositories"], saved["contextRepositories"]);
}

#[test]
fn context_snapshot_reopens_and_replays_when_companion_is_offline() {
    let primary = Fixture::new();
    let companion = Fixture::new();
    let request = primary.request(vec![draft_with_context("with-context", &companion.repo, &companion.repo)]);
    let manager = primary.manager();
    let original = manager.accept_launch("context-launch", request.clone(), None).unwrap();
    drop(manager);
    fs::remove_dir_all(&companion.repo).unwrap();
    let reopened = primary.manager();
    let retry = reopened.accept_launch("context-launch", request.clone(), None).unwrap();
    assert!(!retry.created);
    assert_eq!(retry.task.id, original.task.id);
    assert_eq!(serde_json::to_value(&retry.task).unwrap()["contextRepositories"], serde_json::to_value(&original.task).unwrap()["contextRepositories"]);
    assert!(reopened.accept_plan(request).is_err(), "new execution inputs must validate the live companion");
}

#[cfg(unix)]
#[test]
fn context_history_reopens_when_a_saved_path_is_retargeted() {
    let primary = Fixture::new();
    let first = Fixture::new();
    let second = Fixture::new();
    let mut value = serde_json::to_value(draft_with_context("two-peers", &first.repo, &first.repo)).unwrap();
    value["contextRepositories"].as_array_mut().unwrap().push(serde_json::json!({
        "repositoryRoot": second.repo, "workspaceRoot": second.repo,
    }));
    let request = primary.request(vec![serde_json::from_value(value).unwrap()]);
    let manager = primary.manager();
    let task = manager.accept_plan(request).unwrap().remove(0);
    drop(manager);
    fs::remove_dir_all(&first.repo).unwrap();
    std::os::unix::fs::symlink(&second.repo, &first.repo).unwrap();
    let reopened = primary.manager();
    let stored = reopened.get(&task.id);
    fs::remove_file(&first.repo).unwrap();
    let stored = stored.expect("saved paths must be validated lexically so changed live aliases cannot quarantine history");
    assert_eq!(stored.context_repositories, task.context_repositories);
}

#[test]
fn context_repository_cannot_claim_a_foreign_worktree() {
    let primary = Fixture::new();
    let companion = Fixture::new();
    let foreign = Fixture::new();
    let request = primary.request(vec![draft_with_context("wrong-owner", &companion.repo, &foreign.repo)]);
    let manager = primary.manager();
    assert!(manager.accept_plan(request).is_err());
    assert!(manager.all().unwrap().is_empty());
}

#[test]
fn empty_context_keeps_legacy_launch_serialization_and_retry_identity() {
    let primary = Fixture::new();
    let request = primary.request(vec![draft("legacy", &[])]);
    let encoded = serde_json::to_value(&request).unwrap();
    assert!(encoded["tasks"][0].get("contextRepositories").is_none());
    let manager = primary.manager();
    let original = manager.accept_launch("legacy-launch", request, None).unwrap();
    let mut explicit_empty = encoded;
    explicit_empty["tasks"][0]["contextRepositories"] = serde_json::json!([]);
    let request: TaskPlanRequest = serde_json::from_value(explicit_empty).expect("empty context must be backward compatible");
    let retry = manager.accept_launch("legacy-launch", request, None).unwrap();
    assert!(!retry.created);
    assert_eq!(retry.task.id, original.task.id);
    assert!(serde_json::to_value(retry.task).unwrap().get("contextRepositories").is_none());
}

#[test]
fn disabled_pr_delivery_preserves_legacy_launch_request_digest() {
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    let request = fixture.request(vec![draft("legacy-delivery", &[])]);
    let mut legacy = serde_json::to_value(&request).unwrap();
    assert!(legacy["tasks"][0].get("autoDraftPr").is_none());
    assert!(legacy["tasks"][0].get("prBaseBranch").is_none());
    legacy["repositoryRoot"] = serde_json::json!(super::validation::canonical_root(&fixture.repo).unwrap());
    let expected = format!("{:x}", Sha256::digest(serde_json::to_vec(&serde_json::json!({"plan":legacy,"executablePath":null})).unwrap()));
    let manager = fixture.manager();
    let first = manager.accept_launch("legacy-pr-request", request, None).unwrap();
    let persisted: serde_json::Value = serde_json::from_slice(&fs::read(fixture.path()).unwrap()).unwrap();
    assert_eq!(persisted["launchRequests"][0]["requestDigest"], expected);
    legacy["tasks"][0]["autoDraftPr"] = serde_json::json!(false);
    legacy["tasks"][0]["prBaseBranch"] = serde_json::Value::Null;
    let replay = manager.accept_launch("legacy-pr-request", serde_json::from_value(legacy).unwrap(), None).unwrap();
    assert!(!replay.created);
    assert_eq!(replay.task.id, first.task.id);
}

#[test]
fn launch_request_replay_keeps_one_durable_task_and_the_original_failure() {
    let f = Fixture::new();
    let m = f.manager();
    let request = f.request(vec![draft("quick", &[])]);
    let first = m.accept_launch("launch-request", request.clone(), None).unwrap();
    assert!(first.created);
    m.finish_launch("launch-request", Some("Worktree target is unavailable".into())).unwrap();
    assert_eq!(m.launch_error(&first.task.id).unwrap().as_deref(), Some("Worktree target is unavailable"));
    let retry = m.accept_launch("launch-request", request.clone(), None).unwrap();
    assert!(!retry.created);
    assert_eq!(retry.task.id, first.task.id);
    assert_eq!(retry.launch_error.as_deref(), Some("Worktree target is unavailable"));
    assert_eq!(m.all().unwrap().len(), 1);
    assert_eq!(m.events(0).unwrap().len(), 1);
    drop(m);
    let reopened = f.manager();
    let replay = reopened.accept_launch("launch-request", request, None).unwrap();
    assert!(!replay.created);
    assert_eq!(replay.task.id, first.task.id);
    assert_eq!(replay.launch_error, retry.launch_error);
    assert_eq!(reopened.launch_error(&first.task.id).unwrap(), retry.launch_error);
    assert!(reopened.launch_error("nonexistent-task").is_err());
}

#[test]
fn accepted_launch_replay_does_not_revalidate_a_later_repository_head() {
    let f = Fixture::new();
    let m = f.manager();
    let request = f.request(vec![draft("quick", &[])]);
    let original = m.accept_launch("fixed-request", request.clone(), None).unwrap();
    assert!(Command::new("git").args(["-c","user.name=Fixture","-c","user.email=fixture@invalid","commit","--allow-empty","-qm","later commit"]).current_dir(&f.repo).status().unwrap().success());
    let replay = m.accept_launch("fixed-request", request, None).unwrap();
    assert!(!replay.created);
    assert_eq!(replay.task.id, original.task.id);
    assert_eq!(replay.task.base_sha, f.head);
}

#[test]
fn launch_token_rejects_changed_inputs_and_serializes_concurrent_acceptance() {
    let f = Fixture::new();
    let m = f.manager();
    let request = f.request(vec![draft("quick", &[])]);
    let mut workers = Vec::new();
    for _ in 0..4 {
        let manager = m.clone();
        let request = request.clone();
        workers.push(std::thread::spawn(move || manager.accept_launch("same-token", request, None).unwrap()));
    }
    let accepted: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
    assert_eq!(accepted.iter().filter(|result| result.created).count(), 1);
    assert!(accepted.iter().all(|result| result.task.id == accepted[0].task.id));
    let mut changed = request.clone();
    changed.tasks[0].goal = "Another task".into();
    assert!(m.accept_launch("same-token", changed, None).is_err());
    assert!(m.accept_launch("same-token", request, Some("/another/codex")).is_err());
    assert_eq!(m.all().unwrap().len(), 1);
}

#[test]
fn interrupted_launch_token_never_becomes_permission_to_repeat_creation() {
    let f = Fixture::new();
    let request = f.request(vec![draft("quick", &[])]);
    let m = f.manager();
    let first = m.accept_launch("uncertain-launch", request.clone(), None).unwrap();
    drop(m);
    let retry = f.manager().accept_launch("uncertain-launch", request, None).unwrap();
    assert!(!retry.created);
    assert_eq!(retry.task.id, first.task.id);
    assert!(retry.launch_error.is_some());
    assert!(retry.task.workspace_root.is_none());
    assert!(retry.task.attempts.is_empty());
}

#[test]
fn rejected_launch_token_stays_closed_after_head_restoration_and_restart() {
    let f = Fixture::new();
    let m = f.manager();
    let request = f.request(vec![draft("quick", &[])]);
    assert!(Command::new("git").args(["-c","user.name=Fixture","-c","user.email=fixture@invalid","commit","--allow-empty","-qm","moved HEAD"]).current_dir(&f.repo).status().unwrap().success());
    let failure = m.accept_launch("rejected-token", request.clone(), None).err().unwrap();
    assert_eq!(failure.acceptance, "rejected");
    assert_eq!(failure.request_id, "rejected-token");
    assert!(failure.message.contains("HEAD"));
    assert!(m.all().unwrap().is_empty());
    assert!(Command::new("git").args(["checkout","--detach", &f.head]).current_dir(&f.repo).status().unwrap().success());
    drop(m);
    let reopened = f.manager();
    let late_original = reopened.accept_launch("rejected-token", request.clone(), None).err().unwrap();
    assert_eq!(late_original.acceptance, "rejected");
    assert_eq!(late_original.message, failure.message);
    assert!(reopened.all().unwrap().is_empty());
    assert!(reopened.accept_launch("new-token", request, None).unwrap().created);
}

#[test]
fn launch_storage_uncertainty_cannot_claim_a_definitive_rejection() {
    let f = Fixture::new();
    let m = f.manager();
    let request = f.request(vec![draft("quick", &[])]);
    fs::remove_file(f.path()).unwrap();
    fs::create_dir(f.path()).unwrap();
    let failure = m.accept_launch("uncertain-save", request, None).err().unwrap();
    assert_eq!(failure.acceptance, "unknown");
    assert_eq!(failure.request_id, "uncertain-save");
    assert!(m.all().unwrap().is_empty());
    let mut invalid = f.request(vec![draft("invalid", &[])]);
    invalid.tasks[0].goal.clear();
    assert_eq!(m.accept_launch("uncertain-rejection-save", invalid, None).err().unwrap().acceptance, "unknown");
}

#[test]
fn saturated_rejected_launch_history_never_evicts_a_closed_token() {
    let f = Fixture::new();
    drop(f.manager());
    let mut generation: serde_json::Value = serde_json::from_slice(&fs::read(f.path()).unwrap()).unwrap();
    generation["rejectedLaunchRequests"] = serde_json::json!((0..super::store::MAX_TASKS)
        .map(|index| serde_json::json!({"requestId":format!("closed-{index}"),"message":"Previously rejected"}))
        .collect::<Vec<_>>());
    fs::write(f.path(), serde_json::to_vec(&generation).unwrap()).unwrap();
    let before = fs::read(f.path()).unwrap();
    let m = f.manager();
    let mut invalid = f.request(vec![draft("invalid", &[])]);
    invalid.tasks[0].goal.clear();
    assert_eq!(m.accept_launch("overflow", invalid, None).err().unwrap().acceptance, "unknown");
    assert_eq!(fs::read(f.path()).unwrap(), before);
    let closed = m.accept_launch("closed-0", f.request(vec![draft("valid", &[])]), None).err().unwrap();
    assert_eq!(closed.acceptance, "rejected");
    assert_eq!(closed.message, "Previously rejected");
    assert!(m.all().unwrap().is_empty());
}

#[test]
fn accepted_token_with_changed_inputs_never_claims_rejection_or_discards_history() {
    let f = Fixture::new();
    let m = f.manager();
    let mut request = f.request(vec![draft("quick", &[])]);
    let accepted = m.accept_launch("accepted-token", request.clone(), None).unwrap();
    request.tasks[0].goal = "A different goal".into();
    let failure = m.accept_launch("accepted-token", request, None).err().unwrap();
    assert_eq!(failure.acceptance, "unknown");
    assert_eq!(m.all().unwrap()[0].id, accepted.task.id);
}

#[test]
fn natural_language_task_can_explicitly_scope_the_repository_without_weakening_profile_paths() {
    let f = Fixture::new();
    let m = f.manager();
    let mut wide = draft("wide", &[]);
    wide.scope = vec![".".into()];
    let accepted = m.accept_plan(f.request(vec![wide])).unwrap().remove(0);
    assert_eq!(accepted.scope, vec!["."]);
    assert_eq!(m.get(&accepted.id).unwrap().scope, vec!["."]);
    drop(m);
    assert_eq!(f.manager().get(&accepted.id).unwrap().scope, vec!["."]);

    for scope in [vec![".".into(), "src".into()], vec![".git".into()], vec![".env".into()]] {
        let mut unsafe_draft = draft("unsafe", &[]);
        unsafe_draft.scope = scope;
        assert!(f.manager().accept_plan(f.request(vec![unsafe_draft])).is_err());
    }
    for field in ["sourcePaths", "outputPaths"] {
        let mut unsafe_draft = draft("unsafe-profile", &[]);
        let mut profile = serde_json::json!({"schemaVersion":1,"id":"p","name":"p",
            "gates":[{"id":"test","label":"Test","kind":"unit","required":true,"approval":"none",
                "executor":{"type":"process","program":"npm","args":["test"],"cwd":"workspace"}}]});
        profile[field] = serde_json::json!(["."]);
        unsafe_draft.profile = Some(profile);
        assert!(f.manager().accept_plan(f.request(vec![unsafe_draft])).is_err());
    }
}


#[test]
fn dependency_revision_guard_rejects_stale_decisions_without_persistence() {
    let f = Fixture::new();
    let m = f.manager();
    let tasks = m
        .accept_plan(f.request(vec![
            draft("dependency", &[]),
            draft("dependent", &["dependency"]),
        ]))
        .unwrap();
    let dependency = &tasks[0];
    let target = &tasks[1];
    let expected = vec![(dependency.id.clone(), dependency.revision)];
    m.update(&dependency.id, |_| Ok(())).unwrap();
    let disk = fs::read(f.path()).unwrap();
    let event_count = m.events(0).unwrap().len();
    let mut called = false;
    assert!(m
        .update_with_dependency_revisions(&target.id, &expected, |t| {
            called = true;
            t.title = "Must not persist".into();
            t.acceptance = Some(
                serde_json::from_value(serde_json::json!({
            "headSha":f.head,"inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),
            "runId":"run-one","toolchainDigest":"c".repeat(64),
            "acceptedAtMs":1,"acknowledgedWarnings":false}))
                .unwrap(),
            );
            Ok(())
        })
        .is_err());
    assert!(!called);
    assert_eq!(fs::read(f.path()).unwrap(), disk);
    assert_eq!(m.events(0).unwrap().len(), event_count);
    assert!(m.decisions(&target.id).unwrap().is_empty());
    assert_eq!(m.get(&target.id).unwrap().revision, 1);
    assert!(m
        .update_with_dependency_revisions(&target.id, &[], |_| Ok(()))
        .is_err());
    assert_eq!(fs::read(f.path()).unwrap(), disk);
    let fresh = vec![(
        dependency.id.clone(),
        m.get(&dependency.id).unwrap().revision,
    )];
    let updated = m
        .update_with_dependency_revisions(&target.id, &fresh, |t| {
            t.title = "Validated dependency".into();
            Ok(())
        })
        .unwrap();
    assert_eq!(updated.revision, 2);
    drop(m);
    assert_eq!(
        f.manager().get(&target.id).unwrap().title,
        "Validated dependency"
    );
}

#[test]
fn gate_programs_match_runner_exact_names_while_toolchain_paths_remain_metadata() {
    let f = Fixture::new();
    let m = f.manager();
    let compiler = PathBuf::from(&f.repo).join("Compiler Toolchain/bin/python3");
    assert!(compiler.is_absolute());
    let profile = serde_json::json!({"schemaVersion":1,"id":"checks","name":"Checks",
        "toolchainPrograms":[compiler.to_str().unwrap(),"C:\\Compiler Toolchain\\bin\\cl.exe"],
        "gates":[{"id":"build","label":"Build","kind":"build","required":true,"approval":"none",
        "executor":{"type":"process","program":"cargo","args":["--version"],"cwd":"workspace"}}]});
    for program in [
        "python",
        "python3",
        "go",
        "pytest",
        "rustc",
        "pnpm",
        "yarn",
        "make",
        "dotnet",
        "clang",
        "/usr/bin/cargo",
        "C:\\Tools\\cargo.exe",
        "./cargo",
        "Cargo",
        "CARGO.EXE",
        "npm.cmd",
    ] {
        let mut p = profile.clone();
        p["gates"][0]["executor"]["program"] = program.into();
        let mut d = draft("bad", &[]);
        d.profile = Some(p);
        let error = m
            .accept_plan(f.request(vec![d]))
            .expect_err("runner would reject this gate");
        assert!(
            error.contains("cargo") && error.contains("toolchainPrograms"),
            "{error}"
        );
    }
    assert!(m.all().unwrap().is_empty());
    assert!(m.events(0).unwrap().is_empty());
    for program in [
        "cargo",
        "cargo.exe",
        "cmake",
        "cmake.exe",
        "ctest",
        "ctest.exe",
        "ninja",
        "ninja.exe",
        "npm",
        "npm.exe",
        "node",
        "node.exe",
    ] {
        let mut p = profile.clone();
        p["gates"][0]["executor"]["program"] = program.into();
        let mut d = draft("good", &[]);
        d.profile = Some(p);
        let task = m.accept_plan(f.request(vec![d])).unwrap().remove(0);
        let saved = m.get(&task.id).unwrap().profile.unwrap();
        assert_eq!(saved["toolchainPrograms"], profile["toolchainPrograms"]);
        assert_eq!(saved["gates"][0]["executor"]["program"], program);
    }
}

#[test]
fn manifest_binding_preserves_digest_rejects_corruption_and_migrates_legacy() {
    let f = Fixture::new();
    let m = f.manager();
    let task = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let legacy_json = serde_json::json!({"runId":"run-one","headSha":f.head,
        "profileDigest":"a".repeat(64),"inputDigest":"b".repeat(64),"toolchainDigest":"c".repeat(64),
        "status":"pass","checks":[],"artifacts":[],"observedAtMs":1});
    let legacy: TaskEvidence = serde_json::from_value(legacy_json).unwrap();
    assert!(legacy.manifest_digest.is_none());
    assert!(serde_json::to_value(&legacy)
        .unwrap()
        .get("manifestDigest")
        .is_none());
    let mut evidence = TaskEvidence {
        run_id: "run-two".into(),
        head_sha: f.head.clone(),
        profile_digest: "a".repeat(64),
        input_digest: "b".repeat(64),
        toolchain_digest: "c".repeat(64),
        manifest_digest: None,
        status: "pass".into(),
        checks: vec![],
        artifacts: vec![],
        observed_at_ms: 2,
    };
    evidence.manifest_digest = Some("d".repeat(64));
    m.update(&task.id, |t| {
        let mut a = attempt("running");
        a.evidence = Some(evidence);
        t.attempts.push(a);
        Ok(())
    })
    .unwrap();
    for invalid in [
        "".into(),
        "x".repeat(64),
        "d".repeat(40),
        "D".repeat(64),
        "d".repeat(65),
    ] {
        assert!(m
            .update(&task.id, |t| {
                t.attempts[0].evidence.as_mut().unwrap().manifest_digest = Some(invalid);
                Ok(())
            })
            .is_err());
    }
    assert_eq!(m.events(0).unwrap().len(), 2);
    drop(m);
    let m = f.manager();
    assert_eq!(
        m.get(&task.id).unwrap().attempts[0]
            .evidence
            .as_ref()
            .unwrap()
            .manifest_digest
            .as_deref(),
        Some("d".repeat(64).as_str())
    );
    drop(m);
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(f.path()).unwrap()).unwrap();
    data["tasks"][0]["attempts"][0]["evidence"]["manifestDigest"] = "bad".into();
    fs::write(f.path(), serde_json::to_vec(&data).unwrap()).unwrap();
    assert!(TaskManager::open(f.path()).is_err());
    data["tasks"][0]["attempts"][0]["evidence"]
        .as_object_mut()
        .unwrap()
        .remove("manifestDigest");
    fs::write(f.path(), serde_json::to_vec(&data).unwrap()).unwrap();
    let migrated = f.manager().get(&task.id).unwrap();
    assert!(migrated.attempts[0]
        .evidence
        .as_ref()
        .unwrap()
        .manifest_digest
        .is_none());
}

#[test]
fn decision_bindings_migrate_legacy_and_archive_each_explicit_run() {
    let f = Fixture::new();
    let m = f.manager();
    let t = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let review: TaskReview = serde_json::from_value(serde_json::json!({
        "headSha":f.head,"inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),
        "approved":true,"note":"Legacy human review","createdAtMs":1}))
    .unwrap();
    let acceptance: TaskAcceptance = serde_json::from_value(serde_json::json!({
        "headSha":f.head,"inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),
        "acceptedAtMs":2,"acknowledgedWarnings":false}))
    .unwrap();
    assert!(review.run_id.is_none() && review.toolchain_digest.is_none());
    assert!(acceptance.run_id.is_none() && acceptance.toolchain_digest.is_none());
    m.update(&t.id, |t| {
        t.review = Some(review);
        t.acceptance = Some(acceptance);
        Ok(())
    })
    .unwrap();
    // Genuine schema-1 fixture: neither optional binding field was present.
    drop(m);
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(f.path()).unwrap()).unwrap();
    for key in ["review", "acceptance"] {
        let record = data["tasks"][0][key].as_object_mut().unwrap();
        record.remove("runId");
        record.remove("toolchainDigest");
    }
    fs::write(f.path(), serde_json::to_vec(&data).unwrap()).unwrap();
    let m = f.manager();
    assert!(m.get(&t.id).unwrap().review.unwrap().run_id.is_none());
    for run in ["run-one", "run-two"] {
        m.update(&t.id, |t| {
            let review = t.review.as_mut().unwrap();
            review.run_id = Some(run.into());
            review.toolchain_digest = Some("c".repeat(64));
            let acceptance = t.acceptance.as_mut().unwrap();
            acceptance.run_id = Some(run.into());
            acceptance.toolchain_digest = Some("c".repeat(64));
            Ok(())
        })
        .unwrap();
    }
    drop(m);
    let m = f.manager();
    let decisions = m.decisions(&t.id).unwrap();
    assert_eq!(decisions.len(), 6);
    for record in &decisions[..2] {
        assert!(record["record"]["runId"].is_null());
        assert!(record["record"]["toolchainDigest"].is_null());
    }
    for record in &decisions[2..4] {
        assert_eq!(record["record"]["runId"], "run-one");
        assert_eq!(record["record"]["toolchainDigest"], "c".repeat(64));
    }
    for record in &decisions[4..] {
        assert_eq!(record["record"]["runId"], "run-two");
    }
}
#[test]
fn decision_bindings_reject_partial_or_malformed_pairs_without_archiving() {
    let f = Fixture::new();
    let m = f.manager();
    let t = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let review: TaskReview = serde_json::from_value(serde_json::json!({
        "headSha":f.head,"inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),
        "approved":true,"note":"Human review","createdAtMs":1,
        "runId":"run-one","toolchainDigest":"c".repeat(64)}))
    .unwrap();
    let acceptance: TaskAcceptance = serde_json::from_value(serde_json::json!({
        "headSha":f.head,"inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),
        "acceptedAtMs":2,"acknowledgedWarnings":false,
        "runId":"run-one","toolchainDigest":"c".repeat(64)}))
    .unwrap();
    m.update(&t.id, |t| {
        t.review = Some(review);
        t.acceptance = Some(acceptance);
        Ok(())
    })
    .unwrap();
    for (run, tools) in [
        (Some("run-two"), None),
        (None, Some("c".repeat(64))),
        (Some("../bad"), Some("c".repeat(64))),
        (Some("run-two"), Some("bad".into())),
        (Some("run-two"), Some("C".repeat(64))),
    ] {
        for review in [true, false] {
            assert!(m
                .update(&t.id, |t| {
                    if review {
                        let r = t.review.as_mut().unwrap();
                        r.run_id = run.map(str::to_owned);
                        r.toolchain_digest = tools.clone();
                    } else {
                        let a = t.acceptance.as_mut().unwrap();
                        a.run_id = run.map(str::to_owned);
                        a.toolchain_digest = tools.clone();
                    }
                    Ok(())
                })
                .is_err());
        }
    }
    assert_eq!(m.events(0).unwrap().len(), 2);
    assert_eq!(m.decisions(&t.id).unwrap().len(), 2);
    assert_eq!(
        m.get(&t.id).unwrap().review.unwrap().run_id.as_deref(),
        Some("run-one")
    );
    let backup = f.path().with_extension("backup");
    fs::rename(f.path(), &backup).unwrap();
    fs::create_dir(f.path()).unwrap();
    assert!(m
        .update(&t.id, |t| {
            t.review.as_mut().unwrap().run_id = Some("run-two".into());
            t.acceptance.as_mut().unwrap().run_id = Some("run-two".into());
            Ok(())
        })
        .is_err());
    assert_eq!(m.decisions(&t.id).unwrap().len(), 2);
    assert_eq!(
        m.get(&t.id).unwrap().acceptance.unwrap().run_id.as_deref(),
        Some("run-one")
    );
    fs::remove_dir(f.path()).unwrap();
    fs::rename(backup, f.path()).unwrap();
    // Both current and historical records must be validated on reopen.
    let original: serde_json::Value = serde_json::from_slice(&fs::read(f.path()).unwrap()).unwrap();
    drop(m);
    for kind in ["review", "acceptance"] {
        let mut data = original.clone();
        data["tasks"][0][kind]["runId"] = serde_json::Value::Null;
        fs::write(f.path(), serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(TaskManager::open(f.path()).is_err());
        let mut data = original.clone();
        let mut record = data["tasks"][0][kind].clone();
        record["toolchainDigest"] = "bad".into();
        data["decisionHistory"] = serde_json::json!([{"kind":kind,"taskId":t.id,"record":record}]);
        fs::write(f.path(), serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(TaskManager::open(f.path()).is_err());
    }
}

#[test]
fn retry_archives_human_decisions_atomically_and_failed_save_rolls_back() {
    let f = Fixture::new();
    let m = f.manager();
    let t = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let review: TaskReview = serde_json::from_value(serde_json::json!({"headSha":f.head,
        "inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),"approved":true,"note":"Human review","createdAtMs":1})).unwrap();
    let acceptance: TaskAcceptance = serde_json::from_value(serde_json::json!({"headSha":f.head,
        "inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),"acceptedAtMs":2,"acknowledgedWarnings":false})).unwrap();
    m.update(&t.id, |t| {
        t.review = Some(review.clone());
        t.acceptance = Some(acceptance.clone());
        Ok(())
    })
    .unwrap();
    assert_eq!(m.decisions(&t.id).unwrap().len(), 2);
    let backup = f.path().with_extension("backup");
    fs::rename(f.path(), &backup).unwrap();
    fs::create_dir(f.path()).unwrap();
    assert!(m
        .update(&t.id, |t| {
            t.review = None;
            t.acceptance = None;
            t.attempts.push(attempt("queued"));
            Ok(())
        })
        .is_err());
    assert_eq!(m.decisions(&t.id).unwrap().len(), 2);
    assert!(m.get(&t.id).unwrap().review.is_some());
    fs::remove_dir(f.path()).unwrap();
    fs::rename(backup, f.path()).unwrap();
    m.update(&t.id, |t| {
        t.review = None;
        t.acceptance = None;
        t.attempts.push(attempt("queued"));
        Ok(())
    })
    .unwrap();
    assert!(m.get(&t.id).unwrap().review.is_none());
    drop(m);
    let m = f.manager();
    let decisions = m.decisions(&t.id).unwrap();
    assert_eq!(decisions.len(), 2);
    assert_eq!(decisions[0]["kind"], "review");
    assert_eq!(decisions[0]["taskId"], t.id);
    assert_eq!(decisions[0]["record"]["note"], "Human review");
    assert_eq!(decisions[1]["kind"], "acceptance");
    assert_eq!(decisions[1]["record"]["acceptedAtMs"], 2);
    m.update(&t.id, |t| {
        t.review = Some(review.clone());
        Ok(())
    })
    .unwrap();
    m.update(&t.id, |t| {
        t.review.as_mut().unwrap().note = "Second human review".into();
        Ok(())
    })
    .unwrap();
    assert_eq!(m.decisions(&t.id).unwrap().len(), 4);
}
#[test]
fn schema_one_without_history_reopens_and_invalid_archived_decisions_fail_closed() {
    let f = Fixture::new();
    let m = f.manager();
    let task = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    drop(m);
    let mut v: serde_json::Value = serde_json::from_slice(&fs::read(f.path()).unwrap()).unwrap();
    v.as_object_mut().unwrap().remove("decisionHistory");
    fs::write(f.path(), serde_json::to_vec(&v).unwrap()).unwrap();
    assert!(f.manager().decisions(&task.id).unwrap().is_empty());
    for bad in [
        serde_json::json!({"kind":"review","taskId":"missing","record":{"headSha":f.head,"inputDigest":"a".repeat(64),"profileDigest":"b".repeat(64),"approved":true,"note":"Human","createdAtMs":1}}),
        serde_json::json!({"kind":"raw","taskId":task.id,"record":{"prompt":"raw"}}),
    ] {
        v["decisionHistory"] = serde_json::json!([bad]);
        fs::write(f.path(), serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(TaskManager::open(f.path()).is_err());
    }
}

#[test]
fn native_execution_identity_roundtrips_and_rejects_raw_payloads() {
    let f = Fixture::new();
    let m = f.manager();
    let t = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let a = attempt("running");
    assert!(
        a.execution.is_none(),
        "historical attempts default to unknown execution"
    );
    m.update(&t.id, |t| {
        t.attempts.push(a);
        Ok(())
    })
    .unwrap();
    let identity = serde_json::json!({"harness":"codex","executablePath":null,
        "version":"1.0","threadId":"observed-thread","turnId":"observed-turn"});
    m.update(&t.id, |t| {
        t.attempts[0].execution = Some(identity.clone());
        Ok(())
    })
    .unwrap();
    for invalid in [
        {
            let mut v = identity.clone();
            v["prompt"] = "raw prompt".into();
            v
        },
        {
            let mut v = identity.clone();
            v["output"] = "raw output".into();
            v
        },
        {
            let mut v = identity.clone();
            v["turnId"] = "x".repeat(513).into();
            v
        },
        {
            let mut v = identity.clone();
            v["version"] = "raw\noutput".into();
            v
        },
        {
            let mut v = identity.clone();
            v["executablePath"] = "../tool".into();
            v
        },
        serde_json::json!("raw transcript"),
    ] {
        assert!(m
            .update(&t.id, |t| {
                t.attempts[0].execution = Some(invalid);
                Ok(())
            })
            .is_err());
    }
    assert_eq!(
        m.get(&t.id).unwrap().attempts[0].execution,
        Some(identity.clone())
    );
    drop(m);
    assert_eq!(
        f.manager().get(&t.id).unwrap().attempts[0].execution,
        Some(identity)
    );
}

#[test]
fn profile_total_size_is_bounded_before_acceptance_and_keeps_lineage() {
    let f = Fixture::new();
    let m = f.manager();
    let profile = serde_json::json!({"schemaVersion":1,"id":"checks","name":"Checks",
        "gates":[{"id":"build","label":"Build","kind":"build","required":true,"approval":"none",
        "executor":{"type":"process","program":"cargo","args":vec!["x".repeat(1024);128],"cwd":"workspace"}}]});
    let mut d = draft("a", &[]);
    d.profile = Some(profile);
    assert!(m.accept_plan(f.request(vec![d])).is_err());
    assert!(m.all().unwrap().is_empty());
    assert!(m.events(0).unwrap().is_empty());
}

#[test]
fn unavailable_store_preserves_corruption_and_rejects_every_task_operation() {
    let f = Fixture::new();
    fs::create_dir_all(f.path().parent().unwrap()).unwrap();
    fs::write(f.path(), b"corrupt fixture").unwrap();
    let error = match TaskManager::open(f.path()) {
        Ok(_) => panic!("accepted corruption"),
        Err(e) => e,
    };
    let m = TaskManager::unavailable(f.path(), error.clone());
    assert_eq!(m.all().unwrap_err(), error);
    assert_eq!(m.list(&[f.repo.clone()]).unwrap_err(), error);
    assert_eq!(m.get("task").unwrap_err(), error);
    assert_eq!(m.events(0).unwrap_err(), error);
    assert_eq!(m.decisions("task").unwrap_err(), error);
    let mut called = false;
    assert_eq!(
        m.update("task", |_| {
            called = true;
            Ok(())
        })
        .unwrap_err(),
        error
    );
    assert!(!called);
    assert_eq!(
        m.record("task", None, "task.updated", |_| Ok(()))
            .unwrap_err(),
        error
    );
    assert_eq!(
        m.accept_plan(f.request(vec![draft("a", &[])])).unwrap_err(),
        error
    );
    assert_eq!(m.clone().all().unwrap_err(), error);
    assert_eq!(fs::read(f.path()).unwrap(), b"corrupt fixture");
}

#[cfg(unix)]
#[test]
fn symlinks_to_git_metadata_or_env_never_become_accepted_scopes() {
    let f = Fixture::new();
    let m = f.manager();
    fs::write(PathBuf::from(&f.repo).join(".env"), "fixture").unwrap();
    for (target, alias) in [(".env", "alias-secret"), (".git", "alias-metadata")] {
        std::os::unix::fs::symlink(target, PathBuf::from(&f.repo).join(alias)).unwrap();
        let mut d = draft("bad", &[]);
        d.scope = vec![alias.into()];
        assert!(
            m.accept_plan(f.request(vec![d])).is_err(),
            "{alias} resolved to protected inputs"
        );
    }
}
#[cfg(unix)]
#[test]
fn symlink_target_with_literal_backslash_is_not_reinterpreted_as_scope_components() {
    let f = Fixture::new();
    let repo = PathBuf::from(&f.repo);
    fs::write(repo.join("source\\nested.rs"), "fixture").unwrap();
    std::os::unix::fs::symlink("source\\nested.rs", repo.join("alias-source")).unwrap();
    let mut d = draft("bad-native-path", &[]);
    d.scope = vec!["alias-source".into()];
    assert!(f.manager().accept_plan(f.request(vec![d])).is_err());
}
#[test]
fn toolchain_declarations_preserve_paths_and_reject_secret_fingerprints() {
    let f = Fixture::new();
    let m = f.manager();
    let compiler = PathBuf::from(&f.repo).join("Tool Chain/bin/clang");
    assert!(compiler.is_absolute());
    let profile = serde_json::json!({"schemaVersion":1,"id":"checks","name":"Checks",
        "toolchainPrograms":["clang++",compiler.to_str().unwrap(),"C:\\Tool Chain\\bin\\cl.exe"],
        "gates":[{"id":"build","label":"Build","kind":"build","required":true,"approval":"none",
        "executor":{"type":"process","program":"cmake","args":["--build","build"],"cwd":"workspace"}}]});
    let mut d = draft("a", &[]);
    d.profile = Some(profile.clone());
    let task = m.accept_plan(f.request(vec![d])).unwrap().remove(0);
    assert_eq!(
        f.manager().get(&task.id).unwrap().profile.unwrap()["toolchainPrograms"],
        profile["toolchainPrograms"]
    );
    for program in [
        "/tmp/.env",
        "/tmp/.git/config",
        "cc --version",
        "../compiler",
        ".",
    ] {
        let mut p = profile.clone();
        p["toolchainPrograms"] = serde_json::json!([program]);
        let mut d = draft("bad", &[]);
        d.profile = Some(p);
        assert!(
            m.accept_plan(f.request(vec![d])).is_err(),
            "accepted unsafe tool identity: {program}"
        );
    }
}
#[test]
fn terminal_attempts_remain_historical_when_retry_is_appended() {
    let f = Fixture::new();
    let m = f.manager();
    let t = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let mut a = attempt("failed");
    a.ended_at_ms = Some(a.started_at_ms);
    m.update(&t.id, |t| {
        t.attempts.push(a);
        Ok(())
    })
    .unwrap();
    assert!(m
        .update(&t.id, |t| {
            t.attempts[0].state = "running".into();
            Ok(())
        })
        .is_err());
    m.update(&t.id, |t| {
        t.attempts.push(attempt("queued"));
        Ok(())
    })
    .unwrap();
    assert!(m
        .update(&t.id, |t| {
            t.attempts[0].failure = Some("rewritten".into());
            Ok(())
        })
        .is_err());
    assert_eq!(m.get(&t.id).unwrap().attempts[0].state, "failed");
}
use std::{fs, path::PathBuf, process::Command};

struct Fixture {
    dir: PathBuf,
    repo: String,
    head: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("virtuallab-tasks-{}", new_id()));
        let repo = dir.join("仓库 with spaces");
        fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init", "-q"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        ] {
            assert!(Command::new("git")
                .args(args)
                .current_dir(&repo)
                .status()
                .unwrap()
                .success());
        }
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&repo)
            .output()
            .unwrap();
        Self {
            dir,
            repo: repo.to_str().unwrap().into(),
            head: String::from_utf8(output.stdout).unwrap().trim().into(),
        }
    }
    fn path(&self) -> PathBuf {
        self.dir.join("appdata/tasks-v1.json")
    }
    fn manager(&self) -> TaskManager {
        TaskManager::open(self.path()).unwrap()
    }
    fn request(&self, tasks: Vec<TaskDraft>) -> TaskPlanRequest {
        TaskPlanRequest {
            repository_root: self.repo.clone(),
            expected_head_sha: self.head.clone(),
            tasks,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn draft(key: &str, dependencies: &[&str]) -> TaskDraft {
    serde_json::from_value(serde_json::json!({
        "key": key, "title": "Implement task", "goal": "A bounded goal", "scope": ["src"],
        "kind": "implementation", "dependencyKeys": dependencies, "profile": null, "autoCommit": false
    })).unwrap()
}
fn attempt(state: &str) -> TaskAttempt {
    serde_json::from_value(serde_json::json!({
        "id": new_id(), "state": state, "phase": "implementation", "candidateSha": null,
        "failure": null, "startedAtMs": now_ms(), "endedAtMs": null, "evidence": null
    }))
    .unwrap()
}
#[test]
fn plan_freezes_dependencies_and_events_in_one_generation() {
    let f = Fixture::new();
    let m = f.manager();
    let tasks = m
        .accept_plan(f.request(vec![draft("a", &[]), draft("b", &["a"])]))
        .unwrap();
    assert_eq!(tasks[1].dependencies, vec![tasks[0].id.clone()]);
    assert_eq!(tasks[0].base_sha, f.head);
    assert!(tasks
        .iter()
        .all(|t| t.attempts.is_empty() && t.workspace_root.is_none()));
    let events = m.events(0).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].seq, 1);
    assert_eq!(events[1].seq, 2);
    assert_eq!(m.events(1).unwrap().len(), 1);
    drop(m);
    let reopened = f.manager();
    assert_eq!(
        reopened.get(&tasks[1].id).unwrap().dependencies,
        vec![tasks[0].id.clone()]
    );
    assert_eq!(reopened.events(0).unwrap().len(), 2);
    assert_eq!(reopened.storage_dir(), f.path().parent().unwrap());
    assert!(!PathBuf::from(&f.repo).join(".virtuallab").exists());
}
#[test]
fn invalid_plans_never_partially_persist() {
    let f = Fixture::new();
    let m = f.manager();
    for tasks in [
        vec![],
        vec![draft("a", &["missing"])],
        vec![draft("a", &["a"])],
        vec![draft("a", &["b"]), draft("b", &["a"])],
        vec![draft("a", &[]), draft("a", &[])],
    ] {
        assert!(m.accept_plan(f.request(tasks)).is_err());
    }
    let mut stale = f.request(vec![draft("a", &[])]);
    stale.expected_head_sha = "0".repeat(40);
    assert!(m.accept_plan(stale).is_err());
    assert!(m.events(0).unwrap().is_empty());
    assert!(m.all().unwrap().is_empty());
}
#[test]
fn dependencies_cannot_cross_repository_and_list_uses_native_identity() {
    let f = Fixture::new();
    let other = Fixture::new();
    let m = f.manager();
    let task = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    assert!(m
        .accept_plan(other.request(vec![draft("b", &[&task.id])]))
        .is_err());
    assert!(m
        .accept_plan(f.request(vec![draft("b", &[&task.id])]))
        .is_ok());
    assert!(m.list(&[]).unwrap().is_empty());
    assert!(m.list(&[other.repo.clone()]).unwrap().is_empty());
    assert_eq!(m.list(&[format!("{}/.", f.repo)]).unwrap().len(), 2);
    assert!(m.list(&[format!("{}/missing", f.repo)]).is_err());
    #[cfg(unix)]
    {
        let alias = f.dir.join("alias");
        std::os::unix::fs::symlink(&f.repo, &alias).unwrap();
        assert_eq!(m.list(&[alias.to_str().unwrap().into()]).unwrap().len(), 2);
    }
}
#[test]
fn scope_and_profile_paths_use_native_canonical_repository_base() {
    let f = Fixture::new();
    let repo = PathBuf::from(&f.repo);
    fs::create_dir_all(repo.join("Source Dir/代码 with spaces")).unwrap();
    fs::write(
        repo.join("Source Dir/代码 with spaces/nested.rs"),
        "fixture",
    )
    .unwrap();
    fs::create_dir(repo.join("Build Dir")).unwrap();
    let mut roots = vec![f.repo.clone()];
    #[cfg(unix)]
    {
        let alias = f.dir.join("repository-alias");
        std::os::unix::fs::symlink(&repo, &alias).unwrap();
        roots.push(alias.to_str().unwrap().into());
    }
    #[cfg(windows)]
    {
        // Native canonical paths are verbatim; durable identity keys are
        // non-verbatim, slash-normalized and lower-case. Both must be usable.
        roots.push(fs::canonicalize(&repo).unwrap().to_str().unwrap().into());
        roots.push(validation::canonical_root(&f.repo).unwrap());
        roots.push(f.repo.to_ascii_uppercase());
    }
    for root in roots {
        let mut d = draft("native-paths", &[]);
        d.scope = vec![
            "Source Dir/代码 with spaces/nested.rs".into(),
            "future-source/file".into(),
        ];
        d.profile = Some(
            serde_json::json!({"schemaVersion":1,"id":"checks","name":"Checks",
            "sourcePaths":["Source Dir/代码 with spaces/nested.rs"],"outputPaths":["Build Dir/future-output"],
            "gates":[{"id":"build","label":"Build","kind":"build","required":true,"approval":"none",
            "executor":{"type":"process","program":"cargo","args":["check"],"cwd":"workspace"}}]}),
        );
        validation::draft(&d, &root).unwrap();
        #[cfg(windows)]
        {
            d.scope = vec!["sOuRcE dIr/代码 with spaces/NESTED.rs".into()];
            validation::draft(&d, &root).unwrap();
        }
        for protected in [".GiT/config", ".EnV.local", "../outside"] {
            d.scope = vec![protected.into()];
            assert!(validation::draft(&d, &root).is_err());
        }
    }
}
#[test]
fn scopes_reject_traversal_secrets_and_oversize() {
    let f = Fixture::new();
    let m = f.manager();
    for scope in [
        vec![],
        vec!["../outside"],
        vec!["/absolute"],
        vec!["C:\\absolute"],
        vec!["src\\..\\secret"],
        vec![".git/config"],
        vec![".GIT/config"],
        vec![".env"],
        vec!["src/.env.local"],
        vec!["src//x"],
        vec!["./src"],
        vec!["src\nsecret"],
        vec!["src/*"],
        vec!["src"; 129],
    ] {
        let mut d = draft("a", &[]);
        d.scope = scope.into_iter().map(String::from).collect();
        assert!(m.accept_plan(f.request(vec![d])).is_err());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&f.dir, PathBuf::from(&f.repo).join("escape")).unwrap();
        let mut d = draft("a", &[]);
        d.scope = vec!["escape/new-file".into()];
        assert!(m.accept_plan(f.request(vec![d])).is_err());
    }
    assert!(m.events(0).unwrap().is_empty());
}
#[test]
fn profiles_preserve_paths_but_reject_inline_code_and_shells() {
    let f = Fixture::new();
    let m = f.manager();
    let profile = serde_json::json!({"schemaVersion":1,"id":"checks","name":"Checks",
        "outputPaths":["dist"],"sourcePaths":["ignored-source"],"gates":[{
        "id":"build","label":"Build","kind":"build","required":true,"approval":"none",
        "executor":{"type":"process","program":"npm","args":["run","build"],"cwd":"workspace"}}]});
    let mut d = draft("a", &[]);
    d.profile = Some(profile.clone());
    let task = m.accept_plan(f.request(vec![d])).unwrap().remove(0);
    let saved = f.manager().get(&task.id).unwrap().profile.unwrap();
    assert_eq!(saved["outputPaths"], serde_json::json!(["dist"]));
    assert_eq!(saved["sourcePaths"], serde_json::json!(["ignored-source"]));
    for (program, args) in [
        ("sh", vec!["-c", "anything"]),
        ("cmd.exe", vec!["/c", "anything"]),
        ("node", vec!["-e", "anything"]),
        ("python", vec!["-c", "anything"]),
    ] {
        let mut p = profile.clone();
        p["gates"][0]["executor"]["program"] = program.into();
        p["gates"][0]["executor"]["args"] = serde_json::json!(args);
        let mut d = draft("bad", &[]);
        d.profile = Some(p);
        assert!(m.accept_plan(f.request(vec![d])).is_err());
    }
    let mut p = profile;
    p["sourcePaths"] = serde_json::json!([".env"]);
    let mut d = draft("bad", &[]);
    d.profile = Some(p);
    assert!(m.accept_plan(f.request(vec![d])).is_err());
}
#[test]
fn failed_save_and_rejected_update_roll_back_record_and_sequence() {
    let f = Fixture::new();
    let m = f.manager();
    let task = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    assert!(m
        .update(&task.id, |t| {
            t.title = "Rejected".into();
            Err("rejected".into())
        })
        .is_err());
    let backup = f.path().with_extension("backup");
    fs::rename(f.path(), &backup).unwrap();
    fs::create_dir(f.path()).unwrap();
    assert!(m
        .update(&task.id, |t| {
            t.title = "Not durable".into();
            Ok(())
        })
        .is_err());
    assert_eq!(m.get(&task.id).unwrap().title, "Implement task");
    assert_eq!(m.events(0).unwrap().len(), 1);
    fs::remove_dir(f.path()).unwrap();
    fs::rename(backup, f.path()).unwrap();
    let saved = m
        .update(&task.id, |t| {
            t.title = "Durable".into();
            Ok(())
        })
        .unwrap();
    assert_eq!(saved.revision, 2);
    assert_eq!(m.events(1).unwrap()[0].seq, 2);
    assert_eq!(f.manager().get(&task.id).unwrap().title, "Durable");
}
#[test]
fn reopening_interrupts_queued_running_stopping_once_without_replay() {
    let f = Fixture::new();
    let m = f.manager();
    let tasks = m
        .accept_plan(f.request(vec![draft("a", &[]), draft("b", &[]), draft("c", &[])]))
        .unwrap();
    for (t, state) in tasks.iter().zip(["running", "stopping", "queued"]) {
        m.update(&t.id, |t| {
            t.attempts.push(attempt(state));
            Ok(())
        })
        .unwrap();
    }
    drop(m);
    let m = f.manager();
    for task in &tasks {
        let t = m.get(&task.id).unwrap();
        assert_eq!(t.attempts[0].state, "interrupted");
        assert!(t.attempts[0].ended_at_ms.is_some());
    }
    let count = m.events(0).unwrap().len();
    drop(m);
    assert_eq!(f.manager().events(0).unwrap().len(), count);
}
#[test]
fn queued_attempt_limit_rolls_back_the_thirty_third() {
    let f = Fixture::new();
    let m = f.manager();
    let tasks = m
        .accept_plan(f.request((0..33).map(|i| draft(&format!("k{i}"), &[])).collect()))
        .unwrap();
    for t in &tasks[..32] {
        m.update(&t.id, |t| {
            t.attempts.push(attempt("queued"));
            Ok(())
        })
        .unwrap();
    }
    assert!(m
        .update(&tasks[32].id, |t| {
            t.attempts.push(attempt("queued"));
            Ok(())
        })
        .is_err());
    assert!(m.get(&tasks[32].id).unwrap().attempts.is_empty());
}
#[test]
fn corruption_schema_ids_dependencies_and_event_lineage_fail_closed() {
    let f = Fixture::new();
    let m = f.manager();
    m.accept_plan(f.request(vec![draft("a", &[])])).unwrap();
    drop(m);
    let valid = fs::read(f.path()).unwrap();
    let original: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    for changed in ["{", "null", "{\"schemaVersion\":999}"] {
        fs::write(f.path(), changed).unwrap();
        assert!(TaskManager::open(f.path()).is_err());
    }
    for mutate in 0..5 {
        let mut v = original.clone();
        match mutate {
            0 => v["schemaVersion"] = 2.into(),
            1 => v["tasks"][0]["id"] = "../bad".into(),
            2 => v["tasks"][0]["dependencies"] = serde_json::json!(["missing"]),
            3 => v["events"][0]["seq"] = 9.into(),
            _ => v["events"][0]["taskId"] = "missing".into(),
        }
        fs::write(f.path(), serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(TaskManager::open(f.path()).is_err());
    }
    fs::write(f.path(), &valid).unwrap();
    let file = fs::OpenOptions::new().write(true).open(f.path()).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    assert!(TaskManager::open(f.path()).is_err());
}
#[test]
fn structural_record_api_preserves_attempt_lineage_and_validates_literals() {
    let f = Fixture::new();
    let m = f.manager();
    let task = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let a = attempt("queued");
    let id = a.id.clone();
    m.record(&task.id, Some(&id), "attempt.queued", |t| {
        t.attempts.push(a);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        m.events(1).unwrap()[0].attempt_id.as_deref(),
        Some(id.as_str())
    );
    assert!(m
        .record(&task.id, None, "raw secret payload", |_| Ok(()))
        .is_err());
    assert!(m
        .update(&task.id, |t| {
            t.id = "replacement".into();
            Ok(())
        })
        .is_err());
    assert!(m
        .update(&task.id, |t| {
            t.attempts.clear();
            Ok(())
        })
        .is_err());
    assert!(m
        .update(&task.id, |t| {
            t.attempts[0].phase = "arbitrary".into();
            Ok(())
        })
        .is_err());
}
#[test]
fn clones_serialize_updates_without_losing_events() {
    let f = Fixture::new();
    let m = f.manager();
    let t = m
        .accept_plan(f.request(vec![draft("a", &[])]))
        .unwrap()
        .remove(0);
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let m = m.clone();
            let id = t.id.clone();
            std::thread::spawn(move || m.update(&id, |_| Ok(())).unwrap())
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(m.get(&t.id).unwrap().revision, 9);
    assert_eq!(f.manager().events(0).unwrap().len(), 9);
}

#[test]
fn accepted_task_profile_is_independent_of_library_updates() {
    let f=Fixture::new(); let library=crate::task_profiles::TaskProfileLibrary::open(f.dir.join("profiles.json")).unwrap();
    let profile=serde_json::json!({"schemaVersion":1,"id":"checks","name":"Original","gates":[{"id":"unit","label":"Unit","kind":"unit","required":true,"approval":"none","executor":{"type":"process","program":"npm","args":["test"],"cwd":"workspace"}}]});
    library.save(crate::task_profiles::SaveProfileRequest{profile:profile.clone(),expected_revision:None}).unwrap();
    let m=f.manager();let mut d=draft("impl",&[]);d.profile=Some(profile.clone());let tasks=m.accept_plan(f.request(vec![d])).unwrap();
    let mut changed=profile.clone();changed["name"]="Changed".into();library.save(crate::task_profiles::SaveProfileRequest{profile:changed,expected_revision:Some(1)}).unwrap();
    assert_eq!(m.get(&tasks[0].id).unwrap().profile,Some(profile));
}
