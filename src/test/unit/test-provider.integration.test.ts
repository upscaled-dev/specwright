/**
 * Integration tests for the discover → run → status seam, exercised through the REAL provider,
 * parser, organization, and command builder — only the shell (Playwright invocation) and file
 * discovery are faked. This is the layer unit tests couldn't reach: it catches report→tree
 * mapping regressions (a passing scenario showing as skipped, outline examples not mapping, and
 * out-of-scope features running the wrong file).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "../__mocks__/vscode";
import { PlaywrightBddTestProvider } from "../../test-providers/playwright-bdd-test-provider";
import { TestExecutor, ShellRunner } from "../../core/test-executor";
import { CommandBuilder } from "../../core/command-builder";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestOrganizationManager } from "../../core/test-organization";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { PlaywrightBddExtensionContext } from "../../types";
import { BreakpointMirror } from "../../core/breakpoint-mirror";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";

const FEATURE = [
  "@feature",
  "Feature: Sample feature",
  "",
  "  Scenario: Passing scenario", // line 4
  "    Given I am on the test page",
  "",
  "  Scenario Outline: Math", // line 7
  "    Given <a> plus <b>",
  "",
  "    Examples:",
  "      | a | b |",
  "      | 1 | 2 |", // line 12 (example #1)
  "      | 3 | 4 |", // line 13 (example #2)
].join("\n");

interface Fixture {
  root: string;
  featurePath: string;
  genSpecPath: string;
}

/** Build a temp project: source feature + generated spec carrying bddFileData. */
function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbdd-int-"));
  const featurePath = path.join(root, "features", "test.feature");
  fs.mkdirSync(path.dirname(featurePath), { recursive: true });
  fs.writeFileSync(featurePath, FEATURE);

  const genSpecPath = path.join(root, ".features-gen", "features", "test.feature.spec.js");
  fs.mkdirSync(path.dirname(genSpecPath), { recursive: true });
  fs.writeFileSync(
    genSpecPath,
    [
      "// Generated from: features/test.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":6,"pickleLine":4},', // Passing scenario  → feature line 4
      '  {"pwTestLine":18,"pickleLine":12},', // Example #1      → feature line 12
      '  {"pwTestLine":24,"pickleLine":13},', // Example #2      → feature line 13
      "];",
    ].join("\n")
  );
  return { root, featurePath, genSpecPath };
}

/** A Playwright JSON report for the given specs, written by the fake shell to the report path. */
function reportJson(
  fixture: Fixture,
  specs: Array<{ title: string; line: number; status: string }>
): string {
  return JSON.stringify({
    config: {
      rootDir: path.join(fixture.root, ".features-gen"),
      configFile: path.join(fixture.root, "playwright.config.ts"),
    },
    suites: [{
      title: "Sample feature",
      specs: specs.map((s) => ({
        title: s.title,
        file: "features/test.feature.spec.js",
        line: s.line,
        tests: [{ results: [{ status: s.status, duration: 5, steps: [] }] }],
      })),
    }],
  });
}

