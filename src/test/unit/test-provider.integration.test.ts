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
import { OUTLINE_ID_SEPARATOR } from "../../test-providers/constants";
import { TestExecutor, ShellRunner, TestRunEvent } from "../../core/test-executor";
import { CommandBuilder } from "../../core/command-builder";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestOrganizationManager } from "../../core/test-organization";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { PlaywrightBddExtensionContext } from "../../types";
import { BreakpointMirror } from "../../core/breakpoint-mirror";
import { RunArtifactStore } from "../../traceability/run-artifact-store";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";

function fakeMemento(): import("vscode").Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: (key: string, def?: unknown) => (store.has(key) ? store.get(key) : def),
    update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
  } as unknown as import("vscode").Memento;
}

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
    vscode.__resetFileWatchers();
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
    executor: TestExecutor;
    artifactStore: RunArtifactStore;
    discoveryManager: { discoverTestFiles: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn> };
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
      clearCache: vi.fn(),
    };
    const artifactStore = new RunArtifactStore(fakeMemento(), logger);
    const context: PlaywrightBddExtensionContext = {
      logger,
      config,
      testExecutor: executor,
      discoveryManager: discoveryManager as never,
      organizationManager: TestOrganizationManager.create(logger),
      featureParser: FeatureParser.create(logger),
      playwrightJsonParser: parser,
      commandBuilder,
      traceabilityAdapter: {} as PlaywrightBddExtensionContext["traceabilityAdapter"],
      runArtifactStore: artifactStore,
    };
    executor.setContext(context);

    const controller = new FakeTestController();
    const provider = PlaywrightBddTestProvider.create(controller as never, context);
    return { provider, controller, executor, artifactStore, discoveryManager };
  }

  async function runItem(controller: FakeTestController, item: FakeTestItem): Promise<void> {
    const runProfile = controller.profile("Run");
    if (!runProfile) {throw new Error("Run profile not registered");}
    await runProfile.runHandler(
      new vscode.TestRunRequest([item]),
      new vscode.CancellationTokenSource().token
    );
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

  it("passes the parsed scenario duration to run.passed", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    await runItem(controller, leaf!);

    const run = controller.runs.at(-1)!;
    // reportJson stamps duration: 5 on each result; it must reach the VS Code run API.
    expect(run.outcome.durations[`${fixture.featurePath}:4`]).toBe(5);
  });

  it("cancelling mid-run skips the started and not-yet-run items, fails none, and fires no failure event", async () => {
    // Two top-level items. The first item's run cancels the token (user hits Stop); its process is
    // killed (exit 130) but must NOT paint the tree red — it's skipped — and the second, never-run
    // item is skipped too. No failure event reaches the status bar.
    const source = new vscode.CancellationTokenSource();
    let calls = 0;
    const shell: ShellRunner = async () => {
      calls += 1;
      if (calls === 1) {source.cancel();}
      return { success: false, output: "", error: "killed", returnCode: 130 };
    };
    const { provider, controller, executor } = buildProvider(shell);
    const events: TestRunEvent[] = [];
    executor.onTestRunEvent((e) => events.push(e));
    await provider.discoverTests();

    const first = controller.find(`${fixture.featurePath}:4`)!;
    const second = controller.find(`${fixture.featurePath}:12`)!;
    const runProfile = controller.profile("Run")!;
    await runProfile.runHandler(new vscode.TestRunRequest([first, second]), source.token);

    const run = controller.runs.at(-1)!;
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.failed).toEqual([]);
    expect(events.some((e) => e.kind === "failure")).toBe(false);
    expect(run.outcome.ended).toBe(true);
  });

  describe("run-artifact capture (wiring)", () => {
    it("a command-driven executor run during an open batch injects no shard into it", async () => {
      const shell: ShellRunner = async (_cmd, _dir, env) => {
        if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
          fs.writeFileSync(
            env["PLAYWRIGHT_JSON_OUTPUT_NAME"],
            reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }])
          );
        }
        return { success: true, output: "", error: "", returnCode: 0 };
      };
      const { executor, artifactStore } = buildProvider(shell);
      // The Test Explorer opened a batch; a codelens/palette run then fires at the shared seam with
      // no handle. Its parsed results must not land in the open Explorer artifact.
      const batch = artifactStore.beginBatch("explorer");
      await executor.runFeatureFileWithOutput({ filePath: fixture.featurePath, featureName: "Sample feature" });
      const sealed = artifactStore.sealBatch(batch, false);

      expect(sealed?.shards).toEqual([]);
      expect(sealed?.results).toEqual([]);
      expect(sealed?.state).toBe("complete");
    });

    it("a throwing invocation seals the batch partial through the provider run path", async () => {
      const shell: ShellRunner = async () => { throw new Error("spawn failed"); };
      const { provider, controller, artifactStore } = buildProvider(shell);
      await provider.discoverTests();

      const feature = controller.find(fixture.featurePath)!;
      await runItem(controller, feature);

      const latest = artifactStore.latest();
      expect(latest?.state).toBe("partial");
      expect(latest?.shards).toHaveLength(1);
      expect(latest?.shards[0]?.success).toBe(false);
    });

    it("cancelling the run seals the batch cancelled through the provider run path", async () => {
      const source = new vscode.CancellationTokenSource();
      const shell: ShellRunner = async () => {
        source.cancel();
        return { success: false, output: "", error: "killed", returnCode: 130 };
      };
      const { provider, controller, artifactStore } = buildProvider(shell);
      await provider.discoverTests();

      const leaf = controller.find(`${fixture.featurePath}:4`)!;
      const runProfile = controller.profile("Run")!;
      await runProfile.runHandler(new vscode.TestRunRequest([leaf]), source.token);

      expect(artifactStore.latest()?.state).toBe("cancelled");
    });
  });

  it("maps outline examples by their .feature line (Example #N → passed/failed)", async () => {
    // The report titles examples "Example #N" with the generated spec line; only the
    // bddFileData line-mapping connects them to the right .feature example row.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      // bddgen runs first as its own step (no JSON env) — succeed so the playwright run proceeds.
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
      // bddgen step (no JSON env) succeeds; the playwright run then matches nothing — Playwright
      // reports "no tests found" and writes an empty report.
      if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
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

    // A Windows-style feature item: VS Code lowercase drive + backslashes. No discovery needed —
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

  it("fails the feature parent when the run failed with no per-scenario results and no \"no tests found\"", async () => {
    // A bddgen/compile error can exit non-zero yet leave an empty report — no per-scenario results
    // for a genuine failure. Blanket-skipping would hide it, so applyResultsToChildren must fail the
    // parent (its scenarios, having no attributed result, stay skipped).
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      }
      return { success: false, output: "", error: "TypeError: step threw while compiling specs", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const featureItem = controller.find(fixture.featurePath);
    expect(featureItem, "feature item should be discovered").toBeTruthy();
    await runItem(controller, featureItem!);

    const run = controller.runs.at(-1)!;
    expect(run.outcome.failed.map((f) => f.id)).toContain(fixture.featurePath);
    expect(run.outcome.skipped).not.toContain(fixture.featurePath);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:4`);
  });

  it("leaves the feature parent skipped when the empty-result failure is a \"No tests found\" (out-of-scope) run", async () => {
    // Counter-case to the above: the same empty-report failure but Playwright explicitly found no
    // tests. outOfScopeWarning already explains this as skipped, so the parent must NOT fail.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      }
      return { success: false, output: "", error: "Error: No tests found", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const featureItem = controller.find(fixture.featurePath);
    expect(featureItem, "feature item should be discovered").toBeTruthy();
    await runItem(controller, featureItem!);

    const run = controller.runs.at(-1)!;
    expect(run.outcome.skipped).toContain(fixture.featurePath);
    expect(run.outcome.failed.map((f) => f.id)).not.toContain(fixture.featurePath);
  });

  it("debugTests marks every descendant of a debugged feature started", async () => {
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

    // One debug command runs every descendant, so each is marked started — including the nested
    // outline example rows (:12, :13), which proves the recursion, not just the direct children.
    const run = controller.runs.at(-1)!;
    expect(run.outcome.started).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.started).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.started).toContain(`${fixture.featurePath}:13`);

    const sessionKey =
      vscode.debug.__startDebuggingCalls[0]!.config[BreakpointMirror.SESSION_KEY];
    vscode.debug.__fireTerminate({
      configuration: { [BreakpointMirror.SESSION_KEY]: sessionKey },
    });
    await pending;
  });

  describe("scenario outlines whose title contains <placeholders> (substituted report titles)", () => {
    // The user-reported bug: an outline titled with placeholders makes playwright-bdd generate
    // tests titled with the SUBSTITUTED values ("Add (2/2) widgets"), never "Example #N" and
    // never the tree's synthetic example label — so name-based mapping can only go through the
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
      (vscode.workspace.fs as { readFile: unknown }).readFile = async (): Promise<Uint8Array> =>
        new TextEncoder().encode(SUBSTITUTED_FEATURE);
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
      // falls back to the RELATIVE spec path — no line-based or feature-path-based key can ever
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
      fs.writeFileSync(
        fixture.genSpecPath,
        [
          "// Generated from: features/test.feature",
          "const bddFileData = [ // bdd-data-start",
          '  {"pwTestLine":14,"pickleLine":8},',
          '  {"pwTestLine":20,"pickleLine":9},',
          "];",
        ].join("\n")
      );
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

  describe("incremental rediscovery on watcher events (FeatureBased)", () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });

    it("re-parses only the changed file, without re-globbing the workspace", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      expect(controller.find(`${fixture.featurePath}:12`), "outline example seeded").toBeTruthy();
      // The constructor also discovers once; isolate the watcher-triggered calls that follow.
      discoveryManager.discoverTestFiles.mockClear();

      // The file now has one plain scenario at line 7 where the outline used to be.
      const changed = [
        "@feature",
        "Feature: Sample feature",
        "",
        "  Scenario: Passing scenario", // line 4
        "    Given I am on the test page",
        "",
        "  Scenario: Brand new scenario", // line 7
        "    Given something new",
      ].join("\n");
      (vscode.workspace.fs as { readFile: unknown }).readFile = async (): Promise<Uint8Array> =>
        new TextEncoder().encode(changed);

      await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

      expect(controller.find(`${fixture.featurePath}:7`), "new scenario added").toBeTruthy();
      // The old outline example rows are gone from both the tree and the id→scenario map.
      expect(controller.find(`${fixture.featurePath}:12`)).toBeUndefined();
      expect(provider.testIdToScenarioMap.has(`${fixture.featurePath}:12`)).toBe(false);
      // No discovery sweep — the whole point of the incremental path.
      expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();
    });

    it("removes the node and its state when a file is deleted", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      expect(controller.find(fixture.featurePath)).toBeTruthy();
      discoveryManager.discoverTestFiles.mockClear();

      await vscode.__fireFileWatcher("delete", vscode.Uri.file(fixture.featurePath));

      expect(controller.find(fixture.featurePath)).toBeUndefined();
      expect(controller.find(`${fixture.featurePath}:4`)).toBeUndefined();
      expect(provider.testIdToScenarioMap.has(`${fixture.featurePath}:4`)).toBe(false);
      expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();
    });

    it("removes the node when a changed file no longer parses", async () => {
      const { provider, controller } = buildProvider(shell);
      await provider.discoverTests();
      expect(controller.find(fixture.featurePath)).toBeTruthy();

      (vscode.workspace.fs as { readFile: unknown }).readFile = async (): Promise<Uint8Array> =>
        new TextEncoder().encode("this text has no Feature keyword");

      await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

      expect(controller.find(fixture.featurePath)).toBeUndefined();
      expect(provider.testIdToScenarioMap.has(`${fixture.featurePath}:4`)).toBe(false);
    });

    it("ignores a watcher event for a generated (excluded-dir) feature copy", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      discoveryManager.discoverTestFiles.mockClear();

      const genCopy = path.join(fixture.root, ".features-gen", "features", "test.feature");
      await vscode.__fireFileWatcher("change", vscode.Uri.file(genCopy));

      expect(controller.find(genCopy)).toBeUndefined();
      expect(controller.find(fixture.featurePath), "source node untouched").toBeTruthy();
      expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();
    });

    it("falls back to a full refresh under a non-FeatureBased strategy", async () => {
      const { provider, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      discoveryManager.discoverTestFiles.mockClear();

      const tagStrategy = provider
        .getAvailableOrganizationStrategies()
        .find((s) => s.strategy.strategyType === "TagBasedOrganization")!.strategy;
      provider.setOrganizationStrategy(tagStrategy);

      await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

      // Content can move scenarios between tag groups, so the whole workspace is re-swept.
      expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(1);
    });
  });
});
