import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { StepResolver } from "../../providers/step-resolver";
import { extractStepDefsFromSource } from "../../providers/step-definition-provider";

function makeResolver(): StepResolver {
  return new StepResolver();
}

describe("StepResolver.findUnmatchedSteps", () => {
  it("treats And/But as inheriting the previous Given/When/Then keyword", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource(
      [
        "Given('I am ready', async () => {});",
        "Given('I have started', async () => {});",
      ].join("\n")
    );

    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    Given I am ready",
      "    And I have not started",
      "    But I have started",
      "    Then I see results",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, defs);

    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]!.keyword).toBe("And");
    expect(unmatched[0]!.effectiveKeyword).toBe("Given");
    expect(unmatched[0]!.text).toBe("I have not started");
    expect(unmatched[1]!.keyword).toBe("Then");
    expect(unmatched[1]!.effectiveKeyword).toBe("Then");
    expect(unmatched[1]!.text).toBe("I see results");
  });

  it("chains consecutive And keywords back to the last concrete keyword", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource("");

    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    When I click",
      "    And I wait",
      "    And I scroll",
      "    But I do not blink",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, defs);

    expect(unmatched.map((s) => s.effectiveKeyword)).toEqual([
      "When",
      "When",
      "When",
      "When",
    ]);
  });

  it("returns mixed matched and unmatched results in feature order", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource(
      "Given('I have {int} widgets', async ({}, _c: number) => {});"
    );

    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    Given I have 5 widgets",
      "    When I click submit",
      "    Then it works",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, defs);

    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]!.text).toBe("I click submit");
    expect(unmatched[0]!.effectiveKeyword).toBe("When");
    expect(unmatched[1]!.text).toBe("it works");
    expect(unmatched[1]!.effectiveKeyword).toBe("Then");
  });

  it("returns every step as unmatched when defs is empty", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    Given a",
      "    When b",
      "    Then c",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, []);
    expect(unmatched).toHaveLength(3);
    expect(unmatched.map((s) => s.text)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for features with no step lines", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  # just a comment",
      "  Scenario: S",
    ].join("\n");

    expect(resolver.findUnmatchedSteps(feature, [])).toEqual([]);
  });

  it("treats * steps as inheriting the previous Given/When/Then keyword", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource("");

    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    Given I am on the login page",
      "    * I have valid credentials",
      "    * I click the login button",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, defs);

    expect(unmatched).toHaveLength(3);
    expect(unmatched.map((s) => s.effectiveKeyword)).toEqual([
      "Given",
      "Given",
      "Given",
    ]);
    expect(unmatched.map((s) => s.keyword)).toEqual(["Given", "*", "*"]);
    expect(unmatched.map((s) => s.text)).toEqual([
      "I am on the login page",
      "I have valid credentials",
      "I click the login button",
    ]);
  });

  it("re-resolves * carryover when keyword switches mid-scenario", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource("");

    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    When I click",
      "    * I wait",
      "    Then I see results",
      "    * results are correct",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, defs);

    expect(unmatched).toHaveLength(4);
    expect(unmatched[1]!.keyword).toBe("*");
    expect(unmatched[1]!.effectiveKeyword).toBe("When");
    expect(unmatched[3]!.keyword).toBe("*");
    expect(unmatched[3]!.effectiveKeyword).toBe("Then");
  });

  it("skips a leading * with no prior concrete keyword", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    * this dangles",
      "    Given real start",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, []);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.keyword).toBe("Given");
    expect(unmatched[0]!.effectiveKeyword).toBe("Given");
    expect(unmatched[0]!.text).toBe("real start");
  });

  it("skips a leading And with no prior concrete keyword", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    And this dangles",
      "    Given real start",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, []);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.effectiveKeyword).toBe("Given");
    expect(unmatched[0]!.text).toBe("real start");
  });

  it("does NOT inherit a prior scenario's keyword across a Scenario: boundary", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  Scenario: A",
      "    When I click",
      "  Scenario: B",
      "    And this dangles",
      "    Given a real start",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, []);
    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]!.text).toBe("I click");
    expect(unmatched[0]!.effectiveKeyword).toBe("When");
    expect(unmatched[1]!.text).toBe("a real start");
    expect(unmatched[1]!.effectiveKeyword).toBe("Given");
  });

  it("does NOT inherit across a Scenario Outline: boundary", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  Scenario: A",
      "    Given x",
      "  Scenario Outline: B",
      "    * this dangles",
      "    When real start",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, []);
    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]!.text).toBe("x");
    expect(unmatched[1]!.text).toBe("real start");
    expect(unmatched[1]!.effectiveKeyword).toBe("When");
  });

  it("does not offer step-looking lines inside docstrings as unmatched", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  Scenario: S",
      "    Given real step",
      `    """`,
      "    Given fake step inside a docstring",
      `    """`,
      "    When another real step",
      "    ```",
      "    Then fake step inside a backtick docstring",
      "    ```",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, []);
    expect(unmatched.map((s) => s.text)).toEqual(["real step", "another real step"]);
  });

  it("does NOT inherit across a Background: boundary", () => {
    const resolver = makeResolver();
    const feature = [
      "Feature: F",
      "  Scenario: A",
      "    When I click",
      "  Background:",
      "    And this dangles",
      "    Given setup",
    ].join("\n");

    const unmatched = resolver.findUnmatchedSteps(feature, []);
    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]!.text).toBe("I click");
    expect(unmatched[1]!.text).toBe("setup");
    expect(unmatched[1]!.effectiveKeyword).toBe("Given");
  });
});

