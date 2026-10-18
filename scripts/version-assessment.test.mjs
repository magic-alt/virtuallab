import { describe, expect, it } from "vitest";
import { assessVersion } from "./version-assessment.mjs";

const policy = { schemaVersion: 1, milestones: [
  { version: "0.6.0", sections: ["V0.6"] },
  { version: "0.7.0", sections: ["V0.7-A", "V0.7-B", "V0.7-C"] },
] };
const pending = "### V0.6 — Reliability\n- [ ] Restart acceptance\n- [ ] Release qualification for V0.6: accepted evidence\n";
const qualified = pending.replaceAll("[ ]", "[x]");
const pr = (number, title, files = ["src/app.tsx"], extra = {}) => ({
  number, title, files, labels: [], ...extra,
});
const assess = (pullRequests, roadmap = pending, currentVersion = "0.5.0") =>
  assessVersion({ currentVersion, pullRequests, roadmap, policy });

describe("automatic version assessment", () => {
  it("aggregates fixes and ordinary features into one patch while milestone acceptance is open", () => {
    const result = assess([pr(78, "fix(git): confirm deletion"), pr(77, "feat: repository detach")]);
    expect(result).toMatchObject({ nextVersion: "0.5.1", bump: "patch", milestone: { version: "0.6.0", ready: false } });
    expect(result.changes.map(change => change.number)).toEqual([77, 78]);
    expect(result.milestone.blockers).toContain("V0.6: Restart acceptance");
  });

  it("skips documentation, tests and CI based on files even when the title is unconventional", () => {
    expect(assess([pr(1, "Update instructions", ["docs/guide.md"]),
      pr(2, "test: cover behavior", ["src/app.test.tsx"]),
      pr(3, "ci: fix runner", [".github/workflows/ci.yml"])]).nextVersion).toBe("0.5.0");
    expect(assess([pr(4, "docs: includes a real fix", ["README.md", "src/app.tsx"])]).nextVersion).toBe("0.5.1");
    expect(assess([pr(5, "fix: CMake configuration", ["CMakeLists.txt"])]).nextVersion).toBe("0.5.1");
    expect(assess([pr(6, "test: Windows qualification", ["scripts/qualification-windows.tests.ps1"])]).bump).toBe("none");
  });

  it("supports explicit release:skip and release:patch labels", () => {
    expect(assess([pr(1, "refactor: internal cleanup", undefined, { labels: ["release:skip"] })]).bump).toBe("none");
    expect(assess([pr(2, "docs: release correction", ["README.md"], { labels: ["release:patch"] })]).bump).toBe("patch");
    expect(() => assess([pr(3, "fix: conflict", undefined, { labels: ["release:skip", "release:patch"] })])).toThrow(/conflicting/i);
  });

  it("requires explicit exit qualification in addition to checked implementation tasks", () => {
    const roadmap = "### V0.6 — Reliability\n- [x] Source implemented\n";
    expect(assess([pr(1, "feat: source")], roadmap).milestone).toMatchObject({ ready: false });
    expect(assess([pr(1, "feat: source")], roadmap).nextVersion).toBe("0.5.1");
  });

  it("promotes a milestone when its tasks and explicit qualification are accepted", () => {
    expect(assess([pr(1, "docs: record acceptance", ["docs/ROADMAP.md"])], qualified)).toMatchObject({ nextVersion: "0.6.0", bump: "minor", milestone: { ready: true } });
  });

  it("does not infer qualification from code fences, nested headings or a duplicate section", () => {
    const roadmap = "```md\n" + qualified + "```\n" + pending;
    expect(assess([pr(1, "feat: code")], roadmap).nextVersion).toBe("0.5.1");
    expect(assess([pr(1, "feat: code")], qualified + qualified).milestone.ready).toBe(false);
    const nested = "### V0.6 — Reliability\n- [x] Done\n#### Details\n- [ ] Still pending\n- [x] Release qualification for V0.6: accepted\n";
    expect(assess([pr(1, "feat: code")], nested).milestone.ready).toBe(false);
    expect(assess([pr(1, "feat: code")], "<!--\n" + qualified + "-->\n").milestone.ready).toBe(false);
  });

  it("treats V0.7-A/B/C as one milestone and requires earlier gates to remain accepted", () => {
    const slices = ["A", "B", "C"].map(slice => `### V0.7-${slice} — Delivery\n- [x] Work\n`).join("") + "- [x] Release qualification for V0.7: accepted\n";
    expect(assess([pr(1, "feat: delivery")], qualified + slices, "0.6.3").nextVersion).toBe("0.7.0");
    expect(assess([pr(1, "feat: delivery")], pending + slices, "0.6.3").nextVersion).toBe("0.6.4");
    expect(assess([pr(1, "feat: delivery")], qualified + slices.replace("V0.7-B", "V0.7-X"), "0.6.3").nextVersion).toBe("0.6.4");
  });

  it("deduplicates PRs and never increments once per merged branch", () => {
    expect(assess([pr(1, "fix: one"), pr(1, "fix: one"), pr(2, "feat: two")]).changes).toHaveLength(2);
    expect(assess([pr(1, "fix: one"), pr(2, "feat: two")], pending, "0.5.8").nextVersion).toBe("0.5.9");
    expect(assess([], qualified).nextVersion).toBe("0.5.0");
  });

  it("blocks breaking changes until a qualified minor and never automatically promotes to 1.0", () => {
    expect(assess([pr(1, "feat!: incompatible change")])).toMatchObject({ nextVersion: "0.5.0", bump: "none" });
    expect(assess([pr(1, "feat!: incompatible change")], qualified).nextVersion).toBe("0.6.0");
    expect(assess([pr(1, "feat: ordinary feature")], qualified, "0.9.4").nextVersion).toBe("0.9.5");
    expect(assess([pr(1, "feat: major", undefined, { labels: ["release:major"] })], qualified).bump).toBe("none");
  });

  it("rejects incomplete inputs instead of silently misclassifying changes", () => {
    expect(() => assess([pr(1, "fix: unknown files", [])])).toThrow(/files/i);
    expect(() => assess([], pending, "0.6.0-rc.1")).toThrow(/stable/i);
    expect(() => assessVersion({ currentVersion: "0.5.0", pullRequests: [], roadmap: pending, policy: { schemaVersion: 9 } })).toThrow(/policy/i);
  });
});
