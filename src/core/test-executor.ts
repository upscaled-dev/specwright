import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  TestExecutionOptions,
  TestRunResult,
  ParallelExecutionOptions,
  FeatureExecutionOptions,
  PlaywrightBddExtensionContext,
} from "../types/index";
import { Logger } from "../utils/logger";
import { ExtensionConfig } from "./extension-config";
import { spawn, ChildProcess } from "node:child_process";
import { PlaywrightJsonParser, ScenarioStatus, ScenarioResult, normalizePathKey } from "../utils/playwright-json-parser";
import { shellQuote } from "../utils/shell";
import {
  canonicalCwd,
  findNearestPlaywrightConfigDir,
  isSameOrInsideDir,
  toPathFilterRegex,
  workspaceFolderRootFor,
} from "../utils/working-dir";
import { BreakpointMirror } from "./breakpoint-mirror";
import { parseBddFileData, resolveGeneratedSpecPath } from "../parsers/bdd-file-data-parser";

/**
 * A test run result enriched with the per-scenario outcomes parsed from Playwright's JSON
 * report: a status lookup keyed for the Test Explorer, plus the full structured results used to
 * render a legible summary and attach error messages.
 */
export type RunOutputResult = TestRunResult & {
  scenarioResults?: Record<string, ScenarioStatus>;
  scenarioDetails?: ScenarioResult[];
};

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error occurred";
}

// Worst status wins when one scenario ran under several projects (failed > skipped > passed), so
// a chromium-passed / firefox-failed scenario counts as failed no matter which result the report
// lists first. Mirrors PlaywrightJsonParser.toStatusMap's own severity rule.
const STATUS_SEVERITY: Record<ScenarioStatus, number> = {
  passed: 0,
  skipped: 1,
  failed: 2,
};

function countScenarioStatuses(
  results: ScenarioResult[]
): { passed: number; failed: number } {
  // Key by file + line + name so same-named scenarios in different feature files (or different
  // outline examples) are counted separately, while retries/projects of one scenario are not.
  const byScenario = new Map<string, ScenarioStatus>();
  for (const r of results) {
    const key = `${r.featurePath}::${r.lineNumber ?? ""}::${r.scenarioName}`;
    const prev = byScenario.get(key);
    if (prev === undefined || STATUS_SEVERITY[r.status] > STATUS_SEVERITY[prev]) {
      byScenario.set(key, r.status);
    }
  }
  let passed = 0;
  let failed = 0;
  for (const status of byScenario.values()) {
    if (status === "passed") { passed += 1; }
    else if (status === "failed") { failed += 1; }
  }
  return { passed, failed };
}

/**
 * True when the run executed nothing at all and Playwright said so. Distinguishes a filter
 * matching zero tests from real failures (compile errors, failing tests), which produce either
 * scenario results or a different error text.
 */
function foundNoTests(result: RunOutputResult): boolean {
  return (
    (result.scenarioDetails ?? []).length === 0 &&
    /no tests found/i.test(`${result.output}\n${result.error ?? ""}`)
  );
}

let reportSequence = 0;

type CommandResult = { success: boolean; output: string; error: string; returnCode: number };

export type TestRunEvent =
  | { kind: "running"; passed: number; failed: number }
  | { kind: "success"; passed: number; failed: number }
  | { kind: "failure"; passed: number; failed: number }
  | { kind: "cancelled"; passed: number; failed: number };

export type ShellRunner = (
  command: string,
  workingDir: string,
  extraEnv?: NodeJS.ProcessEnv,
  signal?: AbortSignal
) => Promise<CommandResult>;

/**
 * Drives playwright-bdd via shell commands.
 *
 * Two execution modes:
 *   - `run*` methods: pipe the command into the VS Code Terminal so the user can see output.
 *   - `*WithOutput` methods: spawn the command via child_process, capture stdout/stderr, and
 *     parse a JSON Playwright report so we can attribute per-scenario status back to the VS
 *     Code Test Explorer.
 *
 * For result mapping we force `--reporter=json --reporter-output=<tmp>` regardless of the
 * user-visible reporter. Playwright supports multiple `--reporter` flags so this doesn't
 * clobber the user's choice.
 */
export class TestExecutor {
  private readonly config: ExtensionConfig;
  private readonly logger: Logger;
  private readonly workspace: typeof vscode.workspace;
  private readonly window: typeof vscode.window;
  private readonly debug: typeof vscode.debug;
  private terminal: vscode.Terminal | undefined;
  private terminalCloseSubscription: vscode.Disposable | undefined;
  private readonly playwrightJsonParser: PlaywrightJsonParser;
  private context?: PlaywrightBddExtensionContext;
  private readonly runEventEmitter = new vscode.EventEmitter<TestRunEvent>();
  private readonly defaultShellRunner: ShellRunner;
  private shellRunner: ShellRunner;
  private readonly mirror: BreakpointMirror;

  public readonly onTestRunEvent: vscode.Event<TestRunEvent> = this.runEventEmitter.event;

