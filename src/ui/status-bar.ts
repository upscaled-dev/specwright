import * as vscode from "vscode";
import { TestExecutor, TestRunEvent } from "../core/test-executor";

const SHOW_OUTPUT_COMMAND = "playwrightBddRunner.showOutput";
const IDLE_TOOLTIP = "No runs this session";

function formatTooltip(lastRunAt: Date | undefined): string {
  if (!lastRunAt) { return IDLE_TOOLTIP; }
  const hh = String(lastRunAt.getHours()).padStart(2, "0");
  const mm = String(lastRunAt.getMinutes()).padStart(2, "0");
  const ss = String(lastRunAt.getSeconds()).padStart(2, "0");
  return `Last run at ${hh}:${mm}:${ss} — click to show test output`;
}

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  private lastRunAt: Date | undefined;

  public static create(executor: TestExecutor, window: typeof vscode.window = vscode.window): StatusBar {
    return new StatusBar(executor, window);
  }

  constructor(executor: TestExecutor, window: typeof vscode.window = vscode.window) {
    this.item = window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.command = SHOW_OUTPUT_COMMAND;
    this.setIdle();
    this.item.show();

    this.subscription = executor.onTestRunEvent((event) => this.handle(event));
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private handle(event: TestRunEvent): void {
    if (event.kind === "running") {
      this.item.text = "$(loading~spin) Specwright: running…";
      this.item.tooltip = formatTooltip(this.lastRunAt);
      return;
    }
    this.lastRunAt = new Date();
    if (event.kind === "success") {
      this.item.text = `$(check) Specwright: passed ${event.passed}`;
    } else {
      this.item.text = `$(error) Specwright: ${event.passed} passed, ${event.failed} failed`;
    }
    this.item.tooltip = formatTooltip(this.lastRunAt);
  }

  private setIdle(): void {
    this.item.text = "$(beaker) Specwright";
    this.item.tooltip = formatTooltip(this.lastRunAt);
  }
}
