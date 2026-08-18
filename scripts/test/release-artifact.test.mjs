import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import test from "node:test";
import {
  artifactSet,
  assertRequiredSbomComponents,
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
const JOB_PERMISSION_ALLOWLIST = new Map([["ci.yml:promote", [
  "actions: read",
  "contents: read",
  "id-token: write",
  "attestations: write",
]]]);
let generatedReleaseSbom;

function releaseSbom() {
  if (generatedReleaseSbom) {
    return generatedReleaseSbom;
  }
  const args = ["sbom", "--package-lock-only", "--sbom-format", "cyclonedx", "--omit", "dev", "--json"];
  const plan = spawnPlan("npm", args);
  generatedReleaseSbom = JSON.parse(execFileSync(plan.file, plan.args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: plan.shell,
  }));
  return generatedReleaseSbom;
}

function writeReleaseSbom(path) {
  writeFileSync(path, `${JSON.stringify(releaseSbom())}\n`);
}

function yamlJob(workflow, name) {
  const marker = new RegExp(`^  ["']?${escapeRegex(name)}["']?:\\r?$`, "mu");
  const match = marker.exec(workflow);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, `missing ${name} job`);
  const following = workflow.slice(start + match[0].length);
  const nextJob = /^  ["']?[a-z][a-z0-9_-]*["']?:\r?$/mu.exec(following);
  return nextJob ? workflow.slice(start, start + match[0].length + nextJob.index) : workflow.slice(start);
}

function yamlSteps(job) {
  return job.split(/^      - /gmu).slice(1).map((block) => {
    const [header] = block.split(/\r?\n/u);
    const run = /^        run: \|\r?\n((?:^          .*\r?\n?)*)/mu.exec(block)?.[1] ?? "";
    return { header, run, source: block };
  });
}

function workflowSources(workflows = resolve(REPO_ROOT, ".github", "workflows")) {
  return new Map(readdirSync(workflows)
    .filter((filename) => /\.ya?ml$/iu.test(filename))
    .sort()
    .map((filename) => [filename, readFileSync(resolve(workflows, filename), "utf8")]));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeRun(value) {
  if (typeof value !== "string") return false;
  const command = value.split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, ""))
    .join("\n");
  return /\b(?:node|npm|npx|corepack|pnpm|yarn)\b/u.test(command);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isLocalAction(reference) {
  if (!reference.startsWith("./")) return false;
  const relative = reference.slice(2);
  return relative !== "" && !relative.includes("\\") && !relative.split("/").includes("..") && posix.normalize(relative) === relative && !posix.isAbsolute(relative);
}

function hasActionVersionComment(stepSource, reference) {
  const line = new RegExp(`^(?:uses| {8}uses)\\s*:\\s*["']?${escapeRegex(reference)}["']?\\s+#\\s*v\\d+(?:\\.\\d+){0,2}\\s*$`, "mu");
  return line.test(stepSource);
}

