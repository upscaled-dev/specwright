import { describe, it, expect } from "vitest";
import { renderScenariosMarkdown } from "../../exporters/scenarios-markdown";

const CHECKOUT = [
  "@feature",
  "Feature: Checkout",
  "",
  "  @smoke",
  "  Scenario: Empty cart",
  "    Given I am on the cart page",
  "    Then the cart is empty",
  "",
  "  @outline",
  "  Scenario Outline: Sign in",
  `    Given I sign in as "<user>"`,
  `    Then I land on "<page>"`,
  "",
  "    @block",
  "    Examples:",
  "      | user  | page      |",
  "      | admin | dashboard |",
  "      | guest | home      |",
].join("\n");

const PROFILE = [
  "Feature: Profile",
  "  Scenario: View profile",
  "    Given I am logged in",
  "    Then I see my profile",
].join("\n");

describe("renderScenariosMarkdown", () => {
  it("renders a single-root catalog with summary, contents, collapsible features, and a verbatim example table", () => {
    const md = renderScenariosMarkdown([
      { features: [{ pathRel: "features/checkout.feature", rawText: CHECKOUT }] },
    ]);

    expect(md).toBe(
      [
        "# Feature Catalog",
        "",
        "## Contents",
        "- [Checkout](#checkout)",
        "",
        "<details open>",
        "<summary><strong>Summary</strong></summary>",
        "",
        "## Summary",
        "| Feature | Regular | Outlines | Example rows | Total |",
        "|---|---:|---:|---:|---:|",
        "| Checkout | 1 | 1 | 2 | 3 |",
        "| **Total** | **1** | **1** | **2** | **3** |",
        "",
        "</details>",
        "",
        "<details open>",
        "<summary><strong>Tags</strong></summary>",
        "",
        "## Tags",
        "| Tag | Count |",
        "|---|---:|",
        "| @feature | 3 |",
        "| @block | 2 |",
        "| @outline | 2 |",
        "| @smoke | 1 |",
        "",
        "</details>",
        "",
        "<details open>",
        "<summary><strong>Checkout</strong> — 2 scenarios</summary>",
        "",
        "## Checkout",
        "`features/checkout.feature`",
        "",
        "### Scenario: Empty cart",
        "Tags: @feature @smoke",
        "- Given I am on the cart page",
        "- Then the cart is empty",
        "",
        "### Scenario Outline: Sign in",
        "Tags: @feature @outline",
        `- Given I sign in as "&lt;user&gt;"`,
        `- Then I land on "&lt;page&gt;"`,
        "",
        "Examples:",
        "```",
        "| user  | page      |",
        "| admin | dashboard |",
        "| guest | home      |",
        "```",
        "",
        "</details>",
        "",
      ].join("\n")
    );
  });

  it("filters scenarios by any-of tag and renders the filter note", () => {
    const md = renderScenariosMarkdown(
      [{ features: [{ pathRel: "features/checkout.feature", rawText: CHECKOUT }] }],
      { tagFilter: ["@smoke"], filterNote: "Filtered by tag @smoke — 1 of 1 features included." }
    );

    expect(md).toBe(
      [
        "# Feature Catalog",
        "",
        "## Contents",
        "- [Checkout](#checkout)",
        "",
        "<details open>",
        "<summary><strong>Summary</strong></summary>",
        "",
        "## Summary",
        "_Filtered by tag @smoke — 1 of 1 features included._",
        "",
        "| Feature | Regular | Outlines | Example rows | Total |",
        "|---|---:|---:|---:|---:|",
        "| Checkout | 1 | 0 | 0 | 1 |",
        "| **Total** | **1** | **0** | **0** | **1** |",
        "",
        "</details>",
        "",
        "<details open>",
        "<summary><strong>Tags</strong></summary>",
        "",
        "## Tags",
        "| Tag | Count |",
        "|---|---:|",
        "| @feature | 1 |",
        "| @smoke | 1 |",
        "",
        "</details>",
        "",
        "<details open>",
        "<summary><strong>Checkout</strong> — 1 scenario</summary>",
        "",
        "## Checkout",
        "`features/checkout.feature`",
        "",
        "### Scenario: Empty cart",
        "Tags: @feature @smoke",
        "- Given I am on the cart page",
        "- Then the cart is empty",
        "",
        "</details>",
        "",
      ].join("\n")
    );
  });

  it("omits features with no matching scenarios but keeps the ratio in the note", () => {
    const md = renderScenariosMarkdown(
      [
        {
          features: [
            { pathRel: "features/checkout.feature", rawText: CHECKOUT },
            { pathRel: "features/profile.feature", rawText: PROFILE },
          ],
        },
      ],
      { tagFilter: ["@smoke"], filterNote: "Filtered by tag @smoke — 1 of 2 features included." }
    );

    expect(md).toContain("_Filtered by tag @smoke — 1 of 2 features included._");
    expect(md).toContain("| Checkout | 1 | 0 | 0 | 1 |");
    expect(md).toContain("## Checkout");
    expect(md).not.toContain("Profile");
    expect(md).not.toContain("View profile");
  });

  it("sorts features by pathRel within a section", () => {
    const md = renderScenariosMarkdown([
      {
        features: [
          { pathRel: "features/profile.feature", rawText: PROFILE },
          { pathRel: "features/checkout.feature", rawText: CHECKOUT },
        ],
      },
    ]);
    expect(md.indexOf("## Checkout")).toBeLessThan(md.indexOf("## Profile"));
    expect(md.indexOf("- [Checkout](#checkout)")).toBeLessThan(md.indexOf("- [Profile](#profile)"));
  });

  it("suffixes duplicate feature anchors in document order", () => {
    const other = ["Feature: Checkout", "  Scenario: Alt", "    Given y"].join("\n");
    const md = renderScenariosMarkdown([
      {
        features: [
          { pathRel: "features/a.feature", rawText: CHECKOUT },
          { pathRel: "features/b.feature", rawText: other },
        ],
      },
    ]);
    expect(md).toContain("- [Checkout](#checkout)\n- [Checkout](#checkout-1)");
  });

  it("slugs anchors GitHub-style for titles with punctuation", () => {
    const raw = ["Feature: Auth (<user>/<role>)", "  Scenario: S", "    Given x"].join("\n");
    const md = renderScenariosMarkdown([
      { features: [{ pathRel: "features/auth.feature", rawText: raw }] },
    ]);
    // Link text and headings are entity-escaped so the rendered doc shows the literal
    // placeholders; the anchor comes from slugging the RAW title (GitHub slugs rendered text).
    expect(md).toContain("- [Auth (&lt;user&gt;/&lt;role&gt;)](#auth-userrole)");
    expect(md).toContain("## Auth (&lt;user&gt;/&lt;role&gt;)");
  });

  it("keeps a blank line after <summary> and before </details> so inner Markdown renders", () => {
    const md = renderScenariosMarkdown([
      { features: [{ pathRel: "features/profile.feature", rawText: PROFILE }] },
    ]);
    expect(md).toContain("<summary><strong>Profile</strong> — 1 scenario</summary>\n\n## Profile");
    expect(md).toContain("- Then I see my profile\n\n</details>");
  });

  it("renders an OutlineStub with a _No examples_ note", () => {
    const stub = [
      "Feature: Stubby",
      "  Scenario Outline: No data",
      "    Given I do <thing>",
    ].join("\n");
    const md = renderScenariosMarkdown([
      { features: [{ pathRel: "features/stub.feature", rawText: stub }] },
    ]);
    expect(md).toContain("### Scenario Outline: No data");
    expect(md).toContain("- Given I do &lt;thing&gt;");
    expect(md).toContain("_No examples_");
    expect(md).toContain("| Stubby | 0 | 1 | 0 | 0 |");
  });

  it("notes an unparsable feature under its path instead of omitting it", () => {
    const md = renderScenariosMarkdown([
      { features: [{ pathRel: "features/broken.feature", rawText: "this is not gherkin" }] },
    ]);
    expect(md).toContain("- [features/broken.feature](#featuresbrokenfeature)");
    expect(md).toContain("## features/broken.feature");
    expect(md).toContain("_Could not parse_");
    expect(md).toContain("| features/broken.feature | 0 | 0 | 0 | 0 |");
  });

  it("drops unparsable features when a tag filter is active", () => {
    const md = renderScenariosMarkdown(
      [{ features: [{ pathRel: "features/broken.feature", rawText: "this is not gherkin" }] }],
      { tagFilter: ["@smoke"] }
    );
    expect(md).not.toContain("_Could not parse_");
    expect(md).toContain("| **Total** | **0** | **0** | **0** | **0** |");
  });

  it("renders the brand line in italics directly under the title, above the body", () => {
    const md = renderScenariosMarkdown(
      [{ features: [{ pathRel: "features/profile.feature", rawText: PROFILE }] }],
      { brandLine: "Generated by Specwright v0.2.3 — 2026-07-17 22:41" }
    );
    expect(md.startsWith(
      [
        "# Feature Catalog",
        "_Generated by Specwright v0.2.3 — 2026-07-17 22:41_",
        "",
        "## Contents",
      ].join("\n")
    )).toBe(true);
  });

  it("omits the brand line when options do not include it", () => {
    const md = renderScenariosMarkdown([
      { features: [{ pathRel: "features/profile.feature", rawText: PROFILE }] },
    ]);
    expect(md.startsWith("# Feature Catalog\n\n## Contents")).toBe(true);
  });

  it("shifts heading levels and nests the contents under folder entries in multi-root mode", () => {
    const md = renderScenariosMarkdown([
      { folderName: "web", features: [{ pathRel: "features/checkout.feature", rawText: CHECKOUT }] },
      { folderName: "api", features: [{ pathRel: "features/profile.feature", rawText: PROFILE }] },
    ]);
    expect(md).toContain("- [web](#web)\n  - [Checkout](#checkout)");
    expect(md).toContain("- [api](#api)\n  - [Profile](#profile)");
    expect(md).toContain("## web");
    expect(md).toContain("## api");
    expect(md).toContain("### Checkout");
    expect(md).toContain("#### Scenario: Empty cart");
    expect(md).toContain("#### Scenario: View profile");
  });
});
