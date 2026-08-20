import * as path from "node:path";
import type { KeyGrammar, SyncProgressEvent } from "./contracts";
import { isOutcomeUnknownEntry, type LedgerEntry } from "./publish-ledger";
import { executionLabel, hasExecutionRef } from "./publish-core";
import type { ScenarioRef } from "./scenario-ref";
import type {
  TraceabilitySnapshot,
  TraceLink,
  UntracedScenario,
} from "./traceability-model";

// An untraced scenario rendered as a card in the board's left column. `location` is the
// workspace-relative "path:line" the card shows; `dropId` is its unambiguous drag-to-link identity
// (see `scenarioDropId`), never shown. `pills` are the short markers an outline needs ("outline" plus
// an example count); a plain scenario carries none, since every card in this column is untraced and a
// pill saying so on all of them marks nothing. `reqKeys` are carried for the header filter but not
// shown as pills.
export interface BoardScenarioCard {
  readonly name: string;
  readonly location: string;
  readonly dropId: string;
  readonly pills: readonly string[];
  readonly reqKeys: readonly string[];
}

// One linked scenario shown as a row on a mapped test card: its name and workspace-relative
// "path:line" for display, plus `unlinkId`, the scenario's `scenarioDropId`, the handle the row's
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
// "no coverage" for an orphan test that covers nothing). `file` is the workspace-relative feature file
// the row's scenario lives in, the axis the tab folds by; a row with no scenario carries none.
// `projects` are the projects the row evidences, which is what the board's scope selector compares
// against; empty means it evidences none.
export interface MatrixRow {
  readonly requirement: string;
  readonly test: string;
  readonly scenario: string;
  readonly tag: string;
  readonly result: string;
  readonly file: string;
  readonly projects: readonly string[];
}

// One feature file's fold on the Matrix tab. `file` is both the header label and the group's identity in
// the webview's expanded set; the rows with no feature file (the available tests, which no scenario
// covers) group under "" and, like an empty cell, sort last. `count` is what a collapsed header reports,
// since a collapsed group renders none of its rows.
export interface MatrixGroup {
  readonly file: string;
  readonly count: number;
  readonly rows: readonly MatrixRow[];
}

export interface BoardViewModel {
  readonly scenarios: readonly BoardScenarioCard[];
  readonly available: readonly BoardTestCard[];
  readonly mapped: readonly BoardTestCard[];
  readonly matrix: readonly MatrixRow[];
  // What the right column says when the available group is empty.
  readonly availableEmptyText: string;
  // The projects whose catalogue the last sync fetched whole, carried so scoping to one project can
  // re-decide the empty state for that project alone (see `scopeBoardViewModel`).
  readonly completeProjects: readonly string[];
}

// The available group's empty state, by what the user can do about it. With nothing in the resolved
// sync scope no sync helps, since no project's catalogue can be fetched without project keys, and the
// header's project selector is the fastest way to put one there. With a scope but no catalogue landed,
// a sync is the fix. A landed catalogue that yields nothing has nothing to offer, and saying every test
// is mapped would be a lie when the sync catalogued no tests at all.
function availableEmptyText(
  syncScopeResolved: boolean,
  landed: boolean
): string {
  if (!syncScopeResolved) {
    return "Pick a project in the header to load its tests.";
  }
  if (!landed) {
    return "No synced tests yet.";
  }
  return "No unmapped tests in the last sync.";
}

/**
 * The progress strip's live text while a sync pages a project's catalogue. The remote does not always
 * report a total, so a page without one says only what is in hand.
 */
export function syncProgressText(event: SyncProgressEvent): string {
  const tests = countLabel(event.total ?? event.fetched, "test");
  return event.total === undefined
    ? `Syncing ${event.projectKey}: ${tests}`
    : `Syncing ${event.projectKey}: ${event.fetched} of ${tests}`;
}

// What the strip says between the last page and the repaint that carries the new tests; the render
// itself clears it.
export const RENDERING_PROGRESS = "Rendering…";

