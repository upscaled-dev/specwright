import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { EXECUTION_ALREADY_RUNNING } from "../core/execution-gateway";
import type { RunInitiator, RunIntent } from "../core/run-contracts";
import type { RunProgressSession } from "../core/run-progress";
import type { RunOutputResult } from "../core/test-executor";
import type {
  CommandArguments,
  ParsedFeature,
  PlaywrightBddExtensionContext,
} from "../types";
import { outlineNameForScenario } from "../parsers/feature-parser";
import { promptPaletteTags, resolvePaletteFeature, resolvePaletteScenario } from "./palette-target-resolver";
import { logCapturedRunOutput, runGatewayWithProgress } from "./captured-run-progress";
import { pathRunIntent, scenarioRunIntent, suiteRunIntent } from "./run-intent";
import { resolveWorkerCount } from "./prompt-worker-count";

/**
 * Commands wired into editor/explorer context menus are invoked by VS Code with a `vscode.Uri` as the
 * first argument; programmatic/CodeLens callers pass a string path. Normalize both to an fsPath so
 * downstream path operations don't receive a Uri object.
 */
export function commandArgFsPath(arg: unknown): string | undefined {
  if (typeof arg === "string") {return arg;}
  const fsPath = (arg as { fsPath?: unknown } | undefined)?.fsPath;
  return typeof fsPath === "string" ? fsPath : undefined;
}

interface ExternalRunProvider {
  applyExternalRunResult?: (
    filePath: string,
    result: RunOutputResult,
    target?: { lineNumber?: number }
  ) => void;
  beginExternalRun?: (
    filePath: string,
    target?: { lineNumber?: number }
  ) => RunProgressSession;
}

export class RunCommands {
  private readonly parsedFeatureCache = new Map<string, { mtimeMs: number; parsed: ParsedFeature }>();

  public constructor(
    private readonly context: PlaywrightBddExtensionContext,
    private readonly provider: () => unknown
  ) {}

  public async runScenario(...args: CommandArguments): Promise<void> {
    let [filePath, lineNumber, scenarioName] = args as [string | undefined, number | undefined, string | undefined];
    const initiatedBy: RunInitiator = filePath ? "code-lens" : "palette";
    let outlineName: string | undefined;
    if (!filePath) {
      const target = await resolvePaletteScenario(this.context);
      if (!target) {return;}
      ({ filePath, lineNumber, scenarioName, outlineName } = target);
    }
    await this.runCaptured(
      "Scenario",
      filePath,
      lineNumber,
      this.scenarioIntent(filePath, lineNumber, scenarioName, outlineName, "run", initiatedBy)
    );
  }

  public async runFeature(...args: CommandArguments): Promise<void> {
    let [filePath] = args as [string | undefined];
    const initiatedBy: RunInitiator = filePath ? "code-lens" : "palette";
    filePath ??= await resolvePaletteFeature(this.context);
    if (!filePath) {return;}
    await this.runCaptured(
      "Feature",
      filePath,
      undefined,
      pathRunIntent(filePath, "feature", "run", initiatedBy)
    );
  }

  public async runAllTests(): Promise<void> {
    this.context.logger.info("Running all playwright-bdd tests");
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const result = await runGatewayWithProgress(
      "Running all tests",
      undefined,
      this.context.executionGateway,
      suiteRunIntent("run", "palette"),
      this.context.playwrightJsonParser,
      root
    );
    this.finishGatewayRun("All tests", result);
  }

  public async debugScenario(...args: CommandArguments): Promise<void> {
    let [filePath, lineNumber, scenarioName] = args as [string | undefined, number | undefined, string | undefined];
    const initiatedBy: RunInitiator = filePath ? "code-lens" : "palette";
    let outlineName: string | undefined;
    if (!filePath) {
      const target = await resolvePaletteScenario(this.context);
      if (!target) {return;}
      ({ filePath, lineNumber, scenarioName, outlineName } = target);
    }
    this.context.logger.info(`Debugging scenario: ${scenarioName ?? "unnamed"}`, { filePath, lineNumber });
    await this.runCaptured(
      "Debug scenario",
      filePath,
      lineNumber,
      this.scenarioIntent(filePath, lineNumber, scenarioName, outlineName, "debug", initiatedBy)
    );
  }

  public async runFeatureWithTags(...args: CommandArguments): Promise<void> {
    let [filePath, tags] = args as [string | undefined, string | undefined];
    const initiatedBy: RunInitiator = filePath ? "code-lens" : "palette";
    if (!filePath) {
      filePath = await resolvePaletteFeature(this.context);
      if (!filePath) {return;}
      tags = await promptPaletteTags();
      if (tags === undefined) {return;}
    }
    if (!tags) {throw new Error("Tags are required");}
    await this.runCaptured(
      "Feature with tags",
      filePath,
      undefined,
      pathRunIntent(filePath, "feature", "run", initiatedBy, tags)
    );
  }

  public async runScenarioWithTags(...args: CommandArguments): Promise<void> {
    let [filePath, lineNumber, scenarioName, tags] = args as [string | undefined, number | undefined, string | undefined, string | undefined];
    const initiatedBy: RunInitiator = filePath ? "code-lens" : "palette";
    let outlineName: string | undefined;
    if (!filePath) {
      const target = await resolvePaletteScenario(this.context);
      if (!target) {return;}
      ({ filePath, lineNumber, scenarioName, outlineName } = target);
      tags = await promptPaletteTags();
      if (tags === undefined) {return;}
    }
    if (!tags) {throw new Error("Tags are required");}
    await this.runCaptured(
      "Scenario with tags",
      filePath,
      lineNumber,
      this.scenarioIntent(filePath, lineNumber, scenarioName, outlineName, "run", initiatedBy, tags)
    );
  }