  public static create(
    workspace?: typeof vscode.workspace,
    window?: typeof vscode.window,
    _debug?: typeof vscode.debug,
    config?: ExtensionConfig,
    logger?: Logger,
    playwrightJsonParser?: PlaywrightJsonParser,
    shellRunner?: ShellRunner,
    mirror?: BreakpointMirror
  ): TestExecutor {
    return new TestExecutor(workspace, window, _debug, config, logger, playwrightJsonParser, shellRunner, mirror);
  }

  constructor(
    workspace: typeof vscode.workspace = vscode.workspace,
    window: typeof vscode.window = vscode.window,
    _debug: typeof vscode.debug = vscode.debug,
    config?: ExtensionConfig,
    logger?: Logger,
    playwrightJsonParser?: PlaywrightJsonParser,
    shellRunner?: ShellRunner,
    mirror?: BreakpointMirror
  ) {
    this.workspace = workspace;
    this.window = window;
    this.debug = _debug;
    this.config = config ?? ExtensionConfig.create();
    this.logger = logger ?? Logger.create();
    this.playwrightJsonParser = playwrightJsonParser ?? PlaywrightJsonParser.create(this.logger);
    this.defaultShellRunner = (command, workingDir, extraEnv, signal) =>
      this.spawnCommand(command, workingDir, extraEnv, signal);
    this.shellRunner = shellRunner ?? this.defaultShellRunner;
    // Eager, not lazy: constructing the mirror subscribes to onDidChangeBreakpoints, which
    // forces VS Code to initialize its lazily-populated `debug.breakpoints` before first use.
    this.mirror = mirror ?? BreakpointMirror.create(this.debug);
  }

  public setContext(context: PlaywrightBddExtensionContext): void {
    this.context = context;
  }

  /**
   * Swap the shell runner used to execute Playwright. Intended for integration tests, which inject
   * a runner returning a canned JSON report so the run→status path can be exercised in a real VS
   * Code host without spawning a browser. `resetShellRunner` restores the real spawning runner.
   */
  public setShellRunner(runner: ShellRunner): void {
    this.shellRunner = runner;
  }

  public resetShellRunner(): void {
    this.shellRunner = this.defaultShellRunner;
  }

  public setForceParallel(value: boolean, workers?: number): void {
    this.commandBuilder().setForceParallel(value, workers);
  }

  public reloadConfiguration(): void {
    this.config.reload();
  }

  // Public dispatch methods are async so future I/O (install checks, async config reads, etc.)
  // can be threaded through without breaking callers. The bodies currently do no awaiting; the
  // single `await Promise.resolve()` keeps the lint rule happy and the contract stable.
  public async runScenario(options: TestExecutionOptions): Promise<void> {
    await Promise.resolve();
    const command = this.commandBuilder().buildScenarioCommand(this.withSpecLineTarget(options));
    this.executeCommand(command, this.getWorkingDirectory(options.filePath));
  }

  public async debugScenario(options: TestExecutionOptions): Promise<void> {
    let mirrorId: string | undefined;
    try {
      // Run the targeted playwright command under VS Code's JS debugger via a `node-terminal`
      // configuration. js-debug runs the shell command in a terminal and auto-attaches to the
      // spawned node processes, so breakpoints in the user's step-definition .ts files are
      // actually hit. We deliberately avoid Playwright's `--debug` (Inspector) flag here: that
      // pauses in the Inspector, not in VS Code.
      //
      // bddgen runs separately FIRST (not chained into the debugged command) so the generated
      // specs exist before we mirror feature-file breakpoints into them.
      const workingDir = this.getWorkingDirectory(options.filePath);
      const { bddgenCommand } = this.commandBuilder().buildDebugCommandParts(options);

      if (bddgenCommand !== undefined) {
        const result = await this.shellRunner(bddgenCommand, workingDir);
        if (!result.success) {
          const detail = result.error.trim() === "" ? result.output : result.error;
          throw new Error(`bddgen failed (exit code ${result.returnCode}): ${detail}`);
        }
      }

      const specPath = this.resolveSpecPath(workingDir, options.filePath);
      mirrorId = this.mirror.mirrorBreakpoints(options.filePath, specPath);

      // Resolve the precise spec target from the freshly generated spec (bddgen just ran), so a
      // single Scenario Outline row debugs exactly one test instead of grepping its title.
      const { playwrightCommand } = this.commandBuilder().buildDebugCommandParts(
        this.withSpecLineTarget(options, specPath)
      );

      const folder =
        this.workspace.workspaceFolders?.find((f) => isSameOrInsideDir(workingDir, f.uri.fsPath)) ??
        this.workspace.workspaceFolders?.[0];

      const started = await this.debug.startDebugging(folder, {
        type: "node-terminal",
        request: "launch",
        name: "Debug Playwright-BDD Scenario",
        command: playwrightCommand,
        cwd: workingDir,
        ...(options.jsonReportPath
          ? { env: { PLAYWRIGHT_JSON_OUTPUT_NAME: options.jsonReportPath } }
          : {}),
        [BreakpointMirror.SESSION_KEY]: mirrorId,
      });

      if (!started) {
        throw new Error("VS Code declined to start the debug session");
      }

      if (options.waitForSessionEnd) {
        // The testing service treats a Debug-kind run as finished when its handler resolves;
        // resolving at session start tears the run down before the debuggee attaches.
        await this.waitForDebugCompletion(mirrorId, options.jsonReportPath);
      }
    } catch (error) {
      // No session will ever terminate for a failed launch, so the mirror must be released
      // here or the mirrored breakpoints leak until deactivation.
      if (mirrorId !== undefined) {
        this.mirror.release(mirrorId);
      }
      const msg = errMsg(error);
      this.logger.error(`Failed to start debug session: ${msg}`, {
        filePath: options.filePath,
        lineNumber: options.lineNumber,
        scenarioName: options.scenarioName,
      });
      await this.window.showErrorMessage(`Failed to start Playwright debug session: ${msg}`);
    }
  }

