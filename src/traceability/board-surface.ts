import * as vscode from "vscode";
import {
  BoardScenarioCard,
  BoardTestCard,
  BoardViewModel,
  ExecutionRow,
  MatrixRow,
  filterBoardViewModel,
  filterExecutionRows,
} from "./board-data";
import { SurfaceHost } from "./webview-host";

interface SearchMessage {
  type: "search";
  value: string;
}
interface DropMessage {
  type: "drop";
  scenario: string;
  key: string;
}
interface UnlinkMessage {
  type: "unlink";
  scenario: string;
  key: string;
}
interface OpenMessage {
  type: "open";
  key: string;
}
interface SyncMessage {
  type: "sync";
}
type BoardIncoming = SearchMessage | DropMessage | UnlinkMessage | OpenMessage | SyncMessage;

interface RenderMessage {
  type: "render";
  scenarios: readonly BoardScenarioCard[];
  available: readonly BoardTestCard[];
  mapped: readonly BoardTestCard[];
  matrix: readonly MatrixRow[];
  executions: readonly ExecutionRow[];
  availableEmptyText: string;
  offerSync: boolean;
  // Whether these lists came out of a query. The webview cannot read this off its own search box: a
  // snapshot-driven render can land before the host has processed a keystroke or a clear.
  filtering: boolean;
}

// The board is a document-like surface, so its data source is the stable subsystem — not a one-shot
// snapshot — letting it re-render across syncs and provider swaps while the panel stays open.
// `applyDrop` is the drag-to-link seam: the webview posts a normalized {scenario, key} and the host
// validates and writes the tag, then the snapshot rebuild re-renders the board (no hand-patching here).
export interface BoardSurfaceDeps {
  buildModel(): BoardViewModel;
  // The Executions tab's rows, read from the publish ledger — what this workspace has published, never
  // a live remote query. Rebuilt alongside the model on every refresh.
  buildExecutions(): readonly ExecutionRow[];
  readonly onDidChange: vscode.Event<void>;
  applyDrop(scenario: string, key: string): Promise<void>;
  // The unlink seam: the webview posts a test card row's {scenario, key} and the host validates and
  // removes just that `@TEST_` tag, then the snapshot rebuild re-renders (no hand-patching here).
  applyUnlink(scenario: string, key: string): Promise<void>;
  // The Sync now button on an empty available group: the same traceability sync the palette runs. A
  // successful run re-renders through the snapshot rebuild; the settled promise is what repaints after
  // a failure, so the button never stays stuck on "Syncing".
  runSync(): Promise<void>;
  // An Executions row's key link: routed through the host's browseIssue path.
  openExecution(key: string): void;
}

// The Mapping/Matrix/Executions surface. It paints all three board panes from one filtered view model
// (the shell owns which pane is visible), forwards drops and execution-link clicks, and re-renders on
// the subsystem's snapshot-change event. Every render round-trips through the vscode-free
// `filterBoardViewModel`, so the webview JS stays thin and untested.
export class BoardSurface {
  private query = "";
  private model: BoardViewModel;
  private executions: readonly ExecutionRow[];
  private readonly unlinking = new Set<string>();

  constructor(
    private readonly host: SurfaceHost,
    private readonly deps: BoardSurfaceDeps
  ) {
    this.model = deps.buildModel();
    this.executions = deps.buildExecutions();
    host.onMessage((message) => this.handle(message as BoardIncoming));
    const subscription = deps.onDidChange(() => this.refresh());
    host.onDidDispose(() => subscription.dispose());
    this.render();
  }

  private handle(message: BoardIncoming): void {
    if (message.type === "drop") {
      // The write, its snapshot rebuild, and the follow-up re-render are the host's job. Nothing is
      // posted back here: a valid drop re-renders via onDidChange, a stale one toasts and leaves the
      // board as-is for a retry.
      this.deps.applyDrop(message.scenario, message.key).catch(() => undefined);
      return;
    }
    if (message.type === "unlink") {
      // A row already being unlinked is ignored: the board only re-renders once the snapshot rebuilds,
      // so a second click would resolve against the pre-edit document and strip the wrong line.
      const row = `${message.scenario}\n${message.key}`;
      if (this.unlinking.has(row)) {
        return;
      }
      this.unlinking.add(row);
      this.deps
        .applyUnlink(message.scenario, message.key)
        .finally(() => this.unlinking.delete(row))
        .catch(() => undefined);
      return;
    }
    if (message.type === "open") {
      this.deps.openExecution(message.key);
      return;
    }
    if (message.type === "sync") {
      this.deps
        .runSync()
        .finally(() => this.render())
        .catch(() => undefined);
      return;
    }
    this.query = message.value;
    this.render();
  }

  private refresh(): void {
    this.model = this.deps.buildModel();
    this.executions = this.deps.buildExecutions();
    this.render();
  }

  private render(): void {
    const filtered = filterBoardViewModel(this.model, this.query);
    const message: RenderMessage = {
      type: "render",
      scenarios: filtered.scenarios,
      available: filtered.available,
      mapped: filtered.mapped,
      matrix: filtered.matrix,
      executions: filterExecutionRows(this.executions, this.query),
      availableEmptyText: filtered.availableEmptyText,
      offerSync: filtered.offerSync,
      filtering: this.query.trim() !== "",
    };
    this.host.post(message);
  }
}
