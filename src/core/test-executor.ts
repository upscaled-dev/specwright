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
import { spawn } from "node:child_process";
import { PlaywrightJsonParser, ScenarioStatus, ScenarioResult } from "../utils/playwright-json-parser";
import { shellQuote } from "../utils/shell";
import { canonicalCwd, findNearestPlaywrightConfigDir, workspaceFolderRootFor } from "../utils/working-dir";
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

function countScenarioStatuses(
  results: ScenarioResult[]
): { passed: number; failed: number } {
  // Key by file + line + name so same-named scenarios in different feature files (or different
  // outline examples) are counted separately, while retries/projects of one scenario are not.
  const byScenario = new Map<string, ScenarioStatus>();
  for (const r of results) {
    const key = `${r.featurePath}::${r.lineNumber ?? ""}::${r.scenarioName}`;
    if (!byScenario.has(key)) { byScenario.set(key, r.status); }
  }
  let passed = 0;
  let failed = 0;
  for (const status of byScenario.values()) {
    if (status === "passed") { passed += 1; }
    else if (status === "failed") { failed += 1; }
  }
  return { passed, failed };
}

let reportSequence = 0;

type CommandResult = { success: boolean; output: string; error: string; returnCode: number };

export type TestRunEvent =
  | { kind: "running"; passed: number; failed: number }
  | { kind: "success"; passed: number; failed: number }
  | { kind: "failure"; passed: number; failed: number };

