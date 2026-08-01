import * as vscode from "vscode";
import type { RunOutputResult } from "../core/test-executor";
import type { RunProgressSession } from "../core/run-progress";
import {
  normalizePathKey,
  type ScenarioResult,
  type ScenarioStatus,
} from "../utils/playwright-json-parser";

export interface LiveTestScenario {
  readonly source: {
    readonly filePath: string;
    readonly lineNumber: number;
  };
  readonly name?: string | undefined;
}

type ScenarioSource = LiveTestScenario["source"];

export interface LiveTestRunProgressOptions {
  readonly run: vscode.TestRun;
  readonly roots: readonly vscode.TestItem[];
  readonly scenarioFor: (testItemId: string) => LiveTestScenario | undefined;
  /** Used only when no source-matched leaf exists. Intended for a single-scenario external run. */
  readonly fallbackTarget?: vscode.TestItem | undefined;
  readonly onStatus?: ((item: vscode.TestItem, status: ScenarioStatus) => void) | undefined;
}

interface ExternalTestRunOptions {
  readonly controller: vscode.TestController;
  readonly filePath: string;
  readonly lineNumber?: number | undefined;
  readonly lineFor: (item: vscode.TestItem) => number | undefined;
  readonly createProgress: (
    run: vscode.TestRun,
    roots: readonly vscode.TestItem[],
    fallbackTarget?: vscode.TestItem
  ) => LiveTestRunProgress;
  readonly applyFinal: (
    run: vscode.TestRun,
    result: RunOutputResult,
    live: LiveTestRunProgress
  ) => void;
}

interface TrackedItem {
  readonly item: vscode.TestItem;
  readonly source?: ScenarioSource | undefined;
  readonly name: string;
}

/**
 * Applies Playwright scenario results to an already-open VS Code TestRun as they arrive.
 *
 * Only leaf items receive terminal states. A final report can still roll up parents after the
 * process exits. Reporter revisions replace earlier states, so a retry can move from failed to
 * passed while project copies remain aggregated before they reach this layer.
 */
export class LiveTestRunProgress {
  private readonly run: vscode.TestRun;
  private readonly roots: readonly vscode.TestItem[];
  private readonly fallbackTarget: vscode.TestItem | undefined;
  private readonly onStatus: ((item: vscode.TestItem, status: ScenarioStatus) => void) | undefined;
  private readonly items: readonly TrackedItem[];
  private readonly statusByItem = new Map<vscode.TestItem, ScenarioStatus>();
  private readonly resultByItem = new Map<vscode.TestItem, ScenarioResult>();
  private readonly startedItems = new Set<vscode.TestItem>();
  private readonly pendingCarriageReturn = { stdout: false, stderr: false };

  public static create(options: LiveTestRunProgressOptions): LiveTestRunProgress {
    return new LiveTestRunProgress(options);
  }

  private constructor(options: LiveTestRunProgressOptions) {
    this.run = options.run;
    this.roots = options.roots;
    this.fallbackTarget = options.fallbackTarget;
    this.onStatus = options.onStatus;
    this.items = this.collectTrackedItems(options.roots, options.scenarioFor, options.fallbackTarget);
  }

  public get completed(): number {
    return this.statusByItem.size;
  }

  public get total(): number {
    return this.items.length;
  }

  /** Mark the supplied run roots started. Safe to call when roots overlap or more than once. */
  public start(): void {
    const mark = (item: vscode.TestItem): void => {
      if (!this.startedItems.has(item)) {
        this.startedItems.add(item);
        this.run.started(item);
      }
    };
    for (const root of this.roots) {mark(root);}
    if (this.fallbackTarget && !this.startedItems.has(this.fallbackTarget)) {
      mark(this.fallbackTarget);
    }
  }

  /** Apply one completed scenario. Returns true when at least one TestItem changed state. */
  public apply(result: ScenarioResult, completed?: number, total?: number): boolean {
    const matched = this.items.filter((tracked) => this.matches(tracked, result));
    const targets = matched.length > 0 ? matched : this.fallback(result);
    let changed = false;

    for (const tracked of targets) {
      const previous = this.statusByItem.get(tracked.item);
      const previousResult = this.resultByItem.get(tracked.item);
      if (previous === result.status && !hasChangedFailure(result, previousResult)) {
        if (completed !== undefined && total !== undefined) {
          this.appendProgress(tracked, previous, completed, total);
        }
        continue;
      }

      this.statusByItem.set(tracked.item, result.status);
      this.resultByItem.set(tracked.item, result);
      this.mark(tracked, result);
      this.appendProgress(tracked, result.status, completed ?? this.completed, total ?? this.total);
      this.onStatus?.(tracked.item, result.status);
      changed = true;
    }

    return changed;
  }

