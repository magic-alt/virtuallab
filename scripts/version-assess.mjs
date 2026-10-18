import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assessVersion, findVersionBaseline, gitRead, renderAssessment } from "./version-assessment.mjs";
import { collectMergedPullRequests } from "./version-automation.mjs";
import { inspectVersions } from "./version.mjs";

// This adapter exposes only the three read-only REST operations used by assessment.
function githubCli(root, fullName) {
  const api = (route, paginated = false) => {
    const args = ["api", "--method", "GET", `repos/${fullName}/${route}`];
    if (paginated) args.push("--paginate", "--slurp");
    const value = JSON.parse(execFileSync("gh", args, { cwd: root, encoding: "utf8", shell: false,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }));
    return { data: paginated ? value.flat() : value };
  };
  return { paginate: async (method, args) => (await method(args)).data, rest: {
    repos: { listPullRequestsAssociatedWithCommit: ({ commit_sha }) => api(`commits/${commit_sha}/pulls?per_page=100`, true) },
    pulls: { get: ({ pull_number }) => api(`pulls/${pull_number}`),
      listFiles: ({ pull_number }) => api(`pulls/${pull_number}/files?per_page=100`, true) },
  } };
}

export async function main(args, root = process.cwd()) {
  let input;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json" && !json) json = true;
    else if (args[index] === "--input" && !input && args[index + 1] && !args[index + 1].startsWith("--")) input = args[++index];
    else throw new Error("Usage: npm run version:assess -- [--input merged-prs.json] [--json]");
  }
  const history = findVersionBaseline(root);
  const versions = inspectVersions(root);
  if (versions.problems.length || versions.version !== history.currentVersion) throw new Error("Version files must agree with the committed version before assessment.");
  let collected;
  if (input) {
    collected = { pullRequests: JSON.parse(readFileSync(path.resolve(root, input), "utf8")), unassociatedCommits: [] };
  } else {
    const metadata = JSON.parse(execFileSync("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], {
      cwd: root, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024,
    }));
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metadata.nameWithOwner) || !metadata.defaultBranchRef?.name) throw new Error("Cannot resolve selected repository and default branch with gh.");
    const [owner, repo] = metadata.nameWithOwner.split("/");
    collected = await collectMergedPullRequests({ github: githubCli(root, metadata.nameWithOwner), repo: { owner, repo }, history, baseBranch: metadata.defaultBranchRef.name });
  }
  const read = file => readFileSync(path.join(root, file), "utf8");
  const report = { ...assessVersion({ ...history, ...collected, roadmap: read("docs/ROADMAP.md"), policy: JSON.parse(read(".github/version-policy.json")) }),
    baselineSha: history.baselineSha, headSha: history.headSha, unassociatedCommits: collected.unassociatedCommits,
    inputSource: input ? "provided-json" : "github", provisional: Boolean(gitRead(root, ["status", "--porcelain"])) };
  console.log(json ? JSON.stringify(report, null, 2) : renderAssessment(report));
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    // Avoid dumping child-process buffers (PR bodies or authentication diagnostics).
    console.error(error?.status !== undefined ? "Read-only Git/gh inspection failed; check repository access and gh authentication." : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
