import * as path from "node:path";
import type { ScenarioRef } from "./scenario-ref";
import type {
  TraceabilitySnapshot,
  TraceLink,
  UntracedScenario,
} from "./traceability-model";

// An untraced scenario rendered as a card in the board's left column. `location` is the
// workspace-relative "path:line" the card shows; `pills` are the short markers ("no tag" for a plain
// scenario, "outline" + an example count for an untagged outline). `reqKeys` are carried for the
// header filter but not shown as pills.
export interface BoardScenarioCard {
  readonly name: string;
  readonly location: string;
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

export interface BoardViewModel {
  readonly scenarios: readonly BoardScenarioCard[];
  readonly tests: readonly BoardTestCard[];
}

const EMPTY: BoardViewModel = { scenarios: [], tests: [] };

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

function scenarioCard(item: UntracedScenario, roots: readonly string[]): BoardScenarioCard {
  const rel = toWorkspaceRelative(item.scenario.filePath, roots);
  return {
    name: item.scenario.name,
    location: `${rel}:${item.scenario.line}`,
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

/**
 * Assemble the read-only Coverage Board view-model from the traceability snapshot: the untraced
 * scenarios become the left column's cards, and the mapped tests (grouped by key, with their linked
 * scenario count) plus the orphan tests (no local scenario) become the right column's cards. Renders
 * offline from tags alone — with no remote sync, `orphans` is empty and mapped cards carry no summary.
 * An undefined snapshot (panel off or still building) yields empty columns.
 */
export function buildBoardViewModel(
  snapshot: TraceabilitySnapshot | undefined,
  workspaceRoots: readonly string[]
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
  return { scenarios, tests };
}

// The header search: case-insensitive substring over a test's key/summary and a scenario's name, its
// workspace-relative location (the file path), and its requirement tags. One function the panel calls
// on every keystroke; an empty query returns the model untouched.
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
  };
}
