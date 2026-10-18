import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectMergedPullRequests, runVersionAutomation } from "./version-automation.mjs";
import { setVersion } from "./version.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const marker = "VirtualLab-Version-Automation: 1";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "version automation "));
  roots.push(root);
  for (const file of ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(process.cwd(), file), path.join(root, file));
  }
  setVersion("0.5.0", root);
  mkdirSync(path.join(root, ".github"));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, ".github/version-policy.json"), JSON.stringify({ schemaVersion: 1, milestones: [{ version: "0.6.0", sections: ["V0.6"] }] }));
  writeFileSync(path.join(root, "docs/ROADMAP.md"), "### V0.6 — Reliability\n- [ ] Acceptance\n- [ ] Release qualification for V0.6: accepted\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("add", "--all");
  git("commit", "-m", "baseline");
  writeFileSync(path.join(root, "app.js"), "export {};\n");
  git("add", "--all");
  git("commit", "-m", "Merge pull request #7");
  const headSha = git("rev-parse", "HEAD");
  const repo = { owner: "example", repo: "workbench" };
  const context = { repo, eventName: "workflow_run", ref: "refs/heads/main", payload: {
    repository: { default_branch: "main", full_name: "example/workbench" },
    workflow_run: { conclusion: "success", event: "push", head_branch: "main", head_sha: headSha, head_repository: { full_name: "example/workbench" } },
  } };
  const state = { writes: [], main: headSha, branch: null, open: [], summary: "", files: ["app.js"], changedFiles: 1, failFiles: false, race: false, reads: 0 };
  const data = value => ({ data: value });
  const rest = {
    repos: { listPullRequestsAssociatedWithCommit: async () => data([{ number: 7, merged_at: "2026-10-18T00:00:00Z", merge_commit_sha: headSha,
      base: { ref: "main", repo: { full_name: "example/workbench" } } }]) },
    pulls: {
      get: async () => data({ number: 7, title: "fix: real correction", body: "", labels: [], changed_files: state.changedFiles }),
      listFiles: async () => { if (state.failFiles) throw new Error("GitHub unavailable"); return data(state.files.map(filename => ({ filename, status: "modified" }))); },
      list: async () => data(state.open),
      create: async args => { state.writes.push(["createPR", args]); return data({ number: 90, html_url: "https://example.invalid/pull/90" }); },
      update: async args => { state.writes.push(["updatePR", args]); return data({ number: args.pull_number }); },
    },
    git: {
      getRef: async args => {
        if (args.ref === "heads/main") {
          state.reads++;
          return data({ object: { sha: state.race && state.reads > 1 ? "new-main-sha" : state.main } });
        }
        if (!state.branch) throw Object.assign(new Error("Not found"), { status: 404 });
        return data({ object: { sha: state.branch } });
      },
      getCommit: async () => data({ message: state.branchMessage ?? `chore(version): propose 0.5.1\n\nVirtualLab-Version-Tree: ${state.previousTree ?? "old-tree"}\n${marker}`, tree: { sha: state.previousTree ?? "old-tree" } }),
      createTree: async args => { state.writes.push(["tree", args]); return data({ sha: "proposal-tree" }); },
      createCommit: async args => { state.writes.push(["commit", args]); return data({ sha: "proposal-commit" }); },
      createRef: async args => { state.writes.push(["createRef", args]); state.branch = args.sha; return data({ ref: args.ref }); },
      updateRef: async args => { state.writes.push(["updateRef", args]); state.branch = args.sha; return data({ ref: args.ref }); },
    },
  };
  const github = { rest, paginate: async (method, args) => (await method(args)).data,
    graphql: async (query, args) => { state.writes.push(["draft", args]); return {}; } };
  const core = { info() {}, summary: { addRaw(value) { state.summary += value; return this; }, async write() {} } };
  return { root, git, context, state, github, core };
}

