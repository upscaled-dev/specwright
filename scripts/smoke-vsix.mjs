#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests, runVSCodeCommand } from "@vscode/test-electron";
import { argumentValue } from "./release-artifact.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function findVsix() {
  const requested = argumentValue("--vsix");
  if (requested) {return resolve(REPO_ROOT, requested);}

  const dist = resolve(REPO_ROOT, "dist");
  const candidates = readdirSync(dist)
    .filter((name) => name.endsWith(".vsix"))
    .map((name) => resolve(dist, name));
  if (candidates.length !== 1) {
    throw new Error(`Expected one VSIX in dist, found ${candidates.length}`);
  }
  return candidates[0];
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const vsixPath = findVsix();
  const smokeRunner = resolve(REPO_ROOT, "out", "test", "integration", "smoke", "index.js");
  const smokeHarness = resolve(REPO_ROOT, "src", "test", "integration", "smoke-harness");
  if (!existsSync(smokeRunner)) {throw new Error("Compile integration tests before running the VSIX smoke test");}

  // The integration build (a prerequisite of this script) already owns version and
  // executable resolution; import the compiled module instead of duplicating it here.
  const { resolveVSCodeExecutablePath, resolveVSCodeVersion } = await import(
    pathToFileURL(resolve(REPO_ROOT, "out", "test", "integration", "vscode-executable-path.js")).href
  );
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  const version = resolveVSCodeVersion(
    process.env.SPECWRIGHT_VSCODE_VERSION ?? "stable",
    packageJson.engines.vscode
  );
  const profileRoot = mkdtempSync(resolve(tmpdir(), "specwright-vsix-smoke-"));
  const extensionsDir = resolve(profileRoot, "extensions");
  const userDataDir = resolve(profileRoot, "user-data");
  const profileArgs = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`];

  try {
    console.log(`Installing ${basename(vsixPath)} into VS Code ${version}`);
    await runVSCodeCommand(
      ["--install-extension", vsixPath, "--force", ...profileArgs],
      { version }
    );
    const downloadedPath = await downloadAndUnzipVSCode({
      version,
      extensionDevelopmentPath: REPO_ROOT,
    });
    const fixture = resolve(REPO_ROOT, "src", "test", "integration", "fixtures", "workspace");
    await runTests({
      vscodeExecutablePath: resolveVSCodeExecutablePath(downloadedPath),
      extensionDevelopmentPath: smokeHarness,
      extensionTestsPath: smokeRunner,
      launchArgs: [
        `--folder-uri=${pathToFileURL(fixture).toString()}`,
        ...profileArgs,
      ],
    });
    console.log("Installed VSIX activated and discovered the fixture scenario");
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
