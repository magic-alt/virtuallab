import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor } from "./doctor.mjs";

const args = new Set(process.argv.slice(2));
const launch = args.has("--launch");

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
  runStep("Terminal process fixture regression", process.execPath,
    ["--test", "scripts/terminal-process.node-check.mjs"], doctor.env);
  runStep(
    "Rust native tests",
    "cargo",
    ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--", "--nocapture"],
    doctor.env,
  );
} catch (error) {
  console.error("\n" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

console.log("\nAutomated checks passed.");
console.log("\nDesktop acceptance checklist:");
console.log("[ ] Add repository opens the native folder picker and loads the selected Git repository.");
console.log("[ ] Search filters repository/workspace lanes; Ctrl+K focuses it; Escape/clear resets it.");
console.log("[ ] New Workspace creates an isolated branch/worktree; selecting it changes active workspace.");
console.log("[ ] Remove Workspace refuses the primary worktree; clean worktrees remove normally, while dirty worktrees require a second native Force remove confirmation. Cancel preserves files and selection; stale preflight is rejected.");
console.log("[ ] Refresh reloads Git state.");
console.log("[ ] Footer shows the running executable's Git commit/dirty marker. Click it to inspect full commit, branch, UTC build time and Debug/Release; workspace switches do not change this record. Browser preview and missing Git metadata are explicit.");
console.log("[ ] Build identity freshness: rebuild after a branch-only switch, a tracked edit and a non-ignored untracked file; the new executable records each new state and build time. At 640x360 and with long branch names, details remain scrollable and closable.");
console.log("[ ] Terminal: Start/New tab, tab switch, typing, Ctrl+C, resize and Stop all work.");
console.log("[ ] macOS terminal from Finder/Dock: Backspace visibly erases characters, left/right arrows edit the line, and Enter executes the edited command.");
console.log("[ ] Terminal retention: start shells in two worktrees and a second repository; switch Terminal/Run and workspace/repository pages while output continues. Returning restores each original shell, selected terminal and scrollback; typing/resize still work. Close stops only that session; application exit cleans all retained sessions.");
console.log("[ ] Run: repository-scoped Build/Test profile Run streams output; Stop terminates; add/remove profile works.");
console.log("[ ] Run layout: stream 2000+ short/very long compiler lines at desktop >=1280px; only the log scrollbar moves, output panel and outer workbench stay fixed.");
console.log("[ ] Run layout: scroll the left workflow column separately; resizing the window below 1280px stacks cards and keeps the log height bounded with its own scrollbar.");
console.log("[ ] Run scrollback: manually scroll the log upward while compilation continues; position stays stable; Latest output restores follow-tail.");
console.log("[ ] Other scroll boundaries: Terminal scrollback, Changes file list/diff, GitHub CI lists and Agents timeline do not stretch the whole workbench.");
console.log("[ ] Changes/Checks/History/Overview tabs render and switch correctly.");
console.log("[ ] Filesystem edits update repository status without manual refresh.");
console.log("\nV0.3 Phase A diff acceptance:");
console.log("[ ] Worktree mode shows an unstaged tracked-file diff.");
console.log("[ ] Staged mode shows the staged version and hides unstaged-only files.");
console.log("[ ] Base mode loads baseRef...HEAD files even when the working tree is clean.");
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
