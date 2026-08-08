#!/usr/bin/env node
// Release script: bump version, update CHANGELOG, run pipeline, package .vsix,
// commit, and tag. Stops before pushing — you push manually after a final review.
//
// Usage:
//   node scripts/release.mjs                       # default: patch bump
//   node scripts/release.mjs --type patch          # explicit patch
//   node scripts/release.mjs --type minor          # 0.1.5 -> 0.2.0
//   node scripts/release.mjs --type major          # 0.1.5 -> 1.0.0
//   node scripts/release.mjs --version 0.2.0       # explicit version
//   node scripts/release.mjs --type patch --dry-run
//
// Exit codes:
//   0 success
//   1 generic failure
//   2 git working tree dirty
//   3 invalid args
//   4 tag already exists

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PKG_PATH = resolve(REPO_ROOT, "package.json");
const CHANGELOG_PATH = resolve(REPO_ROOT, "CHANGELOG.md");

const args = parseArgs(process.argv.slice(2));
const isDryRun = args["dry-run"] === true;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") {
      out[a.slice(2)] = true;
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function log(msg) { console.log(`▸ ${msg}`); }
function warn(msg) { console.warn(`! ${msg}`); }
function die(code, msg) { console.error(`✗ ${msg}`); process.exit(code); }

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  if (isDryRun && opts.allowInDryRun !== true) return "";
  return execSync(cmd, { stdio: "inherit", cwd: REPO_ROOT, ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

function tryCapture(cmd) {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return undefined; }
}

// 1. Validate git state
function ensureCleanTree() {
  const status = tryCapture("git status --porcelain");
  if (status === undefined) {
    die(1, "git is not initialized in this directory (or not on PATH).");
  }
  if (status.length > 0) {
    if (isDryRun) {
      warn("git working tree is dirty (would fail on a real run; continuing for dry-run only).");
    } else {
      die(2, `git working tree is dirty. Commit or stash first.\n${status}`);
    }
  }
  const branch = tryCapture("git rev-parse --abbrev-ref HEAD");
  if (branch === undefined) {
    // Repo has no commits yet — releases require at least one commit.
    if (isDryRun) {
      warn("repo has no commits yet (would fail on a real run; continuing for dry-run only).");
      return;
    }
    die(1, "repo has no commits yet. Make an initial commit before releasing.");
  }
  if (branch !== "main" && branch !== "master") {
    warn(`On branch '${branch}' (not main/master). Continue? Press Ctrl+C to abort, Enter to proceed.`);
    if (process.stdin.isTTY && !isDryRun) {
      execSync("read _", { stdio: "inherit", shell: "/bin/bash" });
    }
  }
}

// 2. Compute next version
function bumpVersion(current, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) die(3, `current version '${current}' is not X.Y.Z`);
  let [, major, minor, patch] = m.map(Number);
  if (type === "patch") patch += 1;
  else if (type === "minor") { minor += 1; patch = 0; }
  else if (type === "major") { major += 1; minor = 0; patch = 0; }
  else die(3, `invalid --type '${type}' (expected patch|minor|major)`);
  return `${major}.${minor}.${patch}`;
}

function resolveNewVersion(currentVersion) {
  if (args.version) {
    if (!/^\d+\.\d+\.\d+$/.test(args.version)) {
      die(3, `--version must be X.Y.Z, got '${args.version}'`);
    }
    return args.version;
  }
  return bumpVersion(currentVersion, args.type ?? "patch");
}

// 3. Tag pre-check
function ensureTagFree(newVersion) {
  const tag = `v${newVersion}`;
  const existing = tryCapture(`git tag -l ${tag}`);
  if (existing === tag) die(4, `tag '${tag}' already exists`);
}

// 4. Update package.json AND package-lock.json in lockstep.
// `npm version --no-git-tag-version` bumps the version in both files (and only the
// package's own version fields — never a dependency that happens to share the string)
// without touching git. Hand-editing package.json alone was the root cause of repeated
// lockfile drift: the lockfile kept the old version, so the next `npm ci`/install dirtied
// the tree right after a release commit.
function updatePackageVersion(newVersion) {
  if (isDryRun) {
    log(`(dry-run) would run 'npm version --no-git-tag-version ${newVersion}' (package.json + package-lock.json → ${newVersion})`);
    return;
  }
  run(`npm version --no-git-tag-version ${newVersion}`);
  log(`package.json + package-lock.json version → ${newVersion}`);
}

