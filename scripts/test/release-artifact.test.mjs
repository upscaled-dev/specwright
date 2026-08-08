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

function yamlJob(workflow, name) {
  const marker = `  ${name}:`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} job`);
  const following = workflow.slice(start + marker.length);
  const nextJob = /^  [a-z][a-z0-9_-]*:\r?$/mu.exec(following);
  return nextJob ? workflow.slice(start, start + marker.length + nextJob.index) : workflow.slice(start);
}

function yamlSteps(job) {
  return job.split(/^      - /gmu).slice(1).map((block) => {
    const [header] = block.split(/\r?\n/u);
    const run = /^        run: \|\r?\n((?:^          .*\r?\n?)*)/mu.exec(block)?.[1] ?? "";
    return { header, run };
  });
}

function assertImmutablePromotion(promotion, packageScripts) {
  const steps = yamlSteps(promotion);
  assert.deepEqual(steps.map(({ header }) => header), [
    "uses: actions/checkout@v4",
    "name: Validate release tag and source commit",
    "name: Locate successful main candidate",
    "name: Download tested release candidate",
    "name: Verify candidate identity and contents",
    "name: Attest exact VSIX",
    "name: Retain promoted artifact set",
  ]);

  const commands = steps.map(({ run }) => run).filter(Boolean).join("\n");
  const npmRuns = [...commands.matchAll(/\bnpm run ([\w:-]+)/gu)].map((match) => match[1]);
  for (const script of Object.keys(packageScripts)) {
    assert.equal(npmRuns.includes(script), false, `promotion invokes ${script}`);
  }
  assert.deepEqual(npmRuns, []);
  assert.deepEqual(
    [...commands.matchAll(/\bnode scripts\/([^\s\\]+)/gu)].map((match) => match[1]),
    ["release-artifact.mjs"]
  );
  assert.match(commands, /release-artifact\.mjs --verify[\s\S]*?--commit "\$COMMIT" --version "\$VERSION"/u);
  assert.doesNotMatch(commands, /\b(?:npx\s+vsce\s+package|npm\s+(?:exec\s+vsce\s+package|pack|publish)|vsce\s+package)\b/u);
}

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
    sbomDigest: "sbom-digest",
  });

  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.source, {
    repository: "https://example.test/specwright.git",
    commit: "abc123",
  });
  assert.deepEqual(manifest.components, [{
    kind: "vscode-extension",
    id: "upscaled-dev.specwright",
    version: "1.2.3",
    artifact: { file: "specwright-1.2.3.vsix", sha256: "digest" },
    sbom: { file: "specwright-1.2.3.sbom.cdx.json", sha256: "sbom-digest" },
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
    const sbom = resolve(directory, "specwright.sbom.cdx.json");
    writeFileSync(sbom, "sbom");
    writeFileSync(`${artifact}.sha256`, `${digest}  specwright.vsix\n`);
    writeFileSync(resolve(directory, "specwright.artifact-set.json"), JSON.stringify({
      schemaVersion: 2,
      source: { commit: "abc123" },
      components: [{
        kind: "vscode-extension",
        version: "1.2.3",
        artifact: { file: "specwright.vsix", sha256: digest },
        sbom: { file: "specwright.sbom.cdx.json", sha256: sha256(sbom) },
      }],
    }));
    assert.equal(
      verifyReleaseArtifact(artifact, { commit: "abc123", version: "1.2.3" }),
      sha256(artifact)
    );

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
    const sbom = resolve(directory, "specwright.sbom.cdx.json");
    writeFileSync(sbom, "sbom");
    writeFileSync(`${artifact}.sha256`, `${sha256(artifact)}  specwright.vsix\n`);
    writeFileSync(resolve(directory, "specwright.artifact-set.json"), JSON.stringify({
      schemaVersion: 2,
      components: [{
        kind: "vscode-extension",
        artifact: { file: "specwright.vsix", sha256: "stale-digest" },
        sbom: { file: "specwright.sbom.cdx.json", sha256: sha256(sbom) },
      }],
    }));
    assert.throws(() => verifyReleaseArtifact(artifact), /manifest checksum mismatch/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyReleaseArtifact binds the candidate commit, version, and SBOM", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "specwright-artifact-test-"));
  const artifact = resolve(directory, "specwright.vsix");
  const sbom = resolve(directory, "specwright.sbom.cdx.json");
  try {
    writeFileSync(artifact, "tested");
    writeFileSync(sbom, "sbom");
    const digest = sha256(artifact);
    writeFileSync(`${artifact}.sha256`, `${digest}  specwright.vsix\n`);
    const manifestPath = resolve(directory, "specwright.artifact-set.json");
    const manifest = {
      schemaVersion: 2,
      source: { commit: "abc123" },
      components: [{
        kind: "vscode-extension",
        version: "1.2.3",
        artifact: { file: "specwright.vsix", sha256: digest },
        sbom: { file: "specwright.sbom.cdx.json", sha256: sha256(sbom) },
      }],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    assert.throws(
      () => verifyReleaseArtifact(artifact, { commit: "different" }),
      /commit mismatch/u
    );
    assert.throws(
      () => verifyReleaseArtifact(artifact, { version: "2.0.0" }),
      /version mismatch/u
    );
    writeFileSync(`${artifact}.sha256`, `${digest}  other.vsix\n`);
    assert.throws(() => verifyReleaseArtifact(artifact), /VSIX checksum mismatch/u);
    writeFileSync(`${artifact}.sha256`, `${digest}  specwright.vsix\n`);
    writeFileSync(sbom, "changed");
    assert.throws(() => verifyReleaseArtifact(artifact), /SBOM checksum mismatch/u);

    writeFileSync(sbom, "sbom");
    for (const schemaVersion of [undefined, 1, 3]) {
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion }));
      assert.throws(() => verifyReleaseArtifact(artifact), /Unsupported artifact-set schema/u);
    }
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
  assert.ok(release.indexOf('log("  git push origin main")') < release.indexOf("git push origin v${next}"));
  assert.match(release, /rollbackReleaseCommit\(next\)/u);
  assert.equal(
    release.includes('--commit "$(git rev-parse v${next}^{})" --version ${next}'),
    true
  );
});

test("CI builds the candidate after its gates and promotes it without rebuilding", () => {
  const workflow = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  assert.match(workflow, /package:\r?\n[\s\S]*?needs: \[quality, integration\]/u);
  assert.match(workflow, /run: npm run package:release[\s\S]*?run: xvfb-run -a npm run test:vsix[\s\S]*?run: npm run verify:release/u);
  assert.match(workflow, /name: specwright-\$\{\{ github\.sha \}\}[\s\S]*?retention-days: 90/u);

  const noTag = "if: ${{ !startsWith(github.ref, 'refs/tags/v') }}";
  for (const job of ["quality", "integration", "package"]) {
    assert.equal(yamlJob(workflow, job).split(/\r?\n/u).map((line) => line.trim()).includes(noTag), true);
  }

  const promotion = yamlJob(workflow, "promote");
  assert.equal(
    promotion.split(/\r?\n/u).map((line) => line.trim())
      .includes("if: startsWith(github.ref, 'refs/tags/v')"),
    true
  );
  assert.doesNotMatch(promotion, /^\s+needs:/mu);
  assertImmutablePromotion(promotion, packageJson.scripts);
  const packagingMutation = promotion.replace(
    "node scripts/release-artifact.mjs --verify",
    "npm run package:vsix\n          node scripts/release-artifact.mjs --verify"
  );
  assert.throws(
    () => assertImmutablePromotion(packagingMutation, packageJson.scripts),
    /promotion invokes package:vsix/u
  );
  assert.match(promotion, /actions: read\r?\n\s+contents: read\r?\n\s+id-token: write\r?\n\s+attestations: write/u);
  assert.match(promotion, /\/actions\/workflows\/ci\.yml\/runs/u);
  assert.match(promotion, /event=push[\s\S]*?head_sha="\$COMMIT"/u);
  assert.doesNotMatch(promotion, /\.path\s*==/u);
  assert.match(promotion, /uses: actions\/download-artifact@v4[\s\S]*?github-token:[\s\S]*?run-id:/u);
  assert.match(promotion, /--commit "\$COMMIT" --version "\$VERSION"/u);
  assert.match(
    promotion,
    /uses: actions\/attest-build-provenance@v\d+\r?\n\s+with:\r?\n\s+subject-path:/u
  );
  assert.match(promotion, /name: specwright-\$\{\{ github\.ref_name \}\}[\s\S]*?retention-days: 90/u);

  const ignore = readFileSync(resolve(REPO_ROOT, ".vscodeignore"), "utf8");
  assert.match(ignore, /^\*\*\/\*\.map$/mu);
});

test("compatibility record matches the lockfile, README, and exact CI hosts", () => {
  const record = readFileSync(resolve(REPO_ROOT, "docs", "compatibility.md"), "utf8");
  const rows = new Map(record.split(/\r?\n/u)
    .filter((line) => line.startsWith("|") && line.includes("`") && !line.includes("---"))
    .map((line) => {
      const [, component, version] = line.split("|").map((value) => value.trim());
      return [component.replaceAll("`", ""), /`([^`]+)`/u.exec(version)?.[1]];
    }));
  const minimum = rows.get("VS Code declared minimum");
  const current = rows.get("VS Code pinned current target");
  const playwright = rows.get("@playwright/test");
  const playwrightBdd = rows.get("playwright-bdd");
  assert.ok(minimum && current && playwright && playwrightBdd);

  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(resolve(REPO_ROOT, "package-lock.json"), "utf8"));
  assert.equal(/^[~^]?(\d+\.\d+\.\d+)/u.exec(packageJson.engines.vscode)?.[1], minimum);
  assert.equal(lockfile.packages["node_modules/@playwright/test"].version, playwright);
  assert.equal(lockfile.packages["node_modules/playwright-bdd"].version, playwrightBdd);

  const workflow = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const hosts = [...workflow.matchAll(/^\s+vscode: (\S+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(hosts.sort(), [minimum, current, current, current].sort());
  assert.doesNotMatch(workflow, /^\s+vscode: (?:stable|minimum)$/gmu);

  const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
  const gettingStarted = readFileSync(resolve(REPO_ROOT, "docs", "getting-started.md"), "utf8");
  assert.match(readme, /\[compatibility record\]\(docs\/compatibility\.md\)/u);
  assert.equal(readme.includes(`VS Code declares \`${minimum}\``), true);
  assert.doesNotMatch(readme, /\d+\.\d+\.x|current stable/u);
  assert.match(gettingStarted, /\[exact compatibility record\]\(compatibility\.md\)/u);
  assert.equal(gettingStarted.includes(`declared minimum is ${minimum}.`), true);

  const development = readFileSync(resolve(REPO_ROOT, "docs", "development.md"), "utf8");
  assert.match(development, /--commit "\$\(git rev-parse v0\.1\.1\^\{\}\)" \\\r?\n\s+--version 0\.1\.1/u);
});
