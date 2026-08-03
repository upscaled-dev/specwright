import * as vscode from "vscode";
import type { ExecutionEvent } from "../core/run-contracts";

interface GatewayEventSource {
  onEvent(listener: (event: ExecutionEvent) => void): vscode.Disposable;
}

const SHOW_OUTPUT_COMMAND = "playwrightBddRunner.showOutput";
const IDLE_TOOLTIP = "No runs this session";

function formatTooltip(lastRunAt: Date | undefined): string {
  if (!lastRunAt) { return IDLE_TOOLTIP; }
  const hh = String(lastRunAt.getHours()).padStart(2, "0");
  const mm = String(lastRunAt.getMinutes()).padStart(2, "0");
  const ss = String(lastRunAt.getSeconds()).padStart(2, "0");
  return `Last run at ${hh}:${mm}:${ss}, click to show test output`;
}

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  private lastRunAt: Date | undefined;

  public static create(source: GatewayEventSource, window: typeof vscode.window = vscode.window): StatusBar {
    return new StatusBar(source, window);
  }

  constructor(source: GatewayEventSource, window: typeof vscode.window = vscode.window) {
    this.item = window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.command = SHOW_OUTPUT_COMMAND;
    this.setIdle();
    this.item.show();

    this.subscription = source.onEvent((event) => this.handleGateway(event));
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private handleGateway(event: ExecutionEvent): void {
    if (event.kind === "started") {
      this.item.text = "$(loading~spin) Specwright: running…";
      this.item.tooltip = formatTooltip(this.lastRunAt);
      return;
    }
    if (event.kind === "case-finished") {
      this.item.text = `$(loading~spin) Specwright: ${event.completed}/${event.total}`;
      return;
    }
    if (event.kind !== "finished") {return;}
    this.lastRunAt = new Date();
    const completion = event.completion;
    if (completion.state === "cancelled") {
      this.item.text = "$(circle-slash) Specwright: cancelled";
    } else if (completion.state === "partial" || completion.failed > 0) {
      this.item.text = `$(error) Specwright: ${completion.passed} passed, ${completion.failed} failed`;
    } else {
      this.item.text = `$(check) Specwright: passed ${completion.passed}`;
    }
    this.item.tooltip = formatTooltip(this.lastRunAt);
  }

  private setIdle(): void {
    this.item.text = "$(beaker) Specwright";
    this.item.tooltip = formatTooltip(this.lastRunAt);
  }
}