// Best-fit workspace-relative path with forward slashes (a Playwright grep/path regex never sees a
// backslash; see the regex-path gotcha). Picks the root that contains the file; falls back to the
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
  if (item.scenario.kind !== "outline") {
    return [];
  }
  const pills = ["outline"];
  if (item.examples !== undefined) {
    pills.push(countLabel(item.examples, "example"));
  }
  return pills;
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
// (`normalizeProjectKeys`), since the grammar's `canonicalizeKey` is not required to be: both sides of the
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

function matrixRows(
  snapshot: TraceabilitySnapshot,
  roots: readonly string[],
  testTagPrefix: string,
  projectOf: KeyGrammar["projectOf"]
): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const link of snapshot.links) {
    rows.push({
      requirement: link.reqKeys.join(", "),
      test: link.testKey,
      scenario: link.scenario.name,
      tag: `@${testTagPrefix}${link.testKey}`,
      result: linkResult(link),
      file: toWorkspaceRelative(link.scenario.filePath, roots),
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
      file: toWorkspaceRelative(item.scenario.filePath, roots),
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
      file: "",
      projects: rowProjects(projectOf, orphan.testKey, []),
    });
  }
  return rows.sort(compareMatrixRows);
}

/**
 * Fold matrix rows into one group per feature file, the shape the Matrix tab renders. Groups are ordered
 * by file, the rows with no feature file last, and each group holds its rows in the order it was given
 * them, so the row sort survives the fold. Run after the scope and the query, so a group holds exactly
 * the rows on screen and an empty one never reaches the webview.
 */
export function groupMatrixRows(rows: readonly MatrixRow[]): MatrixGroup[] {
  const byFile = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    const group = byFile.get(row.file) ?? [];
    group.push(row);
    byFile.set(row.file, group);
  }
  return [...byFile]
    .map(([file, group]) => ({ file, count: group.length, rows: group }))
    .sort((a, b) => byCell(a.file, b.file));
}

/**
 * Assemble the read-only Coverage Board view-model from the traceability snapshot: the untraced
 * scenarios become the left column's cards, and the right column's two groups are the available tests
 * (no local scenario maps to them, so they are what a scenario can be dropped onto) shown first and the
 * mapped tests (grouped by key, with their linked scenario count and one unlinkable row per linked
 * scenario) shown below, each key-sorted. The matrix rows join requirement, test, scenario, the in-file
 * `@<prefix><key>` tag, and last result, one row per link, untraced scenario, and orphan. Renders
 * offline from tags alone. With no remote sync, `orphans` is empty and mapped cards carry no summary.
 * An undefined snapshot (panel off or still building) yields empty columns, still with the available
 * group's empty state so the board explains itself before the first sync.
 */
