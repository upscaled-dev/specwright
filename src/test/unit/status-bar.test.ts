import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { StatusBar } from "../../ui/status-bar";
import { TestRunEvent } from "../../core/test-executor";

interface CapturedItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  alignment: number;
  priority: number;
  shown: boolean;
  disposed: boolean;
}

class FakeExecutor {
  private listeners: Array<(e: TestRunEvent) => void> = [];
  public readonly onTestRunEvent = (listener: (e: TestRunEvent) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i > -1) { this.listeners.splice(i, 1); }
      },
    };
  };
  public fire(event: TestRunEvent): void {
    for (const l of this.listeners) { l(event); }
  }
  public get listenerCount(): number { return this.listeners.length; }
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
  let executor: FakeExecutor;
  let statusBar: StatusBar;

  beforeEach(() => {
    captured = [];
    executor = new FakeExecutor();
    statusBar = new StatusBar(executor as unknown as Parameters<typeof StatusBar.create>[0], makeWindow(captured));
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
    executor.fire({ kind: "running", passed: 0, failed: 0 });
    const item = captured[0]!;
    expect(item.text).toBe("$(loading~spin) Specwright: running…");
    expect(item.tooltip).toBe("No runs this session");
  });

  it("updates to success state with passed count and updates tooltip with last run time", () => {
    executor.fire({ kind: "success", passed: 7, failed: 0 });
    const item = captured[0]!;
    expect(item.text).toBe("$(check) Specwright: passed 7");
    expect(item.tooltip).toMatch(/^Last run at \d{2}:\d{2}:\d{2} — click to show test output$/);
  });

  it("updates to failure state with passed/failed counts", () => {
    executor.fire({ kind: "failure", passed: 3, failed: 2 });
    const item = captured[0]!;
    expect(item.text).toBe("$(error) Specwright: 3 passed, 2 failed");
    expect(item.tooltip).toMatch(/^Last run at \d{2}:\d{2}:\d{2} — click to show test output$/);
  });

  it("preserves the last-run tooltip when transitioning back to running", () => {
    executor.fire({ kind: "success", passed: 1, failed: 0 });
    const tooltipAfterSuccess = captured[0]!.tooltip;
    executor.fire({ kind: "running", passed: 0, failed: 0 });
    expect(captured[0]!.tooltip).toBe(tooltipAfterSuccess);
  });

  it("disposes the status bar item and unsubscribes from the executor", () => {
    expect(executor.listenerCount).toBe(1);
    statusBar.dispose();
    expect(captured[0]!.disposed).toBe(true);
    expect(executor.listenerCount).toBe(0);
  });
});
