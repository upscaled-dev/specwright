import { describe, it, expect } from "vitest";
import { renderStepsMarkdown, StepDefExport } from "../../exporters/steps-markdown";

function def(overrides: Partial<StepDefExport> & Pick<StepDefExport, "keyword" | "humanized">): StepDefExport {
  return {
    verbatim: overrides.humanized,
    sourceRel: "features/steps/a.steps.ts",
    line: 1,
    usageCount: 0,
    ...overrides,
  };
}

describe("renderStepsMarkdown", () => {
  it("renders a single-root catalog with summary, contents, collapsible groups, and usage markers", () => {
    const md = renderStepsMarkdown([
      {
        defs: [
          { keyword: "Given", humanized: "I have {int} cukes", verbatim: "I have {int} cukes", sourceRel: "features/steps/cukes.steps.ts", line: 7, usageCount: 5 },
          { keyword: "Given", humanized: "the count is {int}", verbatim: "the count is {int}", sourceRel: "features/steps/count.steps.ts", line: 3, usageCount: 0 },
          { keyword: "When", humanized: "I click {string}", verbatim: `I click "([^"]*)"`, sourceRel: "features/steps/click.steps.ts", line: 10, usageCount: 1 },
        ],
      },
    ]);

    expect(md).toBe(
      [
        "# Step Definitions",
        "",
        "## Summary",
        "- Total definitions: 3",
        "- Given: 2",
        "- When: 1",
        "- Then: 0",
        "- Unused: 1",
        "",
        "## Contents",
        "- [Given](#given)",
        "- [When](#when)",
        "",
        "<details open>",
        "<summary><strong>Given</strong> — 2 definitions</summary>",
        "",
        "## Given",
        "- **`I have {int} cukes`** — 5 uses",
        "  - Pattern: `I have {int} cukes`",
        "  - Source: `features/steps/cukes.steps.ts:7`",
        "- **`the count is {int}`** — 0 uses _(unused)_",
        "  - Pattern: `the count is {int}`",
        "  - Source: `features/steps/count.steps.ts:3`",
        "",
        "</details>",
        "",
        "<details open>",
        "<summary><strong>When</strong> — 1 definition</summary>",
        "",
        "## When",
        "- **`I click {string}`** — 1 use",
        `  - Pattern: \`I click "([^"]*)"\``,
        "  - Source: `features/steps/click.steps.ts:10`",
        "",
        "</details>",
        "",
      ].join("\n")
    );
  });

  it("sorts alphabetically by humanized label within a keyword group", () => {
    const md = renderStepsMarkdown([
      {
        defs: [
          def({ keyword: "Then", humanized: "zebra crossing" }),
          def({ keyword: "Then", humanized: "apple falls" }),
          def({ keyword: "Then", humanized: "mango ripens" }),
        ],
      },
    ]);
    const order = md
      .split("\n")
      .filter((l) => l.startsWith("- **`"))
      .map((l) => l.slice(5, l.indexOf("`**")));
    expect(order).toEqual(["apple falls", "mango ripens", "zebra crossing"]);
  });

  it("shifts keyword headings to ### and adds folder headings in multi-root mode", () => {
    const md = renderStepsMarkdown([
      { folderName: "web", defs: [def({ keyword: "Given", humanized: "a", usageCount: 2 })] },
      { folderName: "api", defs: [def({ keyword: "Then", humanized: "b", usageCount: 0 })] },
    ]);

    expect(md).toBe(
      [
        "# Step Definitions",
        "",
        "## Summary",
        "- Total definitions: 2",
        "- Given: 1",
        "- When: 0",
        "- Then: 1",
        "- Unused: 1",
        "",
        "## Contents",
        "- [web](#web)",
        "  - [Given](#given)",
        "- [api](#api)",
        "  - [Then](#then)",
        "",
        "## web",
        "",
        "<details open>",
        "<summary><strong>Given</strong> — 1 definition</summary>",
        "",
        "### Given",
        "- **`a`** — 2 uses",
        "  - Pattern: `a`",
        "  - Source: `features/steps/a.steps.ts:1`",
        "",
        "</details>",
        "",
        "## api",
        "",
        "<details open>",
        "<summary><strong>Then</strong> — 1 definition</summary>",
        "",
        "### Then",
        "- **`b`** — 0 uses _(unused)_",
        "  - Pattern: `b`",
        "  - Source: `features/steps/a.steps.ts:1`",
        "",
        "</details>",
        "",
      ].join("\n")
    );
  });

  it("suffixes duplicate keyword anchors across folders in document order", () => {
    const md = renderStepsMarkdown([
      { folderName: "web", defs: [def({ keyword: "Given", humanized: "a" })] },
      { folderName: "api", defs: [def({ keyword: "Given", humanized: "b" })] },
    ]);
    expect(md).toContain("- [web](#web)\n  - [Given](#given)");
    expect(md).toContain("- [api](#api)\n  - [Given](#given-1)");
  });

  it("keeps a blank line after <summary> and before </details> so inner Markdown renders", () => {
    const md = renderStepsMarkdown([{ defs: [def({ keyword: "Given", humanized: "a" })] }]);
    expect(md).toContain("<summary><strong>Given</strong> — 1 definition</summary>\n\n## Given");
    expect(md).toContain("`features/steps/a.steps.ts:1`\n\n</details>");
  });

  it("omits empty keyword groups", () => {
    const md = renderStepsMarkdown([{ defs: [def({ keyword: "When", humanized: "x" })] }]);
    expect(md).toContain("## When");
    expect(md).not.toContain("## Given");
    expect(md).not.toContain("## Then");
  });

  it("emits just the title and a zeroed summary when there are no defs", () => {
    const md = renderStepsMarkdown([{ defs: [] }]);
    expect(md).toBe(
      [
        "# Step Definitions",
        "",
        "## Summary",
        "- Total definitions: 0",
        "- Given: 0",
        "- When: 0",
        "- Then: 0",
        "- Unused: 0",
        "",
      ].join("\n")
    );
  });

  it("renders the brand line in italics directly under the title, above Summary", () => {
    const md = renderStepsMarkdown(
      [{ defs: [] }],
      { brandLine: "Generated by Specwright v0.2.3 — 2026-07-17 22:41" }
    );
    expect(md.startsWith(
      [
        "# Step Definitions",
        "_Generated by Specwright v0.2.3 — 2026-07-17 22:41_",
        "",
        "## Summary",
      ].join("\n")
    )).toBe(true);
  });

  it("omits the brand line when options are not provided", () => {
    const md = renderStepsMarkdown([{ defs: [] }]);
    expect(md.startsWith("# Step Definitions\n\n## Summary")).toBe(true);
  });
});
