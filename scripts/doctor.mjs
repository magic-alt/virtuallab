import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";

function probe(command, args = ["--version"], env = process.env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    shell: false,
  });
  return {
    ok: result.status === 0,
    text: (result.stdout || result.stderr || "").trim(),
    error: result.error,
  };
}

export function resolveCargoEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const direct = probe("cargo", ["--version"], env);
  if (direct.ok) return { env, cargo: "cargo", version: direct.text, recoveredPath: false };

  const executable = isWindows ? "cargo.exe" : "cargo";
  const fallback = path.join(homedir(), ".cargo", "bin", executable);
  if (existsSync(fallback)) {
    env.PATH = [path.dirname(fallback), env.PATH || ""].filter(Boolean).join(path.delimiter);
    const recovered = probe(fallback, ["--version"], env);
    if (recovered.ok) {
      return { env, cargo: fallback, version: recovered.text, recoveredPath: true };
    }
  }

  return { env, cargo: null, version: null, recoveredPath: false };
}

export function runDoctor({ exitOnFailure = true } = {}) {
  const rows = [];
  const node = probe(process.execPath, ["--version"]);
  rows.push(["Node", node.ok, node.text]);

  const git = probe("git");
  rows.push(["Git", git.ok, git.text]);

  const cargoResult = resolveCargoEnv();
  rows.push([
    "Cargo",
    Boolean(cargoResult.cargo),
    cargoResult.version || "not found",
  ]);

  const rustc = cargoResult.cargo
    ? probe("rustc", ["--version"], cargoResult.env)
    : { ok: false, text: "not checked" };
  rows.push(["Rustc", rustc.ok, rustc.text]);

  console.log("\nVirtualLab desktop toolchain doctor\n");
  for (const [name, ok, detail] of rows) {
    console.log(`${ok ? "OK " : "ERR"}  ${name.padEnd(8)} ${detail}`);
  }

  if (cargoResult.recoveredPath) {
    console.log("\nINFO Cargo was found under ~/.cargo/bin and will be added to PATH for VirtualLab scripts.");
  }

  const ok = rows.every(([, passed]) => passed);
  if (!ok) {
    console.error("\nVirtualLab desktop development requires Node.js, Git and the Rust toolchain.");
    if (!cargoResult.cargo) {
      if (process.platform === "win32") {
        console.error("Windows quick install: winget install Rustlang.Rustup");
        console.error("Then restart PowerShell and run: rustup default stable");
        console.error("Expected Cargo location: %USERPROFILE%\\.cargo\\bin\\cargo.exe");
      } else {
        console.error("Install rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh");
        console.error('Then load the toolchain: source "$HOME/.cargo/env"');
        console.error("Expected Cargo location: ~/.cargo/bin/cargo");
      }
    }
    console.error("\nFrontend-only preview remains available with: npm run dev\n");
    if (exitOnFailure) process.exit(1);
  }

  return { ok, env: cargoResult.env };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = path.resolve(fileURLToPath(import.meta.url));

if (invokedPath === modulePath) {
  runDoctor();
}
