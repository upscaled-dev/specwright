import { countLabel, detailsTag, renderFooter, renderMasthead } from "./brand";
import { MarkdownSlugger } from "./markdown-slugger";

export interface StepDefExport {
  keyword: "Given" | "When" | "Then";
  humanized: string;
  verbatim: string;
  sourceRel: string;
  line: number;
  usageCount: number;
}

const KEYWORD_ORDER: Array<"Given" | "When" | "Then"> = ["Given", "When", "Then"];

interface KeywordGroup {
  keyword: "Given" | "When" | "Then";
  defs: StepDefExport[];
  slug: string;
}

interface SectionPlan {
  folderName?: string | undefined;
  folderSlug?: string | undefined;
  groups: KeywordGroup[];
}

export function renderStepsMarkdown(
  sections: Array<{ folderName?: string; defs: StepDefExport[] }>,
  options?: { brandLine?: string | undefined; collapsed?: boolean | undefined },
): string {
  const multiRoot = sections.length > 1;
  const collapsed = options?.collapsed;
  const slugger = new MarkdownSlugger();
  // Fixed headings claim their slugs first so a folder or group sharing their text still
  // gets the -N anchor GitHub would assign it.
  slugger.slug("Step Definitions");
  slugger.slug("Summary");
  slugger.slug("Unused");
  slugger.slug("Contents");

  const plans: SectionPlan[] = sections.map((section) => {
    const folderSlug = multiRoot ? slugger.slug(section.folderName ?? "") : undefined;
    const groups: KeywordGroup[] = [];
    for (const keyword of KEYWORD_ORDER) {
      const defs = section.defs
        .filter((d) => d.keyword === keyword)
        .sort((a, b) => a.humanized.localeCompare(b.humanized));
      if (defs.length === 0) {continue;}
      groups.push({ keyword, defs, slug: slugger.slug(keyword) });
    }
    return { folderName: section.folderName, folderSlug, groups };
  });

  const allDefs = sections.flatMap((s) => s.defs);
  const unusedDefs = allDefs.filter((d) => d.usageCount === 0);
  const stats = [countLabel(allDefs.length, "definition")];
  if (unusedDefs.length > 0) {stats.push(`${unusedDefs.length} unused`);}

  const out: string[] = renderMasthead("Step Definitions", {
    brandLine: options?.brandLine,
    stats,
  });
  pushBlock(out, renderContents(plans, multiRoot));
  pushBlock(out, renderSummary(sections, collapsed));
  pushBlock(out, renderUnused(unusedDefs, collapsed));

  const keywordLevel = multiRoot ? "###" : "##";
  for (const plan of plans) {
    if (multiRoot) {
      pushBlock(out, [`## ${plan.folderName}`]);
    }
    for (const group of plan.groups) {
      pushBlock(out, renderGroup(group, keywordLevel, collapsed));
    }
  }
  pushBlock(out, renderFooter(stats));

  return `${out.join("\n")}\n`;
}

function renderContents(plans: SectionPlan[], multiRoot: boolean): string[] {
  const lines: string[] = [];
  for (const plan of plans) {
    if (multiRoot) {
      lines.push(`- [${plan.folderName}](#${plan.folderSlug})`);
      for (const group of plan.groups) {
        lines.push(`  - [${group.keyword}](#${group.slug})`);
      }
    } else {
      for (const group of plan.groups) {
        lines.push(`- [${group.keyword}](#${group.slug})`);
      }
    }
  }
  if (lines.length === 0) {return [];}
  return ["## Contents", ...lines];
}

function renderGroup(
  group: KeywordGroup,
  keywordLevel: string,
  collapsed?: boolean,
): string[] {
  const count = countLabel(group.defs.length, "definition");
  // The heading lives inside the details block so its anchor exists; the blank lines after
  // <summary> and before </details> are required for the inner Markdown to render.
  const lines = [
    detailsTag(collapsed),
    `<summary><strong>${group.keyword}</strong>: ${count}</summary>`,
    "",
    `${keywordLevel} ${group.keyword}`,
  ];
  for (const def of group.defs) {
    lines.push(`- **\`${def.humanized}\`**: ${usageSuffix(def.usageCount)}`);
    lines.push(`  - Pattern: \`${def.verbatim}\``);
    lines.push(`  - Source: \`${def.sourceRel}:${def.line}\``);
  }
  lines.push("", "</details>");
  return lines;
}

/** Collapsible per-keyword Summary table with a bolded grand-total row. */
function renderSummary(
  sections: Array<{ folderName?: string; defs: StepDefExport[] }>,
  collapsed?: boolean,
): string[] {
  const all = sections.flatMap((s) => s.defs);
  const lines = [
    detailsTag(collapsed),
    "<summary><strong>Summary</strong></summary>",
    "",
    "## Summary",
    "| Keyword | Definitions | Unused |",
    "|---|---:|---:|",
  ];
  for (const keyword of KEYWORD_ORDER) {
    const defs = all.filter((d) => d.keyword === keyword);
    const unused = defs.filter((d) => d.usageCount === 0).length;
    lines.push(`| ${keyword} | ${defs.length} | ${unused} |`);
  }
  const totalUnused = all.filter((d) => d.usageCount === 0).length;
  lines.push(
    `| **Total** | **${all.length}** | **${totalUnused}** |`,
    "",
    "</details>",
  );
  return lines;
}

/**
 * Collapsible callout listing every never-referenced step definition so dead steps are
 * actionable in one place instead of scattered behind inline _(unused)_ markers. Omitted
 * entirely when nothing is unused.
 */
function renderUnused(unused: StepDefExport[], collapsed?: boolean): string[] {
  if (unused.length === 0) {return [];}
  const ordered = [...unused].sort(
    (a, b) =>
      KEYWORD_ORDER.indexOf(a.keyword) - KEYWORD_ORDER.indexOf(b.keyword) ||
      a.humanized.localeCompare(b.humanized),
  );
  const lines = [
    detailsTag(collapsed),
    `<summary><strong>Unused</strong>: ${countLabel(unused.length, "definition")}</summary>`,
    "",
    "## Unused",
  ];
  for (const def of ordered) {
    lines.push(`- **\`${def.humanized}\`** (${def.keyword}): \`${def.sourceRel}:${def.line}\``);
  }
  lines.push("", "</details>");
  return lines;
}

function usageSuffix(count: number): string {
  const base = count === 1 ? "1 use" : `${count} uses`;
  return count === 0 ? `${base} _(unused)_` : base;
}

function pushBlock(out: string[], block: string[]): void {
  if (block.length === 0) {return;}
  if (out.length > 0) {out.push("");}
  out.push(...block);
}
