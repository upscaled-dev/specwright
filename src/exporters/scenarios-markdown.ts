import { FeatureParser, isOutlineExampleRow } from "../parsers/feature-parser";
import { OutlineExampleRow, OutlineStub, RegularScenario, Scenario } from "../types/index";
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
  slugger.slug("Summary");
  slugger.slug("Contents");
  const prepared = sections.map((section): PreparedSection =>
    prepareSection(parser, section, filter, slugger, multiRoot),
  );

  const featureLevel = multiRoot ? "###" : "##";
  const scenarioLevel = multiRoot ? "####" : "###";

  const out: string[] = ["# Feature Catalog"];
  if (options?.brandLine) {out.push(`_${options.brandLine}_`);}
  pushBlock(out, renderSummary(prepared, filterNote));
  pushBlock(out, renderContents(prepared, multiRoot));

  for (const section of prepared) {
    if (multiRoot) {
      pushBlock(out, [`## ${section.folderName}`]);
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
  // Slugs are claimed in emission order: the folder heading precedes its features.
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
      lines.push(`- [${section.folderName}](#${section.folderSlug})`);
      for (const feature of section.features) {
        lines.push(`  - [${feature.title ?? feature.pathRel}](#${feature.slug})`);
      }
    } else {
      for (const feature of section.features) {
        lines.push(`- [${feature.title ?? feature.pathRel}](#${feature.slug})`);
      }
    }
  }
  if (lines.length === 0) {return [];}
  return ["## Contents", ...lines];
}

function renderFeature(
  feature: PreparedFeature,
  featureLevel: string,
  scenarioLevel: string,
): string[] {
  if (feature.title === null) {
    return [`${featureLevel} ${feature.pathRel}`, "", "_Could not parse_"];
  }
  const units = [...feature.units].sort((a, b) => a.sortLine - b.sortLine);
  const count = units.length === 1 ? "1 scenario" : `${units.length} scenarios`;
  // The heading lives inside the details block so its anchor exists; the blank lines after
  // <summary> and before </details> are required for the inner Markdown to render.
  const lines = [
    "<details open>",
    `<summary><strong>${feature.title}</strong> — ${count}</summary>`,
    "",
    `${featureLevel} ${feature.title}`,
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
      `${scenarioLevel} Scenario: ${unit.scenario.name}`,
      unit.scenario.tags ?? [],
      unit.scenario.steps,
    );
  }
  if (unit.kind === "stub") {
    const lines = renderScenarioLines(
      `${scenarioLevel} Scenario Outline: ${unit.scenario.outlineName}`,
      unit.scenario.tags ?? [],
      unit.scenario.steps,
    );
    lines.push("", "_No examples_");
    return lines;
  }

  const first = unit.rows[0];
  if (!first) {return [];}
  const lines = renderScenarioLines(
    `${scenarioLevel} Scenario Outline: ${first.outlineName}`,
    outlineLevelTags(first),
    first.steps,
  );
  const seenBlocks = new Set<number>();
  for (const row of unit.rows) {
    if (seenBlocks.has(row.examplesBlockLineNumber)) {continue;}
    seenBlocks.add(row.examplesBlockLineNumber);
    lines.push("", examplesLabel(row), ...sliceExamplesTable(rawLines, row.examplesBlockLineNumber));
  }
  return lines;
}

function renderScenarioLines(heading: string, tags: string[], steps: string[]): string[] {
  const lines = [heading];
  if (tags.length > 0) {lines.push(`Tags: ${tags.join(" ")}`);}
  for (const step of steps) {lines.push(`- ${step}`);}
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
  return row.examplesBlockName ? `Examples: ${row.examplesBlockName}` : "Examples:";
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

function renderSummary(sections: PreparedSection[], filterNote?: string): string[] {
  const features = sections.flatMap((s) => s.features);
  const units = features.flatMap((f) => f.units);

  let regular = 0;
  let outlines = 0;
  let exampleRows = 0;
  const tagCounts = new Map<string, number>();
  for (const unit of units) {
    if (unit.kind === "regular") {
      regular += 1;
    } else if (unit.kind === "stub") {
      outlines += 1;
    } else {
      outlines += 1;
      exampleRows += unit.rows.length;
    }
    for (const scenario of unitScenarios(unit)) {
      for (const tag of scenario.tags ?? []) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  const summary = ["## Summary"];
  if (filterNote) {
    summary.push(filterNote, "");
  }
  summary.push(
    `- Features: ${features.length}`,
    `- Regular scenarios: ${regular}`,
    `- Scenario outlines: ${outlines}`,
    `- Outline example rows: ${exampleRows}`,
  );

  const sortedTags = [...tagCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (sortedTags.length > 0) {
    summary.push("", "Tags:");
    for (const [tag, count] of sortedTags) {
      summary.push(`- ${tag} — ${count}`);
    }
  }
  return summary;
}

function pushBlock(out: string[], block: string[]): void {
  if (block.length === 0) {return;}
  if (out.length > 0) {out.push("");}
  out.push(...block);
}
