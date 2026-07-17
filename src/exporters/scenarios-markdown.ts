import { FeatureParser, isOutlineExampleRow } from "../parsers/feature-parser";
import { OutlineExampleRow, OutlineStub, RegularScenario, Scenario } from "../types/index";
import { escapeHtml } from "./html-escape";
import { MarkdownSlugger } from "./markdown-slugger";

interface FeatureInput {
  pathRel: string;
  rawText: string;
}

interface ScenarioSection {
  folderName?: string;
  features: FeatureInput[];
}

interface ScenarioOptions {
  tagFilter?: string[] | undefined;
  filterNote?: string | undefined;
  brandLine?: string | undefined;
}

type Unit =
  | { kind: "regular"; sortLine: number; scenario: RegularScenario }
  | { kind: "stub"; sortLine: number; scenario: OutlineStub }
  | { kind: "outline"; sortLine: number; rows: OutlineExampleRow[] };

interface PreparedFeature {
  pathRel: string;
  title: string | null;
  units: Unit[];
  rawLines: string[];
  slug: string;
}

interface PreparedSection {
  folderName?: string | undefined;
  folderSlug?: string | undefined;
  features: PreparedFeature[];
}

/** Per-feature counts backing one Summary-table row. */
interface FeatureCounts {
  regular: number;
  outlines: number;
  exampleRows: number;
  /** Runnable scenarios: regular + expanded example rows. */
  total: number;
}

export function renderScenariosMarkdown(
  sections: ScenarioSection[],
  options?: ScenarioOptions,
): string {
  const tagFilter = options?.tagFilter;
  const filterNote = options?.filterNote;
  const filter =
    tagFilter && tagFilter.length > 0 ? new Set(tagFilter) : undefined;

  const multiRoot = sections.length > 1;
  const parser = FeatureParser.create();
  const slugger = new MarkdownSlugger();
  // Fixed headings claim their slugs first so a folder or feature sharing their text still
  // gets the -N anchor GitHub would assign it.
  slugger.slug("Feature Catalog");
  slugger.slug("Contents");
  slugger.slug("Summary");
  slugger.slug("Tags");
  const prepared = sections.map((section): PreparedSection =>
    prepareSection(parser, section, filter, slugger, multiRoot),
  );

  const featureLevel = multiRoot ? "###" : "##";
  const scenarioLevel = multiRoot ? "####" : "###";

  const out: string[] = ["# Feature Catalog"];
  if (options?.brandLine) {out.push(`_${options.brandLine}_`);}
  pushBlock(out, renderContents(prepared, multiRoot));
  pushBlock(out, renderSummary(prepared, multiRoot, filterNote));
  pushBlock(out, renderTags(prepared));

  for (const section of prepared) {
    if (multiRoot) {
      pushBlock(out, [`## ${escapeHtml(section.folderName ?? "")}`]);
    }
    for (const feature of section.features) {
      pushBlock(out, renderFeature(feature, featureLevel, scenarioLevel));
    }
  }

  return `${out.join("\n")}\n`;
}

function prepareSection(
  parser: FeatureParser,
  section: ScenarioSection,
  filter: Set<string> | undefined,
  slugger: MarkdownSlugger,
  multiRoot: boolean,
): PreparedSection {
  const collected: Array<Omit<PreparedFeature, "slug">> = [];
  for (const feature of section.features) {
    const parsed = parser.parseFeatureContent(feature.rawText);
    const rawLines = feature.rawText.split("\n");
    if (!parsed) {
      // A tag filter can never include a feature we couldn't parse (no tags to match).
      if (filter) {continue;}
      collected.push({ pathRel: feature.pathRel, title: null, units: [], rawLines });
      continue;
    }
    const units = buildUnits(parsed.scenarios).filter((u) => unitMatches(u, filter));
    if (filter && units.length === 0) {continue;}
    collected.push({ pathRel: feature.pathRel, title: parsed.feature, units, rawLines });
  }
  collected.sort((a, b) => a.pathRel.localeCompare(b.pathRel));
  // Slugs are claimed in emission order: the folder heading precedes its features. The slugger
  // gets the RAW title (not entity-escaped) so anchors match GitHub's slugs of the rendered text.
  const folderSlug = multiRoot ? slugger.slug(section.folderName ?? "") : undefined;
  const features = collected.map((f): PreparedFeature => ({
    ...f,
    slug: slugger.slug(f.title ?? f.pathRel),
  }));
  return { folderName: section.folderName, folderSlug, features };
}

