//! Opt-in local qualification of user-selected build scripts, outside the normal suite.
//! The ignored target/ descriptor contains paths/argv only, never credentials.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Probe {
    workspace_root: String,
    script_path: Option<String>,
    recipe_id: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

#[test]
#[ignore = "requires an explicitly prepared target/run-build-probe.json with selected workspace paths and script argv"]
fn selected_project_build_probe() {
    let output = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
    let descriptor = fs::read(output.join("run-build-probe.json")).unwrap();
    assert!(descriptor.len() <= 16_384);
    let probes: Vec<Probe> = serde_json::from_slice(&descriptor).unwrap();
    let mut results = Vec::new();
    for (index, probe) in probes.into_iter().enumerate() {
        let recipes = build_workflow_discover(probe.workspace_root.clone()).unwrap();
        let mut summary = serde_json::json!({"workspaceRoot": probe.workspace_root, "recipes": recipes});
        let selected = if let Some(script) = probe.script_path {
            Some(build_workflow_import_script(probe.workspace_root.clone(), script).unwrap())
        } else if let Some(id) = probe.recipe_id {
            Some(build_workflow_discover(probe.workspace_root.clone()).unwrap().into_iter().find(|recipe| recipe.id == id).expect("selected recipe must exist"))
        } else { None };
        if let Some(recipe) = selected {
            assert!(recipe.supported);
            let root = fs::canonicalize(&probe.workspace_root).unwrap();
            let mut passed = true;
            let mut codes = Vec::new();
            for (step_index, mut step) in recipe.steps.into_iter().enumerate() {
                step.args.extend(probe.args.clone());
                let log = inputs::KeilLog::prepare(&step).unwrap();
                let mut command = workspace_process_command(&step.program, &root);
                command.args(&step.args).current_dir(&root);
                if let Some(log) = &log { command.arg("-o").arg(log.path()); }
                let result = command.output().unwrap();
                // Keep build diagnostics local; the probe reports only structured status.
                let stem = format!("run-build-probe-{index}-{step_index}");
                fs::write(output.join(format!("{stem}.stdout.log")), result.stdout).unwrap();
                fs::write(output.join(format!("{stem}.stderr.log")), result.stderr).unwrap();
                let code = result.status.code().unwrap_or(-1);
                codes.push(code);
                passed &= inputs::step_succeeded(&step, code);
                if let Some(log) = &log {
                    let text = log.read().unwrap();
                    fs::write(output.join(format!("{stem}.keil.log")), text).unwrap();
                }
                if !passed { break; }
            }
            summary["exitCode"] = serde_json::json!(if passed { 0 } else { -1 });
            summary["stepExitCodes"] = serde_json::json!(codes);
            results.push(summary);
            fs::write(output.join("run-build-probe-results.json"), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
            assert!(passed, "selected project build failed; inspect local probe diagnostics for entry {index}");
        } else { results.push(summary); }
    }
    fs::write(output.join("run-build-probe-results.json"), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
}