describe("StepResolver.parseFeatureSteps", () => {
  it("resolves And after Given to Given", () => {
    const resolver = makeResolver();
    const steps = resolver.parseFeatureSteps(
      [
        "Feature: F",
        "  Scenario: S",
        "    Given a",
        "    And b",
      ].join("\n")
    );
    expect(steps).toHaveLength(2);
    expect(steps[1]!.keyword).toBe("And");
    expect(steps[1]!.effectiveKeyword).toBe("Given");
  });

  it("skips orphan And (no prior concrete keyword in current scenario)", () => {
    const resolver = makeResolver();
    const steps = resolver.parseFeatureSteps(
      [
        "Feature: F",
        "  Scenario: S",
        "    And this dangles",
        "    Given a",
      ].join("\n")
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]!.text).toBe("a");
    expect(steps[0]!.effectiveKeyword).toBe("Given");
  });

  it("does not let And at top of a new Scenario inherit the prior scenario's keyword", () => {
    const resolver = makeResolver();
    const steps = resolver.parseFeatureSteps(
      [
        "Feature: F",
        "  Scenario: A",
        "    When I click",
        "  Scenario: B",
        "    And orphan",
        "    Given real",
      ].join("\n")
    );
    expect(steps.map((s) => s.text)).toEqual(["I click", "real"]);
    expect(steps[1]!.effectiveKeyword).toBe("Given");
  });

  it("does not let And at top of a Rule:-scoped block inherit the prior scenario's keyword", () => {
    const resolver = makeResolver();
    const steps = resolver.parseFeatureSteps(
      [
        "Feature: F",
        "  Scenario: A",
        "    When I click",
        "  Rule: business rule",
        "    Scenario: under rule",
        "    And orphan",
        "    Given real",
      ].join("\n")
    );
    expect(steps.map((s) => s.text)).toEqual(["I click", "real"]);
    expect(steps[1]!.effectiveKeyword).toBe("Given");
  });

  it("does not let And at top of an Example: block inherit the prior scenario's keyword", () => {
    const resolver = makeResolver();
    const steps = resolver.parseFeatureSteps(
      [
        "Feature: F",
        "  Scenario: A",
        "    When I click",
        "  Example: B",
        "    And orphan",
        "    Given real",
      ].join("\n")
    );
    expect(steps.map((s) => s.text)).toEqual(["I click", "real"]);
    expect(steps[1]!.effectiveKeyword).toBe("Given");
  });

  it("does not let And at top of a Scenario Template: block inherit the prior scenario's keyword", () => {
    const resolver = makeResolver();
    const steps = resolver.parseFeatureSteps(
      [
        "Feature: F",
        "  Scenario: A",
        "    When I click",
        "  Scenario Template: B",
        "    And orphan",
        "    Given real",
      ].join("\n")
    );
    expect(steps.map((s) => s.text)).toEqual(["I click", "real"]);
    expect(steps[1]!.effectiveKeyword).toBe("Given");
  });
});

