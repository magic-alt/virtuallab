/**
 * Produce reproducible provenance + SHA-256 for UNSIGNED QA candidate bundles.
 * Do not tag, sign, notarize, install, or publish from this script.
 */
import { createHash } from "node:crypto";
import {
  createReadStream, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, copyFileSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["windows-x64", "macos", "linux-x64"];

export function chooseBundle(directory, version, suffix, directoryOnly = false) {
  if (!existsSync(directory)) throw new Error("Bundle directory does not exist: " + directory);
  const names = readdirSync(directory).filter((name) => {
    const candidate = path.join(directory, name);
    return name.toLowerCase().endsWith(suffix.toLowerCase())
      && (directoryOnly ? statSync(candidate).isDirectory() : statSync(candidate).isFile())
      && (directoryOnly || name.includes(version));
  });
  if (names.length !== 1) {
    throw new Error("Expected exactly one " + suffix + " bundle for " + version
      + " in " + directory + "; found " + names.length);
  }
  return path.join(directory, names[0]);
}

export async function sha256File(filename) {
  const digest = createHash("sha256");
  for await (const data of createReadStream(filename)) digest.update(data);
  return digest.digest("hex");
}

export function validateSourceSha(sourceSha) {
  if (typeof sourceSha !== "string" || !/^[a-f0-9]{40}$/i.test(sourceSha)) {
    throw new Error("An exact 40-character Git HEAD SHA is mandatory for an RC artifact");
  }
  return sourceSha.toLowerCase();
}

function versionAt(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?$/.test(manifest.version)) {
    throw new Error("Missing/invalid application version");
  }
  return manifest.version;
}

export async function buildRcAssets(platform, root = process.cwd(), sourceSha = process.env.GITHUB_SHA) {
  if (!PLATFORMS.includes(platform)) throw new Error("Unknown platform " + platform);
  const sha = validateSourceSha(sourceSha);
  const version = versionAt(root);
  const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");
  const dest = path.join(root, "dist-release", platform);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let input;
  let name;
  if (platform === "windows-x64") {
    input = chooseBundle(path.join(bundleRoot, "nsis"), version, ".exe");
    name = path.basename(input);
    copyFileSync(input, path.join(dest, name));
  } else if (platform === "linux-x64") {
    input = chooseBundle(path.join(bundleRoot, "deb"), version, ".deb");
    name = path.basename(input);
    copyFileSync(input, path.join(dest, name));
  } else {
    input = chooseBundle(path.join(bundleRoot, "macos"), version, ".app", true);
    name = "VirtualLab_" + version + "_macos_qa-unsigned.zip";
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", input, path.join(dest, name)], {
      timeout: 120_000,
    });
  }
  const output = path.join(dest, name);
  const asset = { filename: name, bytes: statSync(output).size, sha256: await sha256File(output) };
  if (asset.bytes <= 0) throw new Error("Empty candidate bundle " + name);
  const manifest = {
    schemaVersion: 1,
    channel: "release-candidate",
    distribution: "QA_ONLY_UNSIGNED_NOT_QUALIFIED",
    version,
    sourceSha: sha,
    platform,
    signed: false,
    notarized: false,
    manualDesktopAccepted: false,
    assets: [asset],
  };
  writeFileSync(path.join(dest, "release-candidate-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(path.join(dest, "SHA256SUMS.txt"), asset.sha256 + "  " + asset.filename + "\n");
  await verifyRcAssets(platform, root, sourceSha);
  return manifest;
}

export async function verifyRcAssets(platform, root = process.cwd(), sourceSha = process.env.GITHUB_SHA) {
  if (!PLATFORMS.includes(platform)) throw new Error("Unknown platform " + platform);
  const folder = path.join(root, "dist-release", platform);
  const manifest = JSON.parse(readFileSync(path.join(folder, "release-candidate-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.version !== versionAt(root)
    || manifest.sourceSha !== validateSourceSha(sourceSha)
    || manifest.distribution !== "QA_ONLY_UNSIGNED_NOT_QUALIFIED"
    || manifest.signed !== false || manifest.manualDesktopAccepted !== false
    || !Array.isArray(manifest.assets) || manifest.assets.length !== 1) {
    throw new Error("Release candidate manifest is missing required provenance or QA-only safety flags");
  }
  const asset = manifest.assets[0];
  if (!asset || typeof asset.filename !== "string"
    || path.basename(asset.filename) !== asset.filename) {
    throw new Error("Invalid candidate asset filename");
  }
  const target = path.join(folder, asset.filename);
  const hash = await sha256File(target);
  if (statSync(target).size !== asset.bytes || hash !== asset.sha256) {
    throw new Error("Candidate bundle size or SHA-256 has changed");
  }
  if (readFileSync(path.join(folder, "SHA256SUMS.txt"), "utf8") !== hash + "  " + asset.filename + "\n") {
    throw new Error("Candidate bundle SHA256SUMS does not match the manifest");
  }
  return manifest;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) {
  const [action, platform] = process.argv.slice(2);
  const task = action === "package" ? buildRcAssets
    : action === "verify" ? verifyRcAssets : null;
  if (!task) {
    console.error("Usage: node scripts/rc-assets.mjs package|verify windows-x64|macos|linux-x64");
    process.exitCode = 2;
  } else {
    task(platform).then((manifest) => {
      console.log(JSON.stringify(manifest, null, 2));
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
