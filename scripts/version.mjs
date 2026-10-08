import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_CRATE = /(^\[package\]\r?\nname\s*=\s*"virtuallab"\r?\nversion\s*=\s*")[^"]+(")/m;
const LOCK_CRATE = /(^\[\[package\]\]\r?\nname\s*=\s*"virtuallab"\r?\nversion\s*=\s*")[^"]+(")/m;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function load(root) {
  const read = (name) => readFileSync(path.join(root, name), "utf8");
  return {
    manifest: JSON.parse(read("package.json")),
    npmLock: JSON.parse(read("package-lock.json")),
    tauri: JSON.parse(read("src-tauri/tauri.conf.json")),
    cargo: read("src-tauri/Cargo.toml"),
    cargoLock: read("src-tauri/Cargo.lock"),
  };
}

function extractVersion(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error("Cannot locate VirtualLab version in " + label);
  const matchVersion = match[0].match(/version\s*=\s*"([^"]+)"/);
  if (!matchVersion) throw new Error("Malformed VirtualLab version in " + label);
  return matchVersion[1];
}

function replaceVersion(source, pattern, next, label) {
  if (!pattern.test(source)) throw new Error("Cannot locate VirtualLab version in " + label);
  return source.replace(pattern, (_matched, prefix, suffix) => prefix + next + suffix);
}

export function inspectVersions(root = DEFAULT_ROOT, tag = undefined) {
  const files = load(root);
  const version = files.manifest.version;
  const observed = {
    "package-lock.json": files.npmLock.version,
    "package-lock.json packages[\"\"]": files.npmLock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": files.tauri.version,
    "src-tauri/Cargo.toml": extractVersion(files.cargo, PACKAGE_CRATE, "Cargo.toml"),
    "src-tauri/Cargo.lock": extractVersion(files.cargoLock, LOCK_CRATE, "Cargo.lock"),
  };
  const problems = [];
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    problems.push("package.json contains an unsupported SemVer version: " + String(version));
  }
  for (const [file, found] of Object.entries(observed)) {
    if (found !== version) problems.push(file + " is " + String(found) + "; expected " + String(version));
  }
  if (tag !== undefined && tag !== "v" + version) {
    problems.push("Git tag " + tag + " must match v" + version);
  }
  return { version, observed, problems };
}

export function setVersion(next, root = DEFAULT_ROOT) {
  if (!VERSION_PATTERN.test(next)) {
    throw new Error("Invalid application version (expected SemVer x.y.z or x.y.z-prerelease): " + next);
  }
  const files = load(root);
  const newCargo = replaceVersion(files.cargo, PACKAGE_CRATE, next, "Cargo.toml");
  const newCargoLock = replaceVersion(files.cargoLock, LOCK_CRATE, next, "Cargo.lock");
  if (!files.npmLock.packages?.[""]) throw new Error("Missing root package in package-lock.json");

  files.manifest.version = next;
  files.npmLock.version = next;
  files.npmLock.packages[""].version = next;
  files.tauri.version = next;

  const content = {
    "package.json": JSON.stringify(files.manifest, null, 2) + "\n",
    "package-lock.json": JSON.stringify(files.npmLock, null, 2) + "\n",
    "src-tauri/tauri.conf.json": JSON.stringify(files.tauri, null, 2) + "\n",
    "src-tauri/Cargo.toml": newCargo,
    "src-tauri/Cargo.lock": newCargoLock,
  };
  for (const [name, value] of Object.entries(content)) {
    writeFileSync(path.join(root, name), value);
  }
  return inspectVersions(root);
}

function main(args) {
  const [command, ...options] = args;
  if (command === "set" && options.length === 1) {
    const result = setVersion(options[0]);
    if (result.problems.length) throw new Error(result.problems.join("\n"));
    console.log("VirtualLab version updated to " + result.version + " across all manifests and lockfiles.");
    return;
  }
  if (command === "check") {
    if (options.length && !(options.length === 2 && options[0] === "--tag")) {
      throw new Error("Usage: node scripts/version.mjs check [--tag vX.Y.Z]");
    }
    const result = inspectVersions(DEFAULT_ROOT, options[1]);
    if (result.problems.length) {
      throw new Error("VirtualLab version mismatch:\n- " + result.problems.join("\n- "));
    }
    console.log("VirtualLab " + result.version + ": package, Tauri, Cargo and lockfiles agree.");
    return;
  }
  throw new Error("Usage: node scripts/version.mjs check [--tag vX.Y.Z] | set X.Y.Z");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
