import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor } from "./doctor.mjs";

const args = new Set(process.argv.slice(2));
const launch = args.has("--launch");
// Only the macOS core CI job uses this flag. Separate required jobs run the
// excluded real-Git fixture modules, so no test is omitted from the CI gate.
const nativeCoreShard = args.has("--native-core");

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);

  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) {
    throw new Error(
      "Unable to resolve npm-cli.js. Run this through 'npm run acceptance:local' or ensure npm is installed beside Node.js.",
    );
  }
  return npmCli;
}

function runCommand(command, commandArgs, env) {
  if (command === "npm") {
    return spawnSync(process.execPath, [resolveNpmCli(), ...commandArgs], {
      stdio: "inherit",
      env,
      shell: false,
    });
  }

  return spawnSync(command, commandArgs, {
    stdio: "inherit",
    env,
    shell: false,
  });
}

function runStep(name, command, commandArgs, env) {
  console.log("\n== " + name + " ==");
  const result = runCommand(command, commandArgs, env);

  if (result.error) {
    throw new Error(name + " failed to start: " + result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(name + " failed with exit code " + String(result.status));
  }
}

const doctor = runDoctor({ exitOnFailure: false });
if (!doctor.ok) {
  process.exit(1);
}

try {
  runStep("TypeScript typecheck", "npm", ["run", "typecheck"], doctor.env);
  runStep("Frontend control tests", "npm", ["run", "test:controls"], doctor.env);
  runStep("Frontend production build", "npm", ["run", "build"], doctor.env);
  runStep(
    "Rust native tests",
    "cargo",
    [
      "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--", "--nocapture",
      ...(nativeCoreShard ? [
        "--skip", "task_inputs::tests::",
        "--skip", "task_execution::review_tests::",
      ] : []),
    ],
    doctor.env,
  );
} catch (error) {
  console.error("\n" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

console.log(nativeCoreShard
  ? "\nCore acceptance checks passed. The macOS Git-input and provider-review shards must also pass."
  : "\nAutomated checks passed.");
console.log("\nDesktop acceptance checklist:");
console.log("[ ] Control center: enter a task and choose 开始任务 once; its unique worktree, installed Codex process, unchanged goal and live execution console appear automatically. No Profile/auto-commit still permits truthful completed implementation, with edits retained and verification unclaimed.");
console.log("[ ] Queued task ownership: occupy both execution slots, launch a third clean sibling worktree at main, then confirm Clean merged. Its worktree and branch survive with a kept/busy result; releasing a slot starts it in that same workspace. Cancellation releases protection only after durable queued cancellation or observed running-process cleanup.");
console.log("[ ] Task launch recovery: double submission/response loss never creates a second worktree. Setup failure keeps the task and concrete error; uncertain worktree preparation requires reconciliation before any replay.");
console.log("[ ] Task reports: final response, discovered problems and verification status remain available after navigation/restart, including tasks with no Profile and earlier implementation Attempts. Background completion does not replace another task or an explicitly selected review tab; hidden composer drafts survive without background baseline reads.");
console.log("[ ] Advanced tasks: create and accept a manual plan, explicitly prepare a workspace, execute/cancel/retry, verify, review and accept; execution success alone never means accepted delivery.");
console.log("[ ] Task evidence: edit source without changing HEAD, restore it, replace a tool, then restart the application; historical evidence never silently becomes current. New verification requires new review and acceptance.");
console.log("[ ] Task integration: rejected or stale dependencies block preview; native confirmation binds exact source commits and expires. Conflicts retain the worktree and require explicit resolution, never implicit merge replay.");
console.log("[ ] Task tools: committed task changes appear against the accepted base; inline Run/Changes and workspace navigation preserve terminals. Cancel remains available while verification/integration is pending.");
console.log("[ ] Task recovery: interrupted workspace preparation can be reconciled explicitly; corrupt task storage preserves direct workspace tools and never overwrites the original file.");
console.log("[ ] Add repository opens the native folder picker and loads the selected Git repository.");
console.log("[ ] Search filters repository/workspace lanes; Ctrl+K focuses it; Escape/clear resets it.");
console.log("[ ] New Workspace creates an isolated branch/worktree; selecting it changes active workspace.");
console.log("[ ] Remove Workspace refuses the primary worktree; clean worktrees remove normally, while dirty worktrees require a second native Force remove confirmation. Cancel preserves files and selection; stale preflight is rejected.");
console.log("[ ] Git branches recovery: delete a linked worktree directory outside Git, retaining its registration. Restart/select the repository: primary workspace stays usable, missing lane/branch navigation is disabled, and confirmed Remove deletes only its stale registration while retaining its branch and other worktrees.");
console.log("[ ] Clean merged: opens Codex read-only analysis without switching/stashing/fetching. Review structured progress, conclusions and keep reasons; all local/remote/worktree checkboxes start unchecked. Worktree-only keeps its branch. Cancel/model failure never deletes; rule-based fallback requires an explicit click. Confirm lists exact selected SHAs/paths/destination. Refresh/navigation invalidates reports; changed branch/base/destination rejects deletion. Dirty/ignored/locked/current/default/primary and busy task/terminal worktrees survive. Check partial outcomes, timeout/Stop and application-exit process cleanup on Windows/macOS/Linux, including spaces and Unicode paths.");
console.log("[ ] Git audit: Pull uses the configured upstream (including differently named branches and a non-origin remote), refuses missing upstream/divergence and never auto-stashes or rebases. Local/remote branch confirmations display inspected commit identities; changing a ref/destination during the dialog rejects deletion. Remote fetch/push mismatch and multiple push destinations are refused; concurrently updated tracking refs survive.");
console.log("[ ] Header shows Fetch (prunes stale origin refs by default) and no Refresh button. File edits, external Git metadata changes and in-app Git operations refresh local Git state automatically.");
console.log("[ ] Open in IDE: Auto and each installed fixed editor open the selected repository/worktree in a new window. macOS Zed works without installing its CLI in PATH. Unavailable or immediately failing launchers show an error.");
console.log("[ ] Windows Open folder opens the selected repository/worktree (not Documents), including paths with spaces/Unicode and UNC shares. Test both repository and worktree row actions.");
console.log("[ ] Footer shows the running executable's Git commit/dirty marker. Click it to inspect full commit, branch, UTC build time and Debug/Release; workspace switches do not change this record. Browser preview and missing Git metadata are explicit.");
console.log("[ ] Build identity freshness: rebuild after a branch-only switch, a tracked edit and a non-ignored untracked file; the new executable records each new state and build time. At 640x360 and with long branch names, details remain scrollable and closable.");
console.log("[ ] Terminal: Start/New tab, tab switch, typing, Ctrl+C, resize and Stop all work.");
console.log("[ ] Task terminal: from a different repository, click 打开终端 on a task. It opens the exact task worktree and a usable shell; repeated clicks reuse it, stopped shells allow a new one, and rapid navigation cannot spawn in the wrong worktree.");
console.log("[ ] Task delivery: new branch names contain the task title; opt into automatic Draft PR and verify exact branch/base, configured checks, URL/report, and independent retry after auth/network failure. Lost creation responses reconcile without duplicate PRs; old tasks remain unpublished. Use an approved disposable GitHub test repository.");
console.log("[ ] Task recommendations: switch repositories in 流程模板 and 高级任务, inspect real commands/scopes, apply a recommendation, and confirm old repository scope/Profile/PR consent do not leak. Missing or unsupported checks remain explicitly unverified.");
console.log("[ ] Collaboration: add two local repositories, select an explicit companion Worktree in Overview → 协作仓库, and compare its code from Start Codex, Hub workspace sessions and a new Task. Each entry shows the selected path; navigation does not change it. Companion edits require a task owned by that repository.");
console.log("[ ] Collaboration lifetime: change the saved selection during a session, confirm stop/reconnect guidance, and verify existing terminals keep their original references. Referenced repositories/worktrees cannot be detached/removed until their providers stop; ordinary writers remain usable.");
console.log("[ ] Collaboration recovery/permissions: accepted task retries keep their original references; offline or retargeted paths fail new execution without breaking historical reports. Context-free Codex terminals preserve user permissions, read-only remains read-only, and unsupported permission profiles produce an explicit error before a context-enabled provider starts work.");
console.log("[ ] macOS terminal from Finder/Dock: Backspace visibly erases characters, left/right arrows edit the line, and Enter executes the edited command.");
console.log("[ ] Terminal retention: start shells in two worktrees and a second repository; switch Terminal/Run and workspace/repository pages while output continues. Returning restores each original shell, selected terminal and scrollback; typing/resize still work. Close stops only that session; application exit cleans all retained sessions.");
console.log("[ ] Terminal independence: keep a shell open, switch its workspace branch, execute Run/build, and open a second terminal. The original shell, PID and scrollback remain; no terminal-stop confirmation appears. Stop waits for cleanup before reporting completion; active terminals still protect worktree removal and repository detach.");
console.log("[ ] Run: repository-scoped Build/Test profile Run streams output; Stop terminates; add/remove profile works.");
console.log("[ ] Run layout: stream 2000+ short/very long compiler lines at desktop >=1280px; only the log scrollbar moves, output panel and outer workbench stay fixed.");
console.log("[ ] Run layout: scroll the left workflow column separately; resizing the window below 1280px stacks cards and keeps the log height bounded with its own scrollbar.");
console.log("[ ] Run scrollback: manually scroll the log upward while compilation continues; position stays stable; Latest output restores follow-tail.");
console.log("[ ] Other scroll boundaries: Terminal scrollback, Changes file list/diff, GitHub CI lists and Agents timeline do not stretch the whole workbench.");
console.log("[ ] Overview/Changes/GitHub/Agents/Terminal/Run tabs render and switch correctly; no separate Checks or History tab.");
console.log("[ ] Filesystem edits update repository status without manual refresh.");
console.log("\nV0.3 Phase A diff acceptance:");
console.log("[ ] Changes opens with file list/diff and collapsed Advanced review / Manage local changes; opening/closing panels alone never changes Git state.");
console.log("[ ] Worktree mode shows an unstaged tracked-file diff.");
console.log("[ ] Staged mode shows the staged version and hides unstaged-only files.");
console.log("[ ] Advanced review opens Base mode, loads baseRef...HEAD files even when the working tree is clean, and returns to Worktree when collapsed.");
console.log("[ ] Rename / Unicode / space-containing paths remain selectable and preserve old → new identity.");
console.log("[ ] Binary files show the explicit binary state.");
console.log("[ ] Large diffs show the truncated state without freezing the desktop window.");
console.log("\nRelease gate regression checklist (see docs/RELEASE_GATE_V0.5.0.md):");
console.log("[ ] Native confirmation: PR merge/comment, worktree removal, agent forget; cancellation never mutates.");
console.log("[ ] Run reattachment after tab/workspace switches restores output, profile and Stop; Stop stays stopping until exit.");
console.log("[ ] Rapid start/stop and application exit leave no child/grandchild processes or late terminal sessions.");
console.log("[ ] Unix terminal: HUP/TERM-ignoring foreground/background jobs stop across job groups; shell exit cleans inherited PTY holders; other sessions survive.");
console.log("[ ] Windows launcher paths with spaces/Unicode and .cmd/.bat arguments work without shell reinterpretation.");
console.log("[ ] Verification: Stop/timeout/leader exit close inherited pipes; excessive output fails with logs capped at 8 MiB per stream.");
console.log("[ ] macOS Finder/Dock/Terminal: GitHub and each installed Agent detect, authenticate and start with Homebrew CLI interpreters.");
console.log("[ ] Watcher rapid workspace switching never reinstalls a stopped/obsolete watch.");
console.log("[ ] Monaco local workers and native IPC work under production CSP in the packaged WebView.");
console.log("[ ] Signed installer first launch, upgrade, uninstall and SHA-256 recorded per platform.");
console.log("\nRecord failures with command/output and workspace path before merging the current PR.");

if (launch) {
  console.log("\nLaunching Tauri dev runtime...");
  const result = runCommand("npm", ["run", "tauri:dev"], doctor.env);
  if (result.error) {
    console.error("Failed to launch Tauri: " + result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
