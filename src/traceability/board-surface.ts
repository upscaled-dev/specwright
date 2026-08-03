import * as vscode from "vscode";
import {
  BoardPageMeta,
  BoardScenarioCard,
  BoardSectionMeta,
  BoardTestCard,
  BoardViewModel,
  ExecutionRow,
  MatrixGroup,
  filterBoardViewModel,
  filterExecutionRows,
  filterScenarioColumn,
  filterTestColumn,
  groupMatrixRows,
  paginate,
  scopeBoardViewModel,
  sectionFiltering,
} from "./board-data";
import { MappingPageSizeStore } from "./mapping-page-size";
import { ProjectScopeStore } from "./project-scope";
import { SurfaceHost } from "./webview-host";

interface SearchMessage {
  type: "search";
  value: string;
}
// The three card lists of the Mapping tab, each with its own search box and paginator.
type MappingSection = "untraced" | "available" | "mapped";
interface ColumnSearchMessage {
  type: "columnSearch";
  section: MappingSection;
  value: string;
}
// A paginator step, never a page number: the webview posts the direction and the host moves its own
// index, so a stale render can never send the board to a page nobody clicked for.
interface PageMessage {
  type: "page";
  section: MappingSection;
  step: "prev" | "next";
}
interface PageSizeMessage {
  type: "pageSize";
  size: number;
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
interface PushTextMessage {
  type: "pushText";
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
// `target` says which column's checkbox moved: scenario cards and test cards hold separate selections,
// and a scenario's drop id and a test's key are never compared.
interface SelectMessage {
  type: "select";
  target: "scenario" | "test";
  id: string;
  on: boolean;
}
interface BulkCreateMessage {
  type: "bulkCreate";
}
interface CreateTestSetMessage {
  type: "createTestSet";
}
interface CreateTestPlanMessage {
  type: "createTestPlan";
}
interface CreateTestExecutionMessage {
  type: "createTestExecution";
}
interface RunSelectedMessage {
  type: "runSelected";
}
type BoardIncoming =
  | SearchMessage
  | ColumnSearchMessage
  | PageMessage
  | PageSizeMessage
  | DropMessage
  | UnlinkMessage
  | PushTextMessage
  | OpenMessage
  | SyncMessage
  | ScopeMessage
  | SelectMessage
  | BulkCreateMessage
  | CreateTestSetMessage
  | CreateTestPlanMessage
  | CreateTestExecutionMessage
  | RunSelectedMessage;

// One handler per message type, so a new board verb is a new line rather than another branch. Exhaustive
// by construction: a message type with no route is a compile error.
type BoardRoutes = {
  [K in BoardIncoming["type"]]: (message: Extract<BoardIncoming, { type: K }>) => void;
};

// A card plus the host's answer to "is this one checked". The webview holds no selection of its own: it
// paints this flag and posts every checkbox change straight back.
interface SelectableScenarioCard extends BoardScenarioCard {
  readonly selected: boolean;
}
interface SelectableTestCard extends BoardTestCard {
  readonly selected: boolean;
}

// A create button's whole state, decided here so the webview only paints it. `hint` is the button's
// tooltip, which is where a disabled verb says what is missing.
interface CreateVerb {
  readonly label: string;
  readonly enabled: boolean;
  readonly hint: string;
}

interface RenderMessage {
  type: "render";
  // One page of each Mapping section, already sliced. `sections` is what the webview paints its header
  // counts, empty states, and paginators from; deriving any of it from the cards it was handed would go
  // wrong the moment a page is not the whole set.
  scenarios: readonly SelectableScenarioCard[];
  available: readonly SelectableTestCard[];
  mapped: readonly SelectableTestCard[];
  sections: Record<MappingSection, BoardSectionMeta>;
  // The one page size every section runs on, for the pane's dropdown to show as selected.
  pageSize: number;
  matrix: readonly MatrixGroup[];
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
  testSetVerb: CreateVerb;
  testPlanVerb: CreateVerb;
  executionVerb: CreateVerb;
  runSelectedVerb: CreateVerb;
}

// The sync progress strip above the panes. The host composes the whole line, so the webview only paints
// it; an empty text clears the strip, as does the next render.
interface SyncProgressMessage {
  type: "syncProgress";
  text: string;
}

// The board is a document-like surface, so its data source is the stable subsystem, not a one-shot
// snapshot, letting it re-render across syncs and provider swaps while the panel stays open.
// `applyDrop` is the drag-to-link seam: the webview posts a normalized {scenario, key} and the host
// validates and writes the tag, then the snapshot rebuild re-renders the board (no hand-patching here).
export interface BoardSurfaceDeps {
  buildModel(): BoardViewModel;
  // The Executions tab's rows, read from the publish ledger: what this workspace has published, never
  // a live remote query. Rebuilt alongside the model on every refresh.
  buildExecutions(): readonly ExecutionRow[];
  readonly onDidChange: vscode.Event<void>;
  applyDrop(scenario: string, key: string): Promise<void>;
  // The unlink seam: the webview posts a test card row's {scenario, key} and the host validates and
  // removes just that `@TEST_` tag, then the snapshot rebuild re-renders (no hand-patching here).
  applyUnlink(scenario: string, key: string): Promise<void>;
  // The push seam: the same {scenario, key} handle, routed to the push command, which owns the fresh
  // remote read, the confirm, the write, and the reporting. Nothing is decided here.
  pushText(scenario: string, key: string): void;
  // The Sync now button on an empty available group: the same traceability sync the palette runs. A
  // successful run re-renders through the snapshot rebuild; the settled promise is what repaints after
  // a failure, so the button never stays stuck on "Syncing".
  runSync(): Promise<void>;
  // The board's own loads, on open and on a project pick. Whether such a load is worth running at all
  // (a reachable tracker, a project no sync has catalogued) is the host's call, not the board's: the
  // board only says which project it is looking at, and the host keeps the run quiet.
  autoSync(projectKey: string): Promise<void>;
  // An Executions row's key link: routed through the host's browseIssue path.
  openExecution(key: string): void;
  // The Create tests button: authors one remote test per checked scenario card. The command layer owns
  // the confirm, the progress, and the reporting, and reads the same selection this surface holds, so
  // the button and the palette entry run one path.
  bulkCreate(): void;
  // The test column's two buttons: one remote container holding the checked test cards. Same division of
  // labour as `bulkCreate`: the command layer owns the summary prompt, the confirm, and the reporting.
  createTestSet(): void;
  createTestPlan(): void;
  // The Executions tab's button: one empty remote execution in the scoped project, for a later publish to
  // append to. It reads no selection, so only the scope decides whether it can run.
  createTestExecution(): void;
  describeRunSelected(testKeys: readonly string[]): {
    readonly runnable: number;
    readonly skipped: number;
  };
  runSelected(testKeys: readonly string[]): void;
  // The scope selector's options, read on the same beat as the model: a sync's new catalogue projects
  // appear with the snapshot that carries them. A settings edit alone does not repaint the board, so the
  // list can lag a just-changed sync scope until the next rebuild. That staleness is the price of one
  // refresh path, not an oversight.
  knownProjects(): readonly string[];
  // Where the selection lives between sessions; it also owns coercing a key that has left `knownProjects`
  // back to All Projects.
  readonly projectScope: ProjectScopeStore;
  // How many cards a Mapping section shows at a time. Persisted, unlike the searches and the paginator
  // positions, which are per panel.
  readonly mappingPageSize: MappingPageSizeStore;
}

// The Mapping tab's per-section search boxes and paginator positions, all ephemeral per panel. Both
// records are replaced from these constants rather than edited in place, so a reset cannot alias them.
interface MappingViewState {
  query: Record<MappingSection, string>;
  page: Record<MappingSection, number>;
}

const NO_COLUMN_QUERIES: Record<MappingSection, string> = { untraced: "", available: "", mapped: "" };
const FIRST_PAGES: Record<MappingSection, number> = { untraced: 0, available: 0, mapped: 0 };

function prune(selection: Set<string>, live: readonly string[]): void {
  const known = new Set(live);
  for (const id of selection) {
    if (!known.has(id)) {
      selection.delete(id);
    }
  }
}

// The Mapping/Matrix/Executions surface. It paints all three board panes from one filtered view model
// (the shell owns which pane is visible), forwards drops and execution-link clicks, and re-renders on
// the subsystem's snapshot-change event. Every render round-trips through the vscode-free
// `scopeBoardViewModel`, `filterBoardViewModel`, and `groupMatrixRows`, so the webview JS stays thin and
// untested; what it does own is display state the host never sees (which matrix groups are folded open,
// how far the executions window is pulled down).
export class BoardSurface {
  private query = "";
  private mapping: MappingViewState = { query: { ...NO_COLUMN_QUERIES }, page: { ...FIRST_PAGES } };
  private model: BoardViewModel;
  private executions: readonly ExecutionRow[];
  private projects: readonly string[];
  private readonly unlinking = new Set<string>();
  // The checked scenario cards, by drop id, and the checked test cards, by key, each in the order they
  // were checked. A scope change narrows what is painted, never what is checked.
  private readonly selectedScenarioIds = new Set<string>();
  private readonly selectedTestKeys = new Set<string>();

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
    const stored = deps.projectScope.get(this.projects);
    if (stored !== undefined) {
      this.autoSync(stored);
    }
  }

