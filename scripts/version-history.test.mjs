import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findVersionBaseline, renderAssessment } from "./version-assessment.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

export function repositoryFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "版本 assessment "));
  roots.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const commit = (message, files) => {
    for (const [file, value] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), value);
    }
    git("add", "--all");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { root, git, commit };
}

describe("committed version baseline", () => {
  it("finds the actual version change rather than a package dependency or scripts edit", () => {
    const { root, commit } = repositoryFixture();
    commit("old version", { "package.json": '{"version":"0.4.0"}' });
    const baselineSha = commit("bump", { "package.json": '{"version":"0.5.0"}' });
    const dependency = commit("dependency", { "package.json": '{"version":"0.5.0","scripts":{"test":"vitest"}}' });
    const headSha = commit("code", { "src/app.ts": "export {};" });
    expect(findVersionBaseline(root)).toMatchObject({ currentVersion: "0.5.0", baselineSha, headSha, commits: [dependency, headSha] });
  });

  it("uses first-parent mainline history and resets coverage after a version PR merge", () => {
    const { root, git, commit } = repositoryFixture();
    const baselineSha = commit("baseline", { "package.json": '{"version":"0.5.0"}' });
    git("switch", "-c", "feature");
    commit("feature version edit", { "package.json": '{"version":"9.0.0"}' });
    commit("restore feature metadata", { "package.json": '{"version":"0.5.0"}', "feature.txt": "ok" });
    git("switch", "main");
    git("merge", "--no-ff", "feature", "-m", "Merge pull request #1");
    expect(findVersionBaseline(root).baselineSha).toBe(baselineSha);
    expect(findVersionBaseline(root).commits).toHaveLength(1);
    const updated = commit("version PR", { "package.json": '{"version":"0.5.1"}' });
    expect(findVersionBaseline(root)).toMatchObject({ currentVersion: "0.5.1", baselineSha: updated, commits: [] });
  });

  it("rejects shallow history rather than treating a truncated checkout as a release baseline", () => {
    const { root, git, commit } = repositoryFixture();
    const sha = commit("baseline", { "package.json": '{"version":"0.5.0"}' });
    writeFileSync(path.join(root, git("rev-parse", "--git-path", "shallow")), sha + "\n");
    expect(() => findVersionBaseline(root)).toThrow(/shallow/i);
  });

  it("renders untrusted PR titles as plain text and records the exact assessed range", () => {
    const report = renderAssessment({ currentVersion: "0.5.0", nextVersion: "0.5.1", bump: "patch", baselineSha: "abc123", headSha: "def456",
      changes: [{ number: 2, title: "fix: <img src=x> [click](https://example.invalid)\n## Forged", kind: "patch", reason: "Product changes" }],
      milestone: { version: "0.6.0", ready: false, blockers: ["V0.6: acceptance pending"] }, blockers: [], unassociatedCommits: ["123abc"] });
    expect(report).toContain("abc123");
    expect(report).toContain("def456");
    expect(report).toContain("&lt;img src=x&gt;");
    expect(report).not.toContain("\n## Forged");
    expect(report).toContain("123abc");
  });
});
