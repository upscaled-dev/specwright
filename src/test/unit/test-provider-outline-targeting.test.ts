/**
 * Integration tests for the discover → run → status seam, exercised through the REAL provider,
 * parser, organization, and command builder; only the shell (Playwright invocation) and file
 * discovery are faked. This is the layer unit tests couldn't reach: it catches report→tree
 * mapping regressions (a passing scenario showing as skipped, outline examples not mapping, and
 * out-of-scope features running the wrong file).
 */
import { fakeMemento, makeFixture, reportJson } from "./helpers/test-provider-fixture";
import type { Fixture } from "./helpers/test-provider-fixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "../__mocks__/vscode";
import { PlaywrightBddTestProvider } from "../../test-providers/playwright-bdd-test-provider";
import { OUTLINE_ID_SEPARATOR } from "../../test-providers/constants";
import { TestExecutor, ShellRunner } from "../../core/test-executor";
import { CommandBuilder } from "../../core/command-builder";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestOrganizationManager } from "../../core/test-organization";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { PlaywrightBddExtensionContext } from "../../types";
import { RunArtifactStore } from "../../traceability/run-artifact-store";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type {
  ExecutionGateway,
} from "../../core/run-contracts";
import { LegacyDirectExecutionGateway } from "../../core/execution-gateway";
import { LegacyExecutionDiscovery } from "../../core/legacy-discovery";
import { LegacyArtifactGateway } from "../../ui/legacy-artifact-gateway";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";
import { parseExecutableCommand } from "../../core/bounded-command-runner";