  // Field initializers run before the constructor body, so every route may only CLOSE OVER `this.deps`
  // and never dereference it here: at this point the constructor has not assigned it yet.
  private readonly routes: BoardRoutes = {
    search: (message) => {
      this.query = message.value;
      this.mapping.page = { ...FIRST_PAGES };
      this.render();
    },
    columnSearch: (message) => {
      this.mapping.query[message.section] = message.value;
      this.mapping.page[message.section] = 0;
      this.render();
    },
    // The step lands on the host's own index, and `paginate` clamps it, so both ends hold without the
    // webview knowing how many pages there are.
    page: (message) => {
      this.mapping.page[message.section] += message.step === "next" ? 1 : -1;
      this.render();
    },
    pageSize: (message) => {
      this.deps.mappingPageSize.set(message.size);
      this.mapping.page = { ...FIRST_PAGES };
      this.render();
    },
    // The write, its snapshot rebuild, and the follow-up re-render are the host's job. Nothing is posted
    // back here: a valid drop re-renders via onDidChange, a stale one toasts and leaves the board as-is
    // for a retry.
    drop: (message) => {
      this.deps.applyDrop(message.scenario, message.key).catch(() => undefined);
    },
    unlink: (message) => this.unlinkRow(message.scenario, message.key),
    pushText: (message) => this.deps.pushText(message.scenario, message.key),
    open: (message) => this.deps.openExecution(message.key),
    sync: () => this.syncNow(),
    scope: (message) => this.scopeTo(message.project),
    select: (message) => this.toggleSelection(message.target, message.id, message.on),
    bulkCreate: () => this.deps.bulkCreate(),
    createTestSet: () => this.deps.createTestSet(),
    createTestPlan: () => this.deps.createTestPlan(),
    createTestExecution: () => this.deps.createTestExecution(),
    runSelected: () => this.deps.runSelected([...this.selectedTestKeys]),
  };