export function buildBoardViewModel(
  snapshot: TraceabilitySnapshot | undefined,
  workspaceRoots: readonly string[],
  testTagPrefix: string,
  syncScopeResolved: boolean,
  projectOf?: KeyGrammar["projectOf"]
): BoardViewModel {
  const completeProjects = snapshot?.completeProjects ?? [];
  const emptyText = availableEmptyText(syncScopeResolved, completeProjects.length > 0);
  if (!snapshot) {
    return { scenarios: [], available: [], mapped: [], matrix: [], completeProjects, availableEmptyText: emptyText };
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
    matrix: matrixRows(snapshot, workspaceRoots, testTagPrefix, projectOf),
    completeProjects,
    availableEmptyText: emptyText,
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
 * The live link a mapped test card's row names, against the CURRENT snapshot. `dropId` is the row's
 * `unlinkId` (the scenario's `scenarioDropId`); `key` is the card's test. Undefined when no link matches
 * both (a rebuild dropped that link, or the row named a stale scenario), so a row action rejects instead
 * of acting blind. The whole link comes back, since the push path needs its synced metadata too.
 */
export function resolveBoardLink(
  snapshot: TraceabilitySnapshot | undefined,
  dropId: string,
  key: string
): TraceLink | undefined {
  return snapshot?.links.find((item) => scenarioDropId(item.scenario) === dropId && item.testKey === key);
}

/**
 * The unlink twin of `resolveBoardDrop`: resolve a test card's unlink to a `ScenarioRef` for the tag
 * removal, rejecting a row the current snapshot no longer carries.
 */
export function resolveBoardUnlink(
  snapshot: TraceabilitySnapshot | undefined,
  dropId: string,
  key: string
): BoardDropResolution | undefined {
  const link = resolveBoardLink(snapshot, dropId, key);
  return link ? { ref: link.scenario, key } : undefined;
}

// One child in a keyed execution's activity history. Every cell is render-ready text: dates are ISO
// days, and an older ledger entry that recorded no counts carries a plain dash.
export interface ExecutionActivityRow {
  readonly action: string;
  readonly resultsImported: string;
  readonly passRate: string;
  readonly publishedAt: string;
}

// One parent in the Executions tab. The key and summary appear once; its ordered children retain every
// create/append activity this workspace recorded. `key` is the raw reference the panel opens, while
// `keyLabel` is what it prints.
export interface ExecutionGroup {
  readonly kind: "group";
  readonly key: string;
  readonly keyLabel: string;
  readonly summary: string;
  readonly latestPublishedAt: string;
  readonly activityCount: number;
  readonly activities: readonly ExecutionActivityRow[];
}

// An import response that named no execution cannot be safely grouped with another blank reference. It
// remains a standalone activity row, with the printable missing-reference phrase decided here rather
// than in the webview.
export interface UnknownExecutionRow extends ExecutionActivityRow {
  readonly kind: "unknown";
  readonly key: "";
  readonly keyLabel: string;
  readonly summary: string;
  readonly activityCount: 1;
}

export type ExecutionRow = ExecutionGroup | UnknownExecutionRow;

interface ExecutionGroupAccumulator {
  readonly key: string;
  readonly keyLabel: string;
  summary: string;
  readonly latestPublishedAt: string;
  readonly activities: ExecutionActivityRow[];
}

type ExecutionItem =
  | { readonly kind: "group"; readonly group: ExecutionGroupAccumulator }
  | { readonly kind: "unknown"; readonly row: UnknownExecutionRow };

const DASH = "-";

function executionSummary(entry: LedgerEntry): string {
  return entry.summary !== undefined && entry.summary.trim() !== "" ? entry.summary : "";
}

function executionActivity(entry: LedgerEntry): ExecutionActivityRow {
  return {
    action: isOutcomeUnknownEntry(entry) ? "Outcome unknown" : executionAction(entry.mode),
    resultsImported: executionImported(entry),
    passRate: executionPassRate(entry),
    publishedAt: new Date(entry.publishedAt).toISOString().slice(0, 10),
  };
}

function executionAction(mode: LedgerEntry["mode"]): string {
  if (mode === "create-new") {
    return "Created";
  }
  if (mode === "append") {
    return "Appended";
  }
  // A standalone create carries no counts, so Imported and Pass rate dash through the same absent-value
  // path an older entry takes. A later publish appends to the key and writes its own row.
  if (mode === "created-empty") {
    return "Created (empty)";
  }
  return DASH;
}

// Imported reads the recorded `total` (the whole publishable count); the pass rate is honest only when
// passed+failed+skipped accounts for every imported result, so a run with a timed-out or interrupted
// result where the three counts fall short of `total` dashes the rate rather than overstating it.
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
 * The Executions tab (vscode-free), newest first, over the site-scoped publish ledger. No live remote
 * query exists, so this reflects only what this workspace recorded. Entries naming the same execution
 * become one parent whose children preserve each create/append activity, newest first. Its summary is
 * the newest nonblank summary known anywhere in that history, which also fills in a newer append written
 * before summaries were recorded. An entry whose import response named no execution remains an
 * independent leaf: blank references cannot prove that two activities belong together.
 */
export function buildExecutionRows(entries: readonly LedgerEntry[]): ExecutionRow[] {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.publishedAt - a.entry.publishedAt || a.index - b.index)
    .map(({ entry }) => entry);
  const groups = new Map<string, ExecutionGroupAccumulator>();
  const items: ExecutionItem[] = [];

  for (const entry of ordered) {
    const activity = executionActivity(entry);
    const summary = executionSummary(entry);
    if (isOutcomeUnknownEntry(entry)) {
      items.push({
        kind: "unknown",
        row: {
          kind: "unknown",
          key: "",
          keyLabel: "Possibly succeeded",
          summary: `Correlation ${entry.operationId}`,
          activityCount: 1,
          ...activity,
        },
      });
      continue;
    }
    const executionRef = entry.executionRef ?? "";
    if (!hasExecutionRef(executionRef)) {
      items.push({
        kind: "unknown",
        row: {
          kind: "unknown",
          key: "",
          keyLabel: executionLabel(executionRef),
          summary,
          activityCount: 1,
          ...activity,
        },
      });
      continue;
    }

    const existing = groups.get(executionRef);
    if (existing !== undefined) {
      existing.activities.push(activity);
      if (existing.summary === "" && summary !== "") {
        existing.summary = summary;
      }
      continue;
    }

    const group: ExecutionGroupAccumulator = {
      key: executionRef,
      keyLabel: executionLabel(executionRef),
      summary,
      latestPublishedAt: activity.publishedAt,
      activities: [activity],
    };
    groups.set(executionRef, group);
    items.push({ kind: "group", group });
  }

  return items.map((item) => {
    if (item.kind === "unknown") {
      return item.row;
    }
    const { group } = item;
    return {
      kind: "group",
      key: group.key,
      keyLabel: group.keyLabel,
      summary: group.summary,
      latestPublishedAt: group.latestPublishedAt,
      activityCount: group.activities.length,
      activities: group.activities,
    };
  });
}

// The Executions header search is a case-insensitive substring over what the table prints. A parent
// match retains its whole history; a child match reveals that same whole history rather than presenting
// a filtered activity list as if it were complete. An empty query returns the rows untouched.
export function filterExecutionRows(rows: readonly ExecutionRow[], query: string): readonly ExecutionRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return rows;
  }
  const matches = (value: string): boolean => value.toLowerCase().includes(needle);
  const matchesActivity = (activity: ExecutionActivityRow): boolean =>
    matches(activity.action) ||
    matches(activity.resultsImported) ||
    matches(activity.passRate) ||
    matches(activity.publishedAt);
  return rows.filter(
    (row) =>
      matches(row.keyLabel) ||
      matches(row.summary) ||
      (row.kind === "group" ? row.activities.some(matchesActivity) : matchesActivity(row))
  );
}

