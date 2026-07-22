import * as path from "node:path";
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

export interface BoardViewModel {
  readonly scenarios: readonly BoardScenarioCard[];
  readonly tests: readonly BoardTestCard[];
  readonly matrix: readonly MatrixRow[];
}

const EMPTY: BoardViewModel = { scenarios: [], tests: [], matrix: [] };

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

function scenarioCard(item: UntracedScenario, roots: readonly string[]): BoardScenarioCard {
  const rel = toWorkspaceRelative(item.scenario.filePath, roots);
  return {
    name: item.scenario.name,
    location: `${rel}:${item.scenario.line}`,
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
  return { scenarios, tests, matrix: matrixRows(snapshot, testTagPrefix) };
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

// The header search: case-insensitive substring over a test's key/summary and a scenario's name, its
// workspace-relative location (the file path), and its requirement tags, plus a match across all five
// matrix columns. One function the panel calls on every keystroke; an empty query returns the model
// untouched.
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
    matrix: model.matrix.filter((row) =>
      [row.requirement, row.test, row.scenario, row.tag, row.result].some((cell) => cell.toLowerCase().includes(needle))
    ),
  };
}