  private handle(message: BoardIncoming): void {
    // The webview is trusted to post known types, but the message still arrives untyped: an own-property
    // check is what keeps an unknown type a no-op and a prototype name like `toString` from resolving to
    // something callable. The cast only erases the per-key narrowing TypeScript cannot carry through a
    // dynamic index, since the map is exhaustive over `BoardIncoming`.
    if (!Object.hasOwn(this.routes, message.type)) {
      return;
    }
    (this.routes[message.type] as (routed: BoardIncoming) => void)(message);
  }

  // A row already being unlinked is ignored: the board only re-renders once the snapshot rebuilds, so a
  // second click would resolve against the pre-edit document and strip the wrong line.
  private unlinkRow(scenario: string, key: string): void {
    const row = `${scenario}\n${key}`;
    if (this.unlinking.has(row)) {
      return;
    }
    this.unlinking.add(row);
    this.deps
      .applyUnlink(scenario, key)
      .finally(() => this.unlinking.delete(row))
      .catch(() => undefined);
  }

  private syncNow(): void {
    this.deps
      .runSync()
      .finally(() => this.render())
      .catch(() => undefined);
  }

  // The board's quiet load. Nothing is posted and nothing repaints here: the host reports it through the
  // progress strip, and the snapshot rebuild is what brings the new tests in.
  private autoSync(project: string): void {
    this.deps.autoSync(project).catch(() => undefined);
  }