/**
 * Narrow the board to one project, or hand it back whole for All Projects (undefined). A compare over
 * the projects stamped at build time: a test card is in scope when its key's project matches, and a
 * matrix row when it evidences that project, whether through its test key or through any of its
 * requirement keys. A row that evidences no project at all stays visible under every scope, so an
 * untraced scenario's coverage hole never hides behind a filter. Scenario cards are local, not remote,
 * so they are never scoped away. The available group's empty state is re-decided for the scoped project
 * alone: a project whose own catalogue never landed must not inherit a sibling's authoritative "no
 * unmapped tests". A project can only be scoped to once it is in the sync scope (the selection is a rung
 * of that scope), so the pick-a-project hint is unreachable from here.
 */
export function scopeBoardViewModel(model: BoardViewModel, project: string | undefined): BoardViewModel {
  if (project === undefined) {
    return model;
  }
  const inScope = (card: BoardTestCard): boolean => card.project === project;
  // Card and row projects are uppercased at build time, but `completeProjects` comes through from the
  // adapter as it reported it, so this compare matches the model's case-insensitive one rather than
  // stranding a landed lowercase project on "No synced tests yet."
  const landed = model.completeProjects.some((key) => key.toLowerCase() === project.toLowerCase());
  return {
    ...model,
    available: model.available.filter(inScope),
    mapped: model.mapped.filter(inScope),
    matrix: model.matrix.filter((row) => row.projects.length === 0 || row.projects.includes(project)),
    availableEmptyText: availableEmptyText(true, landed),
  };
}

