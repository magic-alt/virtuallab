import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setVersion } from "./version.mjs";

describe("read-only version assessment CLI", () => {
  it("assesses supplied PR metadata without changing any version files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "version input "));
    try {
      for (const file of ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        cpSync(file, path.join(root, file));
      }
      setVersion("0.5.0", root);
      mkdirSync(path.join(root, ".github"));
      mkdirSync(path.join(root, "docs"));
      writeFileSync(path.join(root, ".github/version-policy.json"), JSON.stringify({ schemaVersion: 1, milestones: [{ version: "0.6.0", sections: ["V0.6"] }] }));
      writeFileSync(path.join(root, "docs/ROADMAP.md"), "### V0.6 — Reliability\n- [ ] Qualification\n");
      const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "--initial-branch=main");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "--all");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline");
      const input = path.join(root, "merged PRs.json");
      writeFileSync(input, JSON.stringify([{ number: 78, title: "fix: correction", labels: [], files: ["src/app.tsx"] }]));
      const before = readFileSync(path.join(root, "package.json"), "utf8");
      const result = spawnSync(process.execPath, [path.resolve("scripts/version-assess.mjs"), "--input", input, "--json"], { cwd: root, encoding: "utf8", shell: false });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ currentVersion: "0.5.0", nextVersion: "0.5.1", bump: "patch", inputSource: "provided-json", provisional: true });
      expect(report.baselineSha).toMatch(/^[a-f0-9]{40}$/);
      expect(report.milestone.ready).toBe(false);
      expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns a useful error for invalid arguments before accessing GitHub", () => {
    const result = spawnSync(process.execPath, ["scripts/version-assess.mjs", "--apply"], { encoding: "utf8", shell: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});