  /** Settle the selected roots when their run is cancelled without touching filtered siblings. */
  public cancel(): void {
    for (const tracked of this.items) {
      if (!this.statusByItem.has(tracked.item)) {
        this.run.skipped(tracked.item);
      }
    }
    const settledParents = new Set<vscode.TestItem>();
    const settleParents = (item: vscode.TestItem): void => {
      item.children.forEach(settleParents);
      if (item.children.size > 0 && !settledParents.has(item)) {
        settledParents.add(item);
        this.run.skipped(item);
      }
    };
    for (const root of this.roots) {
      settleParents(root);
    }
  }

  public hasResult(item: vscode.TestItem): boolean {
    return this.statusByItem.has(item);
  }

  public statusFor(item: vscode.TestItem): ScenarioStatus | undefined {
    return this.statusByItem.get(item);
  }

  /** Stream process output into the open Test Results run while the process is active. */
  public appendOutput(stream: "stdout" | "stderr", text: string): void {
    const joined = `${this.pendingCarriageReturn[stream] ? "\r" : ""}${text}`;
    this.pendingCarriageReturn[stream] = joined.endsWith("\r");
    const complete = this.pendingCarriageReturn[stream] ? joined.slice(0, -1) : joined;
    if (complete !== "") {this.run.appendOutput(complete.replace(/\r\n|\n/g, "\r\n"));}
  }

  public finishOutput(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.pendingCarriageReturn[stream]) {this.run.appendOutput("\r");}
      this.pendingCarriageReturn[stream] = false;
    }
  }

  /** Reapply a final result only when it changes state or visible result detail. */
  public shouldApplyFinal(
    item: vscode.TestItem,
    status: ScenarioStatus,
    detail?: ScenarioResult
  ): boolean {
    const live = this.resultByItem.get(item);
    if (live?.status !== status) {return true;}
    if (status === "passed" && detail?.durationMs !== undefined) {
      return detail.durationMs !== live.durationMs;
    }
    if (status !== "failed" || !detail) {return false;}
    return hasNewText(detail.errorMessage, live.errorMessage) ||
      hasNewText(detail.errorStack, live.errorStack);
  }

  private collectTrackedItems(
    roots: readonly vscode.TestItem[],
    scenarioFor: LiveTestRunProgressOptions["scenarioFor"],
    fallbackTarget: vscode.TestItem | undefined
  ): readonly TrackedItem[] {
    const items = new Map<vscode.TestItem, TrackedItem>();
    const visit = (item: vscode.TestItem): void => {
      if (item.children.size > 0) {
        item.children.forEach(visit);
        return;
      }
      const metadata = scenarioFor(item.id);
      const source = metadata?.source ?? this.sourceFromItem(item);
      if (source) {
        items.set(item, { item, source, name: metadata?.name ?? item.label });
      }
    };
    for (const root of roots) {visit(root);}

    if (fallbackTarget?.children.size === 0 && !items.has(fallbackTarget)) {
      const metadata = scenarioFor(fallbackTarget.id);
      items.set(fallbackTarget, {
        item: fallbackTarget,
        ...(metadata?.source ? { source: metadata.source } : {}),
        name: metadata?.name ?? fallbackTarget.label,
      });
    }
    return [...items.values()];
  }

  private sourceFromItem(item: vscode.TestItem): ScenarioSource | undefined {
    if (!item.uri || !item.range) {return undefined;}
    return { filePath: item.uri.fsPath, lineNumber: item.range.start.line + 1 };
  }

  private matches(tracked: TrackedItem, result: ScenarioResult): boolean {
    if (!tracked.source || normalizePathKey(tracked.source.filePath) !== normalizePathKey(result.featurePath)) {
      return false;
    }
    if (result.lineNumber !== undefined) {
      return tracked.source.lineNumber === result.lineNumber;
    }
    return tracked.name === result.scenarioName;
  }

  private fallback(result: ScenarioResult): readonly TrackedItem[] {
    if (!this.fallbackTarget || this.fallbackTarget.children.size > 0) {return [];}
    const target = this.items.find((tracked) => tracked.item === this.fallbackTarget);
    return target ? [target] : [{ item: this.fallbackTarget, name: result.scenarioName }];
  }

  private appendProgress(
    tracked: TrackedItem,
    status: ScenarioStatus,
    completed: number,
    total: number
  ): void {
    this.run.appendOutput(
      `[${completed} / ${total}] ${tracked.item.label}: ${status}\r\n`,
      undefined,
      tracked.item
    );
  }

  private mark(tracked: TrackedItem, result: ScenarioResult): void {
    if (result.status === "passed") {
      this.run.passed(tracked.item, result.durationMs);
      return;
    }
    if (result.status === "skipped") {
      this.run.skipped(tracked.item);
      return;
    }
    this.run.failed(tracked.item, this.failureMessage(tracked, result), result.durationMs);
  }

  private failureMessage(tracked: TrackedItem, result: ScenarioResult): vscode.TestMessage {
    const errorMessage = result.errorMessage?.trim();
    const base = errorMessage === undefined || errorMessage === "" ? "Test failed" : errorMessage;
    const text = result.errorStack?.trim() ? `${base}\n\n${result.errorStack}` : base;
    const message = new vscode.TestMessage(text);
    const source = tracked.source;

    if (source && source.lineNumber > 0) {
      message.location = new vscode.Location(
        vscode.Uri.file(source.filePath),
        new vscode.Range(source.lineNumber - 1, 0, source.lineNumber - 1, 0)
      );
    } else if (tracked.item.uri && tracked.item.range) {
      message.location = new vscode.Location(tracked.item.uri, tracked.item.range);
    }
    return message;
  }
}

