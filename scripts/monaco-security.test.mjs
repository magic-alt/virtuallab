import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Monaco sanitizer packaging", () => {
  it("preserves safe review markup while removing scripts, event handlers and unsafe links", async () => {
    const { sanitizeHtml } = await import("monaco-editor/base/browser/domSanitize.js");
    const host = document.createElement("div");
    host.innerHTML = String(sanitizeHtml('<strong>Review</strong><script>alert(1)</script><img src="https://example.org/image.png" onerror="alert(2)"><a href="javascript:alert(3)">unsafe</a><a href="https://example.org">safe</a>'));
    expect(host.querySelector("strong")?.textContent).toBe("Review");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://example.org/image.png");
    expect(host.querySelectorAll("a")[0].getAttribute("href")).toBeNull();
    expect(host.querySelectorAll("a")[1].getAttribute("href")).toBe("https://example.org");
  });

  it("bundles the patched npm sanitizer instead of Monaco's vulnerable embedded copy", () => {
    // Run Vite in Node: esbuild's typed arrays cannot cross jsdom's realm.
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import path from "node:path";
      import { build } from "vite";
      const result = await build({
        configFile: path.resolve("vite.config.ts"),
        logLevel: "silent",
        build: {
          write: false,
          minify: false,
          lib: {
            entry: path.resolve("node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js"),
            formats: ["es"],
          },
        },
      });
      const bundles = Array.isArray(result) ? result : [result];
      const modules = bundles.flatMap((bundle) => bundle.output.flatMap((item) =>
        item.type === "chunk" ? Object.keys(item.modules) : [],
      ));
      console.log(JSON.stringify(modules));
    `], { encoding: "utf8", timeout: 30_000 });
    const modules = JSON.parse(output).map((id) => id.replaceAll("\\", "/"));
    expect(modules.some((id) => id.endsWith("/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js"))).toBe(false);
    expect(modules.some((id) => id.endsWith("/dompurify/dist/purify.es.mjs"))).toBe(true);
  }, 30_000);
});
