import * as vscode from "vscode";

type OperationKind = "mutation" | "sync" | "picker";

/**
 * Authoritative board activity shared by every command door onto remote writes, sync, and the sync-scope
 * picker. The picker is tracked here rather than latched in the command layer so the board's strip
 * repaints on the same activity event the other two use.
 */
export class BoardOperationState implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly running: Record<OperationKind, number> = { mutation: 0, sync: 0, picker: 0 };

  public readonly onDidChange = this.changed.event;

  public get mutationActive(): boolean {return this.running.mutation > 0;}
  public get syncActive(): boolean {return this.running.sync > 0;}
  public get pickerActive(): boolean {return this.running.picker > 0;}

  public mutation<T>(run: () => Promise<T>): Promise<T> {return this.track("mutation", run);}
  public sync<T>(run: () => Promise<T>): Promise<T> {return this.track("sync", run);}
  public picker<T>(run: () => Promise<T>): Promise<T> {return this.track("picker", run);}

  private async track<T>(kind: OperationKind, run: () => Promise<T>): Promise<T> {
    this.change(kind, 1);
    try {
      return await run();
    } finally {
      this.change(kind, -1);
    }
  }

  private change(kind: OperationKind, by: 1 | -1): void {
    this.running[kind] += by;
    this.changed.fire();
  }

  public dispose(): void {this.changed.dispose();}
}