function assertWorkflowSupplyPolicy(workflows) {
  assert.ok(workflows.size > 0, "repository has no workflows");
  for (const [filename, source] of workflows) {
    const workflow = load(source);
    assert.ok(isRecord(workflow), `${filename} must contain an object`);
    assert.deepEqual(workflow.permissions, { contents: "read" }, `${filename} must default to contents: read`);
    assert.ok(isRecord(workflow.jobs), `${filename} must contain jobs`);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.ok(isRecord(job), `${filename}: ${name} must be an object`);
      assert.ok(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0, `${filename}: ${name} needs a timeout`);
      if (Object.hasOwn(job, "permissions")) {
        const allowed = JOB_PERMISSION_ALLOWLIST.get(`${filename}:${name}`);
        assert.ok(allowed, `${filename}: ${name} has no approved job permissions`);
        assert.deepEqual(
          job.permissions,
          Object.fromEntries(allowed.map((line) => line.split(": "))),
          `${filename}: ${name} must use its approved permissions`
        );
      }
      assert.ok(Array.isArray(job.steps), `${filename}: ${name} must contain steps`);
      let sourceSteps;

      let checkout = -1;
      let setupNode = -1;
      let firstNodeRun = -1;
      for (const [index, step] of job.steps.entries()) {
        assert.ok(isRecord(step), `${filename}: ${name} step ${index + 1} must be an object`);
        if (Object.hasOwn(step, "uses")) {
          assert.equal(typeof step.uses, "string", `${filename}: ${name} step ${index + 1} uses must be a string`);
          if (step.uses.startsWith("./")) {
            assert.ok(isLocalAction(step.uses), `${filename}: ${step.uses} must name a normalized repository-local action`);
          } else {
            assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u, `${filename}: ${step.uses} must use an immutable commit SHA`);
            sourceSteps ??= yamlSteps(yamlJob(source, name));
            assert.equal(sourceSteps.length, job.steps.length, `${filename}: ${name} source steps must match parsed steps`);
            assert.ok(hasActionVersionComment(sourceSteps[index].source, step.uses), `${filename}: ${step.uses} must name its version on its uses line`);
          }
          if (step.uses.startsWith("actions/checkout@")) checkout = index;
          if (step.uses.startsWith("actions/setup-node@")) {
            setupNode = index;
            assert.ok(isRecord(step.with), `${filename}: ${name} setup-node needs inputs`);
            assert.equal(step.with["node-version-file"], ".node-version", `${filename}: ${name} setup-node must use .node-version`);
          }
        }
        if (firstNodeRun === -1 && isNodeRun(step.run)) firstNodeRun = index;
      }
      if (firstNodeRun !== -1) {
        assert.ok(checkout >= 0 && checkout < setupNode, `${filename}: ${name} must check out before setting up Node`);
        assert.ok(setupNode >= 0 && setupNode < firstNodeRun, `${filename}: ${name} must set up Node before running it`);
      }
    }
  }
}

function assertDependencyAutomation(config) {
  const parsed = load(config);
  assert.ok(isRecord(parsed), "Dependabot config must be a YAML object");
  assert.equal(parsed.version, 2, "Dependabot config must use version 2");
  assert.ok(Array.isArray(parsed.updates), "Dependabot config needs updates");
  const matching = (ecosystem) => parsed.updates.filter((update) => isRecord(update)
    && update["package-ecosystem"] === ecosystem
    && update.directory === "/"
    && isRecord(update.schedule)
    && update.schedule.interval === "weekly"
    && update.schedule.day === "monday");
  const npm = matching("npm");
  const actions = matching("github-actions");
  assert.ok(npm.length > 0, "npm updates must run weekly");
  assert.ok(actions.length > 0, "github-actions updates must run weekly");
  for (const update of [...npm, ...actions]) {
    const pullRequestLimit = update["open-pull-requests-limit"];
    assert.ok(
      pullRequestLimit === undefined || (Number.isInteger(pullRequestLimit) && pullRequestLimit > 0),
      `${update["package-ecosystem"]} updates must omit open-pull-requests-limit or use a positive integer`
    );
    assert.ok(!Array.isArray(update.ignore) || !update.ignore.some((rule) => isRecord(rule)
      && typeof rule["dependency-name"] === "string"
      && /^\*+$/u.test(rule["dependency-name"])), `${update["package-ecosystem"]} updates cannot ignore every dependency`);
  }
  assert.ok(npm.some((update) => isRecord(update.groups)
    && isRecord(update.groups["production-dependencies"])
    && update.groups["production-dependencies"]["dependency-type"] === "production"
    && isRecord(update.groups["development-dependencies"])
    && update.groups["development-dependencies"]["dependency-type"] === "development"), "npm updates need production and development groups");
  assert.ok(actions.some((update) => isRecord(update.groups)
    && isRecord(update.groups["github-actions"])
    && Array.isArray(update.groups["github-actions"].patterns)
    && update.groups["github-actions"].patterns.includes("*")), "github-actions updates need the action group");
}

