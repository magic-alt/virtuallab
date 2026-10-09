import { describe, expect, it } from "vitest";
import { guideCategories, guidePages, searchGuidePages } from "./guideContent";

describe("bundled help content", () => {
  it("has distinct articles, section anchors and local illustrated assets", () => {
    const pageIds = guidePages.map((page) => page.id);
    expect(pageIds.length).toBeGreaterThanOrEqual(10);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    const diagramSources: string[] = [];

    for (const page of guidePages) {
      expect(guideCategories).toContain(page.category);
      expect(page.title.length).toBeGreaterThan(2);
      expect(page.sections.length).toBeGreaterThan(0);
      expect(new Set(page.sections.map((section) => section.id)).size).toBe(page.sections.length);
      for (const section of page.sections) {
        expect(section.title.length).toBeGreaterThan(2);
        expect(section.blocks.length).toBeGreaterThan(0);
        for (const block of section.blocks) {
          if (block.type === "diagram") {
            expect(block.src).toMatch(/^\/help\/[\w-]+\.svg$/);
            expect(block.alt.length).toBeGreaterThan(12);
            expect(block.caption.length).toBeGreaterThan(8);
            diagramSources.push(block.src);
          }
        }
      }
    }
    expect(new Set(diagramSources).size).toBeGreaterThanOrEqual(4);
  });

  it("searches titles, examples, headings and code content case-insensitively", () => {
    expect(searchGuidePages("")).toHaveLength(guidePages.length);
    expect(searchGuidePages("  QT  ").some((page) => page.id === "build")).toBe(true);
    expect(searchGuidePages("Keil").some((page) => page.id === "build")).toBe(true);
    expect(searchGuidePages("pull").some((page) => page.id === "worktree")).toBe(true);
    expect(searchGuidePages("不存在的完全随机语句")).toHaveLength(0);
  });

  it("makes physical action restrictions explicit", () => {
    const safety = guidePages.find((page) => page.id === "safety");
    const agents = guidePages.find((page) => page.id === "agents");
    expect(safety).toBeDefined();
    expect(JSON.stringify(agents)).toContain("硬件");
    expect(JSON.stringify(safety)).toContain("BLOCKED");
  });
});