  private scopeTo(project: string): void {
    this.deps.projectScope.set(project === "" ? undefined : project);
    this.mapping.page = { ...FIRST_PAGES };
    this.render();
    // Picking a project is also a load instruction. The key rides the request, so the run covers what was
    // just picked whether or not the store's write has settled; All projects asks for nothing.
    if (project !== "") {
      this.autoSync(project);
    }
  }

  // A sync's live line for the strip above the panes, or "" to clear it. Posted straight through the
  // shell's queue, so a board that has closed simply drops it.
  public syncProgress(text: string): void {
    const message: SyncProgressMessage = { type: "syncProgress", text };
    this.host.post(message);
  }

  private toggleSelection(target: SelectMessage["target"], id: string, on: boolean): void {
    const selection = target === "test" ? this.selectedTestKeys : this.selectedScenarioIds;
    if (on) {
      selection.add(id);
    } else {
      selection.delete(id);
    }
    // Re-render so the verb's count and enablement follow the checkbox that just changed.
    this.render();
  }

  // The authoring commands read their selection from here, whether they were fired by the board's
  // buttons or from the palette.
  public selectedScenarios(): readonly string[] {
    return [...this.selectedScenarioIds];
  }

  public selectedTests(): readonly string[] {
    return [...this.selectedTestKeys];
  }

  private refresh(): void {
    this.model = this.deps.buildModel();
    this.executions = this.deps.buildExecutions();
    this.projects = this.deps.knownProjects();
    this.render();
  }

  // A rebuilt webview comes back with empty search boxes and every paginator on page 1, so the state
  // they were filtering behind goes with them; keeping it would leave the board narrowed and scrolled by
  // controls that no longer show any of it.
  public rehydrate(): void {
    this.query = "";
    this.mapping = { query: { ...NO_COLUMN_QUERIES }, page: { ...FIRST_PAGES } };
    this.refresh();
  }

  // Drop checked ids the board no longer offers, against the model rather than the rendered slice, so a
  // search that hides a card never silently unchecks it. Scenario cards are never scoped away, so they
  // are pruned against the whole model; test cards are pruned against the SCOPED one, so a container can
  // only ever hold tests whose checked boxes were on screen, so the count in its confirm is what the eye
  // can verify. Both test groups count as live, since a checked available test stays checked once a link
  // moves it to the mapped group. A key pruned here also leaves `selectedTests`, so a scope change during
  // the command's name prompt shrinks what it goes on to create; `runContainerCreate`'s fail-fast is what
  // guarantees the container never gains a member nobody saw.
  private pruneSelection(scoped: BoardViewModel): void {
    prune(this.selectedScenarioIds, this.model.scenarios.map((card) => card.dropId));
    prune(this.selectedTestKeys, [...scoped.available, ...scoped.mapped].map((card) => card.key));
  }

  // A create needs a project to land in, so All Projects leaves the button visible but disabled with
  // the reason in its tooltip rather than hiding the verb.
  private createVerb(project: string | undefined): CreateVerb {
    if (project === undefined) {
      return { label: "Create tests", enabled: false, hint: "Pick a project in the header to create tests in." };
    }
    const count = this.selectedScenarioIds.size;
    if (count === 0) {
      return { label: "Create tests", enabled: false, hint: "Check the scenarios you want tests for." };
    }
    return {
      label: count === 1 ? `Create 1 test in ${project}` : `Create ${count} tests in ${project}`,
      enabled: true,
      hint: `Creates one test per checked scenario in ${project}.`,
    };
  }

  // The two test-column verbs share one state machine, `noun` being the only difference: a container
  // needs a project to land in and at least one checked test, and a disabled button says which is
  // missing in its tooltip.
  private containerVerb(noun: string, project: string | undefined): CreateVerb {
    const label = `Create ${noun}`;
    if (project === undefined) {
      return { label, enabled: false, hint: `Pick a project in the header to create a ${noun} in.` };
    }
    const count = this.selectedTestKeys.size;
    if (count === 0) {
      return { label, enabled: false, hint: `Check the tests you want in the ${noun}.` };
    }
    const tests = count === 1 ? "1 test" : `${count} tests`;
    return {
      label: `${label} from ${tests}`,
      enabled: true,
      hint: `Creates one ${noun} in ${project} holding the checked ${tests}.`,
    };
  }

