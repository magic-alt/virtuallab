# Run build workflow validation

The automated suite covers compact configuration selection, MinGW/MSVC preset argument preservation, script import/save, stale picker results after workspace switches, literal argument whitespace, Keil target discovery and warning-only exits, scoped script import, and relative launchers with spaces/Unicode. Script fixtures actually execute Node and Windows batch programs and check the resulting artifact and failure exit status.

Run `npm run acceptance:local` on each supported platform. On Windows, ConPTY lifetime tests need normal local process permissions; restricted agent sandboxes can reject descendant termination. This does not justify skipping those tests: rerun the complete acceptance command with normal local permissions.

For explicitly selected local projects, the opt-in native probe reads an ignored `src-tauri/target/run-build-probe.json` descriptor. It is never run by normal acceptance. Each array entry has `workspaceRoot`, optional `scriptPath` or `recipeId`, and optional `args` (an argument array). Include paths and non-secret build arguments only. An entry without a script/recipe only inspects available configurations. Example:

```json
[
  { "workspaceRoot": "C:/selected-firmware" },
  {
    "workspaceRoot": "C:/selected-host",
    "scriptPath": "scripts/build.ps1",
    "args": ["-Configuration", "Release"]
  }
]
```

Run explicitly after reviewing the selected script/recipe:

```text
cargo test --lib --locked --manifest-path src-tauri/Cargo.toml selected_project_build_probe -- --ignored --nocapture
```

The probe uses the same structured launcher, script importer and Keil log/exit adapters as Run. Diagnostics and structured results stay under ignored `src-tauri/target/run-build-probe-*`. Select build-only entry points; this probe does not authorize flash, deployment, release or hardware actions. It does not exercise WebView dialogs or replace desktop UI acceptance.

For a manual desktop check, select a repository/worktree, open Run and switch build configurations. Only the selected recipe should have a build card. In a mixed firmware/SIL repository, Keil targets precede explicitly labelled host/simulation presets. Customize a target and use Browse program if choosing a different UV4 installation. Import a repository script, review its interpreter/arguments, save and Run; check output, Stop and failure results. Switch worktrees to confirm relative script portability.
