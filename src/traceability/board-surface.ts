import * as vscode from "vscode";
import {
  BoardScenarioCard,
  BoardTestCard,
  BoardViewModel,
  ExecutionRow,
  MatrixRow,
  filterBoardViewModel,
  filterExecutionRows,
  scopeBoardViewModel,
} from "./board-data";
import { ProjectScopeStore } from "./project-scope";
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
interface ScopeMessage {
  type: "scope";
  project: string;
}
interface SelectMessage {
  type: "select";
  id: string;
  on: boolean;
}
interface BulkCreateMessage {
  type: "bulkCreate";
}
type BoardIncoming =
  | SearchMessage
  | DropMessage
  | UnlinkMessage
  | OpenMessage
  | SyncMessage
  | ScopeMessage
  | SelectMessage
  | BulkCreateMessage;

// A scenario card plus the host's answer to "is this one checked". The webview holds no selection of
// its own: it paints this flag and posts every checkbox change straight back.
interface SelectableScenarioCard extends BoardScenarioCard {
  readonly selected: boolean;
}

// The Create tests button's whole state, decided here so the webview only paints it. `hint` is the
// button's tooltip, which is where a disabled verb says what is missing.
interface CreateVerb {
  readonly label: string;
  readonly enabled: boolean;
  readonly hint: string;
}

interface RenderMessage {
  type: "render";
  scenarios: readonly SelectableScenarioCard[];
  available: readonly BoardTestCard[];
  mapped: readonly BoardTestCard[];
  matrix: readonly MatrixRow[];
  executions: readonly ExecutionRow[];
  availableEmptyText: string;
  offerSync: boolean;
  // Whether these lists came out of a query. The webview cannot read this off its own search box: a
  // snapshot-driven render can land before the host has processed a keystroke or a clear.
  filtering: boolean;
  // The scope selector's options and its current selection ("" is All Projects).
  projects: readonly string[];
  project: string;
  // Whether a project scope is narrowing these lists. The create verb is computed from it here, since a
  // create needs a target project; the webview reads `createVerb`, not this.
  scoped: boolean;
  createVerb: CreateVerb;
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
  // The Create tests button: authors one remote test per checked scenario card. The command layer owns
  // the confirm, the progress, and the reporting, and reads the same selection this surface holds, so
  // the button and the palette entry run one path.
  bulkCreate(): void;
  // The scope selector's options, read on the same beat as the model: a sync's new catalogue projects
  // appear with the snapshot that carries them. A settings edit alone does not repaint the board, so the
  // list can lag a just-changed sync scope until the next rebuild. That staleness is the price of one
  // refresh path, not an oversight.
  knownProjects(): readonly string[];
  // Where the selection lives between sessions; it also owns coercing a key that has left `knownProjects`
  // back to All Projects.
  readonly projectScope: ProjectScopeStore;
}

// The Mapping/Matrix/Executions surface. It paints all three board panes from one filtered view model
// (the shell owns which pane is visible), forwards drops and execution-link clicks, and re-renders on
// the subsystem's snapshot-change event. Every render round-trips through the vscode-free
// `scopeBoardViewModel` and `filterBoardViewModel`, so the webview JS stays thin and untested.
export class BoardSurface {
  private query = "";
  private model: BoardViewModel;
  private executions: readonly ExecutionRow[];
  private projects: readonly string[];
  private readonly unlinking = new Set<string>();
  // The checked scenario cards, by drop id, in the order they were checked. Scenario cards are never
  // scoped away, so a scope change leaves this alone.
  private readonly selected = new Set<string>();

  constructor(
    private readonly host: SurfaceHost,
    private readonly deps: BoardSurfaceDeps
  ) {
    this.model = deps.buildModel();
    this.executions = deps.buildExecutions();
    this.projects = deps.knownProjects();
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
    if (message.type === "scope") {
      this.deps.projectScope.set(message.project === "" ? undefined : message.project);
      this.render();
      return;
    }
    if (message.type === "select") {
      if (message.on) {
        this.selected.add(message.id);
      } else {
        this.selected.delete(message.id);
      }
      // Re-render so the verb's count and enablement follow the checkbox that just changed.
      this.render();
      return;
    }
    if (message.type === "bulkCreate") {
      this.deps.bulkCreate();
      return;
    }
    this.query = message.value;
    this.render();
  }

  // The bulk-create command reads the selection from here, whether it was fired by the board's button
  // or from the palette.
  public selectedScenarios(): readonly string[] {
    return [...this.selected];
  }

  private refresh(): void {
    this.model = this.deps.buildModel();
    this.executions = this.deps.buildExecutions();
    this.projects = this.deps.knownProjects();
    this.render();
  }

  // Drop checked ids the model no longer carries, against the whole model rather than the rendered
  // slice: a rebuild that traces a scenario (its test was just created and tagged) retires it, while a
  // search that hides a card must not silently uncheck it.
  private pruneSelection(): void {
    const live = new Set(this.model.scenarios.map((card) => card.dropId));
    for (const id of this.selected) {
      if (!live.has(id)) {
        this.selected.delete(id);
      }
    }
  }

  // A create needs a project to land in, so All Projects leaves the button visible but disabled with
  // the reason in its tooltip rather than hiding the verb.
  private createVerb(project: string | undefined): CreateVerb {
    if (project === undefined) {
      return { label: "Create tests", enabled: false, hint: "Pick a project in the header to create tests in." };
    }
    const count = this.selected.size;
    if (count === 0) {
      return { label: "Create tests", enabled: false, hint: "Check the scenarios you want tests for." };
    }
    return {
      label: count === 1 ? `Create 1 test in ${project}` : `Create ${count} tests in ${project}`,
      enabled: true,
      hint: `Creates one test per checked scenario in ${project}.`,
    };
  }

  private render(): void {
    this.pruneSelection();
    const project = this.deps.projectScope.get(this.projects);
    const filtered = filterBoardViewModel(scopeBoardViewModel(this.model, project), this.query);
    const message: RenderMessage = {
      type: "render",
      scenarios: filtered.scenarios.map((card) => ({ ...card, selected: this.selected.has(card.dropId) })),
      available: filtered.available,
      mapped: filtered.mapped,
      matrix: filtered.matrix,
      executions: filterExecutionRows(this.executions, this.query),
      availableEmptyText: filtered.availableEmptyText,
      offerSync: filtered.offerSync,
      filtering: this.query.trim() !== "",
      projects: this.projects,
      project: project ?? "",
      scoped: project !== undefined,
      createVerb: this.createVerb(project),
    };
    this.host.post(message);
  }
}
