import * as vscode from "vscode";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { FeatureParser, isOutlineExampleRow } from "../parsers/feature-parser";
import { TestDiscoveryManager } from "../core/test-discovery-manager";
import {
  PlaywrightJsonParser,
  ScenarioStatus,
  normalizePathKey,
} from "../utils/playwright-json-parser";
import { Logger } from "../utils/logger";
import { OutlineExampleRow, Scenario } from "../types";
import { extractKeys, malformedTestTags } from "./tag-extraction";
import { hasGherkinDrift } from "./push-gherkin";
import { RunResultStore } from "./run-result-store";
import { normalizePath, ScenarioRef, refIdentity, sameScenario } from "./scenario-ref";
import {
  KeyGrammar,
  RemoteMetadataSnapshot,
  TestCaseMetadata,
  TraceabilityAdapter,
} from "./contracts";

export { sameScenario, scenarioRefFromScenario } from "./scenario-ref";
export type { ScenarioRef } from "./scenario-ref";

export type RunOutcome = ScenarioStatus;

export interface TraceLink {
  testKey: string;
  project?: string | undefined;
  scenario: ScenarioRef;
  reqKeys: string[];
  meta?: TestCaseMetadata | undefined;
  lastResult?: RunOutcome | undefined;
  // Test-prefixed tags on this scenario whose key body is malformed (`@TEST_notakey`), sitting
  // ALONGSIDE the valid key that formed this link. The mapping stands; preflight surfaces these as a
  // non-blocking warning rather than hiding a broken extra tag.
  malformedTags?: string[] | undefined;
  // Passed/total iterations for a data-driven row (Scenario Outline / Examples block); drives the
  // "N/M" badge. Absent for non-outline links and for outlines with no run result yet.
  iterations?: { passed: number; total: number } | undefined;
  // Set when the snapshot's stored Gherkin differs from the scenario's verbatim source slice, which is
  // the same text the push sends, so a successful push clears this on the refreshed baseline. Absent
  // until a snapshot populates `meta.gherkin`.
  drift?: boolean | undefined;
  // Provably absent from a complete remote catalogue covering the key's project (display-only
  // verdict). Never set for a project whose catalogue fell short or was never fetched.
  remoteMissing?: boolean | undefined;
}

export interface UntracedScenario {
  scenario: ScenarioRef;
  reqKeys: string[];
  // Tags carrying the test prefix whose key body is malformed (`@TEST_notakey`). Non-empty means the
  // scenario is untraced because of a broken tag, not the absence of one; preflight reads this to
  // classify `invalid-key` rather than `unmapped`. Always populated by the model; optional only so a
  // hand-built snapshot fixture need not spell out an empty list.
  malformedTags?: string[] | undefined;
  // Number of Examples rows when the untraced scenario is a fully-untagged Scenario Outline; drives
  // the "N examples ·" description prefix in the tree. Absent for plain scenarios and zero-row stubs.
  examples?: number | undefined;
}

export interface OrphanTest {
  testKey: string;
  meta: TestCaseMetadata;
}

export interface TraceabilitySnapshot {
  links: TraceLink[];
  untraced: UntracedScenario[];
  orphans: OrphanTest[];
  syncedAt?: number | undefined;
  stale: boolean;
  // The projects whose catalogue the last sync fetched whole; empty means nothing on this snapshot is
  // authoritative about what the remote holds. `orphans` is already filtered to these projects, so a
  // surface reads this only to decide whether an EMPTY orphan list means anything.
  completeProjects: string[];
  errors: string[];
}

export interface ParsedFeatureInput {
  filePath: string;
  scenarios: Scenario[];
}

const EMPTY_SNAPSHOT: TraceabilitySnapshot = {
  links: [],
  untraced: [],
  orphans: [],
  stale: false,
  completeProjects: [],
  errors: [],
};

function nearestOutlineLink(links: readonly TraceLink[], ref: ScenarioRef): TraceLink | undefined {
  const outlineName = ref.kind === "outline" ? ref.outlineName ?? ref.name : undefined;
  if (!outlineName || ref.line <= 0) {return undefined;}
  let nearestOutline: TraceLink | undefined;
  let nearestBlock: TraceLink | undefined;
  for (const link of links) {
    const candidate = link.scenario;
    const candidateOutline = candidate.kind === "outline"
      ? candidate.outlineName ?? candidate.name
      : candidate.kind === "examplesBlock"
        ? candidate.outlineName
        : undefined;
    if (
      candidateOutline === outlineName
      && normalizePath(candidate.filePath) === normalizePath(ref.filePath)
      && candidate.line > 0
      && candidate.line <= ref.line
    ) {
      if (candidate.kind === "outline" && (!nearestOutline || candidate.line > nearestOutline.scenario.line)) {
        nearestOutline = link;
      } else if (candidate.kind === "examplesBlock" && (!nearestBlock || candidate.line > nearestBlock.scenario.line)) {
        nearestBlock = link;
      }
    }
  }
  return nearestOutline ?? nearestBlock;
}