function assertImmutablePromotion(promotion, packageScripts) {
  const steps = yamlSteps(promotion);
  assert.deepEqual(steps.map(({ header }) => header), [
    "uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
    "uses: actions/setup-node@0a44ba7841725637a19e28fa30b79a866c81b0a6 # v4.0.4",
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

test("production SBOM includes bundled Codicons", () => {
  const sbom = releaseSbom();
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies["@vscode/codicons"], "^0.0.46-24");
  assertRequiredSbomComponents(sbom);
  assert.ok(sbom.components.some((component) => component.name === "@vscode/codicons"));
});

test("packaged Codicons retain their license and inventory records", () => {
  const codiconLicense = readFileSync(resolve(REPO_ROOT, "node_modules", "@vscode", "codicons", "LICENSE-CODE"), "utf8")
    .replaceAll("\r\n", "\n")
    .trim()
    .replace(/^ {4}/gmu, "");
  const thirdParty = readFileSync(resolve(REPO_ROOT, "THIRD_PARTY_LICENSES.md"), "utf8").replaceAll("\r\n", "\n");
  const projectLicense = readFileSync(resolve(REPO_ROOT, "LICENSE"), "utf8");
  const development = readFileSync(resolve(REPO_ROOT, "docs", "development.md"), "utf8");
  const inventory = JSON.parse(readFileSync(resolve(REPO_ROOT, "scripts", "package-contents.json"), "utf8"));

  assert.ok(thirdParty.includes(codiconLicense));
  assert.match(thirdParty, /creativecommons\.org\/licenses\/by\/4\.0\/legalcode/u);
  assert.match(projectLicense, /license notices and details for bundled third-party works\./u);
  assert.match(development, new RegExp(`currently lists ${inventory.length} files`));
  for (const file of ["dist/codicon.css", "dist/codicon.ttf", "THIRD_PARTY_LICENSES.md", "LICENSE"]) {
    assert.ok(inventory.includes(file), `package inventory is missing ${file}`);
  }
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
    writeReleaseSbom(sbom);
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
    writeReleaseSbom(sbom);
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

test("verifyReleaseArtifact rejects an SBOM without bundled Codicons", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "specwright-artifact-test-"));
  const artifact = resolve(directory, "specwright.vsix");
  const sbom = resolve(directory, "specwright.sbom.cdx.json");
  try {
    writeFileSync(artifact, "tested");
    const digest = sha256(artifact);
    const withoutCodicons = {
      ...releaseSbom(),
      components: releaseSbom().components.filter((component) => component.name !== "@vscode/codicons"),
    };
    writeFileSync(sbom, `${JSON.stringify(withoutCodicons)}\n`);
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

    assert.throws(
      () => verifyReleaseArtifact(artifact, { commit: "abc123", version: "1.2.3" }),
      /Release SBOM missing required components: @vscode\/codicons/u
    );
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
    writeReleaseSbom(sbom);
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

test("workflow policy parses discovered YAML semantics", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "specwright-workflow-test-"));
  const checkout = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
  const setupNode = "actions/setup-node@0a44ba7841725637a19e28fa30b79a866c81b0a6";
  const write = (filename, source) => writeFileSync(resolve(directory, filename), source);
  const failure = (source, message, filename = "invalid.yaml") => {
    write(filename, source);
    assert.throws(() => assertWorkflowSupplyPolicy(workflowSources(directory)), message);
    rmSync(resolve(directory, filename), { force: true });
  };
  try {
    write("local.yml", `name: Local
permissions: { contents: read }
jobs:
  local:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - { uses: "./local-action" }
`);
    write("semantic.yaml", `name: Semantic
permissions:
  contents: read
"jobs":
  "node":
    runs-on: ubuntu-latest
    "timeout-minutes": 1
    steps:
      - uses : "${checkout}" # v4.2.2
      - uses : "${setupNode}" # v4.0.4
        with: { node-version-file: .node-version }
      - uses: acme/example/action-path@0123456789abcdef0123456789abcdef01234567 # v1.2.3
      - run: >-
          npm test
`);
    assert.equal(workflowSources(directory).size, 2);
    assertWorkflowSupplyPolicy(workflowSources(directory));

    failure(`name: Docker
permissions: { contents: read }
jobs:
  job: { runs-on: ubuntu-latest, timeout-minutes: 1, steps: [{ uses: docker://alpine:3.20 }] }
`, /must use an immutable commit SHA/u);
    failure(`name: Mutable
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: "actions/checkout@v4" # v4
`, /must use an immutable commit SHA/u);
    failure(`name: Missing comment
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: ${checkout}
`, /must name its version/u);
    failure(`name: Timeout
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    steps: [{ uses: ./local-action }]
`, /needs a timeout/u);
    failure(`name: Traversal
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps: [{ uses: ./../outside }]
`, /normalized repository-local action/u);
    failure(`name: Detached comment
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: ${checkout}
      # uses: ${checkout} # v4.2.2
      - uses: ${setupNode} # v4.0.4
        with: { node-version-file: .node-version }
      - run: npm test
`, /must name its version on its uses line/u);
    failure(`name: Duplicate action comment
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: ${checkout} # v4.2.2
      - uses: ${checkout}
      - uses: ${setupNode} # v4.0.4
        with: { node-version-file: .node-version }
      - run: npm test
`, /must name its version on its uses line/u);
    failure(`name: Block scalar decoy
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: ${checkout}
        run: |
          uses: ${checkout} # v4.2.2
      - uses: ${setupNode} # v4.0.4
        with: { node-version-file: .node-version }
      - run: npm test
`, /must name its version on its uses line/u);
    failure(`name: Package runner
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: ${checkout} # v4.2.2
      - run: corepack pnpm test
`, /must check out before setting up Node/u);
    failure(`name: Permissions
permissions: { contents: read }
jobs:
  promote:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    permissions: write-all
    steps: [{ uses: ./local-action }]
`, /ci.yml: promote must use its approved permissions/u, "ci.yml");
    failure(`name: Comment only
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: ${checkout} # v4.2.2
      # - uses: ${setupNode} # v4.0.4
      - run: npm test
`, /must check out before setting up Node/u);
    failure(`name: Wrong order
permissions: { contents: read }
jobs:
  job:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: ${checkout} # v4.2.2
      - run: npm test
      - uses: ${setupNode} # v4.0.4
        with: { node-version-file: .node-version }
`, /must set up Node before running it/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CI builds the candidate after its gates and promotes it without rebuilding", () => {
  const workflows = workflowSources();
  const workflow = workflows.get("ci.yml");
  assert.ok(workflow, "missing ci.yml");
  // Normalized so the mutation probes below can splice on their "\n" anchors after a CRLF checkout.
  const dependabot = readFileSync(resolve(REPO_ROOT, ".github", "dependabot.yml"), "utf8").replaceAll("\r\n", "\n");
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  assertWorkflowSupplyPolicy(workflows);
  assertDependencyAutomation(dependabot);
  assert.equal(packageJson.devDependencies["js-yaml"], "4.1.1");
  assert.equal(readFileSync(resolve(REPO_ROOT, ".node-version"), "utf8").trim(), "24.18.1");
  assert.match(readFileSync(resolve(REPO_ROOT, ".devcontainer", "Dockerfile"), "utf8"), /^FROM node:24\.18\.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7$/mu);
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("package-ecosystem: github-actions", "package-ecosystem: pip")),
    /github-actions updates must run weekly/u
  );
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("version: 2", "version: 1")),
    /must use version 2/u
  );
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("dependency-type: production", "dependency-type: direct")),
    /production and development groups/u
  );
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("groups:\n", "open-pull-requests-limit: 0\n    groups:\n")),
    /must omit open-pull-requests-limit or use a positive integer/u
  );
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("groups:\n", "open-pull-requests-limit: \"0\"\n    groups:\n")),
    /must omit open-pull-requests-limit or use a positive integer/u
  );
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("groups:\n", "open-pull-requests-limit: 1.5\n    groups:\n")),
    /must omit open-pull-requests-limit or use a positive integer/u
  );
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("labels:\n", "ignore:\n      - dependency-name: \"*\"\n    labels:\n")),
    /cannot ignore every dependency/u
  );
  assert.throws(
    () => assertDependencyAutomation(dependabot.replace("labels:\n", "ignore:\n      - dependency-name: \"**\"\n    labels:\n")),
    /cannot ignore every dependency/u
  );
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
  assert.match(promotion, /uses: actions\/download-artifact@[0-9a-f]{40} # v4\.3\.0[\s\S]*?github-token:[\s\S]*?run-id:/u);
  assert.match(promotion, /--commit "\$COMMIT" --version "\$VERSION"/u);
  assert.match(
    promotion,
    /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v2\.2\.2\r?\n\s+with:\r?\n\s+subject-path:/u
  );
  assert.match(promotion, /name: specwright-\$\{\{ github\.ref_name \}\}[\s\S]*?retention-days: 90/u);

  const ignore = readFileSync(resolve(REPO_ROOT, ".vscodeignore"), "utf8");
  assert.match(ignore, /^\.node-version$/mu);
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
