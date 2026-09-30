import { spawnSync } from "node:child_process";
import { runDoctor } from "./doctor.mjs";

const args = new Set(process.argv.slice(2));
const launch = args.has("--launch");
const isWindows = process.platform === "win32";

function runCommand(command, commandArgs, env) {
  return spawnSync(command, commandArgs, {
    stdio: "inherit",
    env,
    shell: isWindows && command === "npm",
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
    ["test", "--manifest-path", "src-tauri/Cargo.toml"],
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
console.log("\nRecord failures with command/output and workspace path before merging the closeout PR.");

if (launch) {
  console.log("\nLaunching Tauri dev runtime...");
  const result = runCommand("npm", ["run", "tauri:dev"], doctor.env);
  if (result.error) {
    console.error("Failed to launch Tauri: " + result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
