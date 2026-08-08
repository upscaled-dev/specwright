#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_PATH = resolve(REPO_ROOT, "package.json");
const CONTENTS_PATH = resolve(SCRIPT_DIR, "package-contents.json");
const DIST_DIR = resolve(REPO_ROOT, "dist");

// git resolves to git.exe and spawns directly on every platform. npm and npx are
// .cmd shims on Windows, which Node refuses to spawn without a shell (EINVAL since
// the CVE-2024-27980 patch); a shell command line needs whitespace-quoted arguments.
export function spawnPlan(name, args, platform = process.platform) {
  if (platform !== "win32" || name === "git") {
    return { file: name, args, shell: false };
  }
  return {
    file: name,
    args: args.map((arg) => (/\s/u.test(arg) ? `"${arg}"` : arg)),
    shell: true,
  };
}

function capture(name, args) {
  const plan = spawnPlan(name, args);
  return execFileSync(plan.file, plan.args, {
    cwd: REPO_ROOT,
    shell: plan.shell,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function run(name, args) {
  const plan = spawnPlan(name, args);
  execFileSync(plan.file, plan.args, { cwd: REPO_ROOT, shell: plan.shell, stdio: "inherit" });
}

export function listedPackageFiles(output) {
  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).sort();
}

export function assertPackageContents(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((file) => !actualSet.has(file)).sort();
  const unexpected = [...actualSet].filter((file) => !expectedSet.has(file)).sort();
  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const details = [
    ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    ...(unexpected.length > 0 ? [`unexpected: ${unexpected.join(", ")}`] : []),
  ];
  throw new Error(`VSIX package contents changed (${details.join("; ")})`);
}

export function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function artifactSet({ packageJson, commit, vsixPath, digest, sbomPath, sbomDigest }) {
  return {
    schemaVersion: 2,
    source: {
      repository: packageJson.repository?.url ?? "",
      commit,
    },
    components: [
      {
        kind: "vscode-extension",
        id: `${packageJson.publisher}.${packageJson.name}`,
        version: packageJson.version,
        artifact: {
          file: basename(vsixPath),
          sha256: digest,
        },
        sbom: {
          file: basename(sbomPath),
          sha256: sbomDigest,
        },
      },
    ],
  };
}

export function assertReleaseSource(status, commit) {
  if (!commit || commit === "unknown") {
    throw new Error("Release artifacts require a Git commit");
  }
  if (status.trim() !== "") {
    throw new Error("Release artifacts require a clean Git worktree; use package:vsix for development builds");
  }
  return commit;
}

export function pathsFor(version, requestedPath) {
  // A relative --out must anchor to the repo root: vsce runs with cwd REPO_ROOT,
  // so resolving against process.cwd() would split the package and checksum steps.
  const vsixPath = requestedPath
    ? resolve(REPO_ROOT, requestedPath)
    : resolve(DIST_DIR, `specwright-${version}.vsix`);
  const stem = vsixPath.endsWith(".vsix") ? vsixPath.slice(0, -5) : vsixPath;
  return {
    vsixPath,
    checksumPath: `${vsixPath}.sha256`,
    sbomPath: `${stem}.sbom.cdx.json`,
    manifestPath: `${stem}.artifact-set.json`,
  };
}

function expectedContents() {
  return JSON.parse(readFileSync(CONTENTS_PATH, "utf8")).sort();
}

function releaseCommit() {
  const commit = capture("git", ["rev-parse", "HEAD"]);
  const status = capture("git", ["status", "--porcelain", "--untracked-files=all"]);
  return assertReleaseSource(status, commit);
}

export function verifyReleaseArtifact(vsixPath, expected = {}) {
  const [expectedDigest, checksumFile] = readFileSync(`${vsixPath}.sha256`, "utf8").trim().split(/\s+/u);
  const actual = sha256(vsixPath);
  if (!expectedDigest || checksumFile !== basename(vsixPath) || actual !== expectedDigest) {
    throw new Error(`VSIX checksum mismatch: expected ${expectedDigest ?? "missing"}, received ${actual}`);
  }
  const stem = vsixPath.endsWith(".vsix") ? vsixPath.slice(0, -5) : vsixPath;
  const manifest = JSON.parse(readFileSync(`${stem}.artifact-set.json`, "utf8"));
  if (manifest.schemaVersion !== 2) {
    throw new Error(`Unsupported artifact-set schema: expected 2, received ${manifest.schemaVersion ?? "missing"}`);
  }
  const component = manifest.components?.find((entry) => entry.kind === "vscode-extension");
  const recorded = component?.artifact?.sha256;
  if (recorded !== actual || component?.artifact?.file !== basename(vsixPath)) {
    throw new Error(`Artifact-set manifest checksum mismatch: expected ${recorded ?? "missing"}, received ${actual}`);
  }
  if (expected.commit && manifest.source?.commit !== expected.commit) {
    throw new Error(`Artifact-set commit mismatch: expected ${expected.commit}, received ${manifest.source?.commit ?? "missing"}`);
  }
  if (expected.version && component?.version !== expected.version) {
    throw new Error(`Artifact-set version mismatch: expected ${expected.version}, received ${component?.version ?? "missing"}`);
  }
  const sbomFile = component?.sbom?.file;
  const sbomPath = resolve(dirname(vsixPath), sbomFile ?? "");
  const sbomDigest = component?.sbom?.sha256;
  if (!sbomFile || sbomFile !== basename(sbomFile) || !sbomDigest || sha256(sbomPath) !== sbomDigest) {
    throw new Error("Artifact-set SBOM checksum mismatch");
  }
  return actual;
}

export function createReleaseArtifact(requestedPath) {
  const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  const paths = pathsFor(packageJson.version, requestedPath);
  const commit = releaseCommit();
  mkdirSync(dirname(paths.vsixPath), { recursive: true });

  const listed = listedPackageFiles(capture("npx", ["vsce", "ls", "--no-dependencies"]));
  assertPackageContents(listed, expectedContents());
  console.log(`package contents: ${listed.length} expected files`);

  // The artifact set is all-or-nothing: a failure mid-write must not leave a
  // VSIX without its checksum and manifest, or --verify and the smoke test
  // start from a half-built dist.
  try {
    run("npx", ["vsce", "package", "--no-dependencies", "--out", paths.vsixPath]);
    const digest = sha256(paths.vsixPath);
    const sbom = JSON.parse(capture("npm", [
      "sbom",
      "--package-lock-only",
      "--sbom-format",
      "cyclonedx",
      "--omit",
      "dev",
    ]));
    writeFileSync(paths.sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
    const sbomDigest = sha256(paths.sbomPath);
    writeFileSync(paths.checksumPath, `${digest}  ${basename(paths.vsixPath)}\n`);
    writeFileSync(
      paths.manifestPath,
      `${JSON.stringify(artifactSet({
        packageJson,
        commit,
        vsixPath: paths.vsixPath,
        digest,
        sbomPath: paths.sbomPath,
        sbomDigest,
      }), null, 2)}\n`
    );
    console.log(`sha256: ${digest}`);
  } catch (error) {
    for (const partial of [paths.vsixPath, paths.sbomPath, paths.checksumPath, paths.manifestPath]) {
      rmSync(partial, { force: true });
    }
    throw error;
  }

  console.log(`release artifact: ${paths.vsixPath}`);
  return paths;
}

export function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const requestedPath = argumentValue("--out");
  const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  const { vsixPath } = pathsFor(packageJson.version, requestedPath);
  if (process.argv.includes("--verify")) {
    console.log(`verified sha256: ${verifyReleaseArtifact(vsixPath, {
      commit: argumentValue("--commit"),
      version: argumentValue("--version"),
    })}`);
    return;
  }
  createReleaseArtifact(requestedPath);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