// What every test-card search has in common: the two fields the card's own header prints. The header
// search adds its linked rows on top; the Mapping column search is exactly this.
function matchesKeyOrSummary(card: BoardTestCard, needle: string): boolean {
  return card.key.toLowerCase().includes(needle) || (card.summary ?? "").toLowerCase().includes(needle);
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
    matchesKeyOrSummary(card, needle) ||
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
    completeProjects: model.completeProjects,
  };
}

// The Mapping tab's per-column searches, one per section, filtering only what is already loaded (a test
// that was never synced is not findable here; Sync now is). They run after `filterBoardViewModel`, so a
// column query and the header query compose AND-wise. Both are deliberately narrower than the header
// predicate, which is what lets one column be searched while the other stays put: the untraced column
// matches a scenario's name, and both test groups match a key or a summary, since a user pastes
// "APEX-123" as readily as a phrase. Case-insensitive substring, no query syntax; an empty query returns
// the cards untouched. Generic in the card so one the host has already stamped for the render keeps its
// own type through the filter.
export function filterScenarioColumn<T extends BoardScenarioCard>(cards: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return cards;
  }
  return cards.filter((card) => card.name.toLowerCase().includes(needle));
}

export function filterTestColumn<T extends BoardTestCard>(cards: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return cards;
  }
  return cards.filter((card) => matchesKeyOrSummary(card, needle));
}

// One page of a section: `filtered` is how many cards the column search left, and `page` is 0-based.
export interface BoardPageMeta {
  readonly filtered: number;
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
}

// How much of a section's filtered set is checked, which is what its select-all box paints. "some" is the
// mixed state, which HTML cannot express, so the webview sets it as a property.
export type SectionSelection = "none" | "some" | "all";

// What a rendered section carries. `total` is the section's count after the header search but before its
// column search, the only count the caller knows, so the caller stamps it: the section's header count
// reads from `total`, the empty condition and the paginator's range label read from `filtered`, and the
// "no matches" versus "nothing to map" wording reads from `filtering`. `filtering`, `query`, and
// `selection` are the three things the webview must not work out for itself: the first two would race the
// render (see `sectionFiltering`), and the last covers the whole filtered set, of which the webview holds
// one page.
export interface BoardSectionMeta extends BoardPageMeta {
  readonly total: number;
  readonly filtering: boolean;
  readonly query: string;
  readonly selection: SectionSelection;
}

export interface BoardPage<T> {
  readonly items: readonly T[];
  readonly meta: BoardPageMeta;
}

/**
 * Slice one page out of a section's filtered cards. The page clamps into range, so an index left past the
 * end by a narrowing search comes back as the last page rather than an empty slice with cards still to
 * show. An empty section is one empty page, never zero, so a paginator never reads "of 0". The returned
 * `page` is the honest index and the caller is expected to adopt it as its new stored page, since a
 * clamped-on-render-only index resurfaces the moment the search clears. Both numbers are coerced here: the
 * page size floors at one whole row, so no arithmetic can leave a card unreachable, and the page truncates
 * to a whole index, so a fraction cannot echo back a window straddling two pages.
 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): BoardPage<T> {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(Math.trunc(page) || 0, 0), pageCount - 1);
  const start = current * size;
  return {
    items: items.slice(start, start + size),
    meta: { filtered: items.length, page: current, pageCount, pageSize: size },
  };
}

/**
 * Whether a section is being narrowed: by the header search, which runs over every section, or by its own
 * column's. Decided here and carried in the section meta, since a webview that read its own input box
 * would race the render it is painting.
 */
export function sectionFiltering(globalQuery: string, columnQuery: string): boolean {
  return globalQuery.trim() !== "" || columnQuery.trim() !== "";
}

/**
 * What a section's select-all box reads, over the section's whole filtered set rather than the page on
 * screen. A section with nothing left to show is "none", since there is nothing to select or clear.
 */
export function sectionSelection(checked: number, filtered: number): SectionSelection {
  if (checked === 0) {
    return "none";
  }
  return checked === filtered ? "all" : "some";
}
