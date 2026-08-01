import * as path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { resolveVSCodeExecutablePath, resolveVSCodeVersion } from "./vscode-executable-path";

async function main(): Promise<void> {
  // If this env var is set in the host shell (e.g. when running inside another Electron app), the test runner's Electron will behave as Node and fail to launch. Strip it.
  delete process.env["ELECTRON_RUN_AS_NODE"];

  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index.js");
  const fixtureWorkspacePath = path.resolve(
    extensionDevelopmentPath,
    "src",
    "test",
    "integration",
    "fixtures",
    "workspace"
  );
  const packageJson = JSON.parse(readFileSync(path.resolve(extensionDevelopmentPath, "package.json"), "utf8")) as {
    engines: { vscode: string };
  };
  const requestedVersion = process.env["SPECWRIGHT_VSCODE_VERSION"] ?? "stable";
  const version = resolveVSCodeVersion(requestedVersion, packageJson.engines.vscode);
  console.log(`Testing with VS Code ${version}`);
  const downloadedExecutablePath = await downloadAndUnzipVSCode({ extensionDevelopmentPath, version });

  await runTests({
    vscodeExecutablePath: resolveVSCodeExecutablePath(downloadedExecutablePath),
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      `--folder-uri=${pathToFileURL(fixtureWorkspacePath).toString()}`,
      "--disable-extensions",
    ],
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
