import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  TestExecutionOptions,
  TestRunResult,
  PlaywrightBddExtensionContext,
} from "../types/index";
import { Logger } from "../utils/logger";
import { errMsg } from "../utils/text";
import { ExtensionConfig } from "./extension-config";
import {
  PlaywrightJsonParser,
  type PlaywrightReportEvidence,
  type ScenarioStatus,
  type ScenarioResult,
  normalizePathKey,
} from "../utils/playwright-json-parser";
import {
  canonicalCwd,
  findNearestPlaywrightConfigDir,
  isSameOrInsideDir,
  toPathFilterRegex,
  workspaceFolderRootFor,
} from "../utils/working-dir";
import { BreakpointMirror } from "./breakpoint-mirror";
import {
  scopeArtifactDetails,
  type ArtifactCaptureTarget,
} from "../traceability/run-artifact-store";
import { openLiveRunSession, type LiveRunHandle } from "./live-run-session";
import type { RunProgressObserver } from "./run-progress";
import { TemporaryReport } from "./temporary-report";
import {
  resolveExecutableCommand,
  runBoundedCommand,
  type BoundedCommandResult,
  type CommandOutputHandler,
} from "./bounded-command-runner";
import { terminationLease, type TerminationLease } from "./execution-admission";
import {
  exactGeneratedTargets,
  needsGeneratedSpecs,
  verifiedGeneratedSpecPaths,
} from "./generated-test-target";

/**
 * A test run result enriched with the per-scenario outcomes parsed from Playwright's JSON
 * report: a status lookup keyed for the Test Explorer, plus the full structured results used to
 * render a legible summary and attach error messages.
 */
export type RunOutputResult = TestRunResult & {
  scenarioResults?: Record<string, ScenarioStatus>;
  scenarioDetails?: ScenarioResult[];
  /** Present when the process did not produce a complete report, even if earlier cases landed. */
  infrastructureFailure?: string;
  /** True when process chunks were already written to a live consumer. */
  outputStreamed?: boolean;
  /** The executor could not prove its process tree ended; execution admission must stay closed. */
  admissionUnsafe?: boolean;
  /** Durable recovery evidence for an unsafe termination. */
  terminationLease?: TerminationLease;
};

function infrastructureResult(
  start: number,
  failure: string,
  output = "",
  outputStreamed = false,
  admissionUnsafe = false,
  lease?: TerminationLease
): RunOutputResult {
  return {
    success: false,
    output,
    error: failure,
    duration: Math.max(1, Date.now() - start),
    infrastructureFailure: failure,
    ...(outputStreamed ? { outputStreamed: true } : {}),
    ...(admissionUnsafe ? { admissionUnsafe: true } : {}),
    ...(lease ? { terminationLease: lease } : {}),
  };
}

function generationRequiredFailure(): string {
  return "An exact test target needs current generated specs, but " +
    "'playwrightBddRunner.bddgenCommand' is empty. Configure it to run bddgen, or ensure " +
    "'playwrightBddRunner.preRunCommand' produces current specs. No broader target was executed.";
}

function missingGeneratedSpecsFailure(filePath: string, action: "executed" | "launched"): string {
  return `Could not find generated specs for ${filePath} after bddgen. Check ` +
    "'playwrightBddRunner.featuresGenDir' and the bddgen features configuration. " +
    `No broader target was ${action}.`;
}

interface ScenarioPlaywrightAttempt {
  readonly result: RunOutputResult;
  readonly command: string;
  readonly exitCode: number;
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

/** Keep the configured reporter visible while adding JSON as one Playwright reporter list. */
export function withJsonReporter(command: string): string {
  const reporterFlag = /--reporter=([^\s]+)/;
  const match = reporterFlag.exec(command);
  if (!match?.[1]) {return `${command} --reporter=json`;}
  const reporters = match[1].split(",");
  if (reporters.includes("json")) {return command;}
  return command.replace(reporterFlag, `--reporter=${match[1]},json`);
}

type CommandResult = BoundedCommandResult;

export type ShellRunner = (
  command: string,
  workingDir: string,
  extraEnv?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onOutput?: CommandOutputHandler,
  shell?: boolean
) => Promise<CommandResult>;

export type ExecutableCommandResolver = typeof resolveExecutableCommand;

/**
 * Drives playwright-bdd via captured executable arguments and parses the JSON report so scenario
 * status can be projected consistently to every UI surface.
 *
 * The final JSON reporter remains authoritative. A lightweight additional reporter writes
 * current results to a private side channel so consumers can update while Playwright is active.
 */
export class TestExecutor {
  private readonly config: ExtensionConfig;
  private readonly logger: Logger;
  private readonly workspace: typeof vscode.workspace;
  private readonly window: typeof vscode.window;
  private readonly debug: typeof vscode.debug;
  private readonly playwrightJsonParser: PlaywrightJsonParser;
  private context?: PlaywrightBddExtensionContext;
  private readonly defaultShellRunner: ShellRunner;
  private shellRunner: ShellRunner;
  private readonly mirror: BreakpointMirror;
  private readonly artifactSinks = new Map<number, {
    contributeShard(handle: number, capture: import("../traceability/run-artifact-store").ShardCapture): void;
  }>();

  public static create(
    workspace?: typeof vscode.workspace,
    window?: typeof vscode.window,
    _debug?: typeof vscode.debug,
    config?: ExtensionConfig,
    logger?: Logger,
    playwrightJsonParser?: PlaywrightJsonParser,
    shellRunner?: ShellRunner,
    mirror?: BreakpointMirror,
    commandResolver?: ExecutableCommandResolver
  ): TestExecutor {
    return new TestExecutor(
      workspace,
      window,
      _debug,
      config,
      logger,
      playwrightJsonParser,
      shellRunner,
      mirror,
      commandResolver
    );
  }