// Artifact results preserve exact plain-scenario lines. Outline results carry an example-row line, so
// resolve them to the nearest preceding outline declaration before using the line-less fallback. A
// resolver scoped to a selected Examples block has no outline candidate, so its block is the fallback.
export function findLinkForScenario(
  links: readonly TraceLink[],
  ref: ScenarioRef
): TraceLink | undefined {
  const id = refIdentity(ref);
  return links.find((link) => refIdentity(link.scenario) === id)
    ?? nearestOutlineLink(links, ref)
    ?? links.find((link) => sameScenario(link.scenario, ref));
}

// The link dialog's "Linked" section: the links a scenario already carries `@TEST_` tags for.
// Stricter than `sameScenario` on purpose; two scenarios with the same name in one file (a tagged
// scenario and its untagged twin) must never be conflated, or the dialog would claim the untagged
// twin is linked to the sibling's test. A real 1-based line on both sides is decisive; only a
// line-less ref keeps `sameScenario`'s title fallback (the outline-row reunification the snapshot
// relies on elsewhere).
export function linkedTestsForScenario(
  links: readonly TraceLink[],
  ref: ScenarioRef
): TraceLink[] {
  return links.filter((link) => {
    if (link.scenario.line > 0 && ref.line > 0) {
      return sameScenario(link.scenario, ref) && link.scenario.line === ref.line;
    }
    return sameScenario(link.scenario, ref);
  });
}

export const OUTCOME_SEVERITY: Record<ScenarioStatus, number> = {
  passed: 0,
  skipped: 1,
  failed: 2,
};

export function worstStatus(
  statuses: readonly (ScenarioStatus | undefined)[]
): ScenarioStatus | undefined {
  let worst: ScenarioStatus | undefined;
  for (const s of statuses) {
    if (s !== undefined && (worst === undefined || OUTCOME_SEVERITY[s] > OUTCOME_SEVERITY[worst])) {
      worst = s;
    }
  }
  return worst;
}

// Mirrors PlaywrightBddTestProvider.resolveStatusForItem: outline example rows are titled
// "Example #N" (or the substituted title) in the report, never the tree's synthetic row label,
// so line-based match is primary, then the source name, then the substituted title.
function lookupStatus(
  statusMap: Record<string, ScenarioStatus>,
  filePath: string,
  line: number,
  name: string,
  substitutedName?: string
): ScenarioStatus | undefined {
  const key = normalizePathKey(filePath);
  return (
    statusMap[`${key}:${line}`] ??
    statusMap[`${key}::${name}`] ??
    (substitutedName ? statusMap[`${key}::${substitutedName}`] : undefined)
  );
}

// N/M for a data-driven row: total = iterations that produced a result this run, passed = those that
// passed. Iterations with no result (never ran) are excluded from both, so a partial run reports only
// what actually ran. Flaky retries already collapse to passed in the parser, so they count as passed.
function countIterations(
  statusMap: Record<string, ScenarioStatus>,
  filePath: string,
  rows: readonly OutlineExampleRow[]
): { passed: number; total: number } | undefined {
  let passed = 0;
  let total = 0;
  for (const row of rows) {
    const status = lookupStatus(statusMap, filePath, row.lineNumber, row.name, row.substitutedName);
    if (status !== undefined) {
      total += 1;
      if (status === "passed") {
        passed += 1;
      }
    }
  }
  return total > 0 ? { passed, total } : undefined;
}

function subtract(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((tag) => !b.includes(tag));
}

// The feature+outline tags common to every row of an outline (independent of Examples block).
function outlineTagsFor(rows: readonly OutlineExampleRow[]): string[] {
  const first = rows[0];
  if (!first) {return [];}
  const byBlock = new Map<number, OutlineExampleRow>();
  for (const row of rows) {
    if (!byBlock.has(row.examplesBlockLineNumber)) {
      byBlock.set(row.examplesBlockLineNumber, row);
    }
  }
  const reps = [...byBlock.values()];
  if (reps.length < 2) {
    return subtract(first.tags ?? [], first.examplesBlockTags ?? []);
  }
  let common = reps[0]?.tags ?? [];
  for (const rep of reps.slice(1)) {
    const tags = rep.tags ?? [];
    common = common.filter((tag) => tags.includes(tag));
  }
  return common;
}

