import { describe, it, expect } from "vitest";
import {
  extractMissingStepsBlock,
  suggestedFeatureGlob,
} from "../../test-providers/playwright-bdd-test-provider";

describe("extractMissingStepsBlock", () => {
  it("returns '' when there is no missing-steps block", () => {
    expect(extractMissingStepsBlock("Running 3 tests\n3 passed")).toBe("");
    expect(extractMissingStepsBlock("")).toBe("");
  });

  it("extracts the bddgen block with snippets, bounded by its trailing marker", () => {
    const out = [
      "Missing step definitions: 1",
      "",
      "Given('I have a new widget', async ({}) => {",
      "  // Step: Given I have a new widget",
      "});",
      "",
      "Use snippets above to create missing steps.",
      "",
      "Running 3 tests using 1 worker",
      "  3 passed (1.2s)",
    ].join("\n");

    const block = extractMissingStepsBlock(out);
    expect(block).toContain("Missing step definitions: 1");
    expect(block).toContain("Given('I have a new widget'");
    expect(block).toContain("Use snippets above to create missing steps.");
    // Must NOT bleed into the Playwright reporter output that follows.
    expect(block).not.toContain("Running 3 tests");
    expect(block).not.toContain("3 passed");
  });

  it("stops at the Playwright reporter line when the trailing marker is absent", () => {
    const out = [
      "Missing step definitions: 2",
      "",
      "When('I do a thing', async ({}) => {});",
      "Running 5 tests using 2 workers",
      "  5 passed",
    ].join("\n");

    const block = extractMissingStepsBlock(out);
    expect(block).toContain("Missing step definitions: 2");
    expect(block).toContain("When('I do a thing'");
    expect(block).not.toContain("Running 5 tests");
  });
});

describe("suggestedFeatureGlob", () => {
  it("returns a recursive glob for the feature's directory, relative to the workspace", () => {
    expect(
      suggestedFeatureGlob(
        "/repo/src/test/integration/fixtures/workspace/features/sample.feature",
        "/repo"
      )
    ).toBe("src/test/integration/fixtures/workspace/features/**/*.feature");
  });

  it("handles a feature at the workspace root", () => {
    expect(suggestedFeatureGlob("/repo/login.feature", "/repo")).toBe("**/*.feature");
  });
});
