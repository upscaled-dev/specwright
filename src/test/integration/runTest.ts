import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runTests } from "@vscode/test-electron";

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

  await runTests({
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
