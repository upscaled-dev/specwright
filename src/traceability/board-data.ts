import * as path from "node:path";
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

// A remote test rendered as a card in the board's right column. `summary` is the synced remote
// summary when present. An orphan (no local scenario maps to it) carries the "orphan" pill; a mapped
// test carries its linked-scenario count instead.
export interface BoardTestCard {
  readonly key: string;
  readonly summary?: string | undefined;
  readonly pills: readonly string[];
}

// One row of the Matrix tab, columns left to right. A coverage hole is an empty string: a requirement
// with no test leaves `test` empty, a test with no scenario leaves `scenario` empty, an untraced
// scenario leaves `tag` empty. `result` is always spelled out ("no run" for an untraced scenario,
// "no coverage" for an orphan test that covers nothing).
export interface MatrixRow {
  readonly requirement: string;
  readonly test: string;
  readonly scenario: string;
  readonly tag: string;
  readonly result: string;
}

// One mapped scenario-to-test link as a chip in the Mapped tree. `key` is the test; `unlinkId` is the
// scenario's `scenarioDropId`, carried so a drag-back-to-untraced or the inline button resolves back to
// exactly this scenario for the tag removal; `result` is the link's last run (or "no run").
export interface MappedTestLeaf {
  readonly key: string;
  readonly unlinkId: string;
  readonly result?: string | undefined;
}

// A mapped scenario row: its name, its workspace-relative "path:line" location, and one leaf per test
// it links (a multi-link scenario carries several leaves).
export interface MappedScenarioNode {
  readonly name: string;
  readonly location: string;
  readonly links: readonly MappedTestLeaf[];
}

// The Mapped tree grouped by feature file: `file` is the workspace-relative path shown as the group's
// summary, `scenarios` its mapped scenario rows.
export interface MappedFeatureGroup {
  readonly file: string;
  readonly scenarios: readonly MappedScenarioNode[];
}

export interface BoardViewModel {
  readonly scenarios: readonly BoardScenarioCard[];
  readonly tests: readonly BoardTestCard[];
  readonly mapped: readonly MappedFeatureGroup[];
  readonly matrix: readonly MatrixRow[];
}

const EMPTY: BoardViewModel = { scenarios: [], tests: [], mapped: [], matrix: [] };

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

// Collapse an outline's per-Examples-block links (each a distinct block line) onto the outline, so a
// multi-block outline counts as one covered scenario; a plain scenario keys off its own file+line.
function scenarioIdentity(scenario: ScenarioRef): string {
  const local = scenario.outlineName ?? `${scenario.line}`;
  return `${scenario.filePath}::${local}`;
}

function mappedTestCards(links: readonly TraceLink[]): BoardTestCard[] {
  const byKey = new Map<string, TraceLink[]>();
  for (const link of links) {
    const list = byKey.get(link.testKey) ?? [];
    list.push(link);
    byKey.set(link.testKey, list);
  }
  const cards: BoardTestCard[] = [];
  for (const [key, group] of byKey) {
    const scenarios = new Set(group.map((link) => scenarioIdentity(link.scenario)));
    const summary = nonEmptySummary(group[0]?.meta?.summary);
    cards.push({
      key,
      pills: [countLabel(scenarios.size, "scenario")],
      ...(summary !== undefined ? { summary } : {}),
    });
  }
  return cards;
}

function linkResult(link: TraceLink): string {
  if (link.iterations) {
    return `${link.iterations.passed}/${link.iterations.total}`;
  }
  return link.lastResult ?? "no run";
}

interface MappedScenarioAccum {
  name: string;
  location: string;
  leaves: MappedTestLeaf[];
}

