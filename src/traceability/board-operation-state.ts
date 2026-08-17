import * as vscode from "vscode";

type OperationKind = "mutation" | "sync";

/** Authoritative board activity shared by every command door onto remote writes and sync. */
export class BoardOperationState implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private mutations = 0;
  private syncs = 0;

  public readonly onDidChange = this.changed.event;

  public get mutationActive(): boolean {return this.mutations > 0;}
  public get syncActive(): boolean {return this.syncs > 0;}

  public mutation<T>(run: () => Promise<T>): Promise<T> {return this.track("mutation", run);}
  public sync<T>(run: () => Promise<T>): Promise<T> {return this.track("sync", run);}

  private async track<T>(kind: OperationKind, run: () => Promise<T>): Promise<T> {
    this.change(kind, 1);
    try {
      return await run();
    } finally {
      this.change(kind, -1);
    }
  }

  private change(kind: OperationKind, by: 1 | -1): void {
    if (kind === "mutation") {
      this.mutations += by;
    } else {
      this.syncs += by;
    }
    this.changed.fire();
  }

  public dispose(): void {this.changed.dispose();}
}
