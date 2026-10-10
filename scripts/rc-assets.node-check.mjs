import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildRcAssets, chooseBundle, validateSourceSha, verifyRcAssets } from "./rc-assets.mjs";

const SHA = "a".repeat(40);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "virtuallab-rc-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.5.0" }));
  const bundle = path.join(root, "src-tauri", "target", "release", "bundle", "deb");
  mkdirSync(bundle, { recursive: true });
  const deb = path.join(bundle, "VirtualLab_0.5.0_amd64.deb");
  writeFileSync(deb, Buffer.alloc(4096, 0x65));
  return { root, bundle, deb };
}

describe("candidate assets", () => {
  it("rejects ambiguous/missing artifacts instead of publishing stale ones", () => {
    const f = fixture();
    try {
      assert.equal(path.basename(chooseBundle(f.bundle, "0.5.0", ".deb")), "VirtualLab_0.5.0_amd64.deb");
      writeFileSync(path.join(f.bundle, "VirtualLab_0.5.0_amd64-copy.deb"), "other");
      assert.throws(() => chooseBundle(f.bundle, "0.5.0", ".deb"), /exactly one/);
      assert.throws(() => chooseBundle(f.bundle, "0.4.0", ".deb"), /exactly one/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("rejects missing or shortened SHA provenance", () => {
    assert.throws(() => validateSourceSha("abc"), /40-character/);
    assert.throws(() => validateSourceSha(undefined), /40-character/);
    assert.equal(validateSourceSha(SHA), SHA);
  });
  it("creates a QA-only artifact with verifiable digest and rejects corruption", async () => {
    const f = fixture();
    try {
      const m = await buildRcAssets("linux-x64", f.root, SHA);
      assert.equal(m.version, "0.5.0");
      assert.equal(m.signed, false);
      assert.equal(m.manualDesktopAccepted, false);
      assert.equal(m.sourceSha, SHA);
      assert.equal((await verifyRcAssets("linux-x64", f.root, SHA)).assets[0].bytes, 4096);
      const filepath = path.join(f.root, "dist-release", "linux-x64", m.assets[0].filename);
      writeFileSync(filepath, "tampered");
      await assert.rejects(() => verifyRcAssets("linux-x64", f.root, SHA), /size or SHA-256/);
      const manifest = readFileSync(path.join(f.root, "dist-release", "linux-x64", "release-candidate-manifest.json"), "utf8");
      assert.match(manifest, /QA_ONLY_UNSIGNED_NOT_QUALIFIED/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