  // The Executions verb reads no selection: an empty execution needs only a project to land in, so the
  // scope is the whole of its state.
  private executionVerb(project: string | undefined): CreateVerb {
    const label = "Create Execution";
    if (project === undefined) {
      return { label, enabled: false, hint: "Pick a project in the header to create an execution in." };
    }
    return {
      label: `${label} in ${project}`,
      enabled: true,
      hint: `Creates an empty Test Execution in ${project} for a later publish to append to.`,
    };
  }

  private runSelectedVerb(): CreateVerb {
    const checked = this.selectedTestKeys.size;
    const label = "Run and publish selected";
    if (checked === 0) {
      return { label, enabled: false, hint: "Check mapped tests to run and publish their scenarios." };
    }
    const { runnable, skipped } = this.deps.describeRunSelected([...this.selectedTestKeys]);
    const skippedText = skipped === 0
      ? ""
      : ` ${skipped} checked ${skipped === 1 ? "test has" : "tests have"} no mapped scenario and will be skipped.`;
    if (runnable === 0) {
      return { label, enabled: false, hint: `No mapped scenarios will run.${skippedText}` };
    }
    return {
      label,
      enabled: true,
      hint: `${runnable} mapped ${runnable === 1 ? "scenario" : "scenarios"} will run and publish.${skippedText}`,
    };
  }

  // What a section's meta says beyond its page arithmetic: `total` is the count the header shows, before
  // the column search but after the header one, and the two flags are the ones the webview must not work
  // out from its own inputs.
  private sectionMeta(section: MappingSection, page: BoardPageMeta, total: number): BoardSectionMeta {
    return {
      ...page,
      total,
      filtering: sectionFiltering(this.query, this.mapping.query[section]),
      query: this.mapping.query[section],
    };
  }

  private render(): void {
    const project = this.deps.projectScope.get(this.projects);
    const scoped = scopeBoardViewModel(this.model, project);
    this.pruneSelection(scoped);
    const filtered = filterBoardViewModel(scoped, this.query);
    const checkedTest = (card: BoardTestCard): SelectableTestCard => ({
      ...card,
      selected: this.selectedTestKeys.has(card.key),
    });
    // Header search, then the section's own search, then one page of what is left. Selection is stamped
    // before the column filter so a checked card off the page keeps its flag for the verb counts.
    const pageSize = this.deps.mappingPageSize.get();
    const scenarios = filtered.scenarios.map((card) => ({
      ...card,
      selected: this.selectedScenarioIds.has(card.dropId),
    }));
    const untraced = paginate(
      filterScenarioColumn(scenarios, this.mapping.query.untraced),
      this.mapping.page.untraced,
      pageSize
    );
    const available = paginate(
      filterTestColumn(filtered.available.map(checkedTest), this.mapping.query.available),
      this.mapping.page.available,
      pageSize
    );
    const mapped = paginate(
      filterTestColumn(filtered.mapped.map(checkedTest), this.mapping.query.mapped),
      this.mapping.page.mapped,
      pageSize
    );
    // Adopt the clamped indexes. A clamp that lived only in the render would resurface the stale index the
    // moment a search cleared and the section grew back.
    this.mapping.page = {
      untraced: untraced.meta.page,
      available: available.meta.page,
      mapped: mapped.meta.page,
    };
    const message: RenderMessage = {
      type: "render",
      scenarios: untraced.items,
      available: available.items,
      mapped: mapped.items,
      sections: {
        untraced: this.sectionMeta("untraced", untraced.meta, filtered.scenarios.length),
        available: this.sectionMeta("available", available.meta, filtered.available.length),
        mapped: this.sectionMeta("mapped", mapped.meta, filtered.mapped.length),
      },
      pageSize,
      matrix: groupMatrixRows(filtered.matrix),
      executions: filterExecutionRows(this.executions, this.query),
      availableEmptyText: filtered.availableEmptyText,
      offerSync: filtered.offerSync,
      filtering: sectionFiltering(this.query, ""),
      projects: this.projects,
      project: project ?? "",
      scoped: project !== undefined,
      createVerb: this.createVerb(project),
      testSetVerb: this.containerVerb("Test Set", project),
      testPlanVerb: this.containerVerb("Test Plan", project),
      executionVerb: this.executionVerb(project),
      runSelectedVerb: this.runSelectedVerb(),
    };
    this.host.post(message);
  }
}