export type ShellRunner = (
  command: string,
  workingDir: string,
  extraEnv?: NodeJS.ProcessEnv
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
    this.defaultShellRunner = (command, workingDir, extraEnv) =>
      this.spawnCommand(command, workingDir, extraEnv);
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

      const specPath = resolveGeneratedSpecPath(
        workingDir,
        this.config.featuresGenDir,
        options.filePath
      );
      mirrorId = this.mirror.mirrorBreakpoints(options.filePath, specPath);

      // Resolve the precise spec target from the freshly generated spec (bddgen just ran), so a
      // single Scenario Outline row debugs exactly one test instead of grepping its title.
      const { playwrightCommand } = this.commandBuilder().buildDebugCommandParts(
        this.withSpecLineTarget(options, specPath)
      );

      const folder =
        this.workspace.workspaceFolders?.find(
          (f) => workingDir === f.uri.fsPath || workingDir.startsWith(f.uri.fsPath + path.sep)
        ) ?? this.workspace.workspaceFolders?.[0];

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

    this.runEventEmitter.fire({ kind: "running", passed: 0, failed: 0 });

    const preRunFailure = await this.runPreRunHook(workingDir);
    if (preRunFailure) {
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
        const gen = await this.shellRunner(bddgenCommand, workingDir);
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
        this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
        return { success: false, output: "", error: errMsg(error), duration: Math.max(1, Date.now() - start) };
      }
    }

    const enriched = this.withSpecLineTarget(options);
    const { playwrightCommand } = this.commandBuilder().buildScenarioCommandParts(enriched);

    reportSequence += 1;
    const reportPath = path.join(
      os.tmpdir(),
      `playwright-bdd-report-${process.pid}-${Date.now()}-${reportSequence}.json`
    );
    const command = this.config.useConfigReporters ? playwrightCommand : `${playwrightCommand} --reporter=json`;

    try {
      const result = await this.shellRunner(command, workingDir, {
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      });
      return this.buildOutputResult(result, reportPath, workingDir, start);
    } catch (error) {
      this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
      return { success: false, output: "", error: errMsg(error), duration: Math.max(1, Date.now() - start) };
    }
  }

  public async runFeatureFileWithOutput(
    options: FeatureExecutionOptions
  ): Promise<RunOutputResult> {
    return this.runWithJsonReport(
      () => this.commandBuilder().buildFeatureCommand(options),
      options.filePath
    );
  }

  public async runAllTestsWithTagsOutput(
    tag: string
  ): Promise<RunOutputResult> {
    return this.runWithJsonReport(() => this.commandBuilder().buildTagCommand(tag));
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
    const target = this.resolveSpecLineTarget(options.filePath, options.lineNumber, specPath);
    return target ? { ...options, specLineTarget: target } : options;
  }

  /**
   * Resolve `<generatedSpec>:<pwTestLine>` for a single scenario/outline row by reading the
   * generated spec's `bddFileData` (pickleLine→pwTestLine). This is the only reliable way to target
   * one Scenario Outline example row, since playwright-bdd substitutes example values into the test
   * title (so no grep on the source title can isolate a row). Returns undefined — caller falls back
   * to name-grep — when there's no line, the spec can't be located/read, or the line isn't mapped.
   */
  private resolveSpecLineTarget(
    filePath: string,
    lineNumber?: number,
    specPathArg?: string
  ): string | undefined {
    if (lineNumber === undefined || lineNumber <= 0) {
      return undefined;
    }
    const workingDir = this.getWorkingDirectory(filePath);
    const specPath =
      specPathArg ?? resolveGeneratedSpecPath(workingDir, this.config.featuresGenDir, filePath);
    if (!specPath) {
      return undefined;
    }
    let content: string;
    try {
      content = fs.readFileSync(specPath, "utf8");
    } catch {
      return undefined;
    }
    const pwTestLine = parseBddFileData(content)?.testLines.get(lineNumber);
    if (pwTestLine === undefined) {
      return undefined;
    }
    // A cwd-relative spec path keeps the Playwright filter short and dodges the Windows drive-colon
    // (`C:\…`) clashing with the trailing `:line`. Fall back to the absolute path when the spec sits
    // outside the working dir (a `..` chain would be brittle).
    const rel = path.relative(workingDir, specPath);
    const specArg = rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? specPath : rel;
    return `${specArg}:${pwTestLine}`;
  }

  private async runWithJsonReport(
    buildCommand: () => string,
    forFile?: string
  ): Promise<RunOutputResult> {
    const start = Date.now();
    const workingDir = this.getWorkingDirectory(forFile);

    this.runEventEmitter.fire({ kind: "running", passed: 0, failed: 0 });

    const preRunFailure = await this.runPreRunHook(workingDir);
    if (preRunFailure) {
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
      const result = await this.shellRunner(command, workingDir, {
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      });
      this.publishBddgenDiagnostics(result, workingDir);
      return this.buildOutputResult(result, reportPath, workingDir, start);
    } catch (error) {
      this.runEventEmitter.fire({ kind: "failure", passed: 0, failed: 0 });
      return {
        success: false,
        output: "",
        error: errMsg(error),
        duration: Math.max(1, Date.now() - start),
      };
    }
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

  /** Parse the JSON report into a RunOutputResult and fire the matching success/failure event. */
  private buildOutputResult(
    result: CommandResult,
    reportPath: string,
    workingDir: string,
    start: number
  ): RunOutputResult {
    const scenarioDetails = this.readScenarioDetails(reportPath, result.output);
    const scenarioResults = this.playwrightJsonParser.toStatusMap(scenarioDetails, workingDir);
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

  private async runPreRunHook(workingDir: string): Promise<string | undefined> {
    const command = this.config.preRunCommand.trim();
    if (command === "") { return undefined; }

    this.logger.info(`Running preRunCommand: ${command}`);
    const result = await this.shellRunner(command, workingDir);
    if (result.success) { return undefined; }

    const detail = result.error?.trim() === "" ? result.output : result.error;
    const message = `preRunCommand "${command}" failed with exit code ${result.returnCode}. Test run aborted.`;
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
      this.terminal.sendText("clear");
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
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      if (!command || command.trim() === "") {
        resolve({ success: false, output: "", error: "Command cannot be empty", returnCode: 1 });
        return;
      }
      try {
        const child = spawn(command, {
          cwd: workingDir,
          shell: true,
          env: { ...process.env, ...(extraEnv ?? {}) },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (code: number | null): void => {
          if (settled) {return;}
          settled = true;
          const returnCode = code ?? 1;
          resolve({ success: returnCode === 0, output: stdout, error: stderr, returnCode });
        };
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
