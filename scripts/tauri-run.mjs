import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor } from "./doctor.mjs";

const [mode, ...tauriArgs] = process.argv.slice(2);
if (!["dev", "build"].includes(mode)) {
  console.error("Usage: node scripts/tauri-run.mjs <dev|build> [tauri args...]");
  process.exit(2);
}

const { ok, env } = runDoctor({ exitOnFailure: false });
if (!ok) process.exit(1);

const packagePath = path.resolve("node_modules", "@tauri-apps", "cli", "package.json");
if (!existsSync(packagePath)) {
  console.error("Tauri CLI package is missing. Run npm ci first.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const binEntry =
  typeof pkg.bin === "string"
    ? pkg.bin
    : pkg.bin?.tauri;

if (!binEntry) {
  console.error("Unable to resolve the @tauri-apps/cli executable entry.");
  process.exit(1);
}

const cliScript = path.resolve(path.dirname(packagePath), binEntry);
const result = spawnSync(process.execPath, [cliScript, mode, ...tauriArgs], {
  stdio: "inherit",
  env,
  shell: false,
});

if (result.error) {
  console.error(`Failed to start Tauri: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