/**
 * The join, isolated as a pure function so it can be unit-tested without VS Code or the
 * filesystem. Keys come from tags (never scenario names), so scenario renames never break the
 * mapping. Outline grouping: one link per outline (tag on the outline covers every row), with a
 * `@TEST_` on an `Examples:` block splitting that block into its own link.
 */
export function buildTraceabilitySnapshot(
  features: readonly ParsedFeatureInput[],
  statusMap: Record<string, ScenarioStatus>,
  keyGrammar: KeyGrammar,
  remote?: RemoteMetadataSnapshot
): TraceabilitySnapshot {
  const links: TraceLink[] = [];
  const untraced: UntracedScenario[] = [];

  const addLink = (
    testKey: string,
    scenario: ScenarioRef,
    reqKeys: string[],
    lastResult: ScenarioStatus | undefined,
    localGherkin?: string,
    iterations?: { passed: number; total: number },
    malformedTags?: readonly string[]
  ): void => {
    const link: TraceLink = {
      testKey,
      scenario,
      reqKeys,
    };
    if (keyGrammar.projectOf) {
      link.project = keyGrammar.projectOf(testKey);
    }
    if (lastResult !== undefined) {
      link.lastResult = lastResult;
    }
    if (iterations) {
      link.iterations = iterations;
    }
    if (malformedTags && malformedTags.length > 0) {
      link.malformedTags = [...malformedTags];
    }
    const meta = remote?.tests.get(testKey);
    if (meta) {
      link.meta = meta;
      if (meta.gherkin !== undefined && localGherkin !== undefined && hasGherkinDrift(localGherkin, meta.gherkin)) {
        link.drift = true;
      }
    } else if (inCompleteCatalogue(link.project, remote) || isVerifiedAbsent(testKey, remote)) {
      link.remoteMissing = true;
    }
    links.push(link);
  };

  const unionReq = (rows: readonly OutlineExampleRow[]): string[] => {
    const out: string[] = [];
    for (const row of rows) {
      for (const key of extractKeys(row.tags ?? [], keyGrammar).reqKeys) {
        if (!out.includes(key)) {out.push(key);}
      }
    }
    return out;
  };

  const buildOutlineLinks = (rows: OutlineExampleRow[], filePath: string): void => {
    const first = rows[0];
    if (!first) {return;}
    const outlineName = first.outlineName;
    const outlineLine = first.outlineLineNumber;
    const outlineRef: ScenarioRef = {
      filePath,
      line: outlineLine,
      name: outlineName,
      kind: "outline",
      outlineName,
    };

    // Feature+outline tags are shared by every row regardless of Examples block. With ≥2 blocks,
    // intersecting one representative row's merged tags per block cancels the block-specific tags
    // (and keeps a tag that sits on both the outline and a block). With a single block there's
    // nothing to intersect against, so fall back to subtracting that block's tags.
    const outlineKeys = extractKeys(outlineTagsFor(rows), keyGrammar).testKeys;

    const outlineLevelRows: OutlineExampleRow[] = [];
    const blockGroups = new Map<number, OutlineExampleRow[]>();
    const untracedRows: OutlineExampleRow[] = [];

    for (const row of rows) {
      const blockKeys = extractKeys(row.examplesBlockTags ?? [], keyGrammar).testKeys;
      if (blockKeys.length > 0) {
        const list = blockGroups.get(row.examplesBlockLineNumber) ?? [];
        list.push(row);
        blockGroups.set(row.examplesBlockLineNumber, list);
      } else if (outlineKeys.length > 0) {
        outlineLevelRows.push(row);
      } else {
        untracedRows.push(row);
      }
    }

    if (outlineLevelRows.length > 0) {
      const reqKeys = unionReq(outlineLevelRows);
      const lastResult = worstStatus(
        outlineLevelRows.map((r) => lookupStatus(statusMap, filePath, r.lineNumber, r.name, r.substitutedName))
      );
      const iterations = countIterations(statusMap, filePath, outlineLevelRows);
      const localGherkin = first.gherkin;
      const malformed = malformedTestTags(outlineTagsFor(rows), keyGrammar);
      for (const testKey of outlineKeys) {
        addLink(testKey, outlineRef, reqKeys, lastResult, localGherkin, iterations, malformed);
      }
    }

    for (const blockRows of blockGroups.values()) {
      const sample = blockRows[0];
      if (!sample) {continue;}
      const blockKeys = extractKeys(sample.examplesBlockTags ?? [], keyGrammar).testKeys;
      const blockName = sample.examplesBlockName;
      const ref: ScenarioRef = {
        filePath,
        line: sample.examplesBlockLineNumber,
        name: blockName ? `${outlineName} · ${blockName}` : outlineName,
        kind: "examplesBlock",
        outlineName,
        ...(blockName ? { examplesBlockName: blockName } : {}),
      };
      const reqKeys = unionReq(blockRows);
      const lastResult = worstStatus(
        blockRows.map((r) => lookupStatus(statusMap, filePath, r.lineNumber, r.name, r.substitutedName))
      );
      const iterations = countIterations(statusMap, filePath, blockRows);
      const localGherkin = sample.gherkin;
      const blockMalformed = malformedTestTags(sample.examplesBlockTags ?? [], keyGrammar);
      for (const testKey of blockKeys) {
        addLink(testKey, ref, reqKeys, lastResult, localGherkin, iterations, blockMalformed);
      }
    }

    if (untracedRows.length > 0) {
      const malformed: string[] = [];
      for (const row of untracedRows) {
        for (const tag of malformedTestTags([...(row.tags ?? []), ...(row.examplesBlockTags ?? [])], keyGrammar)) {
          if (!malformed.includes(tag)) {malformed.push(tag);}
        }
      }
      untraced.push({ scenario: outlineRef, reqKeys: unionReq(untracedRows), malformedTags: malformed, examples: untracedRows.length });
    }
  };

  for (const feature of features) {
    const filePath = feature.filePath;
    const outlineRows = new Map<number, OutlineExampleRow[]>();

    for (const scenario of feature.scenarios) {
      if (isOutlineExampleRow(scenario)) {
        const list = outlineRows.get(scenario.outlineLineNumber) ?? [];
        list.push(scenario);
        outlineRows.set(scenario.outlineLineNumber, list);
        continue;
      }

      const { testKeys, reqKeys } = extractKeys(scenario.tags ?? [], keyGrammar);
      const isOutline = scenario.isScenarioOutline;
      const line = isOutline ? scenario.outlineLineNumber : scenario.lineNumber;
      const name = isOutline ? scenario.outlineName : scenario.name;
      const ref: ScenarioRef = isOutline
        ? { filePath, line, name, kind: "outline", outlineName: name }
        : { filePath, line, name, kind: "scenario" };
      const lastResult = lookupStatus(statusMap, filePath, line, name);

      if (testKeys.length === 0) {
        untraced.push({ scenario: ref, reqKeys, malformedTags: malformedTestTags(scenario.tags ?? [], keyGrammar) });
        continue;
      }
      const localGherkin = scenario.gherkin;
      const malformed = malformedTestTags(scenario.tags ?? [], keyGrammar);
      for (const testKey of testKeys) {
        addLink(testKey, ref, reqKeys, lastResult, localGherkin, undefined, malformed);
      }
    }

    for (const rows of outlineRows.values()) {
      buildOutlineLinks(rows, filePath);
    }
  }

  return {
    links,
    untraced,
    orphans: remote ? computeOrphans(links, remote, keyGrammar.projectOf) : [],
    syncedAt: remote?.syncedAt,
    stale: remote?.stale ?? false,
    completeProjects: remote ? [...remote.completeProjects] : [],
    errors: remote ? [...remote.errors] : [],
  };
}

