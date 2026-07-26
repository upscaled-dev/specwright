import * as path from "node:path";
import { TestExecutionOptions, FeatureExecutionOptions } from "../types";
import { ExtensionConfig } from "./extension-config";
import { resolveWorkerCount } from "../commands/prompt-worker-count";
import { shellQuote } from "../utils/shell";
import { Logger } from "../utils/logger";

// Callers sometimes pass "" for an unknown scenario/outline name; treating it as a real name
// would emit --grep "" and run the entire suite.
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

/**
 * Builds shell commands to drive playwright-bdd.
 *
 * playwright-bdd's flow:
 *   1. `bddgen` reads .feature files and emits Playwright spec files under .features-gen/ (configurable).
 *   2. `playwright test` runs those generated specs.
 *
 * Newer versions can run codegen automatically via `defineBddProject` in playwright.config.ts,
 * in which case `bddgen` is unnecessary; set `playwrightBddRunner.bddgenCommand` to an empty
 * string to skip it.
 *
 * Targeting:
 *   - Tags     → `bddgen --tags "<expr>"` (filters which specs get generated)
 *   - Scenario → `playwright test --grep "<name>"`
 *   - Feature  → `playwright test --grep "<feature name>"` (or by generated spec path if known)
 *
 * Playwright-bdd does not support line-number selection the way behave does, so we fall back to
 * matching by scenario name via --grep. The line number is informational only.
 */
export class CommandBuilder {
  private forceParallel = false;
  private forceParallelWorkers: number | undefined;
  private _lastForcedWorkers: number | undefined;

  constructor(
    private readonly config: ExtensionConfig,
    private readonly logger: Logger
  ) {}

  public static create(config: ExtensionConfig, logger: Logger): CommandBuilder {
    return new CommandBuilder(config, logger);
  }

  public setForceParallel(value: boolean, workers?: number): void {
    this.forceParallel = value;
    this.forceParallelWorkers = value ? workers : undefined;
    if (value) {
      this._lastForcedWorkers = workers;
    }
  }

  public isForceParallel(): boolean {
    return this.forceParallel;
  }

  public get lastForcedWorkers(): number | undefined {
    return this._lastForcedWorkers;
  }

  public buildScenarioCommand(options: TestExecutionOptions): string {
    const parts: string[] = [];
    const gen = this.buildBddgen(options.tags);
    if (gen) {parts.push(gen);}
    parts.push(this.buildPlaywright(options, /*greppedByName*/ true));
    return parts.join(" && ");
  }

  /**
   * Same as {@link buildScenarioCommand} but split into its bddgen and playwright halves, so the
   * executor can run bddgen FIRST and then resolve a precise `<spec>:<pwTestLine>` target from the
   * freshly generated spec before running playwright (mirrors {@link buildDebugCommandParts}).
   * `bddgenCommand` is undefined when bddgen is disabled (empty config) or generation is delegated
   * to `defineBddProject`.
   */
  public buildScenarioCommandParts(
    options: TestExecutionOptions
  ): { bddgenCommand: string | undefined; playwrightCommand: string } {
    return {
      bddgenCommand: this.buildBddgen(options.tags),
      playwrightCommand: this.buildPlaywright(options, /*greppedByName*/ true),
    };
  }

  public buildFeatureCommand(options: FeatureExecutionOptions): string {
    const parts: string[] = [];
    const gen = this.buildBddgen(options.tags);
    if (gen) {parts.push(gen);}

    const playwrightParts: string[] = [this.config.playwrightCommand];

    // Prefer grepping by the Feature title: playwright-bdd names the generated `describe` after
    // it, so the title appears verbatim in Playwright's grep target. This is far more precise
    // than the filename basename, which matched unrelated features whose titles merely contained
    // the filename (file `sample.feature` matched the "Sample feature" of another file). We keep
    // it unanchored because Playwright's grep target may be prefixed by the spec file path; an
    // `^` anchor would then match nothing. Basename stays as a last-resort fallback.
    const grep = options.featureName
      ? this.gripPattern(options.featureName)
      : this.gripPattern(path.basename(options.filePath).replace(/\.feature$/, ""));
    if (grep) {playwrightParts.push("--grep", this.quote(grep));}

    this.appendCommonFlags(playwrightParts, {
      reporter: options.reporter,
      parallel: this.config.parallelExecution,
      dryRun: options.dryRun ?? this.config.dryRun,
    });

    parts.push(playwrightParts.join(" "));
    return parts.join(" && ");
  }