  constructor(
    workspace: typeof vscode.workspace = vscode.workspace,
    window: typeof vscode.window = vscode.window,
    _debug: typeof vscode.debug = vscode.debug,
    config?: ExtensionConfig,
    logger?: Logger,
    playwrightJsonParser?: PlaywrightJsonParser,
    shellRunner?: ShellRunner,
    mirror?: BreakpointMirror,
    private readonly commandResolver: ExecutableCommandResolver = resolveExecutableCommand
  ) {
    this.workspace = workspace;
    this.window = window;
    this.debug = _debug;
    this.config = config ?? ExtensionConfig.create();
    this.logger = logger ?? Logger.create();
    this.playwrightJsonParser = playwrightJsonParser ?? PlaywrightJsonParser.create(this.logger);
    this.defaultShellRunner = (command, workingDir, extraEnv, signal, onOutput, shell) =>
      this.spawnCommand(command, workingDir, extraEnv, signal, onOutput, shell);
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

  public registerArtifactSink(
    handle: number,
    sink: { contributeShard(handle: number, capture: import("../traceability/run-artifact-store").ShardCapture): void }
  ): { dispose(): void } {
    if (this.artifactSinks.has(handle)) {throw new Error(`Artifact batch ${handle} is already registered.`);}
    this.artifactSinks.set(handle, sink);
    return { dispose: () => {this.artifactSinks.delete(handle);} };
  }

  public setForceParallel(value: boolean, workers?: number): void {
    this.commandBuilder().setForceParallel(value, workers);
  }

  public reloadConfiguration(): void {
    this.config.reload();
  }

  public async debugScenario(options: TestExecutionOptions): Promise<void> {
    try {
      const lease = await this.launchDebugScenario(options);
      if (lease) {throw new Error(lease.failure);}
    } catch (error) {
      const msg = errMsg(error);
      this.logger.error(`Failed to start debug session: ${msg}`, {
        filePath: options.filePath,
        lineNumber: options.lineNumber,
        scenarioName: options.scenarioName,
      });
      await this.window.showErrorMessage(`Failed to start Playwright debug session: ${msg}`);
    }
  }

  private async launchDebugScenario(options: TestExecutionOptions): Promise<TerminationLease | undefined> {
    let mirrorId: string | undefined;
    try {
      // Run the targeted playwright command under VS Code's JS debugger with a structured runtime
      // executable and arguments. Child-process auto-attach reaches Playwright's worker processes,
      // so breakpoints in the user's step-definition .ts files are actually hit. We deliberately
      // avoid Playwright's `--debug` (Inspector) flag here: that pauses in the Inspector, not VS Code.
      //
      // bddgen runs separately FIRST (not chained into the debugged command) so the generated
      // specs exist before we mirror feature-file breakpoints into them.
      const workingDir = this.getWorkingDirectory(options.filePath);
      const preRunFailure = await this.runPreRunHook(workingDir, options.signal, options.progress);
      if (preRunFailure) {
        if (preRunFailure.terminationFailure) {
          return preRunFailure.terminationLease ?? terminationLease({
            kind: "debug-session",
            failure: preRunFailure.terminationFailure,
          });
        }
        if (options.signal?.aborted) {return undefined;}
        throw new Error(preRunFailure.failure);
      }
      if (options.signal?.aborted) {return undefined;}
      const { bddgenCommand } = this.commandBuilder().buildDebugCommandParts(options);

      if (bddgenCommand !== undefined) {
        const result = await this.shellRunner(
          bddgenCommand,
          workingDir,
          undefined,
          options.signal,
          options.progress?.onOutput
        );
        // A cancelled bddgen reports failure like any other non-zero exit; stopping is not an error.
        if (result.terminationFailure) {
          return result.terminationLease ?? terminationLease({
            kind: "debug-session",
            failure: result.terminationFailure,
          });
        }
        if (options.signal?.aborted) {return undefined;}
        if (!result.success) {
          const detail = result.error.trim() === "" ? result.output : result.error;
          throw new Error(`bddgen failed (exit code ${result.returnCode}): ${detail}`);
        }
      }
      if (bddgenCommand === undefined && this.needsFreshGeneratedSpecs(options, workingDir)) {
        throw new Error(generationRequiredFailure());
      }

      const specPaths = this.resolveSpecPaths(workingDir, options.filePath);
      if (specPaths.length === 0) {
        throw new Error(missingGeneratedSpecsFailure(options.filePath, "launched"));
      }
      mirrorId = this.mirror.mirrorBreakpoints(options.filePath, specPaths);

      // Resolve the precise spec target from the freshly generated spec (bddgen just ran), so a
      // single Scenario Outline row debugs exactly one test instead of grepping its title. The
      // same exact-target contract as a run: a plain scenario whose line cannot be recovered
      // refuses instead of debugging every title match, and every grep shape (whole outline,
      // whole feature) is scoped to this feature's generated spec by positional filter.
      const enriched = this.withSpecLineTargets(options, specPaths);
      if (
        enriched.specLineTargets === undefined &&
        options.scenarioName !== undefined &&
        options.outlineName === undefined
      ) {
        const at = options.lineNumber ? `:${options.lineNumber}` : "";
        throw new Error(
          `Could not resolve the exact test at ${options.filePath}${at}: a name grep for ` +
            `"${options.scenarioName}" would debug every match. No broader target was launched.`
        );
      }
      const { playwrightCommand } = this.commandBuilder().buildDebugCommandParts(
        enriched.specLineTargets !== undefined
          ? enriched
          : { ...enriched, specFileFilters: specPaths.map((specPath) =>
            toPathFilterRegex(workingDir, specPath)) }
      );

      const folder =
        this.workspace.workspaceFolders?.find((f) => isSameOrInsideDir(workingDir, f.uri.fsPath)) ??
        this.workspace.workspaceFolders?.[0];

      // Cancelled before launch: nothing will ever terminate, so release the mirror here.
      if (options.signal?.aborted) {
        this.mirror.release(mirrorId);
        return undefined;
      }

      const debugCommand = this.commandResolver(playwrightCommand, workingDir);
      const started = await this.debug.startDebugging(folder, {
        type: "node",
        request: "launch",
        name: "Debug Playwright-BDD Scenario",
        runtimeExecutable: debugCommand.executable,
        runtimeArgs: [...debugCommand.args],
        console: "integratedTerminal",
        autoAttachChildProcesses: true,
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
        return await this.waitForDebugCompletion(
          mirrorId,
          options.jsonReportPath,
          options.signal
        );
      }
      return undefined;
    } catch (error) {
      // No session will ever terminate for a failed launch, so the mirror must be released
      // here or the mirrored breakpoints leak until deactivation.
      if (mirrorId !== undefined) {
        this.mirror.release(mirrorId);
      }
      throw error;
    }
  }

  public async runScenarioWithOutput(
    options: TestExecutionOptions,
    artifactTarget?: ArtifactCaptureTarget
  ): Promise<RunOutputResult> {
    const start = Date.now();
    const workingDir = this.getWorkingDirectory(options.filePath);
    const signal = options.signal;
    const preRunFailure = await this.runPreRunHook(workingDir, signal, options.progress);
    if (preRunFailure) {
      if (signal?.aborted) {
        return this.cancelledResult(
          start,
          undefined,
          [],
          "",
          false,
          preRunFailure.terminationFailure,
          preRunFailure.terminationLease
        );
      }
      this.contributeArtifactShard(
        options.artifactBatch,
        workingDir,
        this.config.preRunCommand || "pre-run hook",
        false,
        1,
        [],
        artifactTarget
      );
      return infrastructureResult(
        start,
        preRunFailure.failure,
        "",
        false,
        preRunFailure.terminationFailure !== undefined,
        preRunFailure.terminationLease
      );
    }

    // Run bddgen first so the generated pickleLine→pwTestLine map is fresh before resolving an
    // exact spec target. A delegated, untagged run resolves from the existing generated spec.
    const { bddgenCommand } = this.commandBuilder().buildScenarioCommandParts(options);
    if (bddgenCommand !== undefined) {
      try {
        const gen = this.withBinaryHint(
          await this.shellRunner(
            bddgenCommand,
            workingDir,
            undefined,
            signal,
            options.progress?.onOutput
          ),
          bddgenCommand
        );
        if (signal?.aborted) {
          return this.cancelledResult(
            start,
            undefined,
            [],
            gen.output,
            gen.outputStreamed,
            gen.terminationFailure,
            gen.terminationLease
          );
        }
        this.publishBddgenDiagnostics(gen, workingDir);
        if (!gen.success) {
          this.contributeArtifactShard(
            options.artifactBatch,
            workingDir,
            bddgenCommand,
            false,
            gen.returnCode,
            [],
            artifactTarget
          );
          const detail = gen.error.trim() === "" ? gen.output : gen.error;
          return infrastructureResult(
            start,
            `bddgen failed (exit code ${gen.returnCode}): ${detail}`,
            gen.output,
            gen.outputStreamed,
            gen.terminationFailure !== undefined,
            gen.terminationLease
          );
        }
      } catch (error) {
        if (signal?.aborted) { return this.cancelledResult(start); }
        this.contributeArtifactShard(
          options.artifactBatch,
          workingDir,
          bddgenCommand,
          false,
          1,
          [],
          artifactTarget
        );
        return infrastructureResult(start, errMsg(error));
      }
    }
    if (bddgenCommand === undefined && this.needsFreshGeneratedSpecs(options, workingDir)) {
      this.contributeArtifactShard(
        options.artifactBatch,
        workingDir,
        "exact scenario target resolution",
        false,
        1,
        [],
        artifactTarget
      );
      return infrastructureResult(start, generationRequiredFailure());
    }

    let enriched: TestExecutionOptions;
    try {
      enriched = this.withSpecLineTargets(options);
      // A run may proceed without an exact spec line only as a whole outline (title, no line),
      // whose grep intentionally covers every row. A plain scenario names one exact test even when
      // its line is stale or missing (the parse-miss line-0 shape), and its name grep would search
      // the whole suite; no exact identity, no execution. Debug keeps its own name fallback:
      // buildDebugCommandParts narrows by title under the debugger the user is driving.
      if (
        enriched.specLineTargets === undefined &&
        options.scenarioName !== undefined &&
        options.outlineName === undefined
      ) {
        const at = options.lineNumber ? `:${options.lineNumber}` : "";
        throw new Error(
          `Could not resolve the exact test at ${options.filePath}${at}: a name grep for ` +
            `"${options.scenarioName}" would search the whole suite. No broader target was executed.`
        );
      }
      // The whole-outline title grep intentionally covers every row of THIS outline, but unscoped
      // it also runs a same-titled outline in another feature file. The generated spec positional
      // pins it to its own feature; a feature that cannot map to a spec has no runnable identity.
      if (enriched.specLineTargets === undefined && options.outlineName !== undefined) {
        const specPaths = this.resolveSpecPaths(workingDir, options.filePath);
        if (specPaths.length === 0) {
          throw new Error(missingGeneratedSpecsFailure(options.filePath, "executed"));
        }
        enriched = {
          ...enriched,
          specFileFilters: specPaths.map((specPath) => toPathFilterRegex(workingDir, specPath)),
        };
      }
    } catch (error) {
      const failure = errMsg(error);
      this.contributeArtifactShard(
        options.artifactBatch,
        workingDir,
        "exact scenario target resolution",
        false,
        1,
        [],
        artifactTarget
      );
      return infrastructureResult(start, failure);
    }
    let attempt = await this.runScenarioPlaywright(enriched, workingDir, start, signal, options.progress);

    // A generated line can drift between resolution and Playwright collecting the spec. Refresh
    // generation, resolve the same source row again, and retry only that exact line. A title grep
    // is not a safe fallback: for an outline row it runs every sibling, and for a plain scenario it
    // can match a joined Feature/Rule/title chain the executor cannot prove unique.
    const specLineTargetWasAdded =
      enriched.specLineTargets !== undefined && options.specLineTargets === undefined;
    if (specLineTargetWasAdded && !signal?.aborted && !attempt.result.admissionUnsafe && foundNoTests(attempt.result)) {
      if (bddgenCommand === undefined) {
        this.contributeArtifactShard(
          options.artifactBatch,
          workingDir,
          attempt.command,
          false,
          attempt.exitCode,
          [],
          artifactTarget
        );
        return infrastructureResult(
          start,
          generationRequiredFailure(),
          attempt.result.output,
          attempt.result.outputStreamed
        );
      }
      this.logger.warn(
        `Playwright found no tests for the spec-line targets ${enriched.specLineTargets?.join(", ")}; ` +
          "regenerating and re-resolving the same source row."
      );
      const refreshCommand = bddgenCommand;
      const refreshed = this.withBinaryHint(
        await this.shellRunner(
          refreshCommand,
          workingDir,
          undefined,
          signal,
          options.progress?.onOutput
        ),
        refreshCommand
      );
      if (signal?.aborted) {
        return this.cancelledResult(
          start,
          undefined,
          [],
          refreshed.output,
          refreshed.outputStreamed,
          refreshed.terminationFailure,
          refreshed.terminationLease
        );
      }
      this.publishBddgenDiagnostics(refreshed, workingDir);
      if (!refreshed.success) {
        const detail = refreshed.error.trim() === "" ? refreshed.output : refreshed.error;
        this.contributeArtifactShard(
          options.artifactBatch,
          workingDir,
          refreshCommand,
          false,
          refreshed.returnCode,
          [],
          artifactTarget
        );
        return infrastructureResult(
          start,
          `bddgen failed while refreshing the exact target (exit code ${refreshed.returnCode}): ${detail}`,
          refreshed.output,
          refreshed.outputStreamed,
          refreshed.terminationFailure !== undefined,
          refreshed.terminationLease
        );
      }
      let refreshedTarget: TestExecutionOptions;
      try {
        refreshedTarget = this.withSpecLineTargets(options);
      } catch (error) {
        const failure =
          `Playwright found no tests for ${enriched.specLineTargets?.join(", ")}, and the exact source row ` +
          `could not be re-resolved: ${errMsg(error)}`;
        this.contributeArtifactShard(
          options.artifactBatch,
          workingDir,
          attempt.command,
          false,
          attempt.exitCode,
          [],
          artifactTarget
        );
        return infrastructureResult(
          start,
          failure,
          attempt.result.output,
          attempt.result.outputStreamed
        );
      }
      attempt = await this.runScenarioPlaywright(
        refreshedTarget,
        workingDir,
        start,
        signal,
        options.progress
      );
    }
    this.contributeArtifactShard(
      options.artifactBatch,
      workingDir,
      attempt.command,
      attempt.result.success,
      attempt.exitCode,
      attempt.result.scenarioDetails ?? [],
      artifactTarget
    );
    return attempt.result;
  }

  /** The playwright half of a scenario run: execute with a JSON report and map the outcome. */
  private async runScenarioPlaywright(
    options: TestExecutionOptions,
    workingDir: string,
    start: number,
    signal: AbortSignal | undefined,
    progress: RunProgressObserver | undefined
  ): Promise<ScenarioPlaywrightAttempt> {
    const { playwrightCommand } = this.commandBuilder().buildScenarioCommandParts(options);

    const command = this.config.useConfigReporters
      ? playwrightCommand
      : withJsonReporter(playwrightCommand);
    // Created inside the try so a tmpdir failure becomes a failed result, not a rejection.
    let report: TemporaryReport | undefined;
    let live: LiveRunHandle | undefined;

    try {
      report = this.createTemporaryReport();
      live = this.openLiveRun(report.livePath, progress, signal);
      let commandResult: CommandResult;
      try {
        commandResult = await this.shellRunner(
          command,
          workingDir,
          { PLAYWRIGHT_JSON_OUTPUT_NAME: report.jsonPath, ...(live?.env ?? {}) },
          signal,
          progress?.onOutput
        );
      } finally {
        live?.stream.finish();
      }
      const result = this.withBinaryHint(commandResult, command);
      if (signal?.aborted) {
        return {
          result: this.cancelledResult(
            start,
            workingDir,
            live?.recoverResults([]),
            result.output,
            result.outputStreamed,
            result.terminationFailure,
            result.terminationLease
          ),
          command,
          exitCode: result.returnCode,
        };
      }
      // Delegated generation errors surface with the Playwright result. publish() is a no-op on
      // other failures, so this is the one shared Problems-panel path.
      this.publishBddgenDiagnostics(result, workingDir);
      return {
        result: await this.buildOutputResult(
          result,
          report.jsonPath,
          workingDir,
          start,
          command,
          undefined, live, signal
        ),
        command,
        exitCode: result.returnCode,
      };
    } catch (error) {
      if (signal?.aborted) {
        return {
          result: this.cancelledResult(start, workingDir, live?.recoverResults([])),
          command,
          exitCode: 1,
        };
      }
      return {
        result: infrastructureResult(start, errMsg(error)),
        command,
        exitCode: 1,
      };
    } finally {
      report?.dispose();
    }
  }

  public async runAllTestsWithTagsOutput(
    tag: string,
    signal?: AbortSignal,
    artifactBatch?: number,
    progress?: RunProgressObserver
  ): Promise<RunOutputResult> {
    return this.runWithJsonReport(
      () => this.commandBuilder().buildTagCommandParts(tag),
      undefined,
      signal,
      artifactBatch,
      progress
    );
  }

  // Batch feature/folder/all-mapped scopes: run every generated spec matching a positional path filter,
  // capturing the shard into the open artifact. `target` is the source feature file or folder; the
  // working dir is resolved from it the same way as every run (the owning Playwright-config package,
  // monorepo-aware), and the filter is relativized against that dir so it matches the generated specs
  // even when the config lives in a subdirectory. Relativizing off the pre-canonical dir keeps the
  // drive-letter case aligned with `target`; the spawn cwd is canonicalized separately downstream.
  public async runPathFilterWithOutput(
    target: string,
    signal?: AbortSignal,
    artifactBatch?: number,
    progress?: RunProgressObserver,
    tagExpression?: string,
    titles?: readonly string[]
  ): Promise<RunOutputResult> {
    const pathFilter = toPathFilterRegex(this.resolveWorkingDirectory(target), target);
    return this.runWithJsonReport(
      () => this.commandBuilder().buildPathFilterCommandParts(pathFilter, tagExpression, titles),
      target,
      signal,
      artifactBatch,
      progress
    );
  }

  public async runSuiteWithOutput(
    signal?: AbortSignal,
    artifactBatch?: number,
    progress?: RunProgressObserver
  ): Promise<RunOutputResult> {
    return this.runWithJsonReport(
      () => this.commandBuilder().buildAllTestsCommandParts(),
      undefined,
      signal,
      artifactBatch,
      progress
    );
  }

  public async debugScenarioWithOutput(
    options: TestExecutionOptions,
    artifactTarget?: ArtifactCaptureTarget
  ): Promise<RunOutputResult> {
    const start = Date.now();
    const workingDir = this.getWorkingDirectory(options.filePath);
    const report = this.createTemporaryReport();
    try {
      const termination = await this.launchDebugScenario({
        ...options,
        waitForSessionEnd: true,
        jsonReportPath: report.jsonPath,
      });
      if (termination) {
        this.contributeArtifactShard(
          options.artifactBatch,
          workingDir,
          "playwright debug run",
          false,
          1,
          [],
          artifactTarget
        );
        return infrastructureResult(start, termination.failure, "", false, true, termination);
      }
      if (options.signal?.aborted) {
        return this.cancelledDebugResult(start, workingDir);
      }
      const reportEvidence = await this.readScenarioReport(report.jsonPath, "", options.signal);
      const details = reportEvidence.details;
      if (options.signal?.aborted) {
        return this.cancelledDebugResult(start, workingDir, details);
      }
      const infrastructureFailure = reportEvidence.complete
        ? details.length === 0
          ? "The debug session completed without a readable JSON report"
          : undefined
        : reportEvidence.failureKind === "unreadable"
          ? "The debug session completed without a readable JSON report"
          : reportEvidence.failure;
      const anyFailed = details.some((detail) => detail.status === "failed");
      this.context?.runResultStore?.ingest(
        this.playwrightJsonParser.toStatusMap(details, workingDir)
      );
      this.contributeArtifactShard(
        options.artifactBatch,
        workingDir,
        "playwright debug run",
        infrastructureFailure === undefined && !anyFailed,
        infrastructureFailure !== undefined || anyFailed ? 1 : 0,
        details,
        artifactTarget
      );
      return {
        success: infrastructureFailure === undefined && !anyFailed,
        output: "",
        ...(infrastructureFailure ? {
          error: infrastructureFailure,
          infrastructureFailure,
        } : {}),
        duration: Math.max(1, Date.now() - start),
        scenarioResults: this.playwrightJsonParser.toStatusMap(details, workingDir),
        scenarioDetails: details,
      };
    } catch (error) {
      if (options.signal?.aborted) {
        return this.cancelledDebugResult(start, workingDir);
      }
      this.contributeArtifactShard(
        options.artifactBatch,
        workingDir,
        "playwright debug run",
        false,
        1,
        [],
        artifactTarget
      );
      throw error;
    } finally {
      report.dispose();
    }
  }

  // A parse that completed before cancellation remains useful evidence. Cancellation never starts
  // replacement report I/O after the admitted parse has stopped.
  private cancelledDebugResult(
    start: number,
    workingDir: string,
    details: ScenarioResult[] = []
  ): RunOutputResult {
    if (details.length > 0) {
      this.context?.runResultStore?.ingest(
        this.playwrightJsonParser.toStatusMap(details, workingDir)
      );
    }
    return this.cancelledResult(start, workingDir, details);
  }

  public async dispose(): Promise<void> {
    const results = await this.mirror.shutdown();
    for (const result of results) {
      if (!result.confirmed) {
        this.logger.error(result.failure);
      }
    }
  }

  /**
   * Enrich a line-bearing target with its precise generated-test line. A target without a source
   * line intentionally keeps the command builder's name path (for example, a whole outline). A
   * line-bearing target must never widen to that path when exact resolution fails.
   */
  private withSpecLineTargets(
    options: TestExecutionOptions,
    specPaths?: readonly string[]
  ): TestExecutionOptions {
    if (options.specLineTargets !== undefined) {
      return options;
    }
    const resolution = this.resolveSpecLineTargets(options.filePath, options.lineNumber, specPaths);
    if ("targets" in resolution) {
      return { ...options, specLineTargets: resolution.targets };
    }
    if (
      options.lineNumber !== undefined &&
      options.lineNumber > 0 &&
      (options.scenarioName !== undefined || options.outlineName !== undefined)
    ) {
      throw new Error(
        `Could not resolve the exact test at ${options.filePath}:${options.lineNumber}: ${resolution.reason}. ` +
          "No broader target was executed."
      );
    }
    return options;
  }

  private resolveSpecPaths(workingDir: string, filePath: string): string[] {
    const resolution = verifiedGeneratedSpecPaths(
      workingDir,
      this.config.featuresGenDir,
      filePath
    );
    if ("reason" in resolution) {
      throw new Error(
        `Could not use generated specs for ${filePath}: ${resolution.reason}. ` +
          "No broader target was executed."
      );
    }
    return resolution.paths;
  }

  private needsFreshGeneratedSpecs(
    options: TestExecutionOptions,
    workingDir: string
  ): boolean {
    return needsGeneratedSpecs(
      workingDir,
      this.config.featuresGenDir,
      options.filePath,
      options.lineNumber,
      options.outlineName,
      options.scenarioName,
      options.specLineTargets !== undefined
    );
  }

  private resolveSpecLineTargets(
    filePath: string,
    lineNumber?: number,
    specPathArgs?: readonly string[]
  ): { targets: string[] } | { reason: string } {
    const workingDir = this.getWorkingDirectory(filePath);
    return exactGeneratedTargets(
      workingDir,
      this.config.featuresGenDir,
      filePath,
      lineNumber,
      specPathArgs === undefined ? undefined : [...specPathArgs]
    );
  }

  private async runWithJsonReport(
    buildCommand: () => { bddgenCommand: string | undefined; playwrightCommand: string },
    forFile?: string,
    signal?: AbortSignal,
    artifactBatch?: number,
    progress?: RunProgressObserver
  ): Promise<RunOutputResult> {
    const start = Date.now();
    const workingDir = this.getWorkingDirectory(forFile);


    const preRunFailure = await this.runPreRunHook(workingDir, signal, progress);
    if (preRunFailure) {
      if (signal?.aborted) {
        return this.cancelledResult(
          start,
          undefined,
          [],
          "",
          false,
          preRunFailure.terminationFailure,
          preRunFailure.terminationLease
        );
      }
      this.contributeArtifactShard(
        artifactBatch,
        workingDir,
        this.config.preRunCommand || "pre-run hook",
        false,
        1,
        []
      );
      return infrastructureResult(
        start,
        preRunFailure.failure,
        "",
        false,
        preRunFailure.terminationFailure !== undefined,
        preRunFailure.terminationLease
      );
    }

    const commands = buildCommand();
    if (commands.bddgenCommand !== undefined) {
      const generation = this.withBinaryHint(
        await this.shellRunner(
          commands.bddgenCommand,
          workingDir,
          undefined,
          signal,
          progress?.onOutput
        ),
        commands.bddgenCommand
      );
      this.publishBddgenDiagnostics(generation, workingDir);
      if (!generation.success) {
        if (signal?.aborted) {
          return this.cancelledResult(
            start,
            workingDir,
            [],
            generation.output,
            generation.outputStreamed,
            generation.terminationFailure,
            generation.terminationLease
          );
        }
        const failure = generation.error.trim() === "" ? generation.output : generation.error;
        return infrastructureResult(
          start,
          failure,
          generation.output,
          generation.outputStreamed,
          generation.terminationFailure !== undefined,
          generation.terminationLease
        );
      }
    }
    const baseCommand = commands.playwrightCommand;
    // Normally we force `--reporter=json` for result mapping. With useConfigReporters the user's
    // config owns the reporter list (so a custom reporter survives); a `--reporter` here would
    // override it. We still set PLAYWRIGHT_JSON_OUTPUT_NAME below, which steers a bare `['json']`
    // reporter in their config to our temp file.
    const command = this.config.useConfigReporters ? baseCommand : withJsonReporter(baseCommand);
    // Created inside the try so a tmpdir failure becomes a failed result, not a rejection.
    let report: TemporaryReport | undefined;
    let live: LiveRunHandle | undefined;

    try {
      report = this.createTemporaryReport();
      live = this.openLiveRun(report.livePath, progress, signal);
      let commandResult: CommandResult;
      try {
        commandResult = await this.shellRunner(
          command,
          workingDir,
          { PLAYWRIGHT_JSON_OUTPUT_NAME: report.jsonPath, ...(live?.env ?? {}) },
          signal,
          progress?.onOutput
        );
      } finally {
        live?.stream.finish();
      }
      const result = this.withBinaryHint(commandResult, command);
      if (signal?.aborted) {
        const cancelled = this.cancelledResult(
          start,
          workingDir,
          live?.recoverResults([]),
          result.output,
          result.outputStreamed,
          result.terminationFailure,
          result.terminationLease
        );
        this.contributeArtifactShard(
          artifactBatch,
          workingDir,
          command,
          false,
          result.returnCode,
          cancelled.scenarioDetails ?? []
        );
        return cancelled;
      }
      this.publishBddgenDiagnostics(result, workingDir);
      return await this.buildOutputResult(
        result,
        report.jsonPath,
        workingDir,
        start,
        command,
        artifactBatch, live, signal
      );
    } catch (error) {
      if (signal?.aborted) {
        const cancelled = this.cancelledResult(start, workingDir, live?.recoverResults([]));
        this.contributeArtifactShard(
          artifactBatch,
          workingDir,
          command,
          false,
          1,
          cancelled.scenarioDetails ?? []
        );
        return cancelled;
      }
      this.contributeArtifactShard(artifactBatch, workingDir, command, false, 1, []);
      return infrastructureResult(start, errMsg(error));
    } finally {
      report?.dispose();
    }
  }

  private createTemporaryReport(): TemporaryReport {
    return TemporaryReport.create((error) => {
      this.logger.warn(`Temporary Playwright report cleanup failed: ${error.message}`);
    });
  }

  /** Open the extension-owned reporter stream for one captured Playwright invocation. */
  private openLiveRun(
    liveReportPath: string,
    progress: RunProgressObserver | undefined,
    signal: AbortSignal | undefined
  ): LiveRunHandle | undefined {
    if (progress === undefined) {return undefined;}
    return openLiveRunSession({
      liveReportPath,
      reporterPath: path.join(__dirname, "specwright-live-reporter.js"),
      progress,
      signal,
      ...(progress.detailBudget ? { detailBudget: progress.detailBudget } : {}),
      onError: (error) => this.logger.warn(`Live test result stream failed: ${error.message}`),
    });
  }

  // A cancelled run is a deliberate stop, never a failure: the killed process exits non-zero,
  // but the result says Cancelled and the caller marks the affected items skipped.
  private cancelledResult(
    start: number,
    workingDir?: string,
    scenarioDetails: ScenarioResult[] = [],
    output = "",
    outputStreamed = false,
    terminationFailure?: string,
    lease?: TerminationLease
  ): RunOutputResult {
    return {
      success: false,
      output,
      error: terminationFailure ?? "Cancelled",
      duration: Math.max(1, Date.now() - start),
      ...(workingDir !== undefined && scenarioDetails.length > 0 ? {
        scenarioDetails,
        scenarioResults: this.playwrightJsonParser.toStatusMap(scenarioDetails, workingDir),
      } : {}),
      ...(outputStreamed ? { outputStreamed: true } : {}),
      ...(terminationFailure ? {
        infrastructureFailure: terminationFailure,
        admissionUnsafe: true,
      } : {}),
      ...(lease ? { terminationLease: lease } : {}),
    };
  }

  /**
   * A missing npx/playwright/bddgen binary differs by platform (ENOENT, exit 127, or a package
   * manager diagnostic). Detect those shapes and return an actionable hint naming the attempted
   * binary; undefined otherwise.
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
  // command-driven run). Every invocation contributes exactly once: success or spawn failure.
  private contributeArtifactShard(
    artifactBatch: number | undefined,
    workingDir: string,
    command: string,
    success: boolean,
    exitCode: number,
    details: ScenarioResult[],
    artifactTarget?: ArtifactCaptureTarget
  ): void {
    if (artifactBatch === undefined) { return; }
    const workspaceRoot = this.workspaceRootFor(workingDir);
    this.artifactSinks.get(artifactBatch)?.contributeShard(artifactBatch, {
      workingDir,
      command: this.commandSummary(command, workspaceRoot),
      success,
      exitCode,
      details: scopeArtifactDetails(details, artifactTarget, workingDir),
      workspaceRoot,
      invocation: artifactTarget?.scenario,
    });
  }

  // The workspace folder that owns this run (multi-root aware), mirroring the debug-launch cwd
  // resolution; a run under folder #2 must relativize evidence against folder #2, not the first.
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
  private async buildOutputResult(
    result: CommandResult,
    reportPath: string,
    workingDir: string,
    start: number,
    command: string,
    artifactBatch: number | undefined,
    live: LiveRunHandle | undefined,
    signal: AbortSignal | undefined,
    artifactTarget?: ArtifactCaptureTarget
  ): Promise<RunOutputResult> {
    const report = await this.readScenarioReport(reportPath, result.output, signal);
    const scenarioDetails = live?.recoverResults(report.details) ?? report.details;
    const hasAssertionFailure = scenarioDetails.some((detail) =>
      (detail.outcome ?? detail.status) !== "passed" && detail.status !== "skipped"
    );
    const infrastructureFailure = result.terminationFailure ?? (!report.complete
      ? report.reportReadFailure
        ? report.failure
        : report.failureKind === "unreadable" && result.error.trim() !== ""
        ? result.error
        : report.failure
      : !result.success && !hasAssertionFailure
        ? result.error || "The Playwright process failed after producing no assertion failure."
        : undefined);
    const success = result.success && infrastructureFailure === undefined;
    const scenarioResults = this.playwrightJsonParser.toStatusMap(scenarioDetails, workingDir);
    // Feed the badge store before the ephemeral report is gone: this is the extension-launched run
    // that leaves nothing on disk for the traceability panel to scan (§3.5).
    this.context?.runResultStore?.ingest(scenarioResults);
    // Same seam feeds the richer artifact store. The shard carries already-parsed details before
    // the enclosing temporary-report lifetime ends.
    this.contributeArtifactShard(
      artifactBatch,
      workingDir,
      command,
      success,
      result.returnCode,
      scenarioDetails,
      artifactTarget
    );
    return {
      success,
      output: result.output,
      error: infrastructureFailure ?? result.error,
      duration: Math.max(1, Date.now() - start),
      scenarioResults,
      scenarioDetails,
      ...(infrastructureFailure ? { infrastructureFailure } : {}),
      ...(result.outputStreamed ? { outputStreamed: true } : {}),
      ...(result.terminationFailure ? { admissionUnsafe: true } : {}),
      ...(result.terminationLease ? { terminationLease: result.terminationLease } : {}),
    };
  }

  /**
   * Resolve parsed scenario results from the run: prefer the JSON report file (written via
   * PLAYWRIGHT_JSON_OUTPUT_NAME), falling back to parsing stdout. With useConfigReporters the
   * report only appears if the user's config has a bare `['json']` reporter for the env var to
   * steer; no file + no parseable stdout almost always means that entry is missing, so we point
   * at the fix directly rather than letting it surface as a generic "out of scope" warning.
   */
  private async readScenarioReport(
    reportPath: string,
    output: string,
    signal?: AbortSignal
  ): Promise<PlaywrightReportEvidence & { readonly reportReadFailure?: true }> {
    let hasReport = false;
    try {
      await fs.promises.access(reportPath);
      hasReport = true;
    } catch { /* no report file; fall back to legacy JSON stdout */ }
    let report: PlaywrightReportEvidence & { readonly reportReadFailure?: true };
    try {
      report = hasReport
        ? await this.playwrightJsonParser.inspectFromFileAsync(reportPath, signal)
        : this.playwrightJsonParser.inspect(output);
    } catch (error) {
      if (signal?.aborted) {throw error;}
      report = {
        details: [],
        complete: false,
        failure: errMsg(error),
        failureKind: "unreadable",
        reportReadFailure: true,
      };
    }
    if (this.config.useConfigReporters && report.details.length === 0) {
      this.logger.warn(
        "useConfigReporters is on but no JSON report was produced. Add a bare ['json'] entry " +
          "(no outputFile) to the reporter array in your Playwright config so results can be mapped."
      );
    }
    return report;
  }

  /** Test hooks: shrink the debug watchdog timings so tests don't wait seconds. */
  public debugWatchdogPollMs = 1000;
  public debugWatchdogGraceMs = 5000;

  /**
   * Wait for the debug session to settle. Normally the mirror releases when the last
   * child debug session terminates. That chain can wedge; pnpm process trees leave a
   * debug-attached child (web server, extra node layer) alive, or no child session
   * ever attaches, so when a JSON report path is in play, watch for the report file:
   * Playwright writes it only AFTER the tests finish (a paused breakpoint delays it,
   * so the watchdog can never fire mid-debug). Once it appears, give natural teardown
   * a grace period, then force the session down.
   */
  private async waitForDebugCompletion(
    mirrorId: string,
    reportPath: string | undefined,
    signal?: AbortSignal
  ): Promise<TerminationLease | undefined> {
    let finished = false;
    const toLease = (result: Awaited<ReturnType<BreakpointMirror["forceStop"]>>): TerminationLease | undefined => (
      result.confirmed
        ? undefined
        : terminationLease({ kind: "debug-session", failure: result.failure })
    );
    const released = this.mirror.waitForRelease(mirrorId).then((result) => {
      finished = true;
      return toLease(result);
    });
    let force: Promise<TerminationLease | undefined> | undefined;
    const forceStop = (): Promise<TerminationLease | undefined> => {
      force ??= this.mirror.forceStop(mirrorId).then(toLease);
      return force;
    };
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<TerminationLease | undefined>((resolve) => {
      resolveAbort = () => {
        forceStop().then(resolve, (error) => resolve(terminationLease({
          kind: "debug-session",
          failure: `Debug-session termination failed: ${errMsg(error)}`,
        })));
      };
      signal?.addEventListener("abort", resolveAbort, { once: true });
      if (signal?.aborted) {resolveAbort();}
    });
    if (!reportPath) {
      try {return await Promise.race([released, aborted]);}
      finally {
        finished = true;
        if (resolveAbort) {signal?.removeEventListener("abort", resolveAbort);}
      }
    }

    const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const reportExists = async (): Promise<boolean> => {
      try {
        await fs.promises.access(reportPath);
        return true;
      } catch {
        return false;
      }
    };
    const watchdog = (async (): Promise<TerminationLease | undefined> => {
      while (true) {
        if (finished) {return undefined;}
        if (await reportExists()) {break;}
        if (finished) {return undefined;}
        await delay(this.debugWatchdogPollMs);
      }
      if (finished) {return undefined;}
      await delay(this.debugWatchdogGraceMs);
      if (finished) {return undefined;}
      this.logger.info(
        "Debug session did not settle after the JSON report was written; forcing teardown",
        { mirrorId, reportPath }
      );
      return forceStop();
    })();
    try {
      return await Promise.race([released, aborted, watchdog]);
    } finally {
      finished = true;
      if (resolveAbort) {signal?.removeEventListener("abort", resolveAbort);}
    }
  }

  private async runPreRunHook(
    workingDir: string,
    signal?: AbortSignal,
    progress?: RunProgressObserver
  ): Promise<{
    failure: string;
    terminationFailure?: string | undefined;
    terminationLease?: TerminationLease | undefined;
  } | undefined> {
    const command = this.config.preRunCommand.trim();
    if (command === "") { return undefined; }

    this.logger.info(`Running preRunCommand: ${command}`);
    const result = await this.shellRunner(
      command,
      workingDir,
      undefined,
      signal,
      progress?.onOutput,
      true
    );
    if (result.success) { return undefined; }

    const detail = result.error?.trim() === "" ? result.output : result.error;
    const base = `preRunCommand "${command}" failed with exit code ${result.returnCode}. Test run aborted.`;
    const hint = this.missingBinaryHint(result, command);
    const message = hint ? `${base}\n\n${hint}` : base;
    this.logger.error(message, { detail });
    this.logger.showOutput();
    return {
      failure: result.terminationFailure ?? message,
      ...(result.terminationFailure ? { terminationFailure: result.terminationFailure } : {}),
      ...(result.terminationLease ? { terminationLease: result.terminationLease } : {}),
    };
  }

  private commandBuilder() {
    if (!this.context?.commandBuilder) {
      throw new Error("TestExecutor used before context was injected. Call setContext() during activation.");
    }
    return this.context.commandBuilder;
  }

  private async spawnCommand(
    command: string,
    workingDir: string,
    extraEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    onOutput?: CommandOutputHandler,
    shell = false
  ): Promise<CommandResult> {
    return runBoundedCommand({
      command,
      workingDir,
      logger: this.logger,
      ...(extraEnv ? { extraEnv } : {}),
      ...(signal ? { signal } : {}),
      ...(onOutput ? { onOutput } : {}),
      ...(shell ? { shell: true } : {}),
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
   * `npx bddgen` resolves only when spawned from that package, not the repo root.
   */
  private getWorkingDirectory(forFile?: string): string {
    // Canonicalize the result so the spawn cwd has an uppercase Windows drive letter.
    // VS Code's `uri.fsPath` lowercases it, which makes playwright-bdd treat every feature
    // as "outside the features scope" on Windows (see canonicalCwd).
    return canonicalCwd(this.resolveWorkingDirectory(forFile));
  }

  /** The working directory a run of this feature would use; the anchor for generated-spec lookups. */
  public workingDirectoryFor(featureFsPath: string): string {
    return this.getWorkingDirectory(featureFsPath);
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
