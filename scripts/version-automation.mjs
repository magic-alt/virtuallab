import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assessVersion, findVersionBaseline, gitRead, renderAssessment } from "./version-assessment.mjs";
import { inspectVersions, setVersion } from "./version.mjs";

const BRANCH = "automation/version-update";
const PR_MARKER = "<!-- virtuallab-version-automation:v1 -->";
const COMMIT_MARKER = "VirtualLab-Version-Automation: 1";
const VERSION_FILES = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];

export async function collectMergedPullRequests({ github, repo, history, baseBranch }) {
  const merged = new Map();
  const range = new Set(history.commits);
  const unassociatedCommits = [];
  const fullName = `${repo.owner}/${repo.repo}`.toLowerCase();
  for (const commit_sha of history.commits) {
    const associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit,
      { ...repo, commit_sha, per_page: 100 });
    const eligible = associated.filter(pr => pr.merged_at && range.has(pr.merge_commit_sha)
      && pr.base?.ref === baseBranch && pr.base.repo?.full_name?.toLowerCase() === fullName);
    if (!eligible.length) unassociatedCommits.push(commit_sha);
    for (const pr of eligible) merged.set(pr.number, pr);
  }
  const pullRequests = [];
  for (const number of [...merged.keys()].sort((a, b) => a - b)) {
    const { data: detail } = await github.rest.pulls.get({ ...repo, pull_number: number });
    const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 });
    // GitHub caps list-files at 3,000. Never classify a partial response as docs-only.
    if (!Number.isSafeInteger(detail.changed_files) || detail.changed_files !== files.length || !files.length) {
      throw new Error(`Cannot obtain complete changed files for PR #${number}.`);
    }
    pullRequests.push({ number, title: detail.title, body: detail.body ?? "", labels: detail.labels.map(label => label.name),
      files: files.flatMap(file => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]) });
  }
  return { pullRequests, unassociatedCommits };
}

function eligibleRun(context, baseBranch) {
  if (context.eventName === "workflow_dispatch") return context.ref === `refs/heads/${baseBranch}`;
  if (context.eventName !== "workflow_run") return false;
  const run = context.payload.workflow_run;
  return run?.conclusion === "success" && run.event === "push" && run.head_branch === baseBranch
    && run.head_repository?.full_name?.toLowerCase() === `${context.repo.owner}/${context.repo.repo}`.toLowerCase();
}

