import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveExecutableCommand,
  runBoundedCommand,
} from "../../../core/bounded-command-runner";
import { Logger } from "../../../utils/logger";
import { shellQuote } from "../../../utils/shell";

function installedBddgenTarget(projectDir: string): string {
  const manifestPath = require.resolve("playwright-bdd/package.json", { paths: [projectDir] });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    bin: { bddgen: string };
  };
  return path.resolve(path.dirname(manifestPath), manifest.bin.bddgen);
}

suite("Bounded command runner (real Extension Host)", () => {
  const logger = Logger.create();
  let projectDir: string;
  let generatedDir: string;

  setup(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-host-bddgen-"));
    generatedDir = path.join(projectDir, ".features-gen");
    fs.symlinkSync(
      path.resolve(__dirname, "../../../..", "node_modules"),
      path.join(projectDir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
    fs.mkdirSync(path.join(projectDir, "features"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "steps"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "features", "runner.feature"),
      "Feature: Runner boundary\n\n  Scenario: Installed binary\n    Given the boundary works\n"
    );
    fs.writeFileSync(
      path.join(projectDir, "steps", "runner.steps.ts"),
      'import { createBdd } from "playwright-bdd";\n' +
      "const { Given } = createBdd();\n" +
      'Given("the boundary works", async () => {});\n'
    );
    fs.writeFileSync(
      path.join(projectDir, "playwright.config.ts"),
      'import { defineConfig } from "@playwright/test";\n' +
      'import { defineBddConfig } from "playwright-bdd";\n' +
      "const testDir = defineBddConfig({ features: \"features/*.feature\", steps: \"steps/*.ts\" });\n" +
      "export default defineConfig({ testDir });\n"
    );
  });

  teardown(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  suiteTeardown(() => {
    logger.dispose();
  });

  test("launches the installed bddgen binary with only its requested argv", async () => {
    assert.ok(process.versions["electron"], "test is not running in an Electron Extension Host");
    const bddgenTarget = installedBddgenTarget(projectDir);
    const legacy = await runBoundedCommand({
      command: `${shellQuote(process.execPath)} ${shellQuote(bddgenTarget)}`,
      workingDir: projectDir,
      logger,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(legacy.success, false, "Electron unexpectedly launched bddgen with Node argv");
    assert.match(
      legacy.error,
      /too many arguments for 'test'\. Expected 0 arguments but got 1\./u,
      `historical Electron failure changed: ${legacy.error}`
    );

    const invocation = resolveExecutableCommand("npx bddgen", projectDir);
    assert.notEqual(invocation.executable, process.execPath, "bddgen resolved through Electron");
    const result = await runBoundedCommand({
      command: "npx bddgen",
      workingDir: projectDir,
      logger,
      signal: AbortSignal.timeout(10_000),
    });

    assert.equal(result.success, true, [
      `process.execPath: ${process.execPath}`,
      `resolved: ${JSON.stringify(invocation)}`,
      `stdout: ${result.output}`,
      `stderr: ${result.error}`,
    ].join("\n"));
    assert.equal(fs.existsSync(generatedDir), true, "bddgen did not generate .features-gen");
  });
});