describe("PlaywrightBddTestProvider — discover → run → status (integration)", () => {
  let fixture: Fixture;
  let origReadFile: typeof vscode.workspace.fs.readFile;

  beforeEach(() => {
    vscode.debug.__resetDebug();
    fixture = makeFixture();
    origReadFile = vscode.workspace.fs.readFile;
    // discovery + re-parse read the feature through the vscode fs shim.
    (vscode.workspace.fs as { readFile: unknown }).readFile = async (): Promise<Uint8Array> =>
      new TextEncoder().encode(FEATURE);
  });

  afterEach(() => {
    (vscode.workspace.fs as { readFile: unknown }).readFile = origReadFile;
    try { fs.rmSync(fixture.root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function buildProvider(shell: ShellRunner): {
    provider: PlaywrightBddTestProvider;
    controller: FakeTestController;
  } {
    const logger = Logger.create();
    const config = ExtensionConfig.create();
    const parser = PlaywrightJsonParser.create(logger);
    const commandBuilder = CommandBuilder.create(config, logger);
    const executor = TestExecutor.create(
      vscode.workspace as never,
      vscode.window as never,
      vscode.debug as never,
      config,
      logger,
      parser,
      shell
    );
    const discoveryManager = {
      discoverTestFiles: vi.fn().mockResolvedValue([fixture.featurePath]),
      refreshCache: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn(),
    };
    const context: PlaywrightBddExtensionContext = {
      logger,
      config,
      testExecutor: executor,
      discoveryManager: discoveryManager as never,
      organizationManager: TestOrganizationManager.create(logger),
      featureParser: FeatureParser.create(logger),
      playwrightJsonParser: parser,
      commandBuilder,
    };
    executor.setContext(context);

    const controller = new FakeTestController();
    const provider = PlaywrightBddTestProvider.create(controller as never, context);
    return { provider, controller };
  }

  async function runItem(controller: FakeTestController, item: FakeTestItem): Promise<void> {
    const runProfile = controller.profile("Run");
    if (!runProfile) {throw new Error("Run profile not registered");}
    await runProfile.runHandler(new vscode.TestRunRequest([item]));
  }

  it("marks a passing scenario PASSED in the tree (the report→item mapping holds)", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    expect(leaf, "scenario leaf should be discovered at its feature line").toBeTruthy();

    await runItem(controller, leaf!);
    const last = controller.runs.at(-1)!;
    expect(last.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(last.outcome.skipped).not.toContain(`${fixture.featurePath}:4`);
  });

  it("maps outline examples by their .feature line (Example #N → passed/failed)", async () => {
    // The report titles examples "Example #N" with the generated spec line; only the
    // bddFileData line-mapping connects them to the right .feature example row.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [
        { title: "Example #1", line: 18, status: "passed" },
        { title: "Example #2", line: 24, status: "failed" },
      ]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: false, output: "", error: "", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const ex1 = controller.find(`${fixture.featurePath}:12`);
    const ex2 = controller.find(`${fixture.featurePath}:13`);
    expect(ex1, "example #1 leaf").toBeTruthy();
    expect(ex2, "example #2 leaf").toBeTruthy();

    // Running each example resolves to its own .feature line via bddFileData.
    await runItem(controller, ex1!);
    expect(controller.runs.at(-1)!.outcome.passed).toContain(`${fixture.featurePath}:12`);

    await runItem(controller, ex2!);
    expect(controller.runs.at(-1)!.outcome.failed.map((f) => f.id))
      .toContain(`${fixture.featurePath}:13`);
  });

  it("flags an out-of-scope run (no results attributed) in the Test Results output", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      // Grep matched nothing — Playwright reports no tests and writes an empty report.
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      }
      return { success: false, output: "", error: "Error: No tests found", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    await runItem(controller, leaf!);

    const run = controller.runs.at(-1)!;
    const output = run.outcome.output.join("\n");
    expect(output).toContain("No results were attributed to");
    expect(output).toContain("**/*.feature");
  });

  it("debugTests applies the real status from the JSON report the debugged run wrote", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    const debugProfile = controller.profile("Debug");
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([leaf!]))
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    const env = config["env"] as Record<string, string>;
    const reportPath = env["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
    expect(reportPath).toBeTruthy();
    // Simulate the debugged playwright process writing the file-based JSON report.
    fs.writeFileSync(
      reportPath,
      reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }])
    );
    vscode.debug.__fireTerminate({
      configuration: { [BreakpointMirror.SESSION_KEY]: config[BreakpointMirror.SESSION_KEY] },
    });

    await pending;
    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.ended).toBe(true);
    expect(fs.existsSync(reportPath), "tmp report should be deleted after the run").toBe(false);
  });

  it("debugTests leaves the status unset when no JSON report was written", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    const debugProfile = controller.profile("Debug");
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([leaf!]))
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    vscode.debug.__fireTerminate({
      configuration: { [BreakpointMirror.SESSION_KEY]: config[BreakpointMirror.SESSION_KEY] },
    });

    await pending;
    const run = controller.runs.at(-1)!;
    expect(run.outcome.started).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.passed).toEqual([]);
    expect(run.outcome.failed).toEqual([]);
    expect(run.outcome.skipped).toEqual([]);
    expect(run.outcome.ended).toBe(true);
  });

  it("debugTests rolls a feature item up from the report's per-scenario statuses", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const featureItem = controller.find(fixture.featurePath);
    expect(featureItem, "feature item should be discovered").toBeTruthy();
    const debugProfile = controller.profile("Debug");
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([featureItem!]))
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    const env = config["env"] as Record<string, string>;
    fs.writeFileSync(
      env["PLAYWRIGHT_JSON_OUTPUT_NAME"]!,
      reportJson(fixture, [
        { title: "Passing scenario", line: 6, status: "passed" },
        { title: "Example #1", line: 18, status: "passed" },
        { title: "Example #2", line: 24, status: "failed" },
      ])
    );
    vscode.debug.__fireTerminate({
      configuration: { [BreakpointMirror.SESSION_KEY]: config[BreakpointMirror.SESSION_KEY] },
    });

    await pending;
    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.failed.map((f) => f.id)).toContain(`${fixture.featurePath}:13`);
    // Any failing scenario fails the feature item itself.
    expect(run.outcome.failed.map((f) => f.id)).toContain(fixture.featurePath);
  });

  it("debugTests wraps the session in a TestRun and ends it only when the session ends", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    expect(leaf, "scenario leaf should be discovered").toBeTruthy();
    const debugProfile = controller.profile("Debug");
    expect(debugProfile, "Debug profile should be registered").toBeTruthy();

    let handlerDone = false;
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([leaf!]))
    ).then(() => { handlerDone = true; });

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const run = controller.runs.at(-1)!;
    expect(run.outcome.started).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.ended).toBe(false);
    expect(handlerDone).toBe(false);

    const sessionKey =
      vscode.debug.__startDebuggingCalls[0]!.config[BreakpointMirror.SESSION_KEY];
    expect(typeof sessionKey).toBe("string");
    vscode.debug.__fireTerminate({
      configuration: { [BreakpointMirror.SESSION_KEY]: sessionKey },
    });

    await pending;
    expect(handlerDone).toBe(true);
    expect(run.outcome.ended).toBe(true);
  });
});
