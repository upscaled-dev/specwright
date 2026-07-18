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
import { extractKeys } from "./tag-extraction";
import { KeyGrammar, TraceabilityAdapter } from "./traceability-adapter";

export type RunOutcome = ScenarioStatus;

export interface TestMeta {
  summary?: string | undefined;
  status?: string | undefined;
}

/**
 * The metadata-merge seam for P1: an offline snapshot leaves this undefined so links carry no
 * `meta` field and the orphan bucket is empty. P1 slots a cache-backed provider in here (behind
 * the adapter) without touching the join.
 */
export interface MetadataProvider {
  get(testKey: string): TestMeta | undefined;
  keys(): Iterable<string>;
}

export interface ScenarioRef {
  filePath: string;
  line: number;
  name: string;
  kind: "scenario" | "outline" | "examplesBlock";
  outlineName?: string | undefined;
  examplesBlockName?: string | undefined;
}

export interface TraceLink {
  testKey: string;
  project?: string | undefined;
  scenario: ScenarioRef;
  reqKeys: string[];
  meta?: TestMeta | undefined;
  lastResult?: RunOutcome | undefined;
}

export interface UntracedScenario {
  scenario: ScenarioRef;
  reqKeys: string[];
}

export interface OrphanTest {
  testKey: string;
  meta: TestMeta;
}

export interface TraceabilitySnapshot {
  links: TraceLink[];
  untraced: UntracedScenario[];
  orphans: OrphanTest[];
  syncedAt?: number | undefined;
  stale: boolean;
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
};

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
// "Example #N" (or the substituted title) in the report, never the tree's synthetic row label —
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
  metadataProvider?: MetadataProvider
): TraceabilitySnapshot {
  const links: TraceLink[] = [];
  const untraced: UntracedScenario[] = [];

  const addLink = (
    testKey: string,
    scenario: ScenarioRef,
    reqKeys: string[],
    lastResult: ScenarioStatus | undefined
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
      for (const testKey of outlineKeys) {
        addLink(testKey, outlineRef, reqKeys, lastResult);
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
        name: blockName ? `${outlineName} — ${blockName}` : outlineName,
        kind: "examplesBlock",
        outlineName,
        ...(blockName ? { examplesBlockName: blockName } : {}),
      };
      const reqKeys = unionReq(blockRows);
      const lastResult = worstStatus(
        blockRows.map((r) => lookupStatus(statusMap, filePath, r.lineNumber, r.name, r.substitutedName))
      );
      for (const testKey of blockKeys) {
        addLink(testKey, ref, reqKeys, lastResult);
      }
    }

    if (untracedRows.length > 0) {
      untraced.push({ scenario: outlineRef, reqKeys: unionReq(untracedRows) });
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
        untraced.push({ scenario: ref, reqKeys });
        continue;
      }
      for (const testKey of testKeys) {
        addLink(testKey, ref, reqKeys, lastResult);
      }
    }

    for (const rows of outlineRows.values()) {
      buildOutlineLinks(rows, filePath);
    }
  }

  if (metadataProvider) {
    for (const link of links) {
      const meta = metadataProvider.get(link.testKey);
      if (meta) {link.meta = meta;}
    }
  }

  return {
    links,
    untraced,
    orphans: metadataProvider ? computeOrphans(links, metadataProvider) : [],
    stale: false,
  };
}

function computeOrphans(links: TraceLink[], provider: MetadataProvider): OrphanTest[] {
  const covered = new Set(links.map((l) => l.testKey));
  const orphans: OrphanTest[] = [];
  for (const key of provider.keys()) {
    if (!covered.has(key)) {
      const meta = provider.get(key);
      if (meta) {orphans.push({ testKey: key, meta });}
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
}

export async function findPlaywrightReport(
  roots: readonly string[]
): Promise<FoundReport | undefined> {
  let newest: { path: string; root: string; mtimeMs: number } | undefined;
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
  return newest ? { path: newest.path, root: newest.root } : undefined;
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
      this.adapter.metadataProvider
    );
    this._onDidChange.fire();
  }

  private async readStatusMap(): Promise<Record<string, ScenarioStatus>> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const found = await findPlaywrightReport(roots);
    if (!found) {return {};}
    const results = this.playwrightJsonParser.parseFromFile(found.path);
    return this.playwrightJsonParser.toStatusMap(results, found.root);
  }

  public dispose(): void {
    this._onDidChange.dispose();
  }
}
