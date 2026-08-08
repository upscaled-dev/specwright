import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { StatusBar } from "../../ui/status-bar";
import type { ExecutionEvent, RunCompletion } from "../../core/run-contracts";

interface CapturedItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  alignment: number;
  priority: number;
  shown: boolean;
  disposed: boolean;
}

class FakeGateway {
  private listeners: Array<(e: ExecutionEvent) => void> = [];
  public readonly onEvent = (listener: (e: ExecutionEvent) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i > -1) { this.listeners.splice(i, 1); }
      },
    };
  };
  public fire(event: ExecutionEvent): void {
    for (const l of this.listeners) { l(event); }
  }
  public get listenerCount(): number { return this.listeners.length; }
}

function completion(over: Partial<RunCompletion> = {}): RunCompletion {
  return {
    identity: { engine: "legacy-direct", schemaProfile: "legacy.v1" },
    state: "complete",
    results: [],
    output: "",
    passed: 0,
    failed: 0,
    durationMs: 1,
    ...over,
  };
}

function makeWindow(captured: CapturedItem[]): typeof vscode.window {
  return {
    ...vscode.window,
    createStatusBarItem: (alignment?: number, priority?: number) => {
      const item: CapturedItem = {
        text: "",
        tooltip: undefined,
        command: undefined,
        alignment: alignment ?? -1,
        priority: priority ?? -1,
        shown: false,
        disposed: false,
      };
      captured.push(item);
      return {
        get text() { return item.text; },
        set text(v: string) { item.text = v; },
        get tooltip() { return item.tooltip; },
        set tooltip(v: string | undefined) { item.tooltip = v; },
        get command() { return item.command; },
        set command(v: string | undefined) { item.command = v; },
        show: () => { item.shown = true; },
        hide: () => { item.shown = false; },
        dispose: () => { item.disposed = true; },
      } as unknown as vscode.StatusBarItem;
    },
  } as unknown as typeof vscode.window;
}

describe("StatusBar", () => {
  let captured: CapturedItem[];
  let gateway: FakeGateway;
  let statusBar: StatusBar;

  beforeEach(() => {
    captured = [];
    gateway = new FakeGateway();
    statusBar = new StatusBar(gateway, makeWindow(captured));
  });

  it("renders idle state on creation", () => {
    expect(captured).toHaveLength(1);
    const item = captured[0]!;
    expect(item.text).toBe("$(beaker) Specwright");
    expect(item.tooltip).toBe("No runs this session");
    expect(item.command).toBe("playwrightBddRunner.showOutput");
    expect(item.alignment).toBe(vscode.StatusBarAlignment.Left);
    expect(item.shown).toBe(true);
    expect(item.disposed).toBe(false);
  });

  it("updates to running state when a running event fires", () => {
    gateway.fire({ kind: "started", targetCount: 1 });
    const item = captured[0]!;
    expect(item.text).toBe("$(loading~spin) Specwright: running…");
    expect(item.tooltip).toBe("No runs this session");
  });

  it("shows completed and total counts while a run is active", () => {
    gateway.fire({
      kind: "case-finished",
      result: {
        scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" },
        outcome: "passed",
        durationMs: 1,
        attempts: 1,
        flaky: false,
      },
      completed: 10,
      total: 25,
    });
    expect(captured[0]!.text).toBe("$(loading~spin) Specwright: 10/25");
  });

  it("updates to success state with passed count and updates tooltip with last run time", () => {
    gateway.fire({ kind: "finished", completion: completion({ passed: 7 }) });
    const item = captured[0]!;
    expect(item.text).toBe("$(check) Specwright: passed 7");
    expect(item.tooltip).toMatch(/^Last run at \d{2}:\d{2}:\d{2}, click to show test output$/);
  });

  it("updates to failure state with passed/failed counts", () => {
    gateway.fire({ kind: "finished", completion: completion({ passed: 3, failed: 2 }) });
    const item = captured[0]!;
    expect(item.text).toBe("$(error) Specwright: 3 passed, 2 failed");
    expect(item.tooltip).toMatch(/^Last run at \d{2}:\d{2}:\d{2}, click to show test output$/);
  });

  it("settles to a cancelled state instead of staying on the spinner", () => {
    gateway.fire({ kind: "started", targetCount: 1 });
    gateway.fire({ kind: "finished", completion: completion({ state: "cancelled" }) });
    const item = captured[0]!;
    expect(item.text).toBe("$(circle-slash) Specwright: cancelled");
    expect(item.tooltip).toMatch(/^Last run at \d{2}:\d{2}:\d{2}, click to show test output$/);
  });

  it("preserves the last-run tooltip when transitioning back to running", () => {
    gateway.fire({ kind: "finished", completion: completion({ passed: 1 }) });
    const tooltipAfterSuccess = captured[0]!.tooltip;
    gateway.fire({ kind: "started", targetCount: 1 });
    expect(captured[0]!.tooltip).toBe(tooltipAfterSuccess);
  });

  it("disposes the status bar item and unsubscribes from the gateway", () => {
    expect(gateway.listenerCount).toBe(1);
    statusBar.dispose();
    expect(captured[0]!.disposed).toBe(true);
    expect(gateway.listenerCount).toBe(0);
  });
});