// Whether a key sits inside a catalogue this snapshot fetched whole. A key whose project fell short,
// was never fetched, or cannot be derived proves nothing either way. The absence verdict stops here:
// with no derivable project there is no catalogue to have looked in. Orphans go one step further, since
// a grammar without project derivation still has one catalogue to be absent from (see `computeOrphans`).
function inCompleteCatalogue(
  project: string | undefined,
  remote: RemoteMetadataSnapshot | undefined
): boolean {
  if (project === undefined) {
    return false;
  }
  return (remote?.completeProjects ?? []).some((p) => p.toLowerCase() === project.toLowerCase());
}

// A successful key-batch fetch that queried this key and did not get it back proves absence outright
// (§5), independent of catalogue scope; this covers a tag whose project is not in the configured
// catalogue scope.
function isVerifiedAbsent(testKey: string, remote: RemoteMetadataSnapshot | undefined): boolean {
  return remote?.verifiedAbsentKeys.some((key) => key.toLowerCase() === testKey.toLowerCase()) ?? false;
}

// Orphans are only authoritative inside a catalogue that was fetched whole, so they are derived per
// project: a project whose fetch fell short may be missing the very scenarios that would cover a key,
// while its siblings keep every orphan they earned.
function computeOrphans(
  links: TraceLink[],
  remote: RemoteMetadataSnapshot,
  projectOf: KeyGrammar["projectOf"]
): OrphanTest[] {
  const covered = new Set(links.map((l) => l.testKey));
  // A grammar with no project derivation (the reference adapter's numeric keys) has a single
  // undifferentiated catalogue, so any complete fetch speaks for every key in it.
  const authoritative = projectOf
    ? (key: string): boolean => inCompleteCatalogue(projectOf(key), remote)
    : (): boolean => remote.completeProjects.length > 0;
  const orphans: OrphanTest[] = [];
  for (const [key, meta] of remote.tests) {
    if (!covered.has(key) && authoritative(key)) {
      orphans.push({ testKey: key, meta });
    }
  }
  return orphans;
}

