import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { LiveTestRunProgress } from "../../test-providers/live-test-run-progress";
import type { ScenarioResult, ScenarioStatus } from "../../utils/playwright-json-parser";
import { FakeTestItem } from "./helpers/fake-test-controller";

interface StatusCall {
  readonly item: vscode.TestItem;
  readonly duration?: number | undefined;
}

interface FailureCall extends StatusCall {
  readonly message: vscode.TestMessage;
}

class RecordingRun {
  public readonly started: vscode.TestItem[] = [];
  public readonly passed: StatusCall[] = [];
  public readonly failed: FailureCall[] = [];
  public readonly skipped: vscode.TestItem[] = [];
  public readonly output: Array<{ text: string; item?: vscode.TestItem | undefined }> = [];

  public startedItem(item: vscode.TestItem): void {
    this.started.push(item);
  }

  public passedItem(item: vscode.TestItem, duration?: number): void {
    this.passed.push({ item, duration });
  }

  public failedItem(item: vscode.TestItem, message: vscode.TestMessage, duration?: number): void {
    this.failed.push({ item, message, duration });
  }

  public skippedItem(item: vscode.TestItem): void {
    this.skipped.push(item);
  }

  public appendOutput(text: string, _location?: vscode.Location, item?: vscode.TestItem): void {
    this.output.push({ text, item });
  }

  public asTestRun(): vscode.TestRun {
    return {
      started: (item: vscode.TestItem) => this.startedItem(item),
      passed: (item: vscode.TestItem, duration?: number) => this.passedItem(item, duration),
      failed: (item: vscode.TestItem, message: vscode.TestMessage, duration?: number) =>
        this.failedItem(item, message, duration),
      skipped: (item: vscode.TestItem) => this.skippedItem(item),
      appendOutput: (text: string, location?: vscode.Location, item?: vscode.TestItem) =>
        this.appendOutput(text, location, item),
    } as unknown as vscode.TestRun;
  }
}

interface ScenarioMetadata {
  readonly source: { readonly filePath: string; readonly lineNumber: number };
  readonly name?: string | undefined;
}

function item(id: string, label: string, filePath?: string, lineNumber?: number): FakeTestItem {
  const test = new FakeTestItem(id, label, filePath ? vscode.Uri.file(filePath) : undefined);
  if (lineNumber !== undefined) {
    test.range = new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0);
  }
  return test;
}

function asTestItem(test: FakeTestItem): vscode.TestItem {
  return test as unknown as vscode.TestItem;
}

function result(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    featurePath: "/repo/features/sample.feature",
    lineNumber: 4,
    scenarioName: "First scenario",
    status: "passed",
    ...overrides,
  };
}