// 5. Update CHANGELOG: move ## [Unreleased] content into a dated header,
//    leave a fresh empty ## [Unreleased] above for the next round.
function updateChangelog(newVersion) {
  const today = new Date().toISOString().slice(0, 10);
  const original = readFileSync(CHANGELOG_PATH, "utf-8");
  // Accept both `## Unreleased` and `## [Unreleased]` (Keep-a-Changelog style).
  const unreleasedHeader = /^## \[?Unreleased\]?\s*$/m;
  const match = unreleasedHeader.exec(original);
  if (!match) {
    warn("CHANGELOG.md has no '## Unreleased' or '## [Unreleased]' section — skipping CHANGELOG update.");
    return;
  }
  // Preserve whichever style the file uses for the new Unreleased header.
  const preservedHeader = match[0];
  const updated = original.replace(
    unreleasedHeader,
    `${preservedHeader}\n\n## [${newVersion}] - ${today}`
  );
  if (isDryRun) {
    log(`(dry-run) would insert '## [${newVersion}] - ${today}' below '${preservedHeader}'`);
    return;
  }
  writeFileSync(CHANGELOG_PATH, updated);
  log(`CHANGELOG.md → new section '## [${newVersion}] - ${today}'`);
}

// 6. Run source and contract gates before creating the release commit.
function runPipeline() {
  run("npm run check-types");
  run("npm run lint");
  run("npm run test:coverage");
  run("npm run test:contracts");
}

// 7. Commit the exact source state that the artifact identifies.
function commitRelease(newVersion) {
  run("git add package.json package-lock.json CHANGELOG.md");
  run(`git commit -m "chore(release): v${newVersion}"`);
}

// 8. Build once, package once, and test that exact VSIX.
function packageAndTest() {
  run("npm run build:release");
  run("npm run package:release");
  run("npm run test:integration:built");
  run("npm run test:vsix");
  run("npm run verify:release");
}

// 9. Tag only after every artifact gate passes.
function tagRelease(newVersion) {
  run(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
}

// The artifact gates need the release commit in place (release-artifact.mjs demands a
// clean worktree recording that exact commit), so a gate failure would otherwise strand
// an untagged, version-bumped commit: the next release run reads the bumped version and
// skips this one forever. Remove the commit so a rerun starts from the same version.
function rollbackReleaseCommit(newVersion) {
  const subject = tryCapture("git log -1 --format=%s");
  if (subject !== `chore(release): v${newVersion}`) {
    warn(`HEAD is not the v${newVersion} release commit; leaving git state untouched.`);
    return;
  }
  run("git reset --hard HEAD~1");
  warn(`artifact gate failed: removed the v${newVersion} release commit and version bump. Fix and rerun.`);
}

// --- main ---

(function main() {
  log(`release.mjs ${isDryRun ? "(dry-run)" : ""}`);

  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
  const current = pkg.version;
  const next = resolveNewVersion(current);
  log(`bumping ${current} → ${next}`);

  ensureCleanTree();
  ensureTagFree(next);

  updatePackageVersion(next);
  updateChangelog(next);
  runPipeline();
  commitRelease(next);
  try {
    packageAndTest();
  } catch (error) {
    rollbackReleaseCommit(next);
    die(1, error instanceof Error ? error.message : String(error));
  }
  tagRelease(next);

  log("");
  log(`✓ release ${next} prepared`);
  log("");
  log("Review what's about to be published:");
  log(`  git show v${next}`);
  log(`  ls -la dist/specwright-${next}.vsix`);
  log(`  cat dist/specwright-${next}.vsix.sha256`);
  log("");
  log("If everything looks right, build the hosted candidate before promoting it:");
  log("  git push origin main");
  log(`  wait for the successful main CI artifact named specwright-$(git rev-parse v${next}^{})`);
  log(`  git push origin v${next}`);
  log(`  wait for the tag workflow to verify, attest, and retain specwright-v${next}`);
  log("  then download that promoted artifact set (VSIX + checksum + SBOM + manifest) and verify it:");
  log(`  node scripts/release-artifact.mjs --verify --out <download>/specwright-${next}.vsix --commit "$(git rev-parse v${next}^{})" --version ${next}`);
  log("  publish that verified VSIX. The local .sha256 above identifies the local build only;");
  log("  vsce embeds timestamps, so local and CI digests differ by design.");
  log("");
  log("If something is wrong, remove the tag and the release commit:");
  log(`  git tag -d v${next}`);
  log(`  git reset --hard HEAD~1`);
})();