// The extension's own runs write ephemeral JSON reports to os.tmpdir and delete them, so the
// panel reads a persistent report a normal Playwright run leaves in the workspace. Best-effort:
// no report → no badges. The winning root drives toStatusMap's cwd so relative report paths
// resolve against the folder the report was found in (multi-root safe).
export const REPORT_CANDIDATES = [
  "results.json",
  "test-results.json",
  "test-results/results.json",
  "playwright-report/results.json",
];

export interface FoundReport {
  path: string;
  root: string;
  // The winning report's mtime, so the model can weigh an external CLI run against the session store.
  mtimeMs: number;
}

export async function findPlaywrightReport(
  roots: readonly string[]
): Promise<FoundReport | undefined> {
  let newest: FoundReport | undefined;
  for (const root of roots) {
    for (const candidate of REPORT_CANDIDATES) {
      const full = path.join(root, candidate);
      try {
        const stat = await fsp.stat(full);
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { path: full, root, mtimeMs: stat.mtimeMs };
        }
      } catch {
        /* not present */
      }
    }
  }
  return newest;
}

export class TraceabilityModel implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private current: TraceabilitySnapshot = EMPTY_SNAPSHOT;

  constructor(
    private readonly featureParser: FeatureParser,
    private readonly discoveryManager: TestDiscoveryManager,
    private readonly playwrightJsonParser: PlaywrightJsonParser,
    private readonly adapter: TraceabilityAdapter,
    private readonly runResultStore: RunResultStore,
    private readonly logger: Logger
  ) {}

  public get snapshot(): TraceabilitySnapshot {
    return this.current;
  }

  public async rebuild(): Promise<void> {
    let files: string[];
    try {
      // The subsystem's watchers drive invalidation; let the discovery cache absorb event bursts.
      files = await this.discoveryManager.discoverTestFiles();
    } catch (error) {
      this.logger.warn("Traceability discovery failed", { error: String(error) });
      files = [];
    }

    const features: ParsedFeatureInput[] = [];
    for (const filePath of files) {
      const parsed = this.featureParser.parseFeatureFile(filePath);
      if (parsed) {
        features.push({ filePath, scenarios: parsed.scenarios });
      }
    }

    this.current = buildTraceabilitySnapshot(
      features,
      await this.readStatusMap(),
      this.adapter.keyGrammar,
      this.adapter.metadata?.snapshot()
    );
    this._onDidChange.fire();
  }

  // Badge precedence (§3.5): fresh extension-run outcomes from the session store are the primary
  // source, the workspace-report scan the external-CLI-run fallback. With no report on disk a Test
  // Explorer run still badges the tree (store-only). When both exist, a coarse whole-map mtime check
  // keeps a stale store outcome from permanently masking a newer external report: a report written
  // after the last ingest wins the whole map, otherwise the store does. Per-key is impossible with a
  // single report timestamp; that limitation is accepted. A never-fed store collapses to scan-only.
  private async readStatusMap(): Promise<Record<string, ScenarioStatus>> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const found = await findPlaywrightReport(roots);
    const store = this.runResultStore.statusMap();
    if (!found) {
      return store;
    }
    const scan = this.playwrightJsonParser.toStatusMap(
      this.playwrightJsonParser.parseFromFile(found.path),
      found.root
    );
    return found.mtimeMs > this.runResultStore.lastIngestAt
      ? { ...store, ...scan }
      : { ...scan, ...store };
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}
