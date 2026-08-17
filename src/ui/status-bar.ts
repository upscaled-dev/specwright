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
  private item: vscode.StatusBarItem | undefined;
  private readonly subscription: vscode.Disposable;
  private lastRunAt: Date | undefined;

  public static create(source: GatewayEventSource, window: typeof vscode.window = vscode.window): StatusBar {
    return new StatusBar(source, window);
  }

  constructor(source: GatewayEventSource, window: typeof vscode.window = vscode.window) {
    this.subscription = source.onEvent((event) => this.handleGateway(event, window));
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item?.dispose();
  }

  private handleGateway(event: ExecutionEvent, window: typeof vscode.window): void {
    if (event.kind === "started") {this.ensureItem(window);}
    const item = this.item;
    if (!item) {return;}
    if (event.kind === "started") {
      item.text = "$(loading~spin) Specwright: running…";
      item.tooltip = formatTooltip(this.lastRunAt);
      return;
    }
    if (event.kind === "case-finished") {
      item.text = `$(loading~spin) Specwright: ${event.completed}/${event.total}`;
      return;
    }
    if (event.kind !== "finished") {return;}
    this.lastRunAt = new Date();
    const completion = event.completion;
    if (completion.state === "cancelled") {
      item.text = "$(circle-slash) Specwright: cancelled";
    } else if (completion.state === "partial" || completion.failed > 0) {
      item.text = `$(error) Specwright: ${completion.passed} passed, ${completion.failed} failed`;
    } else {
      item.text = `$(check) Specwright: passed ${completion.passed}`;
    }
    item.tooltip = formatTooltip(this.lastRunAt);
  }

  private ensureItem(window: typeof vscode.window): void {
    if (this.item) {return;}
    this.item = window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.command = SHOW_OUTPUT_COMMAND;
    this.item.show();
  }
}
