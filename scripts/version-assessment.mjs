import { execFileSync } from "node:child_process";

function stableVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("Automatic assessment requires a stable x.y.z application version; prereleases need manual version management.");
  }
  const parts = value.split(".").map(Number);
  if (parts.some(part => !Number.isSafeInteger(part) || part >= Number.MAX_SAFE_INTEGER)) {
    throw new Error("Application version exceeds the supported integer range.");
  }
  return parts;
}

function validatePolicy(policy) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.milestones)) throw new Error("Unsupported version policy.");
  if (policy.automaticPatchOnMain !== undefined && typeof policy.automaticPatchOnMain !== "boolean") {
    throw new Error("automaticPatchOnMain policy must be boolean.");
  }
  let previousMinor = -1;
  const usedSections = new Set();
  for (const milestone of policy.milestones) {
    const [major, minor, patch] = stableVersion(milestone.version);
    if (major !== 0 || patch !== 0 || minor <= previousMinor || !Array.isArray(milestone.sections) || !milestone.sections.length) {
      throw new Error("Version policy must contain ordered 0.x.0 milestones; stable 1.0 requires a separate review.");
    }
    for (const section of milestone.sections) {
      if (typeof section !== "string" || !/^V0\.\d+(?:-[A-Z])?$/.test(section) || usedSections.has(section)) {
        throw new Error("Invalid or duplicate roadmap section in version policy.");
      }
      usedSections.add(section);
    }
    previousMinor = minor;
  }
}

function roadmapSections(markdown) {
  const headings = [];
  const lines = markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/);
  let fence;
  for (let index = 0; index < lines.length; index++) {
    const delimiter = lines[index].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = undefined;
      lines[index] = "";
      continue;
    }
    if (fence) { lines[index] = ""; continue; }
    const match = lines[index].match(/^(#{1,6})\s+(V\d+\.\d+(?:-[A-Z])?)(?=\s|$)/);
    const anyHeading = lines[index].match(/^(#{1,6})\s+/);
    if (anyHeading) headings.push({ index, level: anyHeading[1].length, id: match?.[2] });
  }
  return headings.filter(heading => heading.id).map(heading => {
    const end = headings.find(next => next.index > heading.index && next.level <= heading.level)?.index ?? lines.length;
    const tasks = lines.slice(heading.index + 1, end).flatMap(line => {
      const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
      if (!task) return [];
      // Additional inline unchecked items must not be hidden by the first checkbox.
      return [{ done: task[1].toLowerCase() === "x" && !/\[ \]/.test(task[2]), text: task[2] }];
    });
    return { id: heading.id, tasks };
  });
}

function inspectMilestone(currentVersion, roadmap, policy) {
  const [major, minor] = stableVersion(currentVersion);
  const next = policy.milestones.find(milestone => milestone.version === `${major}.${minor + 1}.0`);
  if (!next) return { version: null, ready: false, blockers: ["No automatic next milestone; 1.0 and major upgrades require a separate human stability review."] };
  const sections = roadmapSections(roadmap);
  const blockers = [];
  for (const milestone of policy.milestones.slice(0, policy.milestones.indexOf(next) + 1)) {
    const collected = [];
    for (const id of milestone.sections) {
      const matches = sections.filter(section => section.id === id);
      if (matches.length !== 1) { blockers.push(`${id}: expected one roadmap section, found ${matches.length}`); continue; }
      if (!matches[0].tasks.length) blockers.push(`${id}: no acceptance checklist`);
      for (const task of matches[0].tasks) {
        collected.push(task);
        if (!task.done) blockers.push(`${id}: ${task.text}`);
      }
    }
    const marker = `Release qualification for V${milestone.version.replace(/\.0$/, "")}:`;
    const qualifications = collected.filter(task => task.text.startsWith(marker));
    if (qualifications.length !== 1 || !qualifications[0].done) {
      blockers.push(`${milestone.version}: explicit release qualification must be checked exactly once`);
    }
  }
  return { version: next.version, ready: blockers.length === 0, blockers };
}

function nonProductFile(file) {
  return file.startsWith("docs/") || file.startsWith(".github/") || /\.(md|mdx|rst)$/i.test(file)
    || /(^|\/)(__tests__|__snapshots__|tests?|fixtures)(\/|$)/.test(file)
    || /\.(tests?|spec|node-check)\.[^/]+$/.test(file);
}

function classify(pr) {
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.title !== "string"
    || !Array.isArray(pr.files) || !pr.files.length || pr.files.some(file => typeof file !== "string" || !file)) {
    throw new Error("Merged PR metadata must include a valid number, title and complete changed files.");
  }
  const labels = new Set(pr.labels ?? []);
  const overrides = ["release:skip", "release:patch", "release:major"].filter(label => labels.has(label));
  if (overrides.length > 1) throw new Error(`PR #${pr.number} has conflicting release labels.`);
  const major = labels.has("release:major");
  const breaking = /^[a-z]+(?:\([^\n)]+\))?!:/i.test(pr.title) || /^BREAKING[ -]CHANGE:/m.test(pr.body ?? "");
  let kind = "patch";
  let reason = "Product changes; ordinary features and fixes use a patch until milestone qualification.";
  if (major) { kind = "major"; reason = "Explicit major release requires human stability review."; }
  else if (breaking) { kind = "breaking"; reason = "Breaking change requires a qualified 0.x minor milestone or manual review."; }
  else if (labels.has("release:skip")) { kind = "skip"; reason = "Explicit release:skip label."; }
  else if (labels.has("release:patch")) { reason = "Explicit release:patch label."; }
  else if (pr.files.every(nonProductFile)) { kind = "skip"; reason = "Only documentation, tests or CI changed."; }
  return { number: pr.number, title: pr.title, kind, reason };
}

