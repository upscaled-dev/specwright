import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  buildStubsForUnmatched,
  compilePatternForDedup,
  defaultNewFilePath,
  inferDefaultStepsDir,
  validateNewFilePath,
} from "../../commands/generate-steps";
import { inferParameters } from "../../generators/step-stub-generator";
import { patternToRegexSource } from "../../providers/step-definition-provider";
import type { UnmatchedStep } from "../../providers/step-resolver";

function makeStep(text: string, keyword: "Given" | "When" | "Then" = "Given"): UnmatchedStep {
  return { line: 0, keyword, effectiveKeyword: keyword, text };
}

const ROOT = path.resolve("/tmp/ws-root");

describe("inferDefaultStepsDir", () => {
  it("uses the literal prefix before the first wildcard segment", () => {
    expect(inferDefaultStepsDir(["features/steps/**/*.ts"], ROOT)).toBe(
      path.join(ROOT, "features/steps")
    );
  });

  it("falls back to features/steps when no glob has a usable prefix", () => {
    expect(inferDefaultStepsDir(["**/*.ts"], ROOT)).toBe(
      path.join(ROOT, "features/steps")
    );
  });

  it("falls back to the default when the glob list is empty", () => {
    expect(inferDefaultStepsDir([], ROOT)).toBe(path.join(ROOT, "features/steps"));
  });

  it("returns the first non-empty glob's prefix when multiple are configured", () => {
    expect(
      inferDefaultStepsDir(
        ["**/*.ts", "tests/steps/**/*.ts", "features/steps/**/*.ts"],
        ROOT
      )
    ).toBe(path.join(ROOT, "tests/steps"));
  });

  it("keeps absolute glob prefixes absolute", () => {
    const absGlob = `${path.sep}abs${path.sep}steps${path.sep}**${path.sep}*.ts`;
    expect(inferDefaultStepsDir([absGlob], ROOT)).toBe(
      `${path.sep}abs${path.sep}steps`
    );
  });

  it("keeps a forward-slash absolute glob prefix absolute on any platform", () => {
    expect(inferDefaultStepsDir(["/abs/steps/**/*.ts"], ROOT)).toBe(
      path.normalize("/abs/steps")
    );
  });

  it("extracts the prefix from a Windows drive-absolute backslash glob", () => {
    expect(inferDefaultStepsDir(["C:\\abs\\steps\\**\\*.ts"], ROOT)).toBe(
      path.normalize("C:/abs/steps")
    );
  });

  it("joins a Windows-style relative backslash glob prefix onto the workspace root", () => {
    expect(inferDefaultStepsDir(["tests\\steps\\**\\*.ts"], ROOT)).toBe(
      path.join(ROOT, "tests/steps")
    );
  });
});

describe("defaultNewFilePath", () => {
  it("appends generated.steps.ts to the inferred base", () => {
    expect(defaultNewFilePath(["features/steps/**/*.ts"], ROOT)).toBe(
      path.join(ROOT, "features/steps", "generated.steps.ts")
    );
  });
});

describe("validateNewFilePath", () => {
  const noFile = (): boolean => false;

  it("rejects empty input", () => {
    expect(validateNewFilePath("", ROOT, noFile)).toBe("Path is required");
    expect(validateNewFilePath("   ", ROOT, noFile)).toBe("Path is required");
  });

  it("rejects paths outside the workspace", () => {
    expect(validateNewFilePath("../outside.ts", ROOT, noFile)).toContain("workspace");
  });

  it("rejects extensions other than .ts or .js", () => {
    expect(validateNewFilePath("steps/foo.txt", ROOT, noFile)).toBe(
      "File must end in .ts or .js"
    );
    expect(validateNewFilePath("steps/foo", ROOT, noFile)).toBe(
      "File must end in .ts or .js"
    );
  });

  it("rejects when the target file already exists", () => {
    const existing = path.join(ROOT, "steps/foo.ts");
    expect(validateNewFilePath("steps/foo.ts", ROOT, (p) => p === existing)).toBe(
      "File already exists"
    );
  });

  it("accepts a valid new .ts file inside the workspace", () => {
    expect(validateNewFilePath("steps/foo.ts", ROOT, noFile)).toBeUndefined();
  });

  it("accepts a valid new .js file inside the workspace", () => {
    expect(validateNewFilePath("steps/foo.js", ROOT, noFile)).toBeUndefined();
  });

  it("accepts an absolute path that resolves inside the workspace", () => {
    const abs = path.join(ROOT, "steps/foo.ts");
    expect(validateNewFilePath(abs, ROOT, noFile)).toBeUndefined();
  });
});

describe("compilePatternForDedup", () => {
  it("round-trips an inferred pattern with escaped braces back to a regex that matches the literal step text", () => {
    const { pattern } = inferParameters("I press {ctrl}");
    const regex = compilePatternForDedup(pattern);
    expect(regex).toBeDefined();
    expect(regex!.test("I press {ctrl}")).toBe(true);
  });

  it("compiles a parameterized pattern that matches concrete substitutions", () => {
    const regex = compilePatternForDedup("I have {int} widgets");
    expect(regex).toBeDefined();
    expect(regex!.test("I have 5 widgets")).toBe(true);
    expect(regex!.test("I have many widgets")).toBe(false);
  });

  it("produces a regex equivalent to patternToRegexSource anchored", () => {
    const pattern = "the value is {float}";
    const direct = new RegExp(`^${patternToRegexSource(pattern)}$`);
    const fromHelper = compilePatternForDedup(pattern);
    expect(fromHelper!.source).toBe(direct.source);
  });
});

describe("buildStubsForUnmatched", () => {
  it("deduplicates two unmatched steps that infer to the same pattern", () => {
    const stubs = buildStubsForUnmatched(
      [makeStep('I have "a"'), makeStep('I have "b"')],
      []
    );
    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toContain('"I have {string}"');
  });

  it("skips steps already matched by existing definitions", () => {
    const existing = [{ regex: /^I have \d+ widgets$/ }];
    const stubs = buildStubsForUnmatched(
      [makeStep("I have 5 widgets"), makeStep("I click submit")],
      existing
    );
    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toContain('"I click submit"');
  });

  it("emits stubs that round-trip through their own dedup regex", () => {
    const stubs = buildStubsForUnmatched([makeStep("I press {ctrl}")], []);
    expect(stubs).toHaveLength(1);
    const second = buildStubsForUnmatched(
      [makeStep("I press {ctrl}"), makeStep("I press {ctrl}")],
      []
    );
    expect(second).toHaveLength(1);
  });
});