describe("StepResolver.findStepMatches", () => {
  it("returns an empty array when no def matches", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource("Given('something else', async () => {});");
    expect(resolver.findStepMatches("not a match", defs)).toEqual([]);
  });

  it("returns a single match when exactly one def matches", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource(
      [
        "Given('I am ready', async () => {});",
        "Given('not me', async () => {});",
      ].join("\n")
    );
    const matches = resolver.findStepMatches("I am ready", defs);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pattern).toBe("I am ready");
  });

  it("returns all defs when two match (no early return)", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource(
      [
        "Given('I am ready', async () => {});",
        "Given(/^I am ready$/, async () => {});",
      ].join("\n")
    );
    const matches = resolver.findStepMatches("I am ready", defs);
    expect(matches).toHaveLength(2);
  });

  it("returns all three defs when three match", () => {
    const resolver = makeResolver();
    const defs = extractStepDefsFromSource(
      [
        "Given('I am ready', async () => {});",
        "Given(/^I am ready$/, async () => {});",
        "Given(/^I am (ready|set)$/, async () => {});",
      ].join("\n")
    );
    const matches = resolver.findStepMatches("I am ready", defs);
    expect(matches).toHaveLength(3);
  });
});

interface FakeWatcher {
  onDidCreate: (cb: (uri: vscode.Uri) => void) => { dispose: () => void };
  onDidChange: (cb: (uri: vscode.Uri) => void) => { dispose: () => void };
  onDidDelete: (cb: (uri: vscode.Uri) => void) => { dispose: () => void };
  dispose: () => void;
  triggerCreate: (uri?: vscode.Uri) => void;
  triggerDelete: (uri?: vscode.Uri) => void;
  disposed: boolean;
}

function makeFakeWatcher(): FakeWatcher {
  const createHandlers: Array<(uri: vscode.Uri) => void> = [];
  const deleteHandlers: Array<(uri: vscode.Uri) => void> = [];
  const defaultUri = vscode.Uri.file("/ws/features/steps/x.ts");
  const watcher: FakeWatcher = {
    onDidCreate: (cb) => {
      createHandlers.push(cb);
      return { dispose: () => {} };
    },
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: (cb) => {
      deleteHandlers.push(cb);
      return { dispose: () => {} };
    },
    dispose: () => {
      watcher.disposed = true;
    },
    triggerCreate: (uri) => {
      for (const h of createHandlers) {h(uri ?? defaultUri);}
    },
    triggerDelete: (uri) => {
      for (const h of deleteHandlers) {h(uri ?? defaultUri);}
    },
    disposed: false,
  };
  return watcher;
}

