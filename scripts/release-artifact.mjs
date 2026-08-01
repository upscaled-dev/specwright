#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_PATH = resolve(REPO_ROOT, "package.json");
const CONTENTS_PATH = resolve(SCRIPT_DIR, "package-contents.json");
const DIST_DIR = resolve(REPO_ROOT, "dist");

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function capture(name, args) {
  return execFileSync(executable(name), args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function run(name, args) {
  execFileSync(executable(name), args, { cwd: REPO_ROOT, stdio: "inherit" });
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

export function artifactSet({ packageJson, commit, vsixPath, digest, sbomPath }) {
  return {
    schemaVersion: 1,
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
        sbom: basename(sbomPath),
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

function pathsFor(version, requestedPath) {
  const vsixPath = requestedPath ?? resolve(DIST_DIR, `specwright-${version}.vsix`);
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

export function verifyReleaseArtifact(vsixPath) {
  const expected = readFileSync(`${vsixPath}.sha256`, "utf8").trim().split(/\s+/u)[0];
  const actual = sha256(vsixPath);
  if (!expected || actual !== expected) {
    throw new Error(`VSIX checksum mismatch: expected ${expected ?? "missing"}, received ${actual}`);
  }
  const stem = vsixPath.endsWith(".vsix") ? vsixPath.slice(0, -5) : vsixPath;
  const manifest = JSON.parse(readFileSync(`${stem}.artifact-set.json`, "utf8"));
  const recorded = manifest.components?.find((component) => component.kind === "vscode-extension")
    ?.artifact?.sha256;
  if (recorded !== actual) {
    throw new Error(`Artifact-set manifest checksum mismatch: expected ${recorded ?? "missing"}, received ${actual}`);
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
  writeFileSync(paths.checksumPath, `${digest}  ${basename(paths.vsixPath)}\n`);
  writeFileSync(
    paths.manifestPath,
    `${JSON.stringify(artifactSet({
      packageJson,
      commit,
      vsixPath: paths.vsixPath,
      digest,
      sbomPath: paths.sbomPath,
    }), null, 2)}\n`
  );

  console.log(`release artifact: ${paths.vsixPath}`);
  console.log(`sha256: ${digest}`);
  return paths;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const requestedPath = argumentValue("--out");
  const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  const { vsixPath } = pathsFor(packageJson.version, requestedPath);
  if (process.argv.includes("--verify")) {
    console.log(`verified sha256: ${verifyReleaseArtifact(vsixPath)}`);
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
