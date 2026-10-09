import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Monaco development sanitizer", () => {
  it("does not prebundle the vulnerable embedded sanitizer in development", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import path from "node:path";
      import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
      import { optimizeDeps, resolveConfig } from "vite";
      const fixtureRoot = path.resolve(".virtuallab");
      mkdirSync(fixtureRoot, { recursive: true });
      const fixture = mkdtempSync(path.join(fixtureRoot, "monaco-dev-security-"));
      try {
        const config = await resolveConfig({
          configFile: path.resolve("vite.config.ts"),
          cacheDir: path.join(fixture, "cache"),
          logLevel: "silent",
          optimizeDeps: { entries: ["src/features/review/monacoEnvironment.ts"] },
        }, "serve");
        const metadata = await optimizeDeps(config, true);
        const files = [...Object.values(metadata.optimized), ...Object.values(metadata.chunks)];
        const legacy = files.some(({ file }) => readFileSync(file, "utf8").includes("monaco-editor/esm/vs/base/browser/dompurify/dompurify.js"));
        console.log(JSON.stringify({ legacy, scannedWrapper: Boolean(metadata.optimized["@monaco-editor/react"]) }));
      } finally {
        if (path.dirname(fixture) !== fixtureRoot) throw new Error("Unsafe test cleanup path");
        rmSync(fixture, { recursive: true, force: true });
      }
    `], { encoding: "utf8", timeout: 60_000 });
    const result = JSON.parse(output);
    expect(result.scannedWrapper).toBe(true);
    expect(result.legacy).toBe(false);
  }, 60_000);
});
