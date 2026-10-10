import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveExecutableCommand,
  runBoundedCommand,
} from "../../../core/bounded-command-runner";
import { Logger } from "../../../utils/logger";

suite("Bounded command runner (real Extension Host)", () => {
  const logger = Logger.create();
  const checkoutDir = path.resolve(__dirname, "../../../..");
  let projectDir: string;
  let generatedDir: string;

  setup(() => {
    projectDir = fs.mkdtempSync(path.join(checkoutDir, ".specwright-host-bddgen-"));
    generatedDir = path.join(projectDir, ".features-gen");
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
    // Windows can hold the just-exited child's files briefly; retry the removal.
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  suiteTeardown(() => {
    logger.dispose();
  });

  test("launches the installed bddgen binary with only its requested argv", async () => {
    assert.ok(process.versions["electron"], "test is not running in an Electron Extension Host");
    const invocation = resolveExecutableCommand("npx bddgen", projectDir);
    assert.notEqual(invocation.executable, process.execPath, "bddgen resolved through Electron");
    const installedBddgen = process.platform === "win32" ? invocation.args[0] : invocation.executable;
    assert.ok(installedBddgen, "bddgen target was not resolved");
    const packageDir = path.join(checkoutDir, "node_modules", "playwright-bdd");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      bin: { bddgen: string };
    };
    assert.equal(
      fs.realpathSync(installedBddgen),
      fs.realpathSync(path.resolve(packageDir, manifest.bin.bddgen)),
      `bddgen did not resolve from the checkout: ${installedBddgen}`
    );
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
    const generatedSpec = path.join(generatedDir, "features", "runner.feature.spec.js");
    assert.equal(fs.existsSync(generatedSpec), true, "bddgen did not generate runner.feature.spec.js");
    assert.match(
      fs.readFileSync(generatedSpec, "utf8"),
      /test\('Installed binary',/u,
      "bddgen did not generate the named scenario"
    );
  });
});