  public async runFeatureFile(options: FeatureExecutionOptions): Promise<void> {
    await Promise.resolve();
    const command = this.commandBuilder().buildFeatureCommand(options);
    this.executeCommand(command, this.getWorkingDirectory(options.filePath));
  }

  public async runAllTests(): Promise<void> {
    await Promise.resolve();
    const command = this.commandBuilder().buildAllTestsCommand();
    this.executeCommand(command, this.getWorkingDirectory());
  }

  public async runAllTestsWithTags(tag: string): Promise<void> {
    await Promise.resolve();
    const command = this.commandBuilder().buildTagCommand(tag);
    this.executeCommand(command, this.getWorkingDirectory());
  }

  public async runTestsInParallel(options: ParallelExecutionOptions): Promise<void> {
    await Promise.resolve();
    // Parallel runs span one suite; infer the cwd from the first feature file.
    const workingDir = this.getWorkingDirectory(options.featureFiles[0]);
    this.window.showInformationMessage(
      `Running playwright-bdd with ${options.maxProcesses} workers across ${options.featureFiles.length} feature file(s)`
    );
    // Playwright handles parallelism internally via --workers; we just trigger one command,
    // forcing --workers=<maxProcesses> the same way the "Run in Parallel" profile does.
    const builder = this.commandBuilder();
    builder.setForceParallel(true, options.maxProcesses);
    try {
      const command = options.tags
        ? builder.buildTagCommand(options.tags)
        : builder.buildAllTestsCommand();
      this.executeCommand(command, workingDir);
    } finally {
      builder.setForceParallel(false);
    }
  }

  public async runAllTestsInParallel(): Promise<void> {
    try {
      const featureFiles = await this.discoverFeatureFiles();
      if (featureFiles.length === 0) {
        await this.window.showWarningMessage("No feature files found to run");
        return;
      }
      await this.runTestsInParallel({
        featureFiles,
        maxProcesses: this.config.maxParallelProcesses,
        tags: this.config.tags,
      });
    } catch (error) {
      const msg = errMsg(error);
      this.logger.error(`Failed to run tests in parallel: ${msg}`);
      await this.window.showErrorMessage(`Failed to run tests in parallel: ${msg}`);
    }
  }

  public async runScenarioWithOutput(
    options: TestExecutionOptions
  ): Promise<RunOutputResult> {
    const start = Date.now();
    const workingDir = this.getWorkingDirectory(options.filePath);
    const signal = options.signal;

    this.runEventEmitter.fire({ kind: "running", passed: 0, failed: 0 });

    const preRunFailure = await this.runPreRunHook(workingDir, signal);
    if (preRunFailure) {
      if (signal?.aborted) { return this.cancelledResult(start); }
      this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
      return { success: false, output: "", error: preRunFailure, duration: Math.max(1, Date.now() - start) };
    }

    // Run bddgen separately FIRST (not chained with `&&`) so the generated spec — and its
    // pickleLine→pwTestLine map — is fresh before we resolve the precise `<spec>:<pwTestLine>`
    // target. This makes single-row targeting airtight even right after the feature was edited
    // (mirrors the debug path). When bddgenCommand is undefined (empty config or defineBddProject
    // auto-gen), generation happens inside `playwright test`, so we resolve from the existing spec.
    const { bddgenCommand } = this.commandBuilder().buildScenarioCommandParts(options);
    if (bddgenCommand !== undefined) {
      try {
        const gen = this.withBinaryHint(await this.shellRunner(bddgenCommand, workingDir, undefined, signal), bddgenCommand);
        if (signal?.aborted) { return this.cancelledResult(start); }
        this.publishBddgenDiagnostics(gen, workingDir);
        if (!gen.success) {
          this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
          const detail = gen.error.trim() === "" ? gen.output : gen.error;
          return {
            success: false,
            output: gen.output,
            error: `bddgen failed (exit code ${gen.returnCode}): ${detail}`,
            duration: Math.max(1, Date.now() - start),
          };
        }
      } catch (error) {
        if (signal?.aborted) { return this.cancelledResult(start); }
        this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
        return { success: false, output: "", error: errMsg(error), duration: Math.max(1, Date.now() - start) };
      }
    }

    const enriched = this.withSpecLineTarget(options);
    const result = await this.runScenarioPlaywright(enriched, workingDir, start, signal);

    // Safety net: a spec-line target Playwright doesn't recognize (stale spec, path-filter
    // quirk) makes it report "no tests found" — the run ends with nothing executed and every
    // Explorer item skipped. That's strictly worse than the imprecise name-grep, so rerun once
    // without the target. Only the exact no-tests outcome retries; real failures (compile
    // errors, failing tests) would fail identically again and must surface as-is.
    const specLineTargetWasAdded =
      enriched.specLineTarget !== undefined && options.specLineTarget === undefined;
    if (specLineTargetWasAdded && !signal?.aborted && foundNoTests(result)) {
      this.logger.warn(
        `Playwright found no tests for the spec-line target ${enriched.specLineTarget}; ` +
          "retrying with a name-based --grep."
      );
      return this.runScenarioPlaywright(options, workingDir, start, signal);
    }
    return result;
  }

