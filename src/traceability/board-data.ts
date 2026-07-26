import * as path from "node:path";
import type { KeyGrammar } from "./contracts";
import type { LedgerEntry } from "./publish-ledger";
import type { ScenarioRef } from "./scenario-ref";
import type {
  TraceabilitySnapshot,
  TraceLink,
  UntracedScenario,
} from "./traceability-model";

// An untraced scenario rendered as a card in the board's left column. `location` is the
// workspace-relative "path:line" the card shows; `dropId` is its unambiguous drag-to-link identity
// (see `scenarioDropId`), never shown. `pills` are the short markers ("no tag" for a plain scenario,
// "outline" + an example count for an untagged outline). `reqKeys` are carried for the header filter
// but not shown as pills.
export interface BoardScenarioCard {
  readonly name: string;
  readonly location: string;
  readonly dropId: string;
  readonly pills: readonly string[];
  readonly reqKeys: readonly string[];
}

// One linked scenario shown as a row on a mapped test card: its name and workspace-relative
// "path:line" for display, plus `unlinkId` — the scenario's `scenarioDropId` — the handle the row's
// Unlink button posts back so the removal resolves to exactly this scenario.
export interface BoardTestLink {
  readonly name: string;
  readonly location: string;
  readonly unlinkId: string;
}

// A remote test rendered as a card in one of the right column's two groups. `summary` is the synced
// remote summary when present. An available test (no local scenario maps to it) carries no pills and
// no links; a mapped test carries its linked-scenario count and one row per linked scenario. `project`
// is the key's project, what the board's scope selector compares against.
export interface BoardTestCard {
  readonly key: string;
  readonly summary?: string | undefined;
  readonly project?: string | undefined;
  readonly pills: readonly string[];
  readonly links: readonly BoardTestLink[];
}

// One row of the Matrix tab, columns left to right. A coverage hole is an empty string: a requirement
// with no test leaves `test` empty, a test with no scenario leaves `scenario` empty, an untraced
// scenario leaves `tag` empty. `result` is always spelled out ("no run" for an untraced scenario,
// "no coverage" for an orphan test that covers nothing). `projects` are the projects the row evidences,
// which is what the board's scope selector compares against; empty means it evidences none.
export interface MatrixRow {
  readonly requirement: string;
  readonly test: string;
  readonly scenario: string;
  readonly tag: string;
  readonly result: string;
  readonly projects: readonly string[];
}

export interface BoardViewModel {
  readonly scenarios: readonly BoardScenarioCard[];
  readonly available: readonly BoardTestCard[];
  readonly mapped: readonly BoardTestCard[];
  readonly matrix: readonly MatrixRow[];
  // What the right column says when the available group is empty, and whether that emptiness is worth
  // offering a sync over (see `availableEmptyState`).
  readonly availableEmptyText: string;
  readonly offerSync: boolean;
}

// The available group's empty state, by what the user can do about it. Without sync scope no sync
// helps, since completeness never reaches "complete" without project keys. With scope but no complete
// catalogue, a sync is the fix. A complete catalogue that yields nothing has nothing to offer, and
// saying every test is mapped would be a lie when the sync catalogued no tests at all.
function availableEmptyState(
  syncScopeConfigured: boolean,
  completeness: TraceabilitySnapshot["completeness"] | undefined
): { availableEmptyText: string; offerSync: boolean } {
  if (!syncScopeConfigured) {
    return {
      availableEmptyText: "Add project keys to playwrightBddRunner.xray.syncProjectKeys to list available tests.",
      offerSync: false,
    };
  }
  if (completeness !== "complete") {
    return { availableEmptyText: "No synced tests yet.", offerSync: true };
  }
  return { availableEmptyText: "No unmapped tests in the last sync.", offerSync: false };
}

