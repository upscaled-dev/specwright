import { EventEmitter, type Event } from "vscode";
import type { ExecutionSelectionOwner } from "../core/execution-engine";
import type { RunArtifact, RunArtifactOutcome } from "../traceability/contracts";
import type { RunArtifactStore } from "../traceability/run-artifact-store";

export interface ExecutionArtifactCatalog {
  readonly onDidChange: Event<void>;
  list(): RunArtifact[];
  latest(): RunArtifact | undefined;
  latestOutcome(testKey: string): RunArtifactOutcome | undefined;
  clear(): number;
}

/** Presents only the selected engine/profile store to publishing and UI consumers. */
export class SelectedArtifactCatalog implements ExecutionArtifactCatalog {
  private readonly changeEmitter = new EventEmitter<void>();
  private readonly subscriptions: { dispose(): void }[];
  public readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly selection: ExecutionSelectionOwner,
    private readonly stores: ReadonlyMap<string, RunArtifactStore>
  ) {
    this.subscriptions = [...stores.values()].map((store) =>
      store.onDidChange(() => this.changeEmitter.fire())
    );
  }

  public list(): RunArtifact[] {return this.selected()?.list() ?? [];}
  public latest(): RunArtifact | undefined {return this.selected()?.latest();}
  public latestOutcome(testKey: string): RunArtifactOutcome | undefined {
    return this.selected()?.latestOutcome(testKey);
  }
  public clear(): number {return this.selected()?.clear() ?? 0;}
  public dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.changeEmitter.dispose();
  }

  private selected(): RunArtifactStore | undefined {
    const { engine, schemaProfile } = this.selection.begin();
    return this.stores.get(`${engine}:${schemaProfile}`);
  }
}
