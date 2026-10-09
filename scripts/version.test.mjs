import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectVersions, setVersion } from "./version.mjs";

const repoRoot = process.cwd();
const versionFiles = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "virtuallab-version-"));
  try {
    mkdirSync(path.join(root, "src-tauri"), { recursive: true });
    for (const file of versionFiles) cpSync(path.join(repoRoot, file), path.join(root, file));
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("application version management", () => {
  it("starts with synchronized manifests and lockfiles", () => {
    const report = inspectVersions(repoRoot);
    expect(report.version).toBe("0.5.0");
    expect(report.problems).toEqual([]);
  });

  it("detects drift in Tauri and npm root package lock versions", () => withFixture((root) => {
    const tauriPath = path.join(root, "src-tauri/tauri.conf.json");
    const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
    tauri.version = "0.2.0";
    writeFileSync(tauriPath, JSON.stringify(tauri));
    const lockPath = path.join(root, "package-lock.json");
    const npmLock = JSON.parse(readFileSync(lockPath, "utf8"));
    npmLock.packages[""].version = "0.2.0";
    writeFileSync(lockPath, JSON.stringify(npmLock));
    expect(inspectVersions(root).problems).toEqual([
      "package-lock.json packages[\"\"] is 0.2.0; expected 0.5.0",
      "src-tauri/tauri.conf.json is 0.2.0; expected 0.5.0",
    ]);
  }));

  it("bumps npm, Tauri and Rust root versions together", () => withFixture((root) => {
    expect(setVersion("0.6.0-rc.1", root).problems).toEqual([]);
    const report = inspectVersions(root, "v0.6.0-rc.1");
    expect(report.version).toBe("0.6.0-rc.1");
    expect(Object.values(report.observed)).toEqual(Array(5).fill("0.6.0-rc.1"));
    expect(inspectVersions(root, "v0.5.0").problems).toContain(
      "Git tag v0.5.0 must match v0.6.0-rc.1",
    );
  }));

  it("rejects malformed versions without modifying the repository", () => withFixture((root) => {
    const before = readFileSync(path.join(root, "package.json"), "utf8");
    expect(() => setVersion("V0.6", root)).toThrow(/Invalid application version/);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
  }));
});
