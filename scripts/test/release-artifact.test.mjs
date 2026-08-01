import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  artifactSet,
  assertReleaseSource,
  assertPackageContents,
  listedPackageFiles,
  pathsFor,
  sha256,
  spawnPlan,
  verifyReleaseArtifact,
} from "../release-artifact.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

test("listedPackageFiles normalizes platform line endings and ordering", () => {
  assert.deepEqual(listedPackageFiles("b\r\na\r\n\r\n"), ["a", "b"]);
});

test("assertPackageContents reports missing and unexpected files", () => {
  assert.throws(
    () => assertPackageContents(["a", "extra"], ["a", "missing"]),
    /missing: missing; unexpected: extra/u
  );
});

test("artifactSet records one extensible component with the tested digest", () => {
  const manifest = artifactSet({
    packageJson: {
      name: "specwright",
      publisher: "upscaled-dev",
      version: "1.2.3",
      repository: { url: "https://example.test/specwright.git" },
    },
    commit: "abc123",
    vsixPath: "/tmp/specwright-1.2.3.vsix",
    digest: "digest",
    sbomPath: "/tmp/specwright-1.2.3.sbom.cdx.json",
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.components, [{
    kind: "vscode-extension",
    id: "upscaled-dev.specwright",
    version: "1.2.3",
    artifact: { file: "specwright-1.2.3.vsix", sha256: "digest" },
    sbom: "specwright-1.2.3.sbom.cdx.json",
  }]);
});

test("assertReleaseSource rejects dirty or unidentified source", () => {
  assert.equal(assertReleaseSource("", "abc123"), "abc123");
  assert.throws(() => assertReleaseSource(" M package.json", "abc123"), /clean Git worktree/u);
  assert.throws(() => assertReleaseSource("", "unknown"), /require a Git commit/u);
});

test("verifyReleaseArtifact rejects a changed artifact", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "specwright-artifact-test-"));
  const artifact = resolve(directory, "specwright.vsix");
  try {
    writeFileSync(artifact, "tested");
    const digest = sha256(artifact);
    writeFileSync(`${artifact}.sha256`, `${digest}  specwright.vsix\n`);
    writeFileSync(resolve(directory, "specwright.artifact-set.json"), JSON.stringify({
      components: [{ kind: "vscode-extension", artifact: { sha256: digest } }],
    }));
    assert.equal(verifyReleaseArtifact(artifact), sha256(artifact));

    writeFileSync(artifact, "changed");
    assert.throws(() => verifyReleaseArtifact(artifact), /checksum mismatch/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyReleaseArtifact rejects a manifest that disagrees with the checksum file", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "specwright-artifact-test-"));
  const artifact = resolve(directory, "specwright.vsix");
  try {
    writeFileSync(artifact, "tested");
    writeFileSync(`${artifact}.sha256`, `${sha256(artifact)}  specwright.vsix\n`);
    writeFileSync(resolve(directory, "specwright.artifact-set.json"), JSON.stringify({
      components: [{ kind: "vscode-extension", artifact: { sha256: "stale-digest" } }],
    }));
    assert.throws(() => verifyReleaseArtifact(artifact), /manifest checksum mismatch/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spawnPlan shells only npm and npx on Windows and quotes whitespace", () => {
  assert.deepEqual(spawnPlan("git", ["rev-parse", "HEAD"], "win32"), {
    file: "git",
    args: ["rev-parse", "HEAD"],
    shell: false,
  });
  assert.deepEqual(spawnPlan("npx", ["vsce", "package", "--out", "C:\\a dir\\x.vsix"], "win32"), {
    file: "npx",
    args: ["vsce", "package", "--out", "\"C:\\a dir\\x.vsix\""],
    shell: true,
  });
  assert.deepEqual(spawnPlan("npm", ["sbom"], "linux"), {
    file: "npm",
    args: ["sbom"],
    shell: false,
  });
});

test("pathsFor anchors a relative --out to the repo root and derives the set from the stem", () => {
  const relative = pathsFor("1.2.3", "build/custom.vsix");
  assert.equal(relative.vsixPath, resolve(REPO_ROOT, "build", "custom.vsix"));
  assert.equal(relative.checksumPath, `${relative.vsixPath}.sha256`);
  assert.equal(relative.sbomPath, resolve(REPO_ROOT, "build", "custom.sbom.cdx.json"));
  assert.equal(relative.manifestPath, resolve(REPO_ROOT, "build", "custom.artifact-set.json"));

  const defaulted = pathsFor("1.2.3", undefined);
  assert.equal(defaulted.vsixPath, resolve(REPO_ROOT, "dist", "specwright-1.2.3.vsix"));
});

test("release orchestration keeps artifact gates mandatory and ordered", () => {
  // Strip line comments so a commented-out gate cannot satisfy the assertions.
  const release = readFileSync(resolve(REPO_ROOT, "scripts", "release.mjs"), "utf8")
    .replace(/^\s*\/\/.*$/gmu, "");
  assert.equal(release.includes("skip-tests"), false);
  const ordered = [
    "runPipeline();",
    "commitRelease(next);",
    "packageAndTest();",
    "rollbackReleaseCommit(next);",
    "tagRelease(next);",
  ].map((needle) => release.indexOf(needle));
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
});

test("CI packages only after quality and integration and keeps maps outside the VSIX", () => {
  const workflow = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /package:\r?\n[\s\S]*?needs: \[quality, integration\]/u);
  assert.match(workflow, /run: npm run package:release[\s\S]*?run: xvfb-run -a npm run test:vsix[\s\S]*?run: npm run verify:release/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(
    workflow,
    /uses: actions\/attest-build-provenance@v\d+\r?\n\s+with:\r?\n\s+subject-path:/u
  );

  const ignore = readFileSync(resolve(REPO_ROOT, ".vscodeignore"), "utf8");
  assert.match(ignore, /^\*\*\/\*\.map$/mu);
});