  /**
   * Run every generated spec whose path matches a positional filter. Playwright treats the filter as
   * a regular expression, so the caller passes an already forward-slashed, regex-escaped path (see
   * `resolveBatchSelection`); a Windows-separator path would read as regex poison and match nothing
   * (the v0.3.9 gotcha). Used by the batch feature/folder scopes.
   */
  public buildPathFilterCommand(pathFilter: string): string {
    const parts: string[] = [];
    const gen = this.buildBddgen(undefined);
    if (gen) {parts.push(gen);}
    const playwrightParts: string[] = [this.config.playwrightCommand, this.quote(pathFilter)];
    this.appendCommonFlags(playwrightParts, {
      reporter: this.config.reporter,
      parallel: this.config.parallelExecution,
      dryRun: this.config.dryRun,
    });
    parts.push(playwrightParts.join(" "));
    return parts.join(" && ");
  }

  public buildTagCommand(tag: string): string {
    const parts: string[] = [];
    const gen = this.buildBddgen(tag);
    if (gen) {parts.push(gen);}
    const playwrightParts: string[] = [this.config.playwrightCommand];
    this.appendCommonFlags(playwrightParts, {
      reporter: this.config.reporter,
      parallel: this.config.parallelExecution,
      dryRun: this.config.dryRun,
    });
    parts.push(playwrightParts.join(" "));
    return parts.join(" && ");
  }

  /**
   * Run several scenarios in one bddgen+playwright pass via a combined `--grep` regex; the batch
   * all-mapped collapse. Each name is regex-escaped (and its outline `<placeholders>` wildcarded) the
   * same way {@link buildScenarioCommand} escapes a single grep, then OR-joined. Stays UNANCHORED
   * like every other grep here: Playwright's grep target is `path › describes › title › @tags`
   * joined, so a `^`/`$` anchor would fail on the path prefix / appended tags and match nothing.
   */
  public buildGrepCommand(names: readonly string[]): string {
    const parts: string[] = [];
    const gen = this.buildBddgen(undefined);
    if (gen) {parts.push(gen);}
    const pattern = names.map((name) => this.gripPattern(name)).join("|");
    const playwrightParts: string[] = [this.config.playwrightCommand, "--grep", this.quote(pattern)];
    this.appendCommonFlags(playwrightParts, {
      reporter: this.config.reporter,
      parallel: this.config.parallelExecution,
      dryRun: this.config.dryRun,
    });
    parts.push(playwrightParts.join(" "));
    return parts.join(" && ");
  }

  /**
   * Debug command, split into its bddgen and playwright halves. The executor runs bddgen
   * itself (so the generated specs exist before breakpoints are mirrored into them) and then
   * launches ONLY the playwright half under VS Code's JS debugger via a `node-terminal`
   * configuration, so breakpoints in step-definition files are hit. We do NOT add Playwright's
   * `--debug` flag here; that opens the Playwright Inspector and pauses there instead of in
   * VS Code.
   */
  public buildDebugCommandParts(
    options: TestExecutionOptions
  ): { bddgenCommand: string | undefined; playwrightCommand: string } {
    const bddgenCommand = this.buildBddgen(options.tags);

    const playwrightParts: string[] = [this.config.playwrightCommand];
    if (options.specLineTarget) {
      // Preferred: target the exact generated test by `<spec>:<pwTestLine>`. This is the only way
      // to debug a single Scenario Outline example row (grep on the source title can't isolate one).
      playwrightParts.push(this.quote(options.specLineTarget));
    } else if (options.scenarioName) {
      playwrightParts.push("--grep", this.quote(this.gripPattern(options.scenarioName, options.outlineName)));
    } else {
      // No specific scenario (e.g. debugging a whole feature file): narrow to the feature's
      // generated spec by its basename, mirroring buildFeatureCommand.
      const base = path.basename(options.filePath).replace(/\.feature$/, "");
      if (base) {playwrightParts.push("--grep", this.quote(this.gripPattern(base)));}
    }
    if (options.jsonReportPath) {
      // The debugged run reports through PLAYWRIGHT_JSON_OUTPUT_NAME (file output); keep the
      // user-visible reporter alongside json so the terminal output stays legible.
      const reporter = this.config.reporter;
      const reporters = reporter ? `${reporter},json` : "json";
      playwrightParts.push(`--reporter=${reporters}`);
    }
    return { bddgenCommand, playwrightCommand: playwrightParts.join(" ") };
  }

