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
  options?: { brandLine?: string | undefined },
): string {
  const multiRoot = sections.length > 1;
  const slugger = new MarkdownSlugger();
  // Fixed headings claim their slugs first so a folder or group sharing their text still
  // gets the -N anchor GitHub would assign it.
  slugger.slug("Step Definitions");
  slugger.slug("Summary");
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

  const out: string[] = ["# Step Definitions"];
  if (options?.brandLine) {out.push(`_${options.brandLine}_`);}
  pushBlock(out, renderSummary(sections));
  pushBlock(out, renderContents(plans, multiRoot));

  const keywordLevel = multiRoot ? "###" : "##";
  for (const plan of plans) {
    if (multiRoot) {
      pushBlock(out, [`## ${plan.folderName}`]);
    }
    for (const group of plan.groups) {
      pushBlock(out, renderGroup(group, keywordLevel));
    }
  }

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

function renderGroup(group: KeywordGroup, keywordLevel: string): string[] {
  const count = group.defs.length === 1 ? "1 definition" : `${group.defs.length} definitions`;
  // The heading lives inside the details block so its anchor exists; the blank lines after
  // <summary> and before </details> are required for the inner Markdown to render.
  const lines = [
    "<details open>",
    `<summary><strong>${group.keyword}</strong> — ${count}</summary>`,
    "",
    `${keywordLevel} ${group.keyword}`,
  ];
  for (const def of group.defs) {
    lines.push(`- **\`${def.humanized}\`** — ${usageSuffix(def.usageCount)}`);
    lines.push(`  - Pattern: \`${def.verbatim}\``);
    lines.push(`  - Source: \`${def.sourceRel}:${def.line}\``);
  }
  lines.push("", "</details>");
  return lines;
}

function renderSummary(
  sections: Array<{ folderName?: string; defs: StepDefExport[] }>,
): string[] {
  const all = sections.flatMap((s) => s.defs);
  const count = (keyword: "Given" | "When" | "Then"): number =>
    all.filter((d) => d.keyword === keyword).length;
  const unused = all.filter((d) => d.usageCount === 0).length;
  return [
    "## Summary",
    `- Total definitions: ${all.length}`,
    `- Given: ${count("Given")}`,
    `- When: ${count("When")}`,
    `- Then: ${count("Then")}`,
    `- Unused: ${unused}`,
  ];
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
