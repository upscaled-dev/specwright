import * as path from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { resolveVSCodeExecutablePath, resolveVSCodeVersion } from "./vscode-executable-path";

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate the workbench inspection port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

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
  const inspectionPort = process.env["SPECWRIGHT_PROGRESS_UI"] === "1"
    ? await availablePort()
    : undefined;

  await runTests({
    vscodeExecutablePath: resolveVSCodeExecutablePath(downloadedExecutablePath),
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(inspectionPort === undefined ? {} : {
      extensionTestsEnv: { SPECWRIGHT_WORKBENCH_PORT: String(inspectionPort) },
    }),
    launchArgs: [
      `--folder-uri=${pathToFileURL(fixtureWorkspacePath).toString()}`,
      "--disable-extensions",
      ...(inspectionPort === undefined ? [] : [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${inspectionPort}`,
      ]),
    ],
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