function renderContents(sections: PreparedSection[], multiRoot: boolean): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    if (multiRoot) {
      lines.push(`- [${escapeHtml(section.folderName ?? "")}](#${section.folderSlug})`);
      for (const feature of section.features) {
        lines.push(`  - [${escapeHtml(feature.title ?? feature.pathRel)}](#${feature.slug})`);
      }
    } else {
      for (const feature of section.features) {
        lines.push(`- [${escapeHtml(feature.title ?? feature.pathRel)}](#${feature.slug})`);
      }
    }
  }
  if (lines.length === 0) {return [];}
  return ["## Contents", ...lines];
}

function featureCounts(feature: PreparedFeature): FeatureCounts {
  let regular = 0;
  let outlines = 0;
  let exampleRows = 0;
  for (const unit of feature.units) {
    if (unit.kind === "regular") {
      regular += 1;
    } else if (unit.kind === "stub") {
      outlines += 1;
    } else {
      outlines += 1;
      exampleRows += unit.rows.length;
    }
  }
  return { regular, outlines, exampleRows, total: regular + exampleRows };
}

/**
 * Collapsible per-feature Summary table with a grand-total row. The Total column counts
 * runnable scenarios (regular + expanded example rows); outline declarations are broken out
 * separately so the table explains the Total rather than mystifying it.
 */
function renderSummary(
  sections: PreparedSection[],
  multiRoot: boolean,
  filterNote?: string,
): string[] {
  const lines = [
    "<details open>",
    "<summary><strong>Summary</strong></summary>",
    "",
    "## Summary",
  ];
  if (filterNote) {
    lines.push(`_${escapeHtml(filterNote)}_`, "");
  }

  const folderCol = multiRoot ? "| Folder " : "";
  const folderSep = multiRoot ? "|---" : "";
  lines.push(
    `${folderCol}| Feature | Regular | Outlines | Example rows | Total |`,
    `${folderSep}|---|---:|---:|---:|---:|`,
  );

  const grand: FeatureCounts = { regular: 0, outlines: 0, exampleRows: 0, total: 0 };
  for (const section of sections) {
    for (const feature of section.features) {
      const c = featureCounts(feature);
      grand.regular += c.regular;
      grand.outlines += c.outlines;
      grand.exampleRows += c.exampleRows;
      grand.total += c.total;
      const folder = multiRoot ? `| ${escapeHtml(section.folderName ?? "")} ` : "";
      const name = escapeHtml(feature.title ?? feature.pathRel);
      lines.push(
        `${folder}| ${name} | ${c.regular} | ${c.outlines} | ${c.exampleRows} | ${c.total} |`,
      );
    }
  }
  const totalFolder = multiRoot ? "| " : "";
  lines.push(
    `${totalFolder}| **Total** | **${grand.regular}** | **${grand.outlines}** | **${grand.exampleRows}** | **${grand.total}** |`,
    "",
    "</details>",
  );
  return lines;
}