// Group the links into the Mapped tree: by workspace-relative feature file, then by the scenario's
// round-trippable `scenarioDropId` (so a multi-block outline collapses to one row while same-named
// twins stay apart), one leaf per test key. The leaf's `unlinkId` is that scenario id, the removal's
// only handle back to the source. Groups sort by file, scenarios by name, leaves by key.
function buildMappedTree(links: readonly TraceLink[], roots: readonly string[]): MappedFeatureGroup[] {
  const groups = new Map<string, Map<string, MappedScenarioAccum>>();
  for (const link of links) {
    const rel = toWorkspaceRelative(link.scenario.filePath, roots);
    const dropId = scenarioDropId(link.scenario);
    const scenarios = groups.get(rel) ?? new Map<string, MappedScenarioAccum>();
    groups.set(rel, scenarios);
    const node = scenarios.get(dropId) ?? { name: link.scenario.name, location: scenarioLocation(link.scenario, roots), leaves: [] };
    scenarios.set(dropId, node);
    node.leaves.push({ key: link.testKey, unlinkId: dropId, result: linkResult(link) });
  }
  return [...groups.entries()]
    .map(([file, scenarios]): MappedFeatureGroup => ({
      file,
      scenarios: [...scenarios.values()]
        .map((node): MappedScenarioNode => ({
          name: node.name,
          location: node.location,
          links: [...node.leaves].sort((a, b) => a.key.localeCompare(b.key)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
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

function matrixRows(snapshot: TraceabilitySnapshot, testTagPrefix: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const link of snapshot.links) {
    rows.push({
      requirement: link.reqKeys.join(", "),
      test: link.testKey,
      scenario: link.scenario.name,
      tag: `@${testTagPrefix}${link.testKey}`,
      result: linkResult(link),
    });
  }
  for (const item of snapshot.untraced) {
    rows.push({ requirement: item.reqKeys.join(", "), test: "", scenario: item.scenario.name, tag: "", result: "no run" });
  }
  for (const orphan of snapshot.orphans) {
    rows.push({ requirement: "", test: orphan.testKey, scenario: "", tag: "", result: "no coverage" });
  }
  return rows.sort(compareMatrixRows);
}

/**
 * Assemble the read-only Coverage Board view-model from the traceability snapshot: the untraced
 * scenarios become the left column's cards, and the mapped tests (grouped by key, with their linked
 * scenario count) plus the orphan tests (no local scenario) become the right column's cards. The
 * mapped tree groups the same links by feature file and scenario for the unlink surface below. The
 * matrix rows join requirement, test, scenario, the in-file `@<prefix><key>` tag, and last result, one
 * row per link, untraced scenario, and orphan. Renders offline from tags alone — with no remote sync,
 * `orphans` is empty and mapped cards carry no summary. An undefined snapshot (panel off or still
 * building) yields empty columns.
 */
export function buildBoardViewModel(
  snapshot: TraceabilitySnapshot | undefined,
  workspaceRoots: readonly string[],
  testTagPrefix: string
): BoardViewModel {
  if (!snapshot) {
    return EMPTY;
  }
  const scenarios = snapshot.untraced
    .map((item) => scenarioCard(item, workspaceRoots))
    .sort((a, b) => a.name.localeCompare(b.name));
  const orphanCards = snapshot.orphans.map((orphan): BoardTestCard => {
    const summary = nonEmptySummary(orphan.meta.summary);
    return { key: orphan.testKey, pills: ["orphan"], ...(summary !== undefined ? { summary } : {}) };
  });
  const tests = [...mappedTestCards(snapshot.links), ...orphanCards].sort((a, b) => a.key.localeCompare(b.key));
  return {
    scenarios,
    tests,
    mapped: buildMappedTree(snapshot.links, workspaceRoots),
    matrix: matrixRows(snapshot, testTagPrefix),
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
 * The unlink twin of `resolveBoardDrop`: validate a Mapped-tree unlink against the CURRENT snapshot and
 * resolve the scenario+key pair to a `ScenarioRef` for the tag removal. `dropId` is the leaf's
 * `unlinkId` (the scenario's `scenarioDropId`); `key` is the leaf's test. Returns undefined when no
 * live link matches both (a rebuild dropped that link, or the leaf named a stale card) so the caller
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

// The header search: case-insensitive substring over a test's key/summary and a scenario's name, its
// workspace-relative location (the file path), and its requirement tags, plus a match across all five
// matrix columns and the Mapped tree (a leaf on its key, a scenario on its name or location, pruning
// empty scenarios and groups). One function the panel calls on every keystroke; an empty query returns
// the model untouched.
export function filterBoardViewModel(model: BoardViewModel, query: string): BoardViewModel {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return model;
  }
  return {
    scenarios: model.scenarios.filter(
      (card) =>
        card.name.toLowerCase().includes(needle) ||
        card.location.toLowerCase().includes(needle) ||
        card.reqKeys.some((key) => key.toLowerCase().includes(needle))
    ),
    tests: model.tests.filter(
      (card) => card.key.toLowerCase().includes(needle) || (card.summary ?? "").toLowerCase().includes(needle)
    ),
    mapped: model.mapped
      .map((group): MappedFeatureGroup => ({
        file: group.file,
        scenarios: group.scenarios
          .map((scenario): MappedScenarioNode => {
            const scenarioMatches =
              scenario.name.toLowerCase().includes(needle) || scenario.location.toLowerCase().includes(needle);
            return {
              name: scenario.name,
              location: scenario.location,
              links: scenarioMatches
                ? scenario.links
                : scenario.links.filter((leaf) => leaf.key.toLowerCase().includes(needle)),
            };
          })
          .filter((scenario) => scenario.links.length > 0),
      }))
      .filter((group) => group.scenarios.length > 0),
    matrix: model.matrix.filter((row) =>
      [row.requirement, row.test, row.scenario, row.tag, row.result].some((cell) => cell.toLowerCase().includes(needle))
    ),
  };
}
