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
console.log("[ ] Remove Workspace refuses primary/dirty worktrees and removes a clean isolated worktree.");
console.log("[ ] Refresh reloads Git state.");
console.log("[ ] Terminal: Start/New tab, tab switch, typing, Ctrl+C, resize and Stop all work.");
console.log("[ ] Run: repository-scoped Build/Test profile Run streams output; Stop terminates; add/remove profile works.");
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
