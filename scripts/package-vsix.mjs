#!/usr/bin/env node
// Dev packaging: bumps the patch version on every run, then wraps `vsce package`
// with a filename that identifies the exact source state:
//
//   specwright-<version>-g<sha>.vsix         (clean working tree)
//   specwright-<version>-g<sha>-dirty.vsix   (uncommitted changes)
//
// The patch bump (`npm version patch --no-git-tag-version`, updates package.json
// and package-lock.json, no commit/tag) makes every packaged build carry a unique
// version, so successive packages are trackable; the sha records provenance.
//
// Output goes to packages/ (git-ignored), NOT dist/ — `npm run clean` wipes dist/
// at the start of every package run, which is exactly why version history was
// untrackable before. Releases are unaffected: scripts/release.mjs invokes vsce
// itself with the canonical dist/specwright-<version>.vsix name.
//
// Usage: node scripts/package-vsix.mjs   (invoked by `npm run package:vsix`)

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(REPO_ROOT, "packages");

function log(msg) { console.log(`▸ ${msg}`); }
function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

function capture(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

log("bumping patch version");
execSync("npm version patch --no-git-tag-version", { cwd: REPO_ROOT, stdio: "inherit" });

const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
if (!version) { die("package.json has no version"); }

let sha = "nogit";
let dirty = false;
try {
  sha = capture("git rev-parse --short HEAD");
  dirty = capture("git status --porcelain") !== "";
} catch {
  log("not a git repository (or git unavailable) — tagging build as 'nogit'");
}

const suffix = dirty ? `-g${sha}-dirty` : `-g${sha}`;
const outPath = resolve(OUT_DIR, `specwright-${version}${suffix}.vsix`);

mkdirSync(OUT_DIR, { recursive: true });
log(`packaging ${outPath}`);
execSync(`npx vsce package --no-dependencies --out "${outPath}"`, {
  cwd: REPO_ROOT,
  stdio: "inherit",
});
log(`done: ${outPath}`);