async function maybeRef(github, repo, branch) {
  try {
    return (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data.object.sha;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function holdDraft(github, pr) {
  if (pr && !pr.draft) {
    await github.graphql("mutation($pullRequestId: ID!) { convertPullRequestToDraft(input: {pullRequestId: $pullRequestId}) { pullRequest { id } } }",
      { pullRequestId: pr.node_id });
  }
}

export async function runVersionAutomation({ github, context, core, root = process.cwd() }) {
  const repo = context.repo;
  const baseBranch = context.payload.repository?.default_branch;
  if (!baseBranch || !eligibleRun(context, baseBranch)) return { status: "skipped" };
  if (gitRead(root, ["status", "--porcelain"])) throw new Error("Version automation requires a clean checkout of the default branch.");
  const history = findVersionBaseline(root);
  const fresh = async () => (await maybeRef(github, repo, baseBranch)) === history.headSha;
  if ((context.eventName === "workflow_run" && context.payload.workflow_run.head_sha !== history.headSha) || !await fresh()) {
    core.info("A newer default-branch revision exists; its successful CI will assess the complete pending range.");
    return { status: "superseded" };
  }
  const versions = inspectVersions(root);
  if (versions.problems.length || versions.version !== history.currentVersion) throw new Error("Application version sources are inconsistent.");
  const read = name => readFileSync(path.join(root, name), "utf8");
  const collected = await collectMergedPullRequests({ github, repo, history, baseBranch });
  const report = { ...assessVersion({ ...history, ...collected, roadmap: read("docs/ROADMAP.md"), policy: JSON.parse(read(".github/version-policy.json")) }),
    baselineSha: history.baselineSha, headSha: history.headSha, unassociatedCommits: collected.unassociatedCommits };
  const markdown = renderAssessment(report);
  await core.summary.addRaw(markdown).write();
  const open = await github.paginate(github.rest.pulls.list,
    { ...repo, state: "open", base: baseBranch, head: `${repo.owner}:${BRANCH}`, per_page: 100 });
  if (open.length > 1 || open.some(pr => !pr.body?.includes(PR_MARKER))) throw new Error("Cannot verify version PR ownership; manual intervention required.");
  const pr = open[0];
  if (!await fresh()) return { status: "superseded", report };
  const instructions = `${PR_MARKER}\n\n${markdown}\n## Human review required\n\n`
    + "This PR is kept in draft. Review the assessed commit range, PR classifications and roadmap evidence. "
    + "Mark it **Ready for review** to trigger the full PR CI, and approve any GitHub workflow-run approval prompt. "
    + "Merge only after the required checks pass for the current PR revision. Updates return it to draft. "
    + "No tag, GitHub Release or deployment is created.\n";
  const fields = { ...repo, title: `chore(version): ${report.nextVersion}`, body: instructions };
  if (report.bump === "none") {
    if (pr) {
      await holdDraft(github, pr);
      await github.rest.pulls.update({ ...repo, pull_number: pr.number, title: "chore(version): HOLD — no eligible version update", body: instructions });
    }
    return { status: "unchanged", report };
  }
  const previous = await maybeRef(github, repo, BRANCH);
  let previousCommit;
  if (previous) {
    const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: previous });
    if (!commit.message.endsWith(COMMIT_MARKER) || !commit.message.includes(`VirtualLab-Version-Tree: ${commit.tree.sha}\n`)) {
      throw new Error("Version branch ownership lost after manual changes; refusing to overwrite it.");
    }
    previousCommit = commit;
  }
  setVersion(report.nextVersion, root);
  const assessmentPath = "docs/VERSION_ASSESSMENT.md";
  writeFileSync(path.join(root, assessmentPath), markdown);
  const tree = [...VERSION_FILES, assessmentPath].map(file => ({ path: file, mode: "100644", type: "blob", content: read(file) }));
  const { data: createdTree } = await github.rest.git.createTree({ ...repo, base_tree: gitRead(root, ["rev-parse", "HEAD^{tree}"]), tree });
  // Retrying the same successful CI or manual dispatch must not reset a human review.
  if (previousCommit?.tree.sha === createdTree.sha) {
    if (!await fresh()) return { status: "superseded", report };
    if (pr?.title === fields.title && pr.body === fields.body) return { status: "current", report };
    if (pr) {
      await holdDraft(github, pr);
      await github.rest.pulls.update({ ...fields, pull_number: pr.number });
    } else await github.rest.pulls.create({ ...fields, head: BRANCH, base: baseBranch, draft: true });
    return { status: "proposed", report };
  }
  // Hold any ready PR before changing its revision. Never auto-approve or auto-merge it.
  await holdDraft(github, pr);
  const { data: commit } = await github.rest.git.createCommit({ ...repo, tree: createdTree.sha,
    message: `chore(version): propose ${report.nextVersion}\n\nVirtualLab-Version-Tree: ${createdTree.sha}\n${COMMIT_MARKER}`,
    // Keeping the previous proposal as a parent makes updates fast-forward, without force-push.
    parents: [...new Set([history.headSha, previous].filter(Boolean))] });
  if (!await fresh()) return { status: "superseded", report };
  if (previous) await github.rest.git.updateRef({ ...repo, ref: `heads/${BRANCH}`, sha: commit.sha, force: false });
  else await github.rest.git.createRef({ ...repo, ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  if (pr) await github.rest.pulls.update({ ...fields, pull_number: pr.number });
  else await github.rest.pulls.create({ ...fields, head: BRANCH, base: baseBranch, draft: true });
  return { status: "proposed", report };
}
