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

const isWindows = process.platform === "win32";
const bin = path.resolve(
  "node_modules",
  ".bin",
  isWindows ? "tauri.cmd" : "tauri",
);

const result = spawnSync(bin, [mode, ...tauriArgs], {
  stdio: "inherit",
  env,
  shell: isWindows,
});

if (result.error) {
  console.error(`Failed to start Tauri: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
