// Node-only imports live in a JS test, outside the browser TypeScript project.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceKey } from "../src/lib/workspaceKey.ts";

describe.skipIf(process.platform === "win32")("POSIX workspace directory identity", () => {
  it.each([
    ["literal\\child", "literal/child"],
    ["trailing\\", "trailing"],
  ])("keeps real directories %s and %s independent", (firstName, secondName) => {
    const base = mkdtempSync(join(tmpdir(), "virtuallab-workspace-key-"));
    try {
      const first = join(base, firstName);
      const second = join(base, secondName);
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      expect(realpathSync(first)).not.toBe(realpathSync(second));
      expect(workspaceKey(first)).not.toBe(workspaceKey(second));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