describe("post-CI version PR automation", () => {
  it("deduplicates rebase associations while retaining merge and squash PRs in the range", async () => {
    const base = { ref: "main", repo: { full_name: "example/workbench" } };
    const merged = (number, merge_commit_sha) => ({ number, merge_commit_sha, merged_at: "2026-10-18", base });
    const associations = {
      "rebase-first": [merged(1, "rebase-final")],
      "rebase-final": [merged(1, "rebase-final")],
      "squash-final": [merged(2, "squash-final")],
      "merge-final": [merged(3, "merge-final"), { ...merged(4, "merge-final"), base: { ...base, repo: { full_name: "foreign/workbench" } } }],
      direct: [],
    };
    const reads = [];
    const rest = {
      repos: { listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({ data: associations[commit_sha] }) },
      pulls: {
        get: async ({ pull_number }) => { reads.push(pull_number); return { data: { title: `fix: ${pull_number}`, labels: [], body: "", changed_files: 1 } }; },
        listFiles: async () => ({ data: [{ filename: "src/app.ts", status: "modified" }] }),
      },
    };
    const result = await collectMergedPullRequests({ github: { rest, paginate: async (method, args) => (await method(args)).data },
      repo: { owner: "example", repo: "workbench" }, baseBranch: "main", history: { commits: ["rebase-first", "rebase-final", "squash-final", "merge-final", "direct"] } });
    expect(result.pullRequests.map(pr => pr.number)).toEqual([1, 2, 3]);
    expect(reads).toEqual([1, 2, 3]);
    expect(result.unassociatedCommits).toEqual(["direct"]);
  });

  it("creates one draft containing synchronized versions and an auditable assessment", async () => {
    const f = fixture();
    const result = await runVersionAutomation(f);
    expect(result.status).toBe("proposed");
    const entries = f.state.writes.find(([kind]) => kind === "tree")[1].tree;
    expect(entries.map(entry => entry.path).sort()).toEqual(["docs/VERSION_ASSESSMENT.md", "package-lock.json", "package.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
    expect(JSON.parse(entries.find(entry => entry.path === "package.json").content).version).toBe("0.5.1");
    expect(entries.find(entry => entry.path === "src-tauri/Cargo.toml").content).toContain('version = "0.5.1"');
    expect(f.state.writes.find(([kind]) => kind === "createPR")[1]).toMatchObject({ draft: true, base: "main", head: "automation/version-update" });
    expect(f.state.summary).toContain("0.5.0 → 0.5.1");
  });

  it("updates the existing bot branch without force and returns ready PRs to draft", async () => {
    const f = fixture();
    f.state.branch = "previous-proposal";
    f.state.open = [{ number: 90, node_id: "PR_node", draft: false, body: "<!-- virtuallab-version-automation:v1 -->" }];
    await runVersionAutomation(f);
    expect(f.state.writes.find(([kind]) => kind === "commit")[1].parents).toEqual([f.state.main, "previous-proposal"]);
    expect(f.state.writes.find(([kind]) => kind === "updateRef")[1].force).toBe(false);
    expect(f.state.writes.filter(([kind]) => kind === "createPR")).toEqual([]);
    expect(f.state.writes.find(([kind]) => kind === "draft")[1]).toMatchObject({ pullRequestId: "PR_node" });
  });

  it("does not write from failed, fork, PR or nondefault-branch CI runs", async () => {
    for (const patch of [{ conclusion: "failure" }, { event: "pull_request" }, { head_branch: "feature" }, { head_repository: { full_name: "fork/workbench" } }]) {
      const f = fixture();
      Object.assign(f.context.payload.workflow_run, patch);
      expect((await runVersionAutomation(f)).status).toBe("skipped");
      expect(f.state.writes).toEqual([]);
    }
  });

  it("rejects nondefault manual dispatch and stale CI snapshots", async () => {
    const f = fixture();
    f.context.eventName = "workflow_dispatch";
    f.context.ref = "refs/heads/feature";
    expect((await runVersionAutomation(f)).status).toBe("skipped");
    f.context.eventName = "workflow_run";
    f.state.main = "new-main-sha";
    expect((await runVersionAutomation(f)).status).toBe("superseded");
    expect(f.state.writes).toEqual([]);
  });

  it("fails closed on incomplete file pagination or API failures", async () => {
    const f = fixture();
    f.state.changedFiles = 2;
    await expect(runVersionAutomation(f)).rejects.toThrow(/complete|files/i);
    expect(f.state.writes).toEqual([]);
    f.state.failFiles = true;
    await expect(runVersionAutomation(f)).rejects.toThrow(/unavailable/i);
    expect(f.state.writes).toEqual([]);
  });

  it("counts both sides of a rename to avoid misclassifying moved product code as docs", async () => {
    const f = fixture();
    f.github.rest.pulls.listFiles = async () => ({ data: [{ filename: "docs/old.md", previous_filename: "src/app.ts", status: "renamed" }] });
    expect((await runVersionAutomation(f)).report.bump).toBe("patch");
  });

  it("keeps docs-only merges read-only and blocks writes if main advances during assessment", async () => {
    const f = fixture();
    f.state.files = ["docs/guide.md"];
    expect((await runVersionAutomation(f)).status).toBe("unchanged");
    expect(f.state.writes).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(f.root, "package.json"), "utf8")).version).toBe("0.5.0");
    const raced = fixture();
    raced.state.race = true;
    expect((await runVersionAutomation(raced)).status).toBe("superseded");
    expect(raced.state.writes).toEqual([]);
  });

  it("does not overwrite manual changes to the reserved branch", async () => {
    const f = fixture();
    f.state.branch = "human-commit";
    f.state.branchMessage = "manual edits";
    await expect(runVersionAutomation(f)).rejects.toThrow(/ownership|manual/i);
    expect(f.state.writes).toEqual([]);
  });

  it("detects manual amendments even when the original bot commit message is retained", async () => {
    const f = fixture();
    f.state.branch = "amended-proposal";
    f.state.previousTree = "tree-after-manual-edit";
    f.state.branchMessage = `chore(version): propose 0.5.1\n\nVirtualLab-Version-Tree: old-tree\n${marker}`;
    await expect(runVersionAutomation(f)).rejects.toThrow(/ownership|manual/i);
    expect(f.state.writes).toEqual([]);
  });

  it("leaves a ready version PR alone when a repeated assessment produces the same tree", async () => {
    const f = fixture();
    await runVersionAutomation(f);
    const proposal = f.state.writes.find(([kind]) => kind === "createPR")[1];
    f.git("restore", "--worktree", "--", ".");
    rmSync(path.join(f.root, "docs/VERSION_ASSESSMENT.md"));
    f.state.previousTree = "proposal-tree";
    f.state.open = [{ number: 90, node_id: "PR_node", draft: false, title: proposal.title, body: proposal.body }];
    f.state.writes = [];
    expect((await runVersionAutomation(f)).status).toBe("current");
    expect(f.state.writes.map(([kind]) => kind)).toEqual(["tree"]);
  });

  it("refreshes a HOLD explanation when the same proposal becomes eligible again", async () => {
    const f = fixture();
    f.state.branch = "previous-proposal";
    f.state.previousTree = "proposal-tree";
    f.state.open = [{ number: 90, node_id: "PR_node", draft: true,
      title: "chore(version): HOLD — no eligible version update", body: "<!-- virtuallab-version-automation:v1 -->\nHOLD" }];
    expect((await runVersionAutomation(f)).status).toBe("proposed");
    expect(f.state.writes.find(([kind]) => kind === "updatePR")[1].title).toBe("chore(version): 0.5.1");
    expect(f.state.writes.some(([kind]) => ["commit", "updateRef"].includes(kind))).toBe(false);
  });

  it("holds an obsolete proposal in draft when the merged changes become ineligible", async () => {
    const f = fixture();
    f.state.files = ["docs/guide.md"];
    f.state.open = [{ number: 90, node_id: "PR_node", draft: false, body: "<!-- virtuallab-version-automation:v1 -->" }];
    expect((await runVersionAutomation(f)).status).toBe("unchanged");
    expect(f.state.writes.map(([kind]) => kind)).toEqual(["draft", "updatePR"]);
    expect(f.state.writes[1][1].title).toContain("HOLD");
  });

  it("excludes unmerged, foreign-base and out-of-range PR associations and reports uncovered commits", async () => {
    const f = fixture();
    const base = { ref: "main", repo: { full_name: "example/workbench" } };
    f.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({ data: [
      { number: 8, merged_at: null, merge_commit_sha: f.state.main, base },
      { number: 9, merged_at: "2026-10-18", merge_commit_sha: "older-than-baseline", base },
      { number: 10, merged_at: "2026-10-18", merge_commit_sha: f.state.main, base: { ...base, ref: "other" } },
    ] });
    const result = await runVersionAutomation(f);
    expect(result.status).toBe("unchanged");
    expect(result.report.changes).toEqual([]);
    expect(result.report.unassociatedCommits).toEqual([f.state.main]);
    expect(f.state.writes).toEqual([]);
  });
});