export function assessVersion({ currentVersion, pullRequests, roadmap, policy }) {
  const [major, minor, patch] = stableVersion(currentVersion);
  validatePolicy(policy);
  if (typeof roadmap !== "string" || !Array.isArray(pullRequests)) throw new Error("Missing roadmap or merged PR input.");
  const milestone = inspectMilestone(currentVersion, roadmap, policy);
  const changes = [...new Map(pullRequests.map(pr => [pr.number, classify(pr)])).values()].sort((a, b) => a.number - b.number);
  const blockers = [];
  let nextVersion = currentVersion;
  let bump = "none";
  if (changes.some(change => change.kind === "major")) blockers.push("Major release requested; manual stability review and version bump required.");
  else if (changes.length && milestone.ready) { nextVersion = milestone.version; bump = "minor"; }
  else if (changes.some(change => change.kind === "breaking")) blockers.push("Breaking changes cannot be released as a patch; qualify the next milestone or manage the version manually.");
  else if (changes.some(change => change.kind === "patch")) { nextVersion = `${major}.${minor}.${patch + 1}`; bump = "patch"; }
  return { currentVersion, nextVersion, bump, changes, milestone, blockers };
}

export function gitRead(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", shell: false,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function findVersionBaseline(root = process.cwd()) {
  if (gitRead(root, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("Version assessment requires full, non-shallow Git history.");
  }
  const headSha = gitRead(root, ["rev-parse", "HEAD"]);
  const currentVersion = JSON.parse(gitRead(root, ["show", `${headSha}:package.json`])).version;
  stableVersion(currentVersion);
  const candidates = gitRead(root, ["log", "--first-parent", "--format=%H", headSha, "--", "package.json"]).split("\n").filter(Boolean);
  let baselineSha;
  for (const sha of candidates) {
    const version = JSON.parse(gitRead(root, ["show", `${sha}:package.json`])).version;
    if (version !== currentVersion) break;
    baselineSha = sha;
  }
  if (!baselineSha) throw new Error("Cannot locate the committed application version baseline.");
  const commits = gitRead(root, ["rev-list", "--first-parent", "--reverse", `${baselineSha}..${headSha}`]).split("\n").filter(Boolean);
  return { currentVersion, baselineSha, headSha, commits };
}

function plain(value) {
  return String(value).replace(/[\r\n\t]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()!|#])/g, "\\$1");
}

export function renderAssessment(report) {
  const lines = ["# Application version assessment", "", `Version: ${report.currentVersion} → ${report.nextVersion} (${report.bump}).`, "",
    `Baseline commit: ${report.baselineSha}`, `Assessed main commit: ${report.headSha}`, "",
    "This is a version proposal. It does not authorize a tag, Release, deployment or hardware operation.", "", "## Merged PRs", ""];
  if (report.provisional || report.inputSource === "provided-json") {
    lines.splice(8, 0, "Provisional local preview: working-tree changes or supplied JSON have not been validated as a committed GitHub snapshot.", "");
  }
  for (const change of report.changes) lines.push(`- #${change.number} — ${plain(change.title)} (${change.kind}): ${plain(change.reason)}`);
  if (!report.changes.length) lines.push("No new merged PRs since the committed version baseline.");
  lines.push("", "## Roadmap qualification", "", `Next milestone: ${report.milestone.version ?? "manual review"}; ${report.milestone.ready ? "qualified" : "pending"}.`);
  for (const blocker of report.milestone.blockers) lines.push(`- ${plain(blocker)}`);
  for (const blocker of report.blockers) lines.push(`- Version update blocked: ${plain(blocker)}`);
  if (report.unassociatedCommits?.length) {
    lines.push("", "## Commits without an eligible merged PR", "", "These commits were not classified as merged PRs; review them before accepting this proposal.");
    for (const sha of report.unassociatedCommits) lines.push(`- ${sha}`);
  }
  return lines.join("\n") + "\n";
}