function collectTagCounts(sections: PreparedSection[]): Map<string, number> {
  const tagCounts = new Map<string, number>();
  const scenarios = sections
    .flatMap((s) => s.features)
    .flatMap((f) => f.units)
    .flatMap((u) => unitScenarios(u));
  for (const scenario of scenarios) {
    for (const tag of scenario.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return tagCounts;
}

/** Collapsible tag-frequency table; omitted entirely when the catalog carries no tags. */
function renderTags(sections: PreparedSection[]): string[] {
  const tagCounts = collectTagCounts(sections);
  if (tagCounts.size === 0) {return [];}

  const sorted = [...tagCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const lines = [
    "<details open>",
    "<summary><strong>Tags</strong></summary>",
    "",
    "## Tags",
    "| Tag | Count |",
    "|---|---:|",
  ];
  for (const [tag, count] of sorted) {
    lines.push(`| ${tag} | ${count} |`);
  }
  lines.push("", "</details>");
  return lines;
}

function renderFeature(
  feature: PreparedFeature,
  featureLevel: string,
  scenarioLevel: string,
): string[] {
  if (feature.title === null) {
    return [`${featureLevel} ${feature.pathRel}`, "", "_Could not parse_"];
  }
  const title = escapeHtml(feature.title);
  const units = [...feature.units].sort((a, b) => a.sortLine - b.sortLine);
  const count = units.length === 1 ? "1 scenario" : `${units.length} scenarios`;
  // The heading lives inside the details block so its anchor exists; the blank lines after
  // <summary> and before </details> are required for the inner Markdown to render.
  const lines = [
    "<details open>",
    `<summary><strong>${title}</strong> — ${count}</summary>`,
    "",
    `${featureLevel} ${title}`,
    `\`${feature.pathRel}\``,
  ];
  for (const unit of units) {
    const rendered = renderUnit(unit, scenarioLevel, feature.rawLines);
    if (rendered.length > 0) {lines.push("", ...rendered);}
  }
  lines.push("", "</details>");
  return lines;
}

function buildUnits(scenarios: Scenario[]): Unit[] {
  const units: Unit[] = [];
  const seenOutlines = new Set<number>();
  for (const s of scenarios) {
    if (!s.isScenarioOutline) {
      units.push({ kind: "regular", sortLine: s.line, scenario: s });
    } else if (isOutlineExampleRow(s)) {
      if (seenOutlines.has(s.outlineLineNumber)) {continue;}
      seenOutlines.add(s.outlineLineNumber);
      const rows = scenarios.filter(
        (x): x is OutlineExampleRow =>
          isOutlineExampleRow(x) && x.outlineLineNumber === s.outlineLineNumber,
      );
      units.push({ kind: "outline", sortLine: s.outlineLineNumber, rows });
    } else {
      units.push({ kind: "stub", sortLine: s.outlineLineNumber, scenario: s });
    }
  }
  return units;
}

function unitScenarios(unit: Unit): Scenario[] {
  return unit.kind === "outline" ? unit.rows : [unit.scenario];
}

function unitMatches(unit: Unit, filter: Set<string> | undefined): boolean {
  if (!filter) {return true;}
  for (const s of unitScenarios(unit)) {
    for (const tag of s.tags ?? []) {
      if (filter.has(tag)) {return true;}
    }
  }
  return false;
}

function renderUnit(unit: Unit, scenarioLevel: string, rawLines: string[]): string[] {
  if (unit.kind === "regular") {
    return renderScenarioLines(
      `${scenarioLevel} Scenario: ${escapeHtml(unit.scenario.name)}`,
      unit.scenario.tags ?? [],
      unit.scenario.steps,
    );
  }
  if (unit.kind === "stub") {
    const lines = renderScenarioLines(
      `${scenarioLevel} Scenario Outline: ${escapeHtml(unit.scenario.outlineName)}`,
      unit.scenario.tags ?? [],
      unit.scenario.steps,
    );
    lines.push("", "_No examples_");
    return lines;
  }

  const first = unit.rows[0];
  if (!first) {return [];}
  const lines = renderScenarioLines(
    `${scenarioLevel} Scenario Outline: ${escapeHtml(first.outlineName)}`,
    outlineLevelTags(first),
    first.steps,
  );
  const seenBlocks = new Set<number>();
  for (const row of unit.rows) {
    if (seenBlocks.has(row.examplesBlockLineNumber)) {continue;}
    seenBlocks.add(row.examplesBlockLineNumber);
    // The verbatim table goes inside a fence: alignment survives exactly and the raw `<...>`
    // header/cell text needs no escaping there.
    lines.push(
      "",
      examplesLabel(row),
      "```",
      ...sliceExamplesTable(rawLines, row.examplesBlockLineNumber),
      "```",
    );
  }
  return lines;
}

function renderScenarioLines(heading: string, tags: string[], steps: string[]): string[] {
  const lines = [heading];
  if (tags.length > 0) {lines.push(`Tags: ${tags.join(" ")}`);}
  // Steps are prose list items, so outline placeholders like `<user>` must be entity-escaped
  // or the renderer swallows them as HTML tags.
  for (const step of steps) {lines.push(`- ${escapeHtml(step)}`);}
  return lines;
}

// Example rows carry the outline's tags plus their own examples-block tags; strip the block
// tags so the heading shows just the outline-level tags.
function outlineLevelTags(row: OutlineExampleRow): string[] {
  const tags = row.tags ?? [];
  const blockCount = row.examplesBlockTags?.length ?? 0;
  return blockCount > 0 ? tags.slice(0, tags.length - blockCount) : tags;
}

function examplesLabel(row: OutlineExampleRow): string {
  return row.examplesBlockName ? `Examples: ${escapeHtml(row.examplesBlockName)}` : "Examples:";
}

// The table is copied straight from the source so cell alignment survives; we take the
// contiguous run of `|...|` rows immediately after the Examples: line.
function sliceExamplesTable(rawLines: string[], examplesBlockLineNumber: number): string[] {
  const rows: string[] = [];
  for (let i = examplesBlockLineNumber; i < rawLines.length; i++) {
    const trimmed = (rawLines[i] ?? "").trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {break;}
    rows.push(trimmed);
  }
  return rows;
}

function pushBlock(out: string[], block: string[]): void {
  if (block.length === 0) {return;}
  if (out.length > 0) {out.push("");}
  out.push(...block);
}