function progressFor(
  run: RecordingRun,
  roots: FakeTestItem[],
  scenarios: Readonly<Record<string, ScenarioMetadata>>,
  options: {
    fallbackTarget?: FakeTestItem | undefined;
    onStatus?: ((test: vscode.TestItem, status: ScenarioStatus) => void) | undefined;
  } = {}
): LiveTestRunProgress {
  return LiveTestRunProgress.create({
    run: run.asTestRun(),
    roots: roots.map(asTestItem),
    scenarioFor: (id) => scenarios[id],
    ...(options.fallbackTarget ? { fallbackTarget: asTestItem(options.fallbackTarget) } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
  });
}

describe("LiveTestRunProgress", () => {
  it("streams split CRLF output without duplicating carriage returns", () => {
    const feature = item("feature", "Sample feature", "/repo/features/sample.feature", 1);
    const run = new RecordingRun();
    const progress = progressFor(run, [feature], {});

    progress.appendOutput("stdout", "first\nsecond\r");
    progress.appendOutput("stdout", "\nthird\r");
    progress.finishOutput();

    expect(run.output).toEqual([
      { text: "first\r\nsecond", item: undefined },
      { text: "\r\nthird", item: undefined },
      { text: "\r", item: undefined },
    ]);
  });

  it("starts the supplied scope once and marks matching leaves as each result arrives", () => {
    const feature = item("feature", "Sample feature", "/repo/features/sample.feature", 1);
    const first = item("first", "First scenario", "/repo/features/sample.feature", 4);
    const second = item("second", "Second scenario", "/repo/features/sample.feature", 8);
    feature.children.add(first);
    feature.children.add(second);
    const run = new RecordingRun();
    const onStatus = vi.fn();
    const progress = progressFor(run, [feature], {
      first: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
      second: { source: { filePath: "/repo/features/sample.feature", lineNumber: 8 } },
    }, { onStatus });

    expect(progress.total).toBe(2);
    expect(progress.completed).toBe(0);
    progress.start();
    progress.start();

    expect(run.started.map((test) => test.id)).toEqual(["feature"]);
    expect(progress.apply(result({ durationMs: 12 }))).toBe(true);
    expect(run.passed).toEqual([{ item: asTestItem(first), duration: 12 }]);
    expect(run.passed.some((call) => call.item.id === "feature")).toBe(false);
    expect(run.output).toEqual([{
      text: "[1 / 2] First scenario: passed\r\n",
      item: asTestItem(first),
    }]);
    expect(progress.completed).toBe(1);

    expect(progress.apply(result({
      lineNumber: 8,
      scenarioName: "Second scenario",
      status: "skipped",
    }))).toBe(true);
    expect(run.skipped).toEqual([asTestItem(second)]);
    expect(run.output.at(-1)?.text).toBe("[2 / 2] Second scenario: skipped\r\n");
    expect(progress.completed).toBe(2);
    expect(onStatus.mock.calls.map(([, status]) => status)).toEqual(["passed", "skipped"]);
  });

  it("builds a located failure message from the matched scenario source", () => {
    const failed = item("failed", "Fails", "c:\\repo\\features\\failure.feature", 9);
    const run = new RecordingRun();
    const onStatus = vi.fn();
    const progress = progressFor(run, [failed], {
      failed: {
        source: { filePath: "c:\\repo\\features\\failure.feature", lineNumber: 9 },
      },
    }, { onStatus });

    expect(progress.apply(result({
      featurePath: "C:/repo/features/failure.feature",
      lineNumber: 9,
      scenarioName: "Fails",
      status: "failed",
      durationMs: 37,
      errorMessage: "  expected true  ",
      errorStack: "Error: expected true\n    at steps.ts:2:3",
    }))).toBe(true);

    expect(run.failed).toHaveLength(1);
    const failure = run.failed[0]!;
    expect(failure.item.id).toBe("failed");
    expect(failure.duration).toBe(37);
    expect(failure.message.message).toBe(
      "expected true\n\nError: expected true\n    at steps.ts:2:3"
    );
    expect(failure.message.location?.uri.fsPath).toBe("c:\\repo\\features\\failure.feature");
    expect(failure.message.location?.range.start.line).toBe(8);
    expect(onStatus).toHaveBeenCalledWith(asTestItem(failed), "failed");
  });

  it("applies reporter revisions while deduping an unchanged status", () => {
    const scenario = item("scenario", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const statuses: ScenarioStatus[] = [];
    const progress = progressFor(run, [scenario], {
      scenario: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    }, { onStatus: (_test, status) => statuses.push(status) });

    expect(progress.apply(result({ status: "passed" }))).toBe(true);
    expect(progress.apply(result({ status: "passed" }))).toBe(false);
    expect(progress.apply(result({ status: "skipped" }))).toBe(true);
    expect(progress.apply(result({ status: "passed" }))).toBe(true);
    expect(progress.apply(result({ status: "failed" }))).toBe(true);
    expect(progress.apply(result({ status: "skipped" }))).toBe(true);

    expect(run.passed).toHaveLength(2);
    expect(run.skipped).toHaveLength(2);
    expect(run.failed).toHaveLength(1);
    expect(statuses).toEqual(["passed", "skipped", "passed", "failed", "skipped"]);
    expect(run.output.map(({ text }) => text)).toEqual([
      "[1 / 1] Scenario: passed\r\n",
      "[1 / 1] Scenario: skipped\r\n",
      "[1 / 1] Scenario: passed\r\n",
      "[1 / 1] Scenario: failed\r\n",
      "[1 / 1] Scenario: skipped\r\n",
    ]);
    expect(progress.completed).toBe(1);
  });

  it("matches by name when a result has no line number", () => {
    const scenario = item("named", "Tree label", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const progress = progressFor(run, [scenario], {
      named: {
        source: { filePath: "/repo/features/sample.feature", lineNumber: 4 },
        name: "Generated scenario title",
      },
    });

    expect(progress.apply(result({
      lineNumber: undefined,
      scenarioName: "Generated scenario title",
    }))).toBe(true);
    expect(run.passed[0]?.item.id).toBe("named");
  });

  it("uses the explicit fallback only when no source-matched leaf exists", () => {
    const fallback = item("target", "Target scenario", "/repo/features/target.feature", 3);
    const runWithoutFallback = new RecordingRun();
    const unmatched = result({
      featurePath: "/repo/.features-gen/target.feature.spec.js",
      lineNumber: 20,
      scenarioName: "Generated target",
    });
    const scenarios = {
      target: { source: { filePath: "/repo/features/target.feature", lineNumber: 3 } },
    };

    const withoutFallback = progressFor(runWithoutFallback, [fallback], scenarios);
    expect(withoutFallback.apply(unmatched)).toBe(false);
    expect(runWithoutFallback.passed).toEqual([]);

    const runWithFallback = new RecordingRun();
    const withFallback = progressFor(runWithFallback, [fallback], scenarios, {
      fallbackTarget: fallback,
    });
    expect(withFallback.apply(unmatched)).toBe(true);
    expect(runWithFallback.passed[0]?.item.id).toBe("target");
    expect(runWithFallback.output[0]?.text).toBe("[1 / 1] Target scenario: passed\r\n");
  });

  it("uses reporter counts and skips only unfinished leaves when cancelled", () => {
    const feature = item("feature", "Sample feature", "/repo/features/sample.feature", 1);
    const first = item("first", "First scenario", "/repo/features/sample.feature", 4);
    const second = item("second", "Second scenario", "/repo/features/sample.feature", 8);
    feature.children.add(first);
    feature.children.add(second);
    const run = new RecordingRun();
    const progress = progressFor(run, [feature], {
      first: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
      second: { source: { filePath: "/repo/features/sample.feature", lineNumber: 8 } },
    });

    progress.apply(result(), 127, 500);
    progress.cancel();

    expect(run.output[0]?.text).toBe("[127 / 500] First scenario: passed\r\n");
    expect(run.skipped.map((test) => test.id)).toEqual(["second", "feature"]);
  });

  it("settles nested parents when cancelled", () => {
    const feature = item("feature", "Sample feature", "/repo/features/sample.feature", 1);
    const outline = item("outline", "Outline", "/repo/features/sample.feature", 4);
    const example = item("example", "Example #1", "/repo/features/sample.feature", 8);
    feature.children.add(outline);
    outline.children.add(example);
    const run = new RecordingRun();
    const progress = progressFor(run, [feature], {
      example: { source: { filePath: "/repo/features/sample.feature", lineNumber: 8 } },
    });

    progress.cancel();

    expect(run.skipped.map((test) => test.id)).toEqual(["example", "outline", "feature"]);
  });

  it("advances reporter counts when another project keeps the same status", () => {
    const scenario = item("scenario", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const progress = progressFor(run, [scenario], {
      scenario: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    });

    progress.apply(result(), 1, 2);
    progress.apply(result(), 2, 2);

    expect(run.passed).toHaveLength(1);
    expect(run.output.map(({ text }) => text)).toEqual([
      "[1 / 2] Scenario: passed\r\n",
      "[2 / 2] Scenario: passed\r\n",
    ]);
  });

  it("replaces a failed attempt when its retry passes", () => {
    const scenario = item("scenario", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const progress = progressFor(run, [scenario], {
      scenario: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    });

    progress.apply(result({ status: "failed" }), 1, 1);
    progress.apply(result({ status: "passed" }), 1, 1);

    expect(run.failed).toHaveLength(1);
    expect(run.passed).toHaveLength(1);
    expect(run.output.map(({ text }) => text)).toEqual([
      "[1 / 1] Scenario: failed\r\n",
      "[1 / 1] Scenario: passed\r\n",
    ]);
  });

  it("tracks retry detail and only reapplies a materially changed final result", () => {
    const scenario = item("scenario", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const progress = progressFor(run, [scenario], {
      scenario: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    });
    const streamed = result({ status: "failed", durationMs: 5, errorMessage: "failed" });
    progress.apply(streamed);
    const revised = {
      ...streamed,
      errorStack: "Error: failed\n    at steps.ts:1:1",
    };
    expect(progress.apply(revised)).toBe(true);
    expect(run.failed).toHaveLength(2);
    const exhausted = { ...revised, durationMs: 80, attempts: 2 };
    expect(progress.apply(exhausted)).toBe(true);
    expect(run.failed.at(-1)?.duration).toBe(80);

    expect(progress.shouldApplyFinal(asTestItem(scenario), "failed", exhausted)).toBe(false);
    expect(progress.shouldApplyFinal(asTestItem(scenario), "passed")).toBe(true);
    expect(progress.shouldApplyFinal(asTestItem(scenario), "failed", {
      ...revised,
      errorStack: "Error: failed\n    at steps.ts:2:1",
    })).toBe(true);
    expect(progress.statusFor(asTestItem(scenario))).toBe("failed");
  });

  it("reapplies a final passing duration when a serial rerun changed it", () => {
    const scenario = item("scenario", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const progress = progressFor(run, [scenario], {
      scenario: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    });
    progress.apply(result({ durationMs: 5 }));

    expect(progress.shouldApplyFinal(asTestItem(scenario), "passed", result({ durationMs: 20 })))
      .toBe(true);
  });

  it("updates distinct tree copies even when their TestItem ids match", () => {
    const firstCopy = item("shared", "Scenario", "/repo/features/sample.feature", 4);
    const secondCopy = item("shared", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const progress = progressFor(run, [firstCopy, secondCopy], {
      shared: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    });

    progress.apply(result(), 1, 1);

    expect(run.passed.map(({ item: test }) => test)).toEqual([
      asTestItem(firstCopy),
      asTestItem(secondCopy),
    ]);
  });
});