// Best-fit workspace-relative path with forward slashes (a Playwright grep/path regex never sees a
// backslash — see the regex-path gotcha). Picks the root that contains the file; falls back to the
// absolute path forward-slashed when the file sits outside every root.
function toWorkspaceRelative(filePath: string, roots: readonly string[]): string {
  let best: string | undefined;
  for (const root of roots) {
    const rel = path.relative(root, filePath);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && (best === undefined || rel.length < best.length)) {
      best = rel;
    }
  }
  return (best ?? filePath).replaceAll("\\", "/");
}

function countLabel(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`;
}

function scenarioPills(item: UntracedScenario): string[] {
  if (item.scenario.kind === "outline") {
    const pills = ["outline"];
    if (item.examples !== undefined) {
      pills.push(countLabel(item.examples, "example"));
    }
    return pills;
  }
  return ["no tag"];
}

// The drag-to-link identity for a scenario card: its absolute path, line, and name together, so a
// dropped card resolves back to exactly one untraced scenario. Unlike the display `location` (a
// workspace-relative path that can repeat across roots), this never collides; and because it pins the
// line and name, a rebuild that shifts the scenario or swaps a different scenario onto the same line
// yields a different id, so a stale drop fails to match and is rejected rather than mis-tagging.
export function scenarioDropId(scenario: ScenarioRef): string {
  return [scenario.filePath, scenario.line, scenario.name].join("\n");
}

// The display "path:line" a scenario shows: its workspace-relative path with the 1-based line. Repeats
// across roots (unlike `scenarioDropId`), so it is for display and search only, never identity.
function scenarioLocation(scenario: ScenarioRef, roots: readonly string[]): string {
  return `${toWorkspaceRelative(scenario.filePath, roots)}:${scenario.line}`;
}

function scenarioCard(item: UntracedScenario, roots: readonly string[]): BoardScenarioCard {
  return {
    name: item.scenario.name,
    location: scenarioLocation(item.scenario, roots),
    dropId: scenarioDropId(item.scenario),
    pills: scenarioPills(item),
    reqKeys: item.reqKeys,
  };
}

function nonEmptySummary(summary: string | undefined): string | undefined {
  return summary !== undefined && summary !== "" ? summary : undefined;
}

// A key's project, or undefined when none can be derived. Uppercased like the scope selector's options
// (`knownProjectKeys`), since the grammar's `canonicalizeKey` is not required to be: both sides of the
// scope compare have to normalize the same way. Never the empty string, so a scope compare stays a plain
// field match and an underivable key falls outside every project.
function keyProject(projectOf: KeyGrammar["projectOf"], key: string): string | undefined {
  const project = projectOf?.(key).trim().toUpperCase();
  return project !== undefined && project !== "" ? project : undefined;
}

// The projects a matrix row evidences: its test key's, or, for a row with no test key, every one of its
// requirement keys'. A scenario tagged with two projects' requirements is a coverage hole in both. A row
// that evidences none comes back empty and stays visible under every scope.
function rowProjects(projectOf: KeyGrammar["projectOf"], testKey: string, reqKeys: readonly string[]): string[] {
  const projects = new Set<string>();
  for (const key of testKey !== "" ? [testKey] : reqKeys) {
    const project = keyProject(projectOf, key);
    if (project !== undefined) {
      projects.add(project);
    }
  }
  return [...projects];
}

// One row per linked scenario, keyed by `scenarioDropId` so the row round-trips back to exactly that
// scenario. An outline's Examples blocks stay apart, each owning its own tag. Sorted by name, then by
// location so blocks sharing a name (an unnamed block falls back to the outline's) hold their order.
function cardLinks(group: readonly TraceLink[], roots: readonly string[]): BoardTestLink[] {
  const rows = new Map<string, BoardTestLink>();
  for (const link of group) {
    const unlinkId = scenarioDropId(link.scenario);
    rows.set(unlinkId, { name: link.scenario.name, location: scenarioLocation(link.scenario, roots), unlinkId });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
}

function mappedTestCards(links: readonly TraceLink[], roots: readonly string[], projectOf: KeyGrammar["projectOf"]): BoardTestCard[] {
  const byKey = new Map<string, TraceLink[]>();
  for (const link of links) {
    const list = byKey.get(link.testKey) ?? [];
    list.push(link);
    byKey.set(link.testKey, list);
  }
  const cards: BoardTestCard[] = [];
  for (const [key, group] of byKey) {
    const rows = cardLinks(group, roots);
    const summary = nonEmptySummary(group[0]?.meta?.summary);
    cards.push({
      key,
      project: keyProject(projectOf, key),
      // The pill counts the rows, so the card's headline and the list under it can never disagree.
      pills: [countLabel(rows.length, "scenario")],
      links: rows,
      ...(summary !== undefined ? { summary } : {}),
    });
  }
  return cards.sort((a, b) => a.key.localeCompare(b.key));
}

function linkResult(link: TraceLink): string {
  if (link.iterations) {
    return `${link.iterations.passed}/${link.iterations.total}`;
  }
  return link.lastResult ?? "no run";
}

// Empty cells sort last so a column's filled values group ahead of its holes. Rows read requirement,
// then test, then scenario, so a requirement's tests and their scenarios stay together.
function byCell(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a === "") {
    return 1;
  }
  if (b === "") {
    return -1;
  }
  return a.localeCompare(b);
}

function compareMatrixRows(a: MatrixRow, b: MatrixRow): number {
  return byCell(a.requirement, b.requirement) || byCell(a.test, b.test) || byCell(a.scenario, b.scenario);
}

function matrixRows(snapshot: TraceabilitySnapshot, testTagPrefix: string, projectOf: KeyGrammar["projectOf"]): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const link of snapshot.links) {
    rows.push({
      requirement: link.reqKeys.join(", "),
      test: link.testKey,
      scenario: link.scenario.name,
      tag: `@${testTagPrefix}${link.testKey}`,
      result: linkResult(link),
      projects: rowProjects(projectOf, link.testKey, link.reqKeys),
    });
  }
  for (const item of snapshot.untraced) {
    rows.push({
      requirement: item.reqKeys.join(", "),
      test: "",
      scenario: item.scenario.name,
      tag: "",
      result: "no run",
      projects: rowProjects(projectOf, "", item.reqKeys),
    });
  }
  for (const orphan of snapshot.orphans) {
    rows.push({
      requirement: "",
      test: orphan.testKey,
      scenario: "",
      tag: "",
      result: "no coverage",
      projects: rowProjects(projectOf, orphan.testKey, []),
    });
  }
  return rows.sort(compareMatrixRows);
}

/**
 * Assemble the read-only Coverage Board view-model from the traceability snapshot: the untraced
 * scenarios become the left column's cards, and the right column's two groups are the available tests
 * (no local scenario maps to them, so they are what a scenario can be dropped onto) shown first and the
 * mapped tests (grouped by key, with their linked scenario count and one unlinkable row per linked
 * scenario) shown below, each key-sorted. The matrix rows join requirement, test, scenario, the in-file
 * `@<prefix><key>` tag, and last result, one row per link, untraced scenario, and orphan. Renders
 * offline from tags alone — with no remote sync, `orphans` is empty and mapped cards carry no summary.
 * An undefined snapshot (panel off or still building) yields empty columns, still with the available
 * group's empty state so the board explains itself before the first sync.
 */
export function buildBoardViewModel(
  snapshot: TraceabilitySnapshot | undefined,
  workspaceRoots: readonly string[],
  testTagPrefix: string,
  syncScopeConfigured: boolean,
  projectOf?: KeyGrammar["projectOf"]
): BoardViewModel {
  const emptyState = availableEmptyState(syncScopeConfigured, snapshot?.completeness);
  if (!snapshot) {
    return { scenarios: [], available: [], mapped: [], matrix: [], ...emptyState };
  }
  const scenarios = snapshot.untraced
    .map((item) => scenarioCard(item, workspaceRoots))
    .sort((a, b) => a.name.localeCompare(b.name));
  const available = snapshot.orphans
    .map((orphan): BoardTestCard => {
      const summary = nonEmptySummary(orphan.meta.summary);
      return {
        key: orphan.testKey,
        project: keyProject(projectOf, orphan.testKey),
        pills: [],
        links: [],
        ...(summary !== undefined ? { summary } : {}),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    scenarios,
    available,
    mapped: mappedTestCards(snapshot.links, workspaceRoots, projectOf),
    matrix: matrixRows(snapshot, testTagPrefix, projectOf),
    ...emptyState,
  };
}

export interface BoardDropResolution {
  readonly ref: ScenarioRef;
  readonly key: string;
}

/**
 * Validate a drag-to-link drop against the CURRENT snapshot and resolve the scenario it names to a
 * `ScenarioRef` for the tag insert. `dropId` is the dragged card's `scenarioDropId` (absolute path +
 * line + name); `key` is the dropped test. Returns undefined when either side no longer exists (a drop
 * staged before a rebuild names a stale card, or a rebuild moved that scenario) so the caller can
 * reject it instead of tagging blind. Direction is already normalized by the webview, so a
 * scenario-onto-test and a test-onto-scenario drop arrive the same way.
 */
export function resolveBoardDrop(
  snapshot: TraceabilitySnapshot | undefined,
  dropId: string,
  key: string
): BoardDropResolution | undefined {
  if (!snapshot) {
    return undefined;
  }
  const untraced = snapshot.untraced.find((item) => scenarioDropId(item.scenario) === dropId);
  if (!untraced) {
    return undefined;
  }
  const known =
    snapshot.links.some((link) => link.testKey === key) || snapshot.orphans.some((orphan) => orphan.testKey === key);
  if (!known) {
    return undefined;
  }
  return { ref: untraced.scenario, key };
}

/**
 * The unlink twin of `resolveBoardDrop`: validate a test card's unlink against the CURRENT snapshot and
 * resolve the scenario+key pair to a `ScenarioRef` for the tag removal. `dropId` is the row's
 * `unlinkId` (the scenario's `scenarioDropId`); `key` is the card's test. Returns undefined when no
 * live link matches both (a rebuild dropped that link, or the row named a stale scenario) so the caller
 * rejects it instead of removing blind.
 */
export function resolveBoardUnlink(
  snapshot: TraceabilitySnapshot | undefined,
  dropId: string,
  key: string
): BoardDropResolution | undefined {
  const link = snapshot?.links.find((item) => scenarioDropId(item.scenario) === dropId && item.testKey === key);
  return link ? { ref: link.scenario, key } : undefined;
}

// One row of the Executions tab. Every cell is render-ready text (dates as ISO days, a plain dash
// where an older ledger entry recorded no counts), except `timesFromHere` — the per-key publish count
// the panel renders as its own column. `action` is the create/append the publish took.
export interface ExecutionRow {
  readonly key: string;
  readonly summary: string;
  readonly action: string;
  readonly resultsImported: string;
  readonly passRate: string;
  readonly publishedAt: string;
  readonly timesFromHere: number;
}

const DASH = "-";

function executionAction(mode: LedgerEntry["mode"]): string {
  if (mode === "create-new") {
    return "Created";
  }
  if (mode === "append") {
    return "Appended";
  }
  return DASH;
}

// Imported reads the recorded `total` (the whole publishable count); the pass rate is honest only when
// passed+failed+skipped accounts for every imported result, so a run with a timed-out or interrupted
// result — where the three counts fall short of `total` — dashes the rate rather than overstating it.
function executionImported(entry: LedgerEntry): string {
  return entry.total === undefined ? DASH : String(entry.total);
}

function executionPassRate(entry: LedgerEntry): string {
  if (entry.passed === undefined || entry.failed === undefined || entry.skipped === undefined || entry.total === undefined) {
    return DASH;
  }
  if (entry.passed + entry.failed + entry.skipped !== entry.total) {
    return DASH;
  }
  return `${entry.passed}/${entry.total} passed`;
}

/**
 * The Executions tab rows (vscode-free), newest first, over the site-scoped publish ledger. No live
 * remote execution query exists, so this reflects only what this workspace has published: each row
 * carries the execution key, its summary, whether the publish created or appended, the imported result
 * count (the recorded total) and pass rate (rendered only when the recorded pass/fail/skip counts add
 * up to that total, else a dash), the ISO publish date, and how many ledger entries published to that
 * same key.
 */
export function buildExecutionRows(entries: readonly LedgerEntry[]): ExecutionRow[] {
  const timesByKey = new Map<string, number>();
  for (const entry of entries) {
    timesByKey.set(entry.executionRef, (timesByKey.get(entry.executionRef) ?? 0) + 1);
  }
  return [...entries]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map((entry) => ({
      key: entry.executionRef,
      summary: entry.summary ?? "",
      action: executionAction(entry.mode),
      resultsImported: executionImported(entry),
      passRate: executionPassRate(entry),
      publishedAt: new Date(entry.publishedAt).toISOString().slice(0, 10),
      timesFromHere: timesByKey.get(entry.executionRef) ?? 1,
    }));
}

// The Executions header search: case-insensitive substring over the execution key and its summary. An
// empty query returns the rows untouched.
export function filterExecutionRows(rows: readonly ExecutionRow[], query: string): readonly ExecutionRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return rows;
  }
  return rows.filter((row) => row.key.toLowerCase().includes(needle) || row.summary.toLowerCase().includes(needle));
}

/**
 * Narrow the board to one project, or hand it back whole for All Projects (undefined). A compare over
 * the projects stamped at build time: a test card is in scope when its key's project matches, and a
 * matrix row when it evidences that project, whether through its test key or through any of its
 * requirement keys. A row that evidences no project at all stays visible under every scope, so an
 * untraced scenario's coverage hole never hides behind a filter. Scenario cards are local, not remote,
 * so they are never scoped away, and the available group's empty state stays whatever the build decided.
 */
export function scopeBoardViewModel(model: BoardViewModel, project: string | undefined): BoardViewModel {
  if (project === undefined) {
    return model;
  }
  const inScope = (card: BoardTestCard): boolean => card.project === project;
  return {
    ...model,
    available: model.available.filter(inScope),
    mapped: model.mapped.filter(inScope),
    matrix: model.matrix.filter((row) => row.projects.length === 0 || row.projects.includes(project)),
  };
}

// The header search: case-insensitive substring over a test's key/summary and any of its linked
// scenario rows (name or location), over a scenario card's name, its workspace-relative location (the
// file path), and its requirement tags, plus a match across all five matrix columns. Both test groups
// take the same predicate, and a matched test card keeps all its rows. One function the panel calls on
// every keystroke; an empty query returns the model untouched.
export function filterBoardViewModel(model: BoardViewModel, query: string): BoardViewModel {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return model;
  }
  const matchesTest = (card: BoardTestCard): boolean =>
    card.key.toLowerCase().includes(needle) ||
    (card.summary ?? "").toLowerCase().includes(needle) ||
    card.links.some((row) => row.name.toLowerCase().includes(needle) || row.location.toLowerCase().includes(needle));
  return {
    scenarios: model.scenarios.filter(
      (card) =>
        card.name.toLowerCase().includes(needle) ||
        card.location.toLowerCase().includes(needle) ||
        card.reqKeys.some((key) => key.toLowerCase().includes(needle))
    ),
    available: model.available.filter(matchesTest),
    mapped: model.mapped.filter(matchesTest),
    matrix: model.matrix.filter((row) =>
      [row.requirement, row.test, row.scenario, row.tag, row.result].some((cell) => cell.toLowerCase().includes(needle))
    ),
    availableEmptyText: model.availableEmptyText,
    offerSync: model.offerSync,
  };
}
