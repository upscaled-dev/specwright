import { describe, it, expect } from "vitest";
import {
  extractStepDefsFromSource,
  extractStepText,
  patternToRegexSource,
} from "../../providers/step-definition-provider";
import { STEP_KEYWORDS } from "../../providers/step-keywords";

describe("STEP_KEYWORDS contract", () => {
  it("is the bare alternation without trailing whitespace or grouping", () => {
    expect(typeof STEP_KEYWORDS).toBe("string");
    expect(STEP_KEYWORDS.endsWith(" ")).toBe(false);
    expect(STEP_KEYWORDS).toBe(String.raw`Given|When|Then|And|But|\*`);
  });
});

describe("StepDefinitionProvider helpers", () => {
  describe("extractStepText", () => {
    it("returns trimmed step body for Given/When/Then/And/But", () => {
      expect(extractStepText("  Given I have 5 users")).toBe("I have 5 users");
      expect(extractStepText("When I click submit")).toBe("I click submit");
      expect(extractStepText("Then it works")).toBe("it works");
      expect(extractStepText("  And another step")).toBe("another step");
      expect(extractStepText("    But not this one")).toBe("not this one");
    });

    it("returns trimmed step body for the * generic keyword", () => {
      expect(extractStepText("  * I do something")).toBe("I do something");
      expect(extractStepText("* I have valid credentials")).toBe("I have valid credentials");
    });

    it("returns undefined for non-step lines", () => {
      expect(extractStepText("Feature: foo")).toBeUndefined();
      expect(extractStepText("")).toBeUndefined();
    });

    it("accepts multiple spaces or a tab between keyword and step body", () => {
      expect(extractStepText("  Given   I have 5 users")).toBe("I have 5 users");
      expect(extractStepText("\tWhen\tI click submit")).toBe("I click submit");
    });
  });

  describe("patternToRegexSource", () => {
    const compile = (pattern: string): RegExp => new RegExp(`^${patternToRegexSource(pattern)}$`);

    it("expands {int} to a signed integer matcher", () => {
      const re = compile("I have {int} users");
      expect(re.test("I have 5 users")).toBe(true);
      expect(re.test("I have -5 users")).toBe(true);
      expect(re.test("I have many users")).toBe(false);
    });

    it("expands {float} to a numeric matcher", () => {
      const re = compile("the value is {float}");
      expect(re.test("the value is 3.14")).toBe(true);
      expect(re.test("the value is -7")).toBe(true);
      expect(re.test("the value is pi")).toBe(false);
    });

    it("expands {word} to a non-space matcher", () => {
      const re = compile("I open {word} page");
      expect(re.test("I open admin page")).toBe(true);
      expect(re.test("I open the admin page")).toBe(false);
    });

    it("expands {string} to quoted content consuming the quotes", () => {
      const re = compile("I see {string}");
      expect(re.test(`I see "hello world"`)).toBe(true);
      expect(re.test("I see 'hello'")).toBe(true);
      expect(re.test("I see hello")).toBe(false);
    });

    it("expands {} and custom names to non-greedy wildcards", () => {
      expect(compile("anything {}").test("anything at all")).toBe(true);
      expect(compile("user {name} logs in").test("user Alice logs in")).toBe(true);
    });

    it("treats trailing (s) as optional text", () => {
      const re = compile("I have {int} cucumber(s)");
      expect(re.test("I have 1 cucumber")).toBe(true);
      expect(re.test("I have 2 cucumbers")).toBe(true);
      expect(re.test("I have 2 cucumberz")).toBe(false);
    });

    it("treats a/b as alternation scoped to the adjacent word", () => {
      const re = compile("I click the button/link now");
      expect(re.test("I click the button now")).toBe(true);
      expect(re.test("I click the link now")).toBe(true);
      expect(re.test("I click the buttonlink now")).toBe(false);
    });

    it("treats escaped braces, parens, and slashes as literals", () => {
      expect(compile(String.raw`I press \{ctrl\}`).test("I press {ctrl}")).toBe(true);
      expect(compile(String.raw`I see \(parens\)`).test("I see (parens)")).toBe(true);
      expect(compile(String.raw`either\/or`).test("either/or")).toBe(true);
      expect(compile(String.raw`either\/or`).test("either")).toBe(false);
    });

    it("escapes regex specials in literal text", () => {
      const re = compile("count is 3.14 [exactly]");
      expect(re.test("count is 3.14 [exactly]")).toBe(true);
      expect(re.test("count is 3x14 [exactly]")).toBe(false);
    });
  });

  describe("extractStepDefsFromSource", () => {
    it("finds Given/When/Then with string and template-literal patterns", () => {
      const src = [
        "import { createBdd } from 'playwright-bdd';",
        "const { Given, When, Then } = createBdd();",
        "Given('I am on the home page', async ({ page }) => {});",
        'When("I click {string}", async ({ page }, label) => {});',
        "Then(`the count is {int}`, async ({ page }, n) => {});",
      ].join("\n");

      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(3);
      expect(defs[0]!.regex.test("I am on the home page")).toBe(true);
      expect(defs[1]!.regex.test(`I click "submit"`)).toBe(true);
      expect(defs[2]!.regex.test("the count is 7")).toBe(true);
    });

    it("finds regex-literal step definitions", () => {
      const src = "Then(/^count is (\\d+)$/, async ({}, n) => {});";
      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(1);
      expect(defs[0]!.regex.test("count is 42")).toBe(true);
      expect(defs[0]!.regex.test("the count is wrong")).toBe(false);
    });

    it("finds the pattern when Prettier breaks the call across lines", () => {
      const src = [
        "Given(",
        "  'I am on the home page',",
        "  async ({ page }) => {}",
        ");",
        "",
        "When(",
        "",
        "  /^I press (.+)$/,",
        "  async () => {}",
        ");",
      ].join("\n");
      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(2);
      expect(defs[0]!.line).toBe(0);
      expect(defs[0]!.regex.test("I am on the home page")).toBe(true);
      expect(defs[1]!.line).toBe(5);
      expect(defs[1]!.regex.test("I press enter")).toBe(true);
    });

    it("anchors a regex literal with top-level alternation as a whole", () => {
      const src = "When(/I click|I press/, async () => {});";
      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(1);
      expect(defs[0]!.regex.test("I click")).toBe(true);
      expect(defs[0]!.regex.test("I press")).toBe(true);
      expect(defs[0]!.regex.test("they say I press enter")).toBe(false);
    });

    it("anchors a regex literal whose trailing $ is escaped (literal dollar)", () => {
      const src = String.raw`Then(/the price is 10\$/, async () => {});`;
      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(1);
      expect(defs[0]!.regex.test("the price is 10$")).toBe(true);
      expect(defs[0]!.regex.test("the price is 10$ or more")).toBe(false);
    });

    it("parses a regex literal containing / inside a character class and keeps d/v-style flags", () => {
      const src = "Given(/^path foo[/]bar$/d, async () => {});";
      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(1);
      expect(defs[0]!.regex.test("path foo/bar")).toBe(true);
      expect(defs[0]!.regex.flags).toContain("d");
    });

    it("rejects template literals containing ${...} interpolation", () => {
      const src = "Given(`I have ${count} users`, async () => {});";
      expect(extractStepDefsFromSource(src)).toHaveLength(0);
    });

    it("ignores step calls inside line comments", () => {
      const src = [
        "// Given('commented out', () => {});",
        "  // When('also commented', () => {});",
        "Then('real step', async () => {});",
      ].join("\n");
      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(1);
      expect(defs[0]!.pattern).toBe("real step");
    });

    it("preserves the case-insensitive flag on regex-literal step definitions", () => {
      const src = "When(/^Click Submit$/i, async () => {});";
      const defs = extractStepDefsFromSource(src);
      expect(defs).toHaveLength(1);
      expect(defs[0]!.regex.flags).toContain("i");
      expect(defs[0]!.regex.test("click submit")).toBe(true);
    });

    it("ignores method calls like foo.Given(...)", () => {
      const src = "foo.Given('not a real step', () => {});";
      expect(extractStepDefsFromSource(src)).toHaveLength(0);
    });
  });
});
