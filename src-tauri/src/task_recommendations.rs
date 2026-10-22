//! Read-only, repository-scoped facts for task suggestions. No script is executed.
use serde::Serialize;
use std::{fs, io::Read, path::{Path, PathBuf}};

const MAX_MANIFEST_BYTES: u64 = 1_048_576;
const MAX_ROOT_ENTRIES: usize = 256;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetectedCheck {
    id: String,
    name: String,
    kind: &'static str,
    program: &'static str,
    args: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryTaskContext {
    repository_root: String,
    recipes: Vec<crate::build_workflows::BuildSuggestion>,
    checks: Vec<DetectedCheck>,
    source_paths: Vec<String>,
    manifest_paths: Vec<String>,
    documentation_paths: Vec<String>,
    ci_paths: Vec<String>,
    known_paths: Vec<String>,
    warnings: Vec<String>,
}

/// Every path component must remain inside the selected root and be nonsymlink.
/// Only bounded known manifests are read; directory entries supply names only.
fn safe_entry(root: &Path, relative: &str) -> Option<(PathBuf, fs::Metadata)> {
    crate::task_inputs::safe_relative(relative, false).ok()?;
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        path.push(component);
        if fs::symlink_metadata(&path).ok()?.file_type().is_symlink() { return None; }
    }
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() && !metadata.is_dir() { return None; }
    let canonical = fs::canonicalize(&path).ok()?;
    if !canonical.starts_with(root) { return None; }
    Some((path, metadata))
}

fn manifest(root: &Path, relative: &str) -> Result<Option<String>, String> {
    let Some((path, metadata)) = safe_entry(root, relative) else { return Ok(None) };
    if !metadata.is_file() { return Ok(None); }
    if metadata.len() > MAX_MANIFEST_BYTES { return Err(format!("{relative} exceeds the 1 MiB discovery limit.")); }
    let mut text = String::new();
    fs::File::open(path).and_then(|file| file.take(MAX_MANIFEST_BYTES + 1).read_to_string(&mut text))
        .map_err(|_| format!("Cannot read {relative} for recommendations."))?;
    if text.len() as u64 > MAX_MANIFEST_BYTES { return Err(format!("{relative} exceeds the 1 MiB discovery limit.")); }
    Ok(Some(text))
}

fn existing(root: &Path, candidates: &[&str]) -> Vec<String> {
    candidates.iter().filter(|path| safe_entry(root, path).is_some()).map(|path| (*path).into()).collect()
}

fn source_file(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()).is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(),
        "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx" | "rs" | "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" |
        "py" | "go" | "java" | "kt" | "cs" | "swift" | "m" | "mm" | "v" | "sv" | "vhd" | "vhdl" | "s" | "asm"))
}

