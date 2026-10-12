import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { beginExternalTestRun, LiveTestRunProgress } from "../../test-providers/live-test-run-progress";
import type { ScenarioResult, ScenarioStatus } from "../../utils/playwright-json-parser";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";

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
  private readonly states = new Map<vscode.TestItem, ScenarioStatus>();

  private accepts(item: vscode.TestItem, status: ScenarioStatus): boolean {
    // VS Code does not accept a terminal state with lower priority in the same TestRun.
    const priority = { passed: 0, skipped: 1, failed: 2 };
    const previous = this.states.get(item);
    if (previous !== undefined && priority[status] < priority[previous]) {return false;}
    this.states.set(item, status);
    return true;
  }

  public statusFor(item: vscode.TestItem): ScenarioStatus | undefined {
    return this.states.get(item);
  }

  public startedItem(item: vscode.TestItem): void {
    this.started.push(item);
  }

  public passedItem(item: vscode.TestItem, duration?: number): void {
    if (this.accepts(item, "passed")) {this.passed.push({ item, duration });}
  }

  public failedItem(item: vscode.TestItem, message: vscode.TestMessage, duration?: number): void {
    if (this.accepts(item, "failed")) {this.failed.push({ item, message, duration });}
  }

  public skippedItem(item: vscode.TestItem): void {
    if (this.accepts(item, "skipped")) {this.skipped.push(item);}
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

  it("keeps blank output chunks out of the transcript and names an unassigned-project retry", () => {
    const run = new RecordingRun();
    const progress = progressFor(run, [], {});

    progress.appendOutput("stdout", "");
    progress.reportProgress({ phase: "running", completed: 1, total: 2 });
    progress.reportProgress({ phase: "running", completed: 1, total: 2 });
    progress.reportProgress({
      phase: "running", completed: 1, total: 2,
      retry: { title: "Pay by card", attempt: 2, projectName: "" },
    });

    expect(run.output.map(({ text }) => text)).toEqual([
      "Running 1/2\r\n",
      "Retrying Pay by card, attempt 2\r\n",
    ]);
  });

  it("names the project when a parallel run retries a scenario", () => {
    const run = new RecordingRun();
    progressFor(run, [], {}).reportProgress({
      phase: "running", completed: 1, total: 2,
      retry: { title: "Pay by card", attempt: 2, projectName: "firefox" },
    });

    expect(run.output.at(-1)?.text).toBe("Retrying Pay by card [firefox], attempt 2\r\n");
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

    expect(run.failed).toEqual([]);
    progress.publishPendingFailures();
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

  it("records a failed attempt without publishing an irreversible TestRun failure", () => {
    const scenario = item("scenario", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const statuses: ScenarioStatus[] = [];
    const progress = progressFor(run, [scenario], {
      scenario: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    }, { onStatus: (_test, status) => statuses.push(status) });

    expect(progress.apply(result({ status: "passed" }))).toBe(true);
    expect(progress.apply(result({ status: "passed" }))).toBe(false);
    expect(progress.apply(result({ status: "failed" }))).toBe(true);
    expect(progress.apply(result({ status: "failed" }))).toBe(false);

    expect(run.passed).toHaveLength(1);
    expect(run.skipped).toEqual([]);
    expect(run.failed).toEqual([]);
    expect(statuses).toEqual(["passed"]);
    expect(run.output.map(({ text }) => text)).toEqual([
      "[1 / 1] Scenario: passed\r\n",
      "[1 / 1] Scenario: failed\r\n",
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

  it("starts and updates a selected leaf outside the discovered roots from its source metadata", () => {
    const fallback = item("selected", "Displayed title", "/repo/features/target.feature", 3);
    const run = new RecordingRun();
    const progress = progressFor(run, [], {
      selected: {
        source: { filePath: "/repo/features/target.feature", lineNumber: 3 },
        name: "Generated title",
      },
    }, { fallbackTarget: fallback });

    progress.start();
    const changed = progress.apply(result({
      featurePath: "/repo/.features-gen/target.feature.spec.js",
      lineNumber: 20,
      scenarioName: "Generated title",
    }), 1, 1);

    expect(run.started.map((test) => test.id)).toEqual(["selected"]);
    expect(changed).toBe(true);
    expect(run.passed.map(({ item: test }) => test.id)).toEqual(["selected"]);
  });

  it("reports an unsourced selected leaf without inventing a failure location", () => {
    const selected = item("selected", "Selected scenario");
    const run = new RecordingRun();
    const progress = progressFor(run, [], {}, { fallbackTarget: selected });

    progress.start();
    expect(progress.apply(result({ status: "failed", errorMessage: "" }))).toBe(true);
    progress.publishPendingFailures();

    expect(run.started).toEqual([asTestItem(selected)]);
    expect(run.failed[0]?.item).toBe(asTestItem(selected));
    expect(run.failed[0]?.message.message).toBe("Test failed");
    expect(run.failed[0]?.message.location).toBeUndefined();
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

  it("publishes a recorded failure when cancellation ends the retry window", () => {
    const scenario = item("scenario", "Scenario", "/repo/features/sample.feature", 4);
    const run = new RecordingRun();
    const progress = progressFor(run, [scenario], {
      scenario: { source: { filePath: "/repo/features/sample.feature", lineNumber: 4 } },
    });
    progress.apply(result({ status: "failed", errorMessage: "attempt failed" }));

    progress.cancel();

    expect(run.statusFor(asTestItem(scenario))).toBe("failed");
    expect(run.failed[0]?.message.message).toContain("attempt failed");
    expect(run.skipped).toEqual([]);
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
    expect(run.failed).toEqual([]);
    progress.apply(result({ status: "passed" }), 1, 1);

    expect(run.failed).toEqual([]);
    expect(run.passed).toHaveLength(1);
    expect(run.statusFor(asTestItem(scenario))).toBe("passed");
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
    expect(run.failed).toEqual([]);
    const exhausted = { ...revised, durationMs: 80, attempts: 2 };
    expect(progress.apply(exhausted)).toBe(true);
    expect(progress.shouldApplyFinal(asTestItem(scenario), "failed", exhausted)).toBe(true);
    progress.publishPendingFailures();
    expect(run.failed).toHaveLength(1);
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

describe("editor-triggered Test Results run", () => {
  function runFor(
    controller: FakeTestController,
    lineNumber?: number,
    applyFinal: Parameters<typeof beginExternalTestRun>[0]["applyFinal"] = vi.fn()
  ) {
    return beginExternalTestRun({
      controller: controller as unknown as vscode.TestController,
      filePath: "/repo/features/sample.feature",
      ...(lineNumber === undefined ? {} : { lineNumber }),
      lineFor: (test) => test.range?.start.line === undefined ? undefined : test.range.start.line + 1,
      createProgress: (run, roots, fallbackTarget) => LiveTestRunProgress.create({
        run,
        roots,
        fallbackTarget,
        scenarioFor: () => undefined,
      }),
      applyFinal,
    });
  }

  it("streams only the selected scenario into the open run and closes after final reconciliation", () => {
    const controller = new FakeTestController();
    const feature = item("feature", "Sample feature", "/repo/features/sample.feature", 1);
    const first = item("first", "First scenario", "/repo/features/sample.feature", 4);
    const second = item("second", "Second scenario", "/repo/features/sample.feature", 8);
    feature.children.add(first);
    feature.children.add(second);
    controller.items.add(feature);
    const applyFinal = vi.fn();

    const session = runFor(controller, 8, applyFinal);
    session.progress.onOutput?.("stdout", "running\n");
    session.progress.onTestEnd?.(result({ lineNumber: 4 }), 1, 2);
    session.progress.onTestEnd?.(result({ lineNumber: 8, scenarioName: "Second scenario" }), 2, 2);
    const final = { success: true, output: "", duration: 12 };
    session.complete(final);

    const run = controller.runs[0]!;
    expect((run.request as vscode.TestRunRequest).include?.map((test) => test.id)).toEqual(["second"]);
    expect(run.outcome.started).toEqual(["second"]);
    expect(run.outcome.passed).toEqual(["second"]);
    expect(run.outcome.output).toContain("running\r\n");
    expect(run.outcome.ended).toBe(true);
    expect(applyFinal).toHaveBeenCalledWith(run, final, expect.any(LiveTestRunProgress));
  });

  it("preserves a completed scenario and skips only unfinished siblings when the file run is cancelled", () => {
    const controller = new FakeTestController();
    const feature = item("feature", "Sample feature", "/repo/features/sample.feature", 1);
    feature.children.add(item("first", "First scenario", "/repo/features/sample.feature", 4));
    feature.children.add(item("second", "Second scenario", "/repo/features/sample.feature", 8));
    controller.items.add(feature);
    const applyFinal = vi.fn();

    const session = runFor(controller, undefined, applyFinal);
    session.progress.onTestEnd?.(result(), 1, 2);
    session.complete({ success: false, output: "", error: "Cancelled", duration: 12 });

    const run = controller.runs[0]!;
    expect((run.request as vscode.TestRunRequest).include?.map((test) => test.id)).toEqual(["feature"]);
    expect(run.outcome.passed).toEqual(["first"]);
    expect(run.outcome.skipped).toEqual(["second", "feature"]);
    expect(run.outcome.ended).toBe(true);
    expect(applyFinal).not.toHaveBeenCalled();
  });

  it("ends an editor run as skipped when execution stops before a result arrives", () => {
    const controller = new FakeTestController();
    controller.items.add(item("scenario", "First scenario", "/repo/features/sample.feature", 4));
    const applyFinal = vi.fn();

    const session = runFor(controller, 4, applyFinal);
    session.end();
    session.complete({ success: true, output: "", duration: 1 });

    expect(controller.runs[0]!.outcome.skipped).toEqual(["scenario"]);
    expect(controller.runs[0]!.outcome.ended).toBe(true);
    expect(applyFinal).not.toHaveBeenCalled();
  });

  it("selects the item range when a caller has no indexed line and ends once", () => {
    const controller = new FakeTestController();
    controller.items.add(item("scenario", "Selected scenario", "/repo/features/sample.feature", 4));
    const session = beginExternalTestRun({
      controller: controller as unknown as vscode.TestController,
      filePath: "/repo/features/sample.feature",
      lineNumber: 4,
      lineFor: () => undefined,
      createProgress: (run, roots, fallbackTarget) => LiveTestRunProgress.create({
        run, roots, fallbackTarget, scenarioFor: () => undefined,
      }),
      applyFinal: vi.fn(),
    });
    const run = controller.runs[0]!;
    const end = vi.spyOn(run, "end");

    expect((run.request as vscode.TestRunRequest).include?.map((test) => test.id))
      .toEqual(["scenario"]);
    session.end();
    session.end();
    session.complete({ success: true, output: "", duration: 1 });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("closes the Test Results run even when final reconciliation fails", () => {
    const controller = new FakeTestController();
    controller.items.add(item("scenario", "First scenario", "/repo/features/sample.feature", 4));
    const session = runFor(controller, 4, () => { throw new Error("reconcile failed"); });

    expect(() => session.complete({ success: true, output: "", duration: 1 }))
      .toThrow("reconcile failed");
    expect(controller.runs[0]!.outcome.ended).toBe(true);
  });
});