  /** The playwright half of a scenario run: execute with a JSON report and map the outcome. */
  private async runScenarioPlaywright(
    options: TestExecutionOptions,
    workingDir: string,
    start: number,
    signal: AbortSignal | undefined
  ): Promise<RunOutputResult> {
    const { playwrightCommand } = this.commandBuilder().buildScenarioCommandParts(options);

    reportSequence += 1;
    const reportPath = path.join(
      os.tmpdir(),
      `playwright-bdd-report-${process.pid}-${Date.now()}-${reportSequence}.json`
    );
    const command = this.config.useConfigReporters ? playwrightCommand : `${playwrightCommand} --reporter=json`;

    try {
      const result = this.withBinaryHint(
        await this.shellRunner(command, workingDir, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath }, signal),
        command
      );
      if (signal?.aborted) { return this.cancelledResult(start); }
      // When bddgenCommand is undefined (defineBddProject auto-gen) bddgen runs inside
      // `playwright test`, so its errors surface here rather than in the separate step above.
      // publish() is a no-op parse+clear on non-bddgen failures, so calling it unconditionally
      // is safe and is the only path those errors reach the Problems panel.
      this.publishBddgenDiagnostics(result, workingDir);
      return this.buildOutputResult(result, reportPath, workingDir, start, command, options.artifactBatch);
    } catch (error) {
      if (signal?.aborted) { return this.cancelledResult(start); }
      // A spawn/binary failure never reaches buildOutputResult, so contribute the failed invocation's
      // shard here — one shard per invocation, and the batch honestly seals partial.
      this.contributeArtifactShard(options.artifactBatch, workingDir, command, false, 1, []);
      this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
      return { success: false, output: "", error: errMsg(error), duration: Math.max(1, Date.now() - start) };
    }
  }

  public async runFeatureFileWithOutput(
    options: FeatureExecutionOptions
  ): Promise<RunOutputResult> {
    return this.runWithJsonReport(
      () => this.commandBuilder().buildFeatureCommand(options),
      options.filePath,
      options.signal,
      options.artifactBatch
    );
  }

  public async runAllTestsWithTagsOutput(
    tag: string,
    signal?: AbortSignal,
    artifactBatch?: number
  ): Promise<RunOutputResult> {
    return this.runWithJsonReport(() => this.commandBuilder().buildTagCommand(tag), undefined, signal, artifactBatch);
  }

  // Batch all-mapped collapse: run several scenarios in one bddgen+playwright pass via a combined
  // `--grep`, capturing one shard for the whole set (one regeneration instead of one per scenario).
  public async runGrepWithOutput(
    names: readonly string[],
    signal?: AbortSignal,
    artifactBatch?: number
  ): Promise<RunOutputResult> {
    return this.runWithJsonReport(
      () => this.commandBuilder().buildGrepCommand(names),
      undefined,
      signal,
      artifactBatch
    );
  }

  // Batch feature/folder/all-mapped scopes: run every generated spec matching a positional path filter,
  // capturing the shard into the open artifact. `target` is the source feature file or folder — the
  // working dir is resolved from it the same way as every run (the owning Playwright-config package,
  // monorepo-aware), and the filter is relativized against that dir so it matches the generated specs
  // even when the config lives in a subdirectory. Relativizing off the pre-canonical dir keeps the
  // drive-letter case aligned with `target`; the spawn cwd is canonicalized separately downstream.
  public async runPathFilterWithOutput(
    target: string,
    signal?: AbortSignal,
    artifactBatch?: number
  ): Promise<RunOutputResult> {
    const pathFilter = toPathFilterRegex(this.resolveWorkingDirectory(target), target);
    return this.runWithJsonReport(
      () => this.commandBuilder().buildPathFilterCommand(pathFilter),
      target,
      signal,
      artifactBatch
    );
  }

  public async discoverFeatureFiles(): Promise<string[]> {
    try {
      const pattern = this.config.testFilePattern;
      if (!pattern || pattern.trim() === "") {
        throw new Error("Test file pattern is empty or invalid");
      }
      const files = await this.workspace.findFiles(pattern, "**/node_modules/**");
      return files?.map((f) => f.fsPath) ?? [];
    } catch (error) {
      const msg = errMsg(error);
      this.logger.error(`Failed to discover feature files: ${msg}`);
      await this.window.showErrorMessage(`Test discovery failed: ${msg}`);
      return [];
    }
  }

  public dispose(): void {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
    }
    this.terminalCloseSubscription?.dispose();
    this.terminalCloseSubscription = undefined;
    this.mirror.dispose();
    this.runEventEmitter.dispose();
  }

  /**
   * Enrich options with a precise `specLineTarget` when one can be resolved, leaving them untouched
   * otherwise (the command builder then falls back to name-based --grep). `specPath` is supplied by
   * the debug path, which resolves it after running bddgen so the line map is fresh.
   */
  private withSpecLineTarget(
    options: TestExecutionOptions,
    specPath?: string
  ): TestExecutionOptions {
    if (options.specLineTarget !== undefined) {
      return options;
    }
    const resolution = this.resolveSpecLineTarget(options.filePath, options.lineNumber, specPath);
    if ("target" in resolution) {
      return { ...options, specLineTarget: resolution.target };
    }
    // Falling back to name-grep. For a plain scenario that grep is precise, but for an outline
    // row it matches EVERY example row of the outline — surface why, so N tests fanning out
    // across Playwright's workers isn't a silent mystery.
    if (options.outlineName !== undefined && options.lineNumber !== undefined) {
      this.logger.warn(
        `Could not target example row ${options.filePath}:${options.lineNumber} by generated spec line: ${resolution.reason}. ` +
          `Falling back to --grep on the outline title, which runs ALL example rows of "${options.outlineName}".`
      );
    }
    return options;
  }

  /**
   * Resolve `<generatedSpec>:<pwTestLine>` for a single scenario/outline row by reading the
   * generated spec's `bddFileData` (pickleLine→pwTestLine). This is the only reliable way to target
   * one Scenario Outline example row, since playwright-bdd substitutes example values into the test
   * title (so no grep on the source title can isolate a row). Returns a `reason` — caller falls
   * back to name-grep — when there's no line, the spec can't be located/read, or the line isn't
   * mapped.
   */
  /**
   * Locate the generated spec for a feature, logging when several BDD projects generated it
   * (the run/debug then covers only the targeted project, which the user should know about).
   */
  private resolveSpecPath(workingDir: string, filePath: string): string | undefined {
    return resolveGeneratedSpecPath(
      workingDir,
      this.config.featuresGenDir,
      filePath,
      (chosen, candidates) => {
        this.logger.warn(
          `Multiple generated specs match ${filePath}: ${candidates.join(", ")}. ` +
            `Targeting the newest, ${chosen} — the scenario runs only in that BDD project. ` +
            `To always target one project, point 'playwrightBddRunner.featuresGenDir' at its ` +
            `output dir (e.g. ".features-gen/browser").`
        );
      }
    );
  }

  private resolveSpecLineTarget(
    filePath: string,
    lineNumber?: number,
    specPathArg?: string
  ): { target: string } | { reason: string } {
    if (lineNumber === undefined || lineNumber <= 0) {
      return { reason: "the test item has no line number" };
    }
    const workingDir = this.getWorkingDirectory(filePath);
    const specPath = specPathArg ?? this.resolveSpecPath(workingDir, filePath);
    if (!specPath) {
      return { reason: `the feature is outside the working directory ${workingDir}` };
    }
    let content: string;
    try {
      content = fs.readFileSync(specPath, "utf8");
    } catch {
      return {
        reason:
          `no generated spec at ${specPath} — ` +
          "check that 'playwrightBddRunner.featuresGenDir' matches your bddgen outputDir",
      };
    }
    const pwTestLine = parseBddFileData(content)?.testLines.get(lineNumber);
    if (pwTestLine === undefined) {
      return {
        reason: `line ${lineNumber} has no bddFileData mapping in ${specPath} (stale spec or feature/spec drift)`,
      };
    }
    // A cwd-relative spec path keeps the Playwright filter short and dodges the Windows drive-colon
    // (`C:\…`) clashing with the trailing `:line`. Fall back to the absolute path when the spec sits
    // outside the working dir (a `..` chain would be brittle).
    const rel = path.relative(workingDir, specPath);
    const specArg = rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? specPath : rel;
    // Playwright treats CLI file filters as regular expressions. A Windows-separator path is
    // regex poison there — `.features-gen\browser` reads as "gen" + word-boundary + "rowser",
    // which matches nothing, and Playwright reports "no tests found". Forward slashes are
    // literal in a regex and Playwright accepts them on every platform.
    return { target: `${specArg.split(path.sep).join("/")}:${pwTestLine}` };
  }

  private async runWithJsonReport(
    buildCommand: () => string,
    forFile?: string,
    signal?: AbortSignal,
    artifactBatch?: number
  ): Promise<RunOutputResult> {
    const start = Date.now();
    const workingDir = this.getWorkingDirectory(forFile);

    this.runEventEmitter.fire({ kind: "running", passed: 0, failed: 0 });

    const preRunFailure = await this.runPreRunHook(workingDir, signal);
    if (preRunFailure) {
      if (signal?.aborted) { return this.cancelledResult(start); }
      this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
      return {
        success: false,
        output: "",
        error: preRunFailure,
        duration: Math.max(1, Date.now() - start),
      };
    }

    reportSequence += 1;
    const reportPath = path.join(
      os.tmpdir(),
      `playwright-bdd-report-${process.pid}-${Date.now()}-${reportSequence}.json`
    );
    const baseCommand = buildCommand();
    // Normally we force `--reporter=json` for result mapping. With useConfigReporters the user's
    // config owns the reporter list (so a custom reporter survives) — a `--reporter` here would
    // override it. We still set PLAYWRIGHT_JSON_OUTPUT_NAME below, which steers a bare `['json']`
    // reporter in their config to our temp file.
    const command = this.config.useConfigReporters ? baseCommand : `${baseCommand} --reporter=json`;

    try {
      const result = this.withBinaryHint(
        await this.shellRunner(command, workingDir, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath }, signal),
        command
      );
      if (signal?.aborted) { return this.cancelledResult(start); }
      this.publishBddgenDiagnostics(result, workingDir);
      return this.buildOutputResult(result, reportPath, workingDir, start, command, artifactBatch);
    } catch (error) {
      if (signal?.aborted) { return this.cancelledResult(start); }
      this.contributeArtifactShard(artifactBatch, workingDir, command, false, 1, []);
      this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
      return {
        success: false,
        output: "",
        error: errMsg(error),
        duration: Math.max(1, Date.now() - start),
      };
    }
  }

  // A cancelled run fires "cancelled", never success/failure — the killed process exits
  // non-zero, and announcing a failure would misrepresent a deliberate stop. Without any event
  // the status bar would sit on "running…" until the next run, so the distinct kind lets it
  // settle. The caller marks the affected items skipped.
  private cancelledResult(start: number): RunOutputResult {
    this.runEventEmitter.fire({ kind: "cancelled", passed: 0, failed: 0 });
    return { success: false, output: "", error: "Cancelled", duration: Math.max(1, Date.now() - start) };
  }

  /**
   * With `shell: true` a missing npx/playwright/bddgen binary surfaces only as raw shell noise
   * (exit 127 + "command not found" on POSIX, "'npx' is not recognized" on Windows). Detect that
   * shape and return an actionable hint naming the attempted binary; undefined otherwise.
   */
  private missingBinaryHint(result: CommandResult, command: string): string | undefined {
    if (result.success) { return undefined; }
    const haystack = `${result.error}\n${result.output}`;
    const looksMissing =
      result.returnCode === 127 ||
      /command not found|is not recognized as an internal or external command|ENOENT/i.test(haystack);
    if (!looksMissing) { return undefined; }
    const bin = command.trim().split(/\s+/)[0] ?? command;
    return (
      `The command "${bin}" was not found. Install the project dependencies ` +
      "(npm i -D playwright-bdd @playwright/test) or adjust the " +
      "'playwrightBddRunner.playwrightCommand' / 'playwrightBddRunner.bddgenCommand' settings."
    );
  }

  /** Append the missing-binary hint to a failed result's error so it reaches the failure surfaces. */
  private withBinaryHint(result: CommandResult, command: string): CommandResult {
    const hint = this.missingBinaryHint(result, command);
    if (hint === undefined) { return result; }
    return { ...result, error: result.error.trim() === "" ? hint : `${result.error}\n\n${hint}` };
  }

  /** Mirror bddgen output into the Problems panel: clear on success, publish the errors on failure. */
  private publishBddgenDiagnostics(result: CommandResult, workingDir: string): void {
    const bddgenDiagnostics = this.context?.bddgenDiagnostics;
    if (!bddgenDiagnostics) {
      return;
    }
    if (result.success) {
      bddgenDiagnostics.clear();
    } else {
      bddgenDiagnostics.publish(`${result.output}\n${result.error}`, workingDir);
    }
  }

  // Contribute one shard to the open artifact batch (no-op when the run carries no handle, e.g. a
  // command-driven run). Every invocation contributes exactly once — success or spawn failure.
  private contributeArtifactShard(
    artifactBatch: number | undefined,
    workingDir: string,
    command: string,
    success: boolean,
    exitCode: number,
    details: ScenarioResult[]
  ): void {
    if (artifactBatch === undefined) { return; }
    const workspaceRoot = this.workspaceRootFor(workingDir);
    this.context?.runArtifactStore?.contributeShard(artifactBatch, {
      workingDir,
      command: this.commandSummary(command, workspaceRoot),
      success,
      exitCode,
      details,
      workspaceRoot,
    });
  }

  // The workspace folder that owns this run (multi-root aware), mirroring the debug-launch cwd
  // resolution — a run under folder #2 must relativize evidence against folder #2, not the first.
  private workspaceRootFor(workingDir: string): string | undefined {
    const folders = this.workspace.workspaceFolders;
    return (folders?.find((f) => isSameOrInsideDir(workingDir, f.uri.fsPath)) ?? folders?.[0])?.uri.fsPath;
  }

  // A publish-safe command summary: strip the JSON reporter we inject for result mapping, forward-
  // slash separators, and relativize any absolute workspace path so shard info never leaks the tree.
  private commandSummary(command: string, workspaceRoot: string | undefined): string {
    let summary = command.replaceAll(" --reporter=json", "").split(path.sep).join("/");
    if (workspaceRoot !== undefined) {
      summary = summary.replaceAll(`${normalizePathKey(workspaceRoot)}/`, "");
    }
    return summary;
  }

  /** Parse the JSON report into a RunOutputResult and fire the matching success/failure event. */
  private buildOutputResult(
    result: CommandResult,
    reportPath: string,
    workingDir: string,
    start: number,
    command: string,
    artifactBatch: number | undefined
  ): RunOutputResult {
    const scenarioDetails = this.readScenarioDetails(reportPath, result.output);
    const scenarioResults = this.playwrightJsonParser.toStatusMap(scenarioDetails, workingDir);
    // Feed the badge store before the ephemeral report is gone: this is the extension-launched run
    // that leaves nothing on disk for the traceability panel to scan (§3.5).
    this.context?.runResultStore?.ingest(scenarioResults);
    // Same seam feeds the richer artifact store. The report is unlinked in readScenarioDetails, so
    // the shard carries the already-parsed details.
    this.contributeArtifactShard(artifactBatch, workingDir, command, result.success, result.returnCode, scenarioDetails);
    const { passed, failed } = countScenarioStatuses(scenarioDetails);
    this.runEventEmitter.fire({
      kind: result.success && failed === 0 ? "success" : "failure",
      passed,
      failed,
    });
    return {
      success: result.success,
      output: result.output,
      error: result.error,
      duration: Math.max(1, Date.now() - start),
      scenarioResults,
      scenarioDetails,
    };
  }

  /**
   * Resolve parsed scenario results from the run: prefer the JSON report file (written via
   * PLAYWRIGHT_JSON_OUTPUT_NAME), falling back to parsing stdout. With useConfigReporters the
   * report only appears if the user's config has a bare `['json']` reporter for the env var to
   * steer; no file + no parseable stdout almost always means that entry is missing, so we point
   * at the fix directly rather than letting it surface as a generic "out of scope" warning.
   */
  private readScenarioDetails(reportPath: string, output: string): ScenarioResult[] {
    if (fs.existsSync(reportPath)) {
      const details = this.playwrightJsonParser.parseFromFile(reportPath);
      try { fs.unlinkSync(reportPath); } catch { /* ignore */ }
      return details;
    }
    const details = this.playwrightJsonParser.parse(output);
    if (this.config.useConfigReporters && details.length === 0) {
      this.logger.warn(
        "useConfigReporters is on but no JSON report was produced. Add a bare ['json'] entry " +
          "(no outputFile) to the reporter array in your Playwright config so results can be mapped."
      );
    }
    return details;
  }

  /** Test hooks: shrink the debug watchdog timings so tests don't wait seconds. */
  public debugWatchdogPollMs = 1000;
  public debugWatchdogGraceMs = 5000;

  /**
   * Wait for the debug session to settle. Normally the mirror releases when the last
   * child debug session terminates. That chain can wedge — pnpm process trees leave a
   * debug-attached child (web server, extra node layer) alive, or no child session
   * ever attaches — so when a JSON report path is in play, watch for the report file:
   * Playwright writes it only AFTER the tests finish (a paused breakpoint delays it,
   * so the watchdog can never fire mid-debug). Once it appears, give natural teardown
   * a grace period, then force the session down.
   */
  private async waitForDebugCompletion(
    mirrorId: string,
    reportPath: string | undefined
  ): Promise<void> {
    let settled = false;
    const isSettled = (): boolean => settled;
    const released = this.mirror.waitForRelease(mirrorId).then(() => { settled = true; });
    if (!reportPath) {
      await released;
      return;
    }

    const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const watchdog = (async (): Promise<void> => {
      while (!isSettled() && !fs.existsSync(reportPath)) {
        await delay(this.debugWatchdogPollMs);
      }
      if (isSettled()) {return;}
      await delay(this.debugWatchdogGraceMs);
      if (isSettled()) {return;}
      this.logger.info(
        "Debug session did not settle after the JSON report was written; forcing teardown",
        { mirrorId, reportPath }
      );
      await this.mirror.forceStop(mirrorId);
    })();
    watchdog.catch(() => { /* logged in forceStop path; never block completion */ });

    await released;
  }

  private async runPreRunHook(workingDir: string, signal?: AbortSignal): Promise<string | undefined> {
    const command = this.config.preRunCommand.trim();
    if (command === "") { return undefined; }

    this.logger.info(`Running preRunCommand: ${command}`);
    const result = await this.shellRunner(command, workingDir, undefined, signal);
    if (result.success) { return undefined; }

    const detail = result.error?.trim() === "" ? result.output : result.error;
    const base = `preRunCommand "${command}" failed with exit code ${result.returnCode}. Test run aborted.`;
    const hint = this.missingBinaryHint(result, command);
    const message = hint ? `${base}\n\n${hint}` : base;
    this.logger.error(message, { detail });
    this.logger.showOutput();
    return message;
  }

  private commandBuilder() {
    if (!this.context?.commandBuilder) {
      throw new Error("TestExecutor used before context was injected. Call setContext() during activation.");
    }
    return this.context.commandBuilder;
  }

  private executeCommand(command: string, workingDir: string): void {
    try {
      if (!command || command.trim() === "") {throw new Error("Command cannot be empty");}
      if (!this.terminal) {
        this.terminal = this.window.createTerminal("Specwright");
        // Without this, a user-closed terminal leaves a disposed handle behind and every later
        // run sends text into it — nothing visible happens. Drop the handle so the next run
        // creates a fresh terminal.
        this.terminalCloseSubscription ??= this.window.onDidCloseTerminal((closed) => {
          if (closed === this.terminal) { this.terminal = undefined; }
        });
      }
      this.terminal.show();
      // cmd.exe has no `clear`; PowerShell accepts either, so `cls` is the safe Windows choice.
      this.terminal.sendText(process.platform === "win32" ? "cls" : "clear");
      if (workingDir && workingDir !== process.cwd()) {
        this.terminal.sendText(`cd ${shellQuote(workingDir)}`);
      }
      this.terminal.sendText(command);
    } catch (error) {
      const msg = errMsg(error);
      this.logger.error(`Failed to execute command: ${msg}`, { command, workingDir });
      this.window.showErrorMessage(`Failed to execute test command: ${msg}`);
    }
  }

  private async spawnCommand(
    command: string,
    workingDir: string,
    extraEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      if (!command || command.trim() === "") {
        resolve({ success: false, output: "", error: "Command cannot be empty", returnCode: 1 });
        return;
      }
      if (signal?.aborted) {
        resolve({ success: false, output: "", error: "Cancelled", returnCode: 130 });
        return;
      }
      try {
        const child = spawn(command, {
          cwd: workingDir,
          shell: true,
          // POSIX: detach so the child leads its own process group; killing that group on
          // cancellation reaches playwright + browsers. With shell:true, signalling only the
          // shell would orphan playwright. Windows uses taskkill /T instead (see killTree).
          ...(process.platform === "win32" ? {} : { detached: true }),
          env: { ...process.env, ...(extraEnv ?? {}) },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let cancelled = false;
        const settle = (code: number | null): void => {
          if (settled) {return;}
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          // A killed process exits non-zero; report the stop, not a failure.
          if (cancelled) {
            resolve({ success: false, output: stdout, error: "Cancelled", returnCode: 130 });
            return;
          }
          const returnCode = code ?? 1;
          resolve({ success: returnCode === 0, output: stdout, error: stderr, returnCode });
        };
        const onAbort = (): void => {
          cancelled = true;
          this.killTree(child);
          // If the tree's `close` never arrives (grandchild holding pipes), force the stop after
          // the same flush grace the exit path uses.
          const timer = setTimeout(() => { settle(130); }, 2000);
          timer.unref?.();
        };
        signal?.addEventListener("abort", onAbort);
        child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
        child.on("close", (code: number | null) => { settle(code); });
        child.on("exit", (code: number | null) => {
          // `close` additionally waits for all stdio pipes to close. A grandchild that
          // inherited them (web server, browser process — common on Windows) keeps the
          // run hanging forever after playwright itself exited. Results come from the
          // JSON report file, not stdout, so after a short flush grace settle anyway.
          const timer = setTimeout(() => { settle(code); }, 2000);
          timer.unref?.();
        });
        child.on("error", (error: Error) => {
          this.logger.error(`Command execution error: ${error.message}`, { command, workingDir });
          if (!settled) {
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve({ success: false, output: "", error: error.message, returnCode: 1 });
          }
        });
      } catch (error) {
        const msg = errMsg(error);
        this.logger.error(`Failed to execute command with output: ${msg}`, { command, workingDir });
        resolve({ success: false, output: "", error: msg, returnCode: 1 });
      }
    });
  }

  /** Kill the whole spawned tree (shell + playwright + browsers), not just the shell. */
  private killTree(child: ChildProcess): void {
    if (child.pid === undefined) { return; }
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        killer.on("error", () => { /* taskkill unavailable; best effort */ });
      } else {
        // Negative pid targets the process group the detached spawn made this child lead.
        process.kill(-child.pid, "SIGTERM");
      }
    } catch (error) {
      // ESRCH: the group already exited between close and kill — nothing left to signal.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        this.logger.warn(`Failed to kill process tree: ${errMsg(error)}`);
      }
    }
  }

  /**
   * Resolve the cwd for spawned bddgen/playwright commands.
   *
   * An explicit `workingDirectory` setting always wins. Otherwise, when the run
   * targets a feature file, infer the package that owns the playwright-bdd setup
   * by walking up from the file to the nearest `playwright.config.*` (stopping at
   * the file's workspace folder). This makes monorepos work without configuration:
   * pnpm links binaries only into the declaring package's `node_modules/.bin`, so
   * `npx bddgen` resolves only when spawned from that package — not the repo root.
   */
  private getWorkingDirectory(forFile?: string): string {
    // Canonicalize the result so the spawn cwd has an uppercase Windows drive letter.
    // VS Code's `uri.fsPath` lowercases it, which makes playwright-bdd treat every feature
    // as "outside the features scope" on Windows (see canonicalCwd).
    return canonicalCwd(this.resolveWorkingDirectory(forFile));
  }

  private resolveWorkingDirectory(forFile?: string): string {
    const folders = this.workspace.workspaceFolders;
    const firstRoot = folders?.[0]?.uri.fsPath;
    const configured = this.config.workingDirectory;
    if (configured) {
      // A relative setting must resolve against the workspace, not the extension host's cwd.
      return path.isAbsolute(configured) ? configured : path.resolve(firstRoot ?? process.cwd(), configured);
    }
    if (forFile) {
      const folderRoot = workspaceFolderRootFor(forFile, folders) ?? firstRoot;
      if (folderRoot) {
        return findNearestPlaywrightConfigDir(forFile, folderRoot) ?? folderRoot;
      }
    }
    return firstRoot ?? process.cwd();
  }
}