  public async runAllTestsParallel(): Promise<void> {
    this.context.logger.info("Running all playwright-bdd tests in parallel");
    const files = await this.context.testExecutor.discoverFeatureFiles();
    if (files.length === 0) {
      await vscode.window.showWarningMessage("No feature files found to run");
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const result = await runGatewayWithProgress(
      "Running all tests in parallel",
      undefined,
      this.context.executionGateway,
      suiteRunIntent(
        "run",
        "palette",
        resolveWorkerCount(this.context.config, this.context.logger)
      ),
      this.context.playwrightJsonParser,
      root
    );
    this.finishGatewayRun("All tests in parallel", result);
  }

  public async runScenarioWithContext(...args: CommandArguments): Promise<void> {
    const filePath = commandArgFsPath(args[0]);
    if (!filePath) {throw new Error("File path is required");}
    const lineNumber = typeof args[1] === "number" ? args[1] : undefined;
    const scenarioName = typeof args[2] === "string" ? args[2] : undefined;

    await this.runCaptured(
      "Scenario with context",
      filePath,
      lineNumber,
      this.scenarioIntent(
        filePath,
        lineNumber,
        scenarioName,
        undefined,
        "run",
        this.contextInitiator(filePath)
      )
    );
  }

  public async debugScenarioWithContext(...args: CommandArguments): Promise<void> {
    const filePath = commandArgFsPath(args[0]);
    if (!filePath) {throw new Error("File path is required");}
    const lineNumber = typeof args[1] === "number" ? args[1] : undefined;
    const scenarioName = typeof args[2] === "string" ? args[2] : undefined;
    await this.runCaptured(
      "Debug scenario",
      filePath,
      lineNumber,
      this.scenarioIntent(
        filePath,
        lineNumber,
        scenarioName,
        undefined,
        "debug",
        this.contextInitiator(filePath)
      )
    );
  }

  public async runFeatureWithContext(...args: CommandArguments): Promise<void> {
    const filePath = commandArgFsPath(args[0]);
    if (!filePath) {throw new Error("File path is required");}
    await this.runCaptured(
      "Feature with context",
      filePath,
      undefined,
      pathRunIntent(filePath, "feature", "run", this.contextInitiator(filePath))
    );
  }

  private async runCaptured(
    label: string,
    filePath: string,
    lineNumber: number | undefined,
    intent: RunIntent
  ): Promise<void> {
    // Opening the Test Explorer run first would mark the scenario skipped in the tree before the
    // gateway ever refused the second run.
    if (this.context.executionGateway.running) {
      await vscode.window.showWarningMessage(EXECUTION_ALREADY_RUNNING);
      return;
    }
    const provider = this.provider() as ExternalRunProvider | undefined;
    const target = lineNumber === undefined ? undefined : { lineNumber };
    const session = provider?.beginExternalRun?.(filePath, target);
    const title = `Running ${label.toLowerCase()}: ${path.basename(filePath)}`;
    const result = await runGatewayWithProgress(
      title,
      session,
      this.context.executionGateway,
      intent,
      this.context.playwrightJsonParser,
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath ?? path.dirname(filePath)
    );
    if (!session && result.error !== "Cancelled") {
      provider?.applyExternalRunResult?.(filePath, result, lineNumber === undefined ? undefined : { lineNumber });
    }
    this.finishGatewayRun(label, result);
  }

  private finishGatewayRun(label: string, result: RunOutputResult): void {
    this.logResult(label, result);
    if (!result.success && result.error !== "Cancelled") {
      throw new Error(`Test failed: ${result.error ?? "Unknown error"}`);
    }
  }

  private logResult(label: string, result: RunOutputResult): void {
    if (result.error === "Cancelled") {
      this.context.logger.info(`${label} cancelled`, { duration: result.duration });
      logCapturedRunOutput(this.context.logger, label, result.output);
      return;
    }
    if (result.success) {
      this.context.logger.info(`${label} completed`, { duration: result.duration, outputLength: result.output.length });
    } else {
      this.context.logger.error(`${label} failed`, { error: result.error, duration: result.duration });
    }
    logCapturedRunOutput(this.context.logger, label, result.output, result.error);
  }

  private contextInitiator(filePath: string): RunInitiator {
    return vscode.window.activeTextEditor?.document.uri.fsPath === filePath ? "editor" : "explorer";
  }

  // One parse per invocation feeds both the outline lookup and the scenario ref the intent carries.
  private scenarioIntent(
    filePath: string,
    lineNumber: number | undefined,
    scenarioName: string | undefined,
    outlineName: string | undefined,
    mode: RunIntent["mode"],
    initiatedBy: RunInitiator,
    tagExpression?: string
  ): RunIntent {
    if (lineNumber === undefined && outlineName === undefined) {
      return pathRunIntent(filePath, "feature", mode, initiatedBy, tagExpression);
    }
    const parsed = this.getParsedFeature(filePath);
    return scenarioRunIntent(
      parsed,
      filePath,
      lineNumber,
      scenarioName,
      outlineName ?? outlineNameForScenario(parsed, lineNumber, scenarioName),
      mode,
      initiatedBy,
      tagExpression
    );
  }

  private getParsedFeature(filePath: string): ParsedFeature | undefined {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return undefined;
    }
    const cached = this.parsedFeatureCache.get(filePath);
    if (cached?.mtimeMs === stat.mtimeMs) {return cached.parsed;}
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = this.context.featureParser.parseFeatureContent(content);
      if (!parsed) {return undefined;}
      this.parsedFeatureCache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
      return parsed;
    } catch {
      return undefined;
    }
  }
}