describe("PlaywrightBddTestProvider: discover → run → status (integration)", () => {
  let fixture: Fixture;
  let origReadFile: typeof vscode.workspace.fs.readFile;

  beforeEach(() => {
    vscode.debug.__resetDebug();
    vscode.__resetFileWatchers();
    fixture = makeFixture();
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: fixture.root } },
    ];
    origReadFile = vscode.workspace.fs.readFile;
    // The watcher path reads the touched file through the vscode fs seam.
    (vscode.workspace.fs as { readFile: unknown }).readFile = async (uri: { fsPath: string }): Promise<Uint8Array> =>
      new Uint8Array(fs.readFileSync(uri.fsPath));
  });

  afterEach(() => {
    (vscode.workspace.fs as { readFile: unknown }).readFile = origReadFile;
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    try { fs.rmSync(fixture.root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function buildProvider(
    shell: ShellRunner,
    executionGateway?: ExecutionGateway,
    runBddgen = false,
    artifactOwnership: readonly ScenarioRef[] = [],
    options: { testFilePattern?: () => string; localCapability?: () => boolean } = {}
  ): {
    provider: PlaywrightBddTestProvider;
    controller: FakeTestController;
    executor: TestExecutor;
    artifactStore: RunArtifactStore;
    gateway: ExecutionGateway;
    config: ExtensionConfig;
    discoveryManager: { discoverTestFiles: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn> };
  } {
    const logger = Logger.create();
    const config = ExtensionConfig.create({
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        if (key === "bddgenCommand" && !runBddgen) {return "" as T;}
        if (key === "testFilePattern" && options.testFilePattern) {return options.testFilePattern() as T;}
        return defaultValue;
      },
      update: (): Promise<void> => Promise.resolve(),
    } as unknown as import("vscode").WorkspaceConfiguration, false);
    const parser = PlaywrightJsonParser.create(logger);
    const commandBuilder = CommandBuilder.create(config, logger);
    const executor = TestExecutor.create(
      vscode.workspace as never,
      vscode.window as never,
      vscode.debug as never,
      config,
      logger,
      parser,
      shell,
      undefined,
      parseExecutableCommand
    );
    const discoveryManager = {
      discoverTestFiles: vi.fn().mockResolvedValue([fixture.featurePath]),
      clearCache: vi.fn(),
    };
    const artifactStore = new RunArtifactStore(fakeMemento(), logger);
    const featureParser = FeatureParser.create(logger);
    const workspaceTrust = new WorkspaceTrust(() => true);
    const gateway = executionGateway ?? new LegacyArtifactGateway(
      new LegacyDirectExecutionGateway(
        executor,
        featureParser,
        workspaceTrust,
        undefined,
        undefined,
        new LegacyExecutionDiscovery(discoveryManager as never, featureParser)
      ),
      artifactStore,
      logger,
      executor,
      () => artifactOwnership
    );
    const context: PlaywrightBddExtensionContext = {
      logger,
      config,
      testExecutor: executor,
      executionGateway: gateway,
      discoveryManager: discoveryManager as never,
      organizationManager: TestOrganizationManager.create(logger),
      featureParser,
      playwrightJsonParser: parser,
      commandBuilder,
      workspaceTrust,
      traceabilityAdapter: {} as PlaywrightBddExtensionContext["traceabilityAdapter"],
      runArtifactStore: artifactStore,
    };
    executor.setContext(context);

    const controller = new FakeTestController();
    const provider = PlaywrightBddTestProvider.create(
      controller as never,
      context,
      undefined,
      () => options.localCapability?.() ?? executionGateway === undefined
    );
    return { provider, controller, executor, artifactStore, gateway, discoveryManager, config };
  }

  async function runItem(controller: FakeTestController, item: FakeTestItem): Promise<void> {
    const runProfile = controller.profile("Run");
    if (!runProfile) {throw new Error("Run profile not registered");}
    await runProfile.runHandler(
      new vscode.TestRunRequest([item]),
      new vscode.CancellationTokenSource().token
    );
  }

  it("writes one run summary for a multi-root selection", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const first = controller.find(`${fixture.featurePath}:4`)!;
    const second = controller.find(`${fixture.featurePath}:12`)!;

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest([first, second]),
      new vscode.CancellationTokenSource().token
    );

    const summaries = controller.runs.at(-1)!.outcome.output
      .filter((text) => text.includes("1 scenario"));
    expect(summaries).toHaveLength(1);
  });

  it("uses an empty request instead of selecting the whole tree when an external target is undiscovered", () => {
    const shell: ShellRunner = async () => ({
      success: true,
      output: "",
      error: "",
      returnCode: 0,
    });
    const { provider, controller } = buildProvider(shell);

    const session = provider.beginExternalRun(fixture.featurePath);
    const request = controller.runs.at(-1)!.request as vscode.TestRunRequest;
    expect(request.include).toEqual([]);
    session.end();
  });

  it("does not let one target's \"no tests found\" mask another target's empty failure", async () => {
    // Run-wide output: the first target is genuinely out of scope, the second fails outright. The
    // carve-out is only readable as one target's own when the run had exactly one.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      }
      return { success: false, output: "", error: "Error: No tests found", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const scenario = controller.find(`${fixture.featurePath}:4`)!;
    const outline = controller.find(`${fixture.featurePath}${OUTLINE_ID_SEPARATOR}7:Math`)!;

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest([scenario, outline]),
      new vscode.CancellationTokenSource().token
    );

    const run = controller.runs.at(-1)!;
    expect(run.outcome.failed.map((entry) => entry.id)).toContain(outline.id);
    expect(run.outcome.skipped).not.toContain(outline.id);
  });

  it("maps outline examples by their .feature line (Example #N → passed/failed)", async () => {
    // The report titles examples "Example #N" with the generated spec line; only the
    // bddFileData line-mapping connects them to the right .feature example row.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      // bddgen runs first as its own step (no JSON env); succeed so the playwright run proceeds.
      if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      const out = reportJson(fixture, [
        { title: "Example #1", line: 18, status: "passed" },
        { title: "Example #2", line: 24, status: "failed" },
      ]);
      fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);
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
      // bddgen step (no JSON env) succeeds; the playwright run then matches nothing; Playwright
      // reports "no tests found" and writes an empty report.
      if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      return { success: false, output: "", error: "Error: No tests found", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell, undefined, true);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    await runItem(controller, leaf!);

    const run = controller.runs.at(-1)!;
    const output = run.outcome.output.join("\n");
    expect(output).toContain("No results were attributed to");
    expect(output).toContain("**/*.feature");
  });

  it("scopes the run summary to the target when the report's featurePath differs only by Windows drive-letter case/separators", async () => {
    // The run targets one feature but the report attributes results to it AND another feature.
    // formatRunOutput must scope the summary to the target, comparing through normalizePathKey so a
    // VS Code lowercase-drive backslash path (c:\repo\…) folds onto the report's uppercase-drive
    // forward-slash path (C:/repo/…). A raw === would miss on Windows and render BOTH features.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const report = JSON.stringify({
        suites: [{
          title: "Suite",
          specs: [
            {
              title: "Target scenario", file: "a.spec.js", line: 4,
              tests: [{
                annotations: [{ type: "C:/repo/features/a.feature:4" }],
                results: [{ status: "passed", duration: 5, steps: [] }],
              }],
            },
            {
              title: "Other scenario", file: "b.spec.js", line: 7,
              tests: [{
                annotations: [{ type: "C:/repo/features/b.feature:7" }],
                results: [{ status: "passed", duration: 5, steps: [] }],
              }],
            },
          ],
        }],
      });
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], report);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { controller } = buildProvider(shell);

    // A Windows-style feature item: VS Code lowercase drive + backslashes. No discovery needed;
    // the run path only reads the item's uri/id/label.
    const winPath = "c:\\repo\\features\\a.feature";
    const featureItem = controller.createTestItem(winPath, "A feature", { fsPath: winPath });
    controller.items.add(featureItem);

    await runItem(controller, featureItem);

    const output = controller.runs.at(-1)!.outcome.output.join("\n");
    expect(output).toContain("Target scenario");
    expect(output).not.toContain("Other scenario");
    // Scoped to one: the tally counts a single scenario, not both.
    expect(output).not.toContain("2 scenarios");
  });

  describe("outline run targets", () => {
    // The spec-line target is resolved against the run's working directory, so the fixture has to be
    // the workspace for a row target to reach bddFileData at all.
    beforeEach(() => {
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: fixture.root } },
      ];
    });

    afterEach(() => {
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    function recordingShell(commands: string[]): ShellRunner {
      return async (command, _dir, env) => {
        commands.push(command);
        if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
          fs.writeFileSync(
            env["PLAYWRIGHT_JSON_OUTPUT_NAME"],
            reportJson(fixture, [{ title: "Example #1", line: 18, status: "passed" }])
          );
        }
        return { success: true, output: "", error: "", returnCode: 0 };
      };
    }

    it("targets one example row by its own generated spec line", async () => {
      const commands: string[] = [];
      const warn = vi.spyOn(Logger.prototype, "warn");
      const { provider, controller } = buildProvider(recordingShell(commands));
      await provider.discoverTests();

      await runItem(controller, controller.find(`${fixture.featurePath}:12`)!);

      // pickleLine 12 maps to pwTestLine 18 in the fixture's bddFileData.
      expect(commands.at(-1)).toContain("test.feature.spec.js:18");
      expect(commands.at(-1)).not.toContain("--grep");
      expect(warn.mock.calls.map(String).join("\n")).not.toContain("Could not target example row");
    });

    it("runs a whole outline by title with no line and no stale-spec warning", async () => {
      const commands: string[] = [];
      const warn = vi.spyOn(Logger.prototype, "warn");
      const { provider, controller } = buildProvider(recordingShell(commands));
      await provider.discoverTests();
      const node = controller.find(`${fixture.featurePath}${OUTLINE_ID_SEPARATOR}7:Math`);
      expect(node, "outline node should be discovered").toBeTruthy();

      await runItem(controller, node!);

      expect(commands.at(-1)).toContain('--grep "Math"');
      expect(commands.at(-1)).not.toContain("test.feature.spec.js:");
      expect(warn.mock.calls.map(String).join("\n")).not.toContain("Could not target example row");
    });

    it("excludes a separately mapped Examples block from an ordinary Test Explorer outline run", async () => {
      const commands: string[] = [];
      const mappedBlock: ScenarioRef = {
        filePath: fixture.featurePath,
        line: 10,
        name: "Math examples",
        kind: "examplesBlock",
        outlineName: "Math",
      };
      const { provider, controller, artifactStore } = buildProvider(
        recordingShell(commands),
        undefined,
        false,
        [mappedBlock]
      );
      await provider.discoverTests();
      const outline = controller.find(`${fixture.featurePath}${OUTLINE_ID_SEPARATOR}7:Math`)!;

      await runItem(controller, outline);

      expect(commands).toEqual([]);
      expect(artifactStore.latest()).toMatchObject({ state: "partial", results: [] });
      expect(controller.runs.at(-1)?.outcome.output.join(""))
        .toContain("owns no parsed rows");
    });
  });

  describe("scenario outlines whose title contains <placeholders> (substituted report titles)", () => {
    // The user-reported bug: an outline titled with placeholders makes playwright-bdd generate
    // tests titled with the SUBSTITUTED values ("Add (2/2) widgets"), never "Example #N" and
    // never the tree's synthetic example label, so name-based mapping can only go through the
    // row's substitutedName.
    const SUBSTITUTED_FEATURE = [
      "Feature: Sample feature",
      "",
      "  Scenario Outline: Add (<a>/<b>) widgets", // line 3
      "    Given <a> plus <b>",
      "",
      "    Examples:",
      "      | a | b |",
      "      | 2 | 2 |", // line 8 → generated test "Add (2/2) widgets"
      "      | 3 | 3 |", // line 9 → generated test "Add (3/3) widgets"
    ].join("\n");

    beforeEach(() => {
      fs.writeFileSync(fixture.featurePath, SUBSTITUTED_FEATURE);
      (vscode.workspace.fs as { readFile: unknown }).readFile = async (): Promise<Uint8Array> =>
        new TextEncoder().encode(SUBSTITUTED_FEATURE);
      // The run target is resolved from the generated file before the report parser exercises its
      // own path and substituted-title fallbacks. Keep this map aligned with the feature above.
      fs.writeFileSync(
        fixture.genSpecPath,
        [
          "// Generated from: features/test.feature",
          "const bddFileData = [ // bdd-data-start",
          '  {"pwTestLine":14,"pickleLine":8},',
          '  {"pwTestLine":20,"pickleLine":9},',
          "]; // bdd-data-end",
        ].join("\n")
      );
    });

    function substitutedReport(rootDir: string): string {
      return JSON.stringify({
        config: { rootDir, configFile: path.join(fixture.root, "playwright.config.ts") },
        suites: [{
          title: "Sample feature",
          suites: [{
            title: "Add (<a>/<b>) widgets",
            specs: [
              {
                title: "Add (2/2) widgets", file: "features/test.feature.spec.js", line: 14,
                tests: [{ results: [{ status: "passed", duration: 5, steps: [] }] }],
              },
              {
                title: "Add (3/3) widgets", file: "features/test.feature.spec.js", line: 20,
                tests: [{ results: [{ status: "failed", duration: 5, steps: [] }] }],
              },
            ],
          }],
        }],
      });
    }

    function substitutedShell(rootDir: string): ShellRunner {
      return async (_cmd, _dir, env) => {
        if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
          return { success: true, output: "", error: "", returnCode: 0 };
        }
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], substitutedReport(rootDir));
        return { success: false, output: "", error: "", returnCode: 1 };
      };
    }

    function outlineItem(controller: FakeTestController): FakeTestItem {
      const item = controller.find(
        `${fixture.featurePath}${OUTLINE_ID_SEPARATOR}3:Add (<a>/<b>) widgets`
      );
      expect(item, "outline item should be discovered").toBeTruthy();
      return item!;
    }

    it("maps the example rows to their real statuses when the report's spec path is unresolvable (the user's environment)", async () => {
      // The user's environment: a custom featuresGenDir / cleaned gen dir means the parser can't
      // read the generated spec, so resolveSourceLocation fails and each result's featurePath
      // falls back to the RELATIVE spec path; no line-based or feature-path-based key can ever
      // match. Only the substitutedName suffix scan connects report entries to the example rows.
      const { provider, controller } = buildProvider(
        substitutedShell(path.join(fixture.root, "no-such-gen-dir"))
      );
      await provider.discoverTests();

      await runItem(controller, outlineItem(controller));

      const run = controller.runs.at(-1)!;
      expect(run.outcome.passed).toContain(`${fixture.featurePath}:8`);
      expect(run.outcome.failed.map((f) => f.id)).toContain(`${fixture.featurePath}:9`);
      expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:8`);
      expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:9`);
      // Results WERE attributed (by substituted title), so the out-of-scope warning must not fire.
      expect(run.outcome.output.join("\n")).not.toContain("No results were attributed");
    });

    it("still maps by .feature line when the generated spec is resolvable (substituted-name lookups don't interfere)", async () => {
      const { provider, controller } = buildProvider(
        substitutedShell(path.join(fixture.root, ".features-gen"))
      );
      await provider.discoverTests();

      await runItem(controller, outlineItem(controller));

      const run = controller.runs.at(-1)!;
      expect(run.outcome.passed).toContain(`${fixture.featurePath}:8`);
      expect(run.outcome.failed.map((f) => f.id)).toContain(`${fixture.featurePath}:9`);
      expect(run.outcome.output.join("\n")).not.toContain("No results were attributed");
    });
  });


});
