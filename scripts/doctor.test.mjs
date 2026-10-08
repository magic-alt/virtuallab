import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCargoEnv } from "./doctor.mjs";

describe.skipIf(process.platform !== "win32")("Windows Cargo path recovery", () => {
  it("keeps Node reachable when the inherited path key is Path", () => {
    const baseEnv = { Path: path.dirname(process.execPath) };
    const result = resolveCargoEnv(baseEnv);
    expect(result.cargo).toBe(path.join(homedir(), ".cargo", "bin", "cargo.exe"));

    const child = spawnSync("node", ["--version"], {
      env: result.env,
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
  });
});
