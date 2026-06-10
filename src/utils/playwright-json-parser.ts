import * as fs from "fs";
import * as path from "path";
import { Logger } from "./logger";

/**
 * Status as exposed to consumers. Playwright also reports `timedOut` and `interrupted`,
 * which we collapse into `failed`. `flaky` is collapsed into `passed`.
 */
export type ScenarioStatus = "passed" | "failed" | "skipped";

const ANSI_PATTERN = new RegExp("\\u001b\\[[0-9;]*m", "g");

/** Strip ANSI color/style escape codes so error text is legible in plain-text panels. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Render a millisecond duration compactly, e.g. 850ms or 2.4s. */
function formatDuration(ms: number): string {
  if (ms < 1000) {return `${Math.round(ms)}ms`;}
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_ICON: Record<ScenarioStatus, string> = {
  passed: "✔",
  failed: "✘",
  skipped: "○",
};

// SGR escape codes — the VS Code "Test Results" panel renders these as colors.
// Written as backslash-u escapes (not raw ESC bytes) so editors/formatters can't destroy them.
const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  gray: "\u001b[90m",
};

function paint(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${ANSI.reset}`;
}

// A scenario that failed in any project is failed overall; skipped only counts
// when nothing ran it.
const STATUS_SEVERITY: Record<ScenarioStatus, number> = {
  passed: 0,
  skipped: 1,
  failed: 2,
};

export interface ScenarioResult {
  /** Absolute path to the .feature file when resolvable from annotations; otherwise the generated spec path. */
  featurePath: string;
  /** Line number in the .feature file when known. */
  lineNumber?: number | undefined;
  /** Scenario title as it appears in the .feature file. */
  scenarioName: string;
  status: ScenarioStatus;
  durationMs?: number | undefined;
  errorMessage?: string | undefined;
  /** Raw stack trace of the failure (paths intact so the Test Results panel can linkify them). */
  errorStack?: string | undefined;
  /** Enclosing Scenario Outline name, when this result is an outline example ("Example #N"). */
  outlineName?: string | undefined;
  /** Per-step outcomes (Gherkin steps, with outline values already substituted by the title). */
  steps?: StepResult[] | undefined;
}

/** A single Gherkin step within a scenario run. */
export interface StepResult {
  /** Step text with keyword, e.g. `Given I have a "hello" value`. */
  title: string;
  status: "passed" | "failed";
  durationMs?: number | undefined;
}

interface RawPlaywrightReport {
  config?: { rootDir?: string; configFile?: string };
  suites?: RawSuite[];
}

/** Where the generated specs live (`config.rootDir`) and the project root (`configFile` dir). */
interface ReportContext {
  rootDir?: string | undefined;
  baseDir?: string | undefined;
}

/** Parsed once per generated spec: the source .feature it came from and pwTestLine→featureLine. */
interface SpecSourceData {
  featurePath: string;
  lineMap: Map<number, number>;
}

interface RawSuite {
  title?: string;
  file?: string;
  suites?: RawSuite[];
  specs?: RawSpec[];
}

interface RawSpec {
  title?: string;
  file?: string;
  line?: number;
  tests?: RawTest[];
}

interface RawStep {
  title?: string;
  category?: string;
  duration?: number;
  error?: { message?: string; stack?: string };
  steps?: RawStep[];
}

interface RawResult {
  status?: string;
  duration?: number;
  error?: { message?: string; stack?: string };
  steps?: RawStep[];
}

interface RawTest {
  annotations?: Array<{ type?: string; description?: string }>;
  results?: RawResult[];
}

/** Matches a Gherkin step title so hook/fixture steps in the report can be filtered out. */
const GHERKIN_STEP = /^(Given|When|Then|And|But|\*)\s/;

/**
 * Parses the JSON reporter output that Playwright produces when run with `--reporter=json`.
 *
 * playwright-bdd emits an annotation on each generated test like:
 *   { type: "<feature_path>:<line>", description?: ... }
 * (the exact shape has varied across versions). We probe a few annotation flavors so this
 * stays resilient.
 */
export class PlaywrightJsonParser {
  /**
   * Cache of generated-spec source data, keyed by absolute spec path. `null` = unreadable.
   * Cleared per parse: bddgen rewrites the generated specs between runs, so the
   * pwTestLine→pickleLine maps go stale across reports.
   */
  private readonly specDataCache = new Map<string, SpecSourceData | null>();

  constructor(private readonly logger: Logger) {}

  public static create(logger: Logger): PlaywrightJsonParser {
    return new PlaywrightJsonParser(logger);
  }

  public parse(jsonText: string): ScenarioResult[] {
    this.specDataCache.clear();

    let raw: RawPlaywrightReport;
    try {
      raw = JSON.parse(jsonText) as RawPlaywrightReport;
    } catch (err) {
      this.logger.warn("Failed to parse Playwright JSON", { error: String(err) });
      return [];
    }

    const ctx: ReportContext = {
      rootDir: raw.config?.rootDir,
      baseDir: raw.config?.configFile ? path.dirname(raw.config.configFile) : raw.config?.rootDir,
    };

    const results: ScenarioResult[] = [];
    for (const suite of raw.suites ?? []) {
      this.walkSuite(suite, results, ctx);
    }
    return results;
  }

  public parseFromFile(jsonPath: string): ScenarioResult[] {
    try {
      const text = fs.readFileSync(jsonPath, "utf8");
      return this.parse(text);
    } catch (err) {
      this.logger.warn(`Could not read Playwright JSON report at ${jsonPath}`, {
        error: String(err),
      });
      return [];
    }
  }

  /**
   * Convenience: build a status lookup keyed by `featurePath:lineNumber` AND
   * `featurePath::scenarioName`, so callers can resolve either way. Each shape is emitted
   * with both the absolute path (relative report paths are resolved against `cwd`) and the
   * cwd-relative path, so consumers match regardless of how they normalize paths. When the
   * same scenario ran more than once (e.g. multi-project chromium+firefox), the worst
   * status wins: failed > skipped > passed.
   */
  public toStatusMap(
    results: ScenarioResult[],
    cwd?: string
  ): Record<string, ScenarioStatus> {
    const out: Record<string, ScenarioStatus> = {};
    const put = (key: string, status: ScenarioStatus): void => {
      const prev = out[key];
      if (prev === undefined || STATUS_SEVERITY[status] > STATUS_SEVERITY[prev]) {
        out[key] = status;
      }
    };
    for (const r of results) {
      const abs =
        !cwd || path.isAbsolute(r.featurePath) ? r.featurePath : path.resolve(cwd, r.featurePath);
      const rel = cwd ? path.relative(cwd, abs) : r.featurePath;
      for (const file of new Set([abs, rel])) {
        if (r.lineNumber) {
          put(`${file}:${r.lineNumber}`, r.status);
        }
        put(`${file}::${r.scenarioName}`, r.status);
      }
    }
    return out;
  }

  private walkSuite(suite: RawSuite, acc: ScenarioResult[], ctx: ReportContext): void {
    for (const spec of suite.specs ?? []) {
      this.recordSpec(spec, acc, ctx, suite.title);
    }
    for (const child of suite.suites ?? []) {
      this.walkSuite(child, acc, ctx);
    }
  }

  private recordSpec(
    spec: RawSpec,
    acc: ScenarioResult[],
    ctx: ReportContext,
    enclosingSuiteTitle?: string
  ): void {
    const scenarioName = spec.title?.trim() ?? "";
    if (!scenarioName) {return;}

    // playwright-bdd no longer emits a source annotation; instead the generated spec carries a
    // `bddFileData` map from spec line (`spec.line`) back to the .feature line. Resolving through
    // it is what lets outline examples (titled "Example #1" etc., with no annotation) map onto
    // the right .feature line so the Test Explorer status sticks. Annotation probing stays as a
    // fallback for older playwright-bdd versions that still emit it.
    const resolved = this.resolveSourceLocation(ctx, spec.file, spec.line);
    // Outline examples are titled "Example #N" and nested under a describe named after the
    // outline; capture that so the summary can show "Scenario Outline: <name> — Example #N".
    const outlineName =
      /^Example #\d+/.test(scenarioName) && enclosingSuiteTitle ? enclosingSuiteTitle : undefined;

    for (const test of spec.tests ?? []) {
      acc.push(this.buildResult(spec, test, scenarioName, resolved, outlineName));
    }
  }

  private buildResult(
    spec: RawSpec,
    test: RawTest,
    scenarioName: string,
    resolved: { featurePath: string; lineNumber?: number } | undefined,
    outlineName: string | undefined
  ): ScenarioResult {
    const annotation = this.extractSourceLocation(test);
    const featurePath = annotation?.featurePath ?? resolved?.featurePath ?? spec.file ?? "";
    const lineNumber = annotation?.lineNumber ?? resolved?.lineNumber;
    const lastResult = (test.results ?? []).at(-1);
    const steps = this.extractSteps(lastResult);
    const stack = lastResult?.error?.stack;

    return {
      scenarioName,
      status: this.aggregateStatus(test),
      featurePath,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(outlineName !== undefined ? { outlineName } : {}),
      ...(this.lastDuration(test) !== undefined ? { durationMs: this.lastDuration(test) } : {}),
      ...(this.lastError(test) !== undefined ? { errorMessage: this.lastError(test) } : {}),
      ...(stack !== undefined ? { errorStack: stripAnsi(stack) } : {}),
      ...(steps.length > 0 ? { steps } : {}),
    };
  }

  /** Collect the Gherkin steps (skipping hook/fixture steps) from a test result, in order. */
  private extractSteps(result: RawResult | undefined): StepResult[] {
    const out: StepResult[] = [];
    const walk = (steps: RawStep[] | undefined): void => {
      for (const step of steps ?? []) {
        if (typeof step.title === "string" && GHERKIN_STEP.test(step.title)) {
          out.push({
            title: step.title,
            status: step.error ? "failed" : "passed",
            ...(typeof step.duration === "number" ? { durationMs: step.duration } : {}),
          });
        } else {
          // Hook/fixture/wrapper step — descend to find the BDD steps nested inside.
          walk(step.steps);
        }
      }
    };
    walk(result?.steps);
    return out;
  }

  /**
   * Map a generated-spec line (`spec.line`, i.e. playwright-bdd's `pwTestLine`) back to the
   * source .feature path + line using the `bddFileData` block embedded in the generated spec.
   * Returns undefined when the report lacks `config.rootDir`, the spec can't be read, or the
   * line isn't in the map — callers then fall back to the spec path / annotation.
   */
  private resolveSourceLocation(
    ctx: ReportContext,
    specFileRel: string | undefined,
    pwTestLine: number | undefined
  ): { featurePath: string; lineNumber?: number } | undefined {
    if (!ctx.rootDir || !specFileRel) {return undefined;}
    const specAbs = path.join(ctx.rootDir, specFileRel);

    let data = this.specDataCache.get(specAbs);
    if (data === undefined) {
      data = this.loadSpecData(specAbs, ctx.baseDir ?? ctx.rootDir);
      this.specDataCache.set(specAbs, data);
    }
    if (!data) {return undefined;}

    const lineNumber = pwTestLine === undefined ? undefined : data.lineMap.get(pwTestLine);
    return { featurePath: data.featurePath, ...(lineNumber === undefined ? {} : { lineNumber }) };
  }

  private loadSpecData(specAbs: string, baseDir: string): SpecSourceData | null {
    let content: string;
    try {
      content = fs.readFileSync(specAbs, "utf8");
    } catch {
      return null;
    }
    const header = /Generated from:\s*(\S+\.feature)/.exec(content);
    if (!header?.[1]) {return null;}

    const featurePath = path.resolve(baseDir, header[1]);
    const lineMap = new Map<number, number>();
    const pairs = /"pwTestLine":(\d+),"pickleLine":(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = pairs.exec(content)) !== null) {
      lineMap.set(Number(match[1]), Number(match[2]));
    }
    return { featurePath, lineMap };
  }

  private aggregateStatus(test: RawTest): ScenarioStatus {
    const statuses = (test.results ?? []).map((r) => (r.status ?? "").toLowerCase());
    if (statuses.length === 0) {return "skipped";}
    if (statuses.includes("failed") || statuses.includes("timedout") || statuses.includes("interrupted")) {
      return "failed";
    }
    if (statuses.every((s) => s === "skipped")) {return "skipped";}
    return "passed";
  }

  private lastDuration(test: RawTest): number | undefined {
    const results = test.results ?? [];
    return results[results.length - 1]?.duration;
  }

  private lastError(test: RawTest): string | undefined {
    const message = (test.results ?? []).at(-1)?.error?.message;
    return message === undefined ? undefined : stripAnsi(message);
  }

  /**
   * Render parsed scenario results as a compact, human-readable summary for the Test Explorer's
   * "Test Results" output panel. Far more legible than the raw JSON reporter payload that the
   * `--reporter=json` run would otherwise dump there.
   */
  public formatResults(results: ScenarioResult[], workspaceRoot?: string): string {
    if (results.length === 0) {
      return "No scenarios were executed.";
    }

    const counts: Record<ScenarioStatus, number> = { passed: 0, failed: 0, skipped: 0 };
    let totalMs = 0;
    const lines: string[] = [];

    for (const r of results) {
      counts[r.status] += 1;
      if (typeof r.durationMs === "number") {totalMs += r.durationMs;}
      lines.push(...this.formatScenario(r, workspaceRoot));
    }

    const tally = [
      `${counts.passed} passed`,
      ...(counts.failed > 0 ? [`${counts.failed} failed`] : []),
      ...(counts.skipped > 0 ? [`${counts.skipped} skipped`] : []),
    ].join(", ");
    const total = formatDuration(totalMs);
    const scenarioWord = results.length === 1 ? "scenario" : "scenarios";

    const divider = "─".repeat(48);
    return [
      ...lines,
      divider,
      `${results.length} ${scenarioWord} · ${tally} · ${total}`,
    ].join("\n");
  }

  /** Dimmed `  (1.2s)` suffix, or empty string when no duration is known. */
  private dimDuration(ms: number | undefined): string {
    if (typeof ms !== "number") {return "";}
    const label = `(${formatDuration(ms)})`;
    return `  ${paint(label, ANSI.dim)}`;
  }

  private formatScenario(r: ScenarioResult, workspaceRoot?: string): string[] {
    const heading = r.outlineName
      ? `Scenario Outline: ${r.outlineName} — ${r.scenarioName}`
      : `Scenario: ${r.scenarioName}`;
    const out = [`${STATUS_ICON[r.status]} ${paint(heading, ANSI.bold)}${this.dimDuration(r.durationMs)}`];

    for (const step of r.steps ?? []) {
      out.push(this.formatStep(step));
    }

    if (r.status === "failed") {
      out.push(...this.formatFailureDetail(r, workspaceRoot));
    }
    return out;
  }

  /** A single Gherkin step line: green when passed, red when failed, with its duration. */
  private formatStep(step: StepResult): string {
    const color = step.status === "failed" ? ANSI.red : ANSI.green;
    const icon = step.status === "failed" ? STATUS_ICON.failed : STATUS_ICON.passed;
    const label = `${icon} ${step.title}`;
    return `    ${paint(label, color)}${this.dimDuration(step.durationMs)}`;
  }

  /**
   * Error block under a failed scenario: the .feature location, the (ANSI-stripped) message in
   * red, then the raw stack frames dimmed. Absolute `file:line:col` frames are left intact so the
   * Test Results panel turns them into clickable links to the failing step-definition code.
   */
  private formatFailureDetail(r: ScenarioResult, workspaceRoot?: string): string[] {
    const out: string[] = [];
    const location = this.formatLocation(r, workspaceRoot);
    if (location) {out.push(`      ${paint(location, ANSI.dim)}`);}

    if (r.errorMessage) {
      for (const line of r.errorMessage.trimEnd().split(/\r?\n/)) {
        out.push(`      ${paint(line, ANSI.red)}`);
      }
    }
    if (r.errorStack) {
      const frames = r.errorStack.split(/\r?\n/).filter((l) => /^\s*at\s/.test(l));
      for (const frame of frames) {
        out.push(`      ${paint(frame.trim(), ANSI.gray)}`);
      }
    }
    return out;
  }

  private formatLocation(r: ScenarioResult, workspaceRoot?: string): string {
    if (!r.featurePath) {return "";}
    // Relativize only when we have an absolute path inside the workspace; otherwise show the
    // basename so an unresolved/relative path never renders as a "../../.." chain.
    let file = r.featurePath;
    if (path.isAbsolute(r.featurePath) && workspaceRoot) {
      const rel = path.relative(workspaceRoot, r.featurePath);
      file = rel.startsWith("..") ? path.basename(r.featurePath) : rel;
    } else if (!path.isAbsolute(r.featurePath)) {
      file = path.basename(r.featurePath);
    }
    return r.lineNumber ? `${file}:${r.lineNumber}` : file;
  }

  /**
   * Look through annotations for one that encodes the original .feature path + line.
   * playwright-bdd writes annotations whose `type` contains the source location; the exact
   * shape varies, so we probe a few flavors:
   *   - { type: "/abs/feature.feature:12" }
   *   - { type: "feature", description: "/abs/feature.feature:12" }
   *   - { type: "bdd-source", description: "/abs/feature.feature:12" }
   */
  private extractSourceLocation(test: RawTest):
    | { featurePath: string; lineNumber?: number }
    | undefined {
    for (const ann of test.annotations ?? []) {
      const candidates = [ann.type, ann.description].filter(
        (v): v is string => typeof v === "string"
      );
      for (const candidate of candidates) {
        const match = candidate.match(/^(.+\.feature):(\d+)$/);
        if (match) {
          return { featurePath: match[1] ?? "", lineNumber: Number(match[2]) };
        }
        if (candidate.endsWith(".feature")) {
          return { featurePath: candidate };
        }
      }
    }
    return undefined;
  }
}