function hasNewText(finalText: string | undefined, liveText: string | undefined): boolean {
  const finalValue = finalText?.trim();
  return finalValue !== undefined && finalValue !== "" && finalValue !== liveText?.trim();
}

function hasChangedFailure(
  current: ScenarioResult,
  previous: ScenarioResult | undefined
): boolean {
  if (current.status !== "failed" || !previous) {return false;}
  return current.errorMessage?.trim() !== previous.errorMessage?.trim() ||
    current.errorStack?.trim() !== previous.errorStack?.trim() ||
    current.outcome !== previous.outcome ||
    current.durationMs !== previous.durationMs ||
    current.attempts !== previous.attempts;
}

/** Open one TestRun before an editor-triggered process starts and close it after reconciliation. */
export function beginExternalTestRun(options: ExternalTestRunOptions): RunProgressSession {
  const roots = externalRunRoots(options);
  const request = new vscode.TestRunRequest([...roots]);
  const run = options.controller.createTestRun(request);
  const onlyRoot = roots.length === 1 ? roots[0] : undefined;
  const fallbackTarget = onlyRoot?.children.size === 0 ? onlyRoot : undefined;
  const live = options.createProgress(run, roots, fallbackTarget);
  live.start();
  let ended = false;
  const close = (): void => {
    if (ended) {return;}
    ended = true;
    run.end();
  };

  return {
    progress: {
      onTestEnd: (result, completed, total) => {
        live.apply(result, completed, total);
      },
      onOutput: (stream, output) => live.appendOutput(stream, output),
    },
    complete: (result) => {
      if (ended) {return;}
      try {
        live.finishOutput();
        if (result.error === "Cancelled") {live.cancel();}
        else {options.applyFinal(run, result, live);}
      } finally {
        close();
      }
    },
    end: () => {
      live.finishOutput();
      live.cancel();
      close();
    },
  };
}

function externalRunRoots(options: ExternalTestRunOptions): vscode.TestItem[] {
  const roots: vscode.TestItem[] = [];
  const fileKey = normalizePathKey(options.filePath);
  const visit = (item: vscode.TestItem): void => {
    const inFile = item.uri && normalizePathKey(item.uri.fsPath) === fileKey;
    if (inFile && options.lineNumber === undefined && item.children.size > 0) {
      roots.push(item);
      return;
    }
    if (inFile && item.children.size === 0) {
      const lineNumber = options.lineFor(item) ?? (item.range ? item.range.start.line + 1 : undefined);
      if (options.lineNumber === undefined || lineNumber === options.lineNumber) {
        roots.push(item);
        return;
      }
    }
    item.children.forEach(visit);
  };
  options.controller.items.forEach(visit);
  return roots;
}