fn inspect(root: &Path, repository_root: String) -> Result<RepositoryTaskContext, String> {
    let mut result = RepositoryTaskContext {
        repository_root, recipes: vec![], checks: vec![],
        source_paths: existing(root, &["src", "lib", "include", "app", "apps", "packages", "tests", "test", "src-tauri", "firmware", "Core", "Drivers"]),
        manifest_paths: existing(root, &["package.json", "package-lock.json", "npm-shrinkwrap.json", "Cargo.toml", "Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "CMakeLists.txt", "CMakePresets.json", "CMakeUserPresets.json"]),
        documentation_paths: existing(root, &["README.md", "README.rst", "README", "CONTRIBUTING.md", "docs", "doc"]),
        ci_paths: existing(root, &[".github/workflows", ".gitlab-ci.yml", "azure-pipelines.yml", "Jenkinsfile", ".circleci"]),
        known_paths: vec![], warnings: vec![],
    };
    let mut entries: Vec<_> = fs::read_dir(root).map_err(|_| "Cannot inspect repository entries.")?
        .take(MAX_ROOT_ENTRIES + 1).filter_map(Result::ok).collect();
    if entries.len() > MAX_ROOT_ENTRIES {
        result.warnings.push("Repository entry discovery was limited to 256 names; manual scope remains available.".into());
        entries.truncate(MAX_ROOT_ENTRIES);
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if let Some((path, metadata)) = safe_entry(root, &name) {
            if metadata.is_file() && source_file(&path) && !result.source_paths.contains(&name) { result.source_paths.push(name.clone()); }
            result.known_paths.push(name);
        }
    }
    for path in result.manifest_paths.iter().chain(&result.ci_paths).chain(&result.documentation_paths).chain(&result.source_paths) {
        if !result.known_paths.contains(path) { result.known_paths.push(path.clone()); }
    }

    // Reuse the native Run detector, but never let its manifest discovery follow
    // a symlink or a nonregular special file through this background endpoint.
    let run_inputs = ["package.json", "CMakeLists.txt", "CMakePresets.json", "CMakeUserPresets.json", "cmake"];
    if run_inputs.iter().all(|path| fs::symlink_metadata(root.join(path)).is_err() || safe_entry(root, path).is_some()) {
        let discovery = crate::build_workflows::discover_with_status(root);
        result.recipes = discovery.suggestions;
        if discovery.limited {
            result.warnings.push("Run recipe discovery was limited; some nested projects may be missing. Review the available recipes or use a saved Profile.".into());
        }
    } else {
        result.warnings.push("Run recipe discovery skipped a symlink or special-file manifest; review it manually.".into());
    }

    match manifest(root, "package.json") {
        Ok(Some(text)) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => {
                if let Some(scripts) = value.get("scripts").and_then(serde_json::Value::as_object) {
                    for (name, kind) in [("build", "build"), ("tauri:build", "build"), ("test", "unit"), ("test:ci", "unit"), ("typecheck", "build"), ("check", "build"), ("lint", "build"), ("docs:build", "build"), ("docs:check", "build"), ("build:docs", "build"), ("lint:docs", "build")] {
                        if scripts.get(name).and_then(serde_json::Value::as_str).is_some_and(|script| !script.trim().is_empty()) {
                            result.checks.push(DetectedCheck { id: format!("npm-{}", name.replace(':', "-")), name: format!("npm · {name}"), kind, program: "npm", args: vec!["run".into(), name.into()] });
                        }
                    }
                }
            }
            Err(_) => result.warnings.push("package.json is invalid JSON; no package script checks were suggested.".into()),
        },
        Ok(None) => {},
        Err(error) => result.warnings.push(error),
    }
    if manifest(root, "Cargo.toml")?.is_some() {
        let locked = safe_entry(root, "Cargo.lock").is_some_and(|(_, metadata)| metadata.is_file());
        for (command, kind) in [("build", "build"), ("check", "build"), ("test", "unit")] {
            let mut args = vec![command.into()];
            if locked { args.push("--locked".into()); }
            result.checks.push(DetectedCheck { id: format!("cargo-{command}"), name: format!("Cargo · {command}"), kind, program: "cargo", args });
        }
    } else if result.manifest_paths.iter().any(|path| path == "src-tauri/Cargo.toml") {
        result.warnings.push("Nested Cargo manifest detected. Task verification does not qualify --manifest-path; use the project's detected package script or a reviewed saved Profile.".into());
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn task_recommendation_context(repository_root: String) -> Result<RepositoryTaskContext, String> {
    if repository_root.len() > 4096 || !Path::new(&repository_root).is_absolute() {
        return Err("Select an absolute repository root for task recommendations.".into());
    }
    let root = fs::canonicalize(&repository_root).map_err(|_| "Repository is unavailable.")?;
    let top = crate::task_inputs::git(&root, &["rev-parse", "--show-toplevel"])?;
    let top = fs::canonicalize(top.trim_end_matches(['\r', '\n'])).map_err(|_| "Cannot identify repository root.")?;
    if crate::workspace_identity::key(&top.to_string_lossy()) != crate::workspace_identity::key(&root.to_string_lossy()) {
        return Err("Select the repository or worktree root, not a subdirectory.".into());
    }
    inspect(&root, repository_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("task-recommendations-{}", crate::tasks::new_id()));
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn write(&self, path: &str, value: &str) {
            let target = self.0.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, value).unwrap();
        }
        fn inspect(&self) -> RepositoryTaskContext { inspect(&self.0, self.0.to_string_lossy().into_owned()).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn only_existing_scripts_and_actual_paths_are_recommended_without_execution() {
        let fixture = Fixture::new();
        fixture.write("package.json", r#"{"scripts":{"test":"node missing-script.js", "lint":"eslint .", "deploy":"publish"}}"#);
        fixture.write("src/main.ts", ""); fixture.write("README.md", ""); fixture.write(".github/workflows/check.yml", "");
        let context = fixture.inspect();
        assert_eq!(context.checks.iter().map(|check| check.id.as_str()).collect::<Vec<_>>(), ["npm-test", "npm-lint"]);
        assert_eq!(context.checks[0].args, ["run", "test"]);
        assert_eq!(context.source_paths, ["src"]);
        assert_eq!(context.documentation_paths, ["README.md"]);
        assert_eq!(context.ci_paths, [".github/workflows"]);
        assert!(context.recipes.is_empty());
    }
    #[test]
    fn cargo_lock_is_used_only_when_present_and_nested_manifests_are_not_fabricated_gates() {
        let fixture = Fixture::new(); fixture.write("Cargo.toml", "[package]\nname = 'sample'\nversion = '0.1.0'\n");
        assert_eq!(fixture.inspect().checks[0].args, ["build"]);
        fixture.write("Cargo.lock", "version = 4\n");
        assert_eq!(fixture.inspect().checks[0].args, ["build", "--locked"]);
        fs::remove_file(fixture.0.join("Cargo.toml")).unwrap(); fixture.write("src-tauri/Cargo.toml", "[package]");
        let context = fixture.inspect(); assert!(context.checks.is_empty()); assert!(!context.warnings.is_empty());
    }
    #[test]
    fn malformed_and_oversized_manifests_never_generate_package_checks() {
        let fixture = Fixture::new(); fixture.write("package.json", "{invalid");
        assert!(fixture.inspect().checks.is_empty()); assert!(!fixture.inspect().warnings.is_empty());
        fixture.write("package.json", &" ".repeat(MAX_MANIFEST_BYTES as usize + 1));
        assert!(fixture.inspect().checks.is_empty()); assert!(!fixture.inspect().warnings.is_empty());
    }
    #[test]
    fn includes_actual_root_sources_in_nonstandard_cmake_layouts() {
        let fixture = Fixture::new();
        fixture.write("CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(sample)\n");
        fixture.write("main.cpp", "int main() { return 0; }");
        fixture.write("public_api.hpp", "#pragma once");
        let context = fixture.inspect();
        assert!(context.source_paths.contains(&"main.cpp".to_owned()));
        assert!(context.source_paths.contains(&"public_api.hpp".to_owned()));
        assert!(!context.recipes.is_empty());
    }
    #[test]
    fn environment_named_build_inputs_are_not_discovered() {
        let fixture = Fixture::new();
        fixture.write(".env.private/project.uvprojx", "<Project><Targets><Target><TargetName>private</TargetName></Target></Targets></Project>");
        fixture.write(".env.uvprojx", "<Project/>");
        assert!(fixture.inspect().recipes.is_empty());
    }

    #[test]
    fn large_nested_directory_limits_background_recipe_discovery_and_reports_partial_results() {
        let fixture = Fixture::new();
        // One root entry avoids the separate root-name cap masking an
        // unbounded nested Run scan. All entries are harmless regular files.
        for index in 0..300 {
            fixture.write(&format!("large-tree/entry-{index:04}.txt"), "");
        }
        let context = fixture.inspect();
        assert!(context.recipes.is_empty());
        assert!(context.warnings.iter().any(|warning| warning.contains("Run recipe discovery was limited")));
        assert!(!context.warnings.iter().any(|warning| warning.contains("Repository entry discovery")));
    }
    #[cfg(unix)]
    #[test]
    fn external_symlinks_and_secret_paths_never_supply_context() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new(); let outside = Fixture::new();
        outside.write("package.json", r#"{"scripts":{"test":"secret-command"}}"#);
        symlink(outside.0.join("package.json"), fixture.0.join("package.json")).unwrap();
        symlink(&outside.0, fixture.0.join("docs")).unwrap(); fixture.write(".env", "secret");
        let context = fixture.inspect();
        assert!(context.checks.is_empty()); assert!(context.recipes.is_empty());
        assert!(!context.known_paths.iter().any(|path| [".env", "package.json", "docs"].contains(&path.as_str())));
    }
    #[test]
    fn endpoint_requires_a_git_root_and_rejects_a_repository_subdirectory() {
        let fixture = Fixture::new();
        assert!(task_recommendation_context(fixture.0.to_string_lossy().into_owned()).is_err());
        crate::task_inputs::git(&fixture.0, &["init", "-q"]).unwrap();
        assert!(task_recommendation_context(fixture.0.to_string_lossy().into_owned()).is_ok());
        fs::create_dir(fixture.0.join("src")).unwrap();
        assert!(task_recommendation_context(fixture.0.join("src").to_string_lossy().into_owned()).is_err());
    }
}