  public buildAllTestsCommand(): string {
    const parts: string[] = [];
    const gen = this.buildBddgen(this.config.tags);
    if (gen) {parts.push(gen);}
    const playwrightParts: string[] = [this.config.playwrightCommand];
    this.appendCommonFlags(playwrightParts, {
      reporter: this.config.reporter,
      parallel: this.config.parallelExecution,
      dryRun: this.config.dryRun,
    });
    parts.push(playwrightParts.join(" "));
    return parts.join(" && ");
  }

  /**
   * Build the playwright test command for a single scenario; used by both run and debug paths.
   */
  private buildPlaywright(options: TestExecutionOptions, greppedByName: boolean): string {
    const parts: string[] = [this.config.playwrightCommand];

    // Grep by the scenario name, or, when targeting a whole Scenario Outline (the Test Explorer
    // outline node passes only `outlineName`), by the outline name, which matches every expanded
    // example row. Without this, an outline run with no scenarioName produced no `--grep` and ran
    // the entire suite.
    if (greppedByName && options.specLineTarget) {
      // Preferred: precise `<spec>:<pwTestLine>` target (see TestExecutionOptions.specLineTarget).
      // Falls through to name-grep below only when no spec line could be resolved.
      parts.push(this.quote(options.specLineTarget));
    } else {
      const grepName = nonEmpty(options.scenarioName) ?? nonEmpty(options.outlineName);
      if (greppedByName && grepName) {
        parts.push("--grep", this.quote(this.gripPattern(grepName, options.outlineName)));
      }
    }

    this.appendCommonFlags(parts, {
      reporter: options.reporter,
      parallel: this.config.parallelExecution,
      dryRun: options.dryRun ?? this.config.dryRun,
    });

    return parts.join(" ");
  }

  private buildBddgen(tagExpression?: string): string | undefined {
    const cmd = this.config.bddgenCommand.trim();
    if (!cmd) {return undefined;}
    const effective = tagExpression ?? this.config.tags;
    if (effective && effective.trim() !== "") {
      return `${cmd} --tags ${this.quote(effective)}`;
    }
    return cmd;
  }

  private appendCommonFlags(
    parts: string[],
    opts: { reporter?: string | undefined; parallel?: boolean | undefined; dryRun?: boolean | undefined }
  ): void {
    if (opts.dryRun) {parts.push("--list");}
    if (this.forceParallel) {
      const workers = this.forceParallelWorkers ?? resolveWorkerCount(this.config, this.logger);
      parts.push(`--workers=${workers}`);
    } else if (opts.parallel) {
      parts.push(`--workers=${resolveWorkerCount(this.config, this.logger)}`);
    }
    // When useConfigReporters is set, defer entirely to the reporters declared in the user's
    // Playwright config; injecting any `--reporter` here would override them (a CLI --reporter
    // replaces the config's reporter array), dropping their custom reporter.
    if (this.config.useConfigReporters) {
      return;
    }
    // Always emit the reporter explicitly (including the default `list`). When the executor
    // later appends `--reporter=json` for result mapping, Playwright keeps both reporters;
    // omitting `list` here would let `--reporter=json` clobber the implicit default and leave
    // stdout (and therefore the Test Explorer output panel) empty.
    const reporter = opts.reporter ?? this.config.reporter;
    if (reporter) {
      parts.push(`--reporter=${reporter}`);
    }
  }

  /**
   * Escape characters that have meaning in a Playwright --grep regex. When `outlineName` is
   * provided, we grep by the outline name verbatim so a single run targets every expanded row
   * of that outline.
   */
  private gripPattern(scenarioName: string, outlineName?: string): string {
    const base = nonEmpty(outlineName) ?? scenarioName;
    // Escape regex specials, THEN turn Gherkin `<placeholders>` into `.*` wildcards. playwright-bdd
    // expands an outline's example rows into tests whose titles have the placeholders substituted
    // (`<role>` → `admin`), so grepping the literal `<role>` only ever matched the parent describe,
    // and the `<`/`>` are redirection operators in cmd.exe / PowerShell, which mangled the command
    // on Windows and made the run find no tests at all. Wildcarding both fixes the match and drops
    // the shell-hostile characters. Order matters: escape first (placeholder names rarely contain
    // specials, but the surrounding text may), then substitute the (unescaped) `<...>` tokens.
    return base
      .replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll(/<[^>]*>/g, ".*");
  }

  private quote(value: string): string {
    return shellQuote(value);
  }
}