describe("StepResolver.findStepFiles file-list cache", () => {
  const originalFindFiles = vscode.workspace.findFiles;
  const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
  let findFilesMock: ReturnType<typeof vi.fn>;
  let watchers: FakeWatcher[];

  beforeEach(() => {
    findFilesMock = vi.fn(async () => []);
    watchers = [];
    (vscode.workspace as { findFiles: unknown }).findFiles = findFilesMock;
    (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = (): FakeWatcher => {
      const w = makeFakeWatcher();
      watchers.push(w);
      return w;
    };
  });

  afterEach(() => {
    (vscode.workspace as { findFiles: unknown }).findFiles = originalFindFiles;
    (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = originalCreateWatcher;
  });

  it("returns the cached file list on the second call with the same globs", async () => {
    const resolver = makeResolver();
    const globs = ["features/steps/**/*.ts"];

    await resolver.findStepFiles(globs);
    await resolver.findStepFiles(globs);

    expect(findFilesMock).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });

  it("invalidates and re-fetches when a watcher onDidCreate handler fires", async () => {
    const resolver = makeResolver();
    const globs = ["features/steps/**/*.ts"];

    await resolver.findStepFiles(globs);
    expect(findFilesMock).toHaveBeenCalledTimes(1);
    expect(watchers).toHaveLength(1);

    watchers[0]!.triggerCreate();
    await resolver.findStepFiles(globs);
    expect(findFilesMock).toHaveBeenCalledTimes(2);
    resolver.dispose();
  });

  it("invalidates and re-fetches when a watcher onDidDelete handler fires", async () => {
    const resolver = makeResolver();
    const globs = ["features/steps/**/*.ts"];

    await resolver.findStepFiles(globs);
    watchers[0]!.triggerDelete();
    await resolver.findStepFiles(globs);

    expect(findFilesMock).toHaveBeenCalledTimes(2);
    resolver.dispose();
  });

  it("dispose() disposes all watchers and clears caches", async () => {
    const resolver = makeResolver();
    await resolver.findStepFiles(["features/steps/**/*.ts", "tests/steps/**/*.ts"]);
    expect(watchers).toHaveLength(2);

    resolver.dispose();
    for (const w of watchers) {
      expect(w.disposed).toBe(true);
    }
  });

  it("disposes the previous batch of watchers when findStepFiles is called with a different glob set", async () => {
    const resolver = makeResolver();

    await resolver.findStepFiles(["a"]);
    expect(watchers).toHaveLength(1);
    const firstWatcher = watchers[0]!;

    await resolver.findStepFiles(["b"]);
    expect(firstWatcher.disposed).toBe(true);
    resolver.dispose();
  });

  it("cache key is order-insensitive: same globs in different order hit the cache", async () => {
    const resolver = makeResolver();

    await resolver.findStepFiles(["a", "b"]);
    const callsAfterFirst = findFilesMock.mock.calls.length;

    await resolver.findStepFiles(["b", "a"]);
    expect(findFilesMock.mock.calls.length).toBe(callsAfterFirst);
    resolver.dispose();
  });

  it("node_modules events from watchers do not invalidate the cache", async () => {
    const resolver = makeResolver();
    const globs = ["**/*.ts"];

    await resolver.findStepFiles(globs);
    expect(findFilesMock).toHaveBeenCalledTimes(1);

    watchers[0]!.triggerCreate(vscode.Uri.file(`/ws/node_modules/foo/bar.ts`));
    await resolver.findStepFiles(globs);
    expect(findFilesMock).toHaveBeenCalledTimes(1);
    resolver.dispose();
  });
});

describe("StepResolver.parseStepFile mtime cache", () => {
  it("re-parses the file when its mtime changes after first read", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-resolver-"));
    const filePath = path.join(tmpDir, "steps.ts");
    fs.writeFileSync(
      filePath,
      [
        "import { createBdd } from 'playwright-bdd';",
        "const { Given } = createBdd();",
        "Given('first step', async () => {});",
      ].join("\n")
    );

    const resolver = makeResolver();
    const first = resolver.parseStepFile(filePath);
    expect(first).toHaveLength(1);
    expect(first[0]!.pattern).toBe("first step");

    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.writeFileSync(
      filePath,
      [
        "import { createBdd } from 'playwright-bdd';",
        "const { Given, When } = createBdd();",
        "Given('first step', async () => {});",
        "When('second step', async () => {});",
      ].join("\n")
    );
    const newMtime = new Date(Date.now() + 1000);
    fs.utimesSync(filePath, newMtime, newMtime);

    const second = resolver.parseStepFile(filePath);
    expect(second).toHaveLength(2);
    expect(second.map((d) => d.pattern)).toEqual(["first step", "second step"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
