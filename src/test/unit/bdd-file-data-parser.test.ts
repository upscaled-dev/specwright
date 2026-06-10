import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { parseBddFileData, resolveGeneratedSpecPath } from "../../parsers/bdd-file-data-parser";

// Verbatim bddFileData block from .features-gen/features/background.feature.spec.js: two
// scenarios sharing Background steps (pwStepLine 7/8 repeated across entries).
const backgroundSpecText = `
// == technical section ==

const bddFileData = [ // bdd-data-start
  {"pwTestLine":11,"pickleLine":8,"tags":["@background","@widgets"],"steps":[{"pwStepLine":7,"gherkinStepLine":5,"keywordType":"Context","textWithKeyword":"Given I have 0 widgets","isBg":true,"stepMatchArguments":[{"group":{"start":7,"value":"0","children":[]},"parameterTypeName":"int"}]},{"pwStepLine":8,"gherkinStepLine":6,"keywordType":"Context","textWithKeyword":"And I add 1 widget","isBg":true,"stepMatchArguments":[{"group":{"start":6,"value":"1","children":[]},"parameterTypeName":"int"}]},{"pwStepLine":12,"gherkinStepLine":9,"keywordType":"Action","textWithKeyword":"When I add 1 widget","stepMatchArguments":[{"group":{"start":6,"value":"1","children":[]},"parameterTypeName":"int"}]},{"pwStepLine":13,"gherkinStepLine":10,"keywordType":"Outcome","textWithKeyword":"Then I have 2 widgets total","stepMatchArguments":[{"group":{"start":7,"value":"2","children":[]},"parameterTypeName":"int"}]}]},
  {"pwTestLine":19,"pickleLine":13,"skipped":true,"tags":["@background","@widgets","@critical"],"steps":[{"pwStepLine":7,"gherkinStepLine":5,"keywordType":"Context","textWithKeyword":"Given I have 0 widgets","isBg":true,"stepMatchArguments":[{"group":{"start":7,"value":"0","children":[]},"parameterTypeName":"int"}]},{"pwStepLine":8,"gherkinStepLine":6,"keywordType":"Context","textWithKeyword":"And I add 1 widget","isBg":true,"stepMatchArguments":[{"group":{"start":6,"value":"1","children":[]},"parameterTypeName":"int"}]},{"pwStepLine":20,"gherkinStepLine":14,"keywordType":"Action","textWithKeyword":"When I add 3 widgets","stepMatchArguments":[{"group":{"start":6,"value":"3","children":[]},"parameterTypeName":"int"}]},{"pwStepLine":21,"gherkinStepLine":15,"keywordType":"Outcome","textWithKeyword":"Then I have 4 widgets total","stepMatchArguments":[{"group":{"start":7,"value":"4","children":[]},"parameterTypeName":"int"}]},{"pwStepLine":22,"gherkinStepLine":16,"keywordType":"Outcome","textWithKeyword":"And I have a new widget"}]},
]; // bdd-data-end
`;

// Scenario Outline shape: each Examples row expands into its own test, so the SAME
// gherkinStepLine appears with DISTINCT pwStepLines across entries.
const outlineSpecText = `
const bddFileData = [ // bdd-data-start
  {"pwTestLine":6,"pickleLine":9,"tags":[],"steps":[{"pwStepLine":7,"gherkinStepLine":4,"keywordType":"Context","textWithKeyword":"Given I have 1 cukes"},{"pwStepLine":8,"gherkinStepLine":5,"keywordType":"Outcome","textWithKeyword":"Then I see 1 cukes"}]},
  {"pwTestLine":11,"pickleLine":10,"tags":[],"steps":[{"pwStepLine":12,"gherkinStepLine":4,"keywordType":"Context","textWithKeyword":"Given I have 2 cukes"},{"pwStepLine":13,"gherkinStepLine":5,"keywordType":"Outcome","textWithKeyword":"Then I see 2 cukes"}]},
]; // bdd-data-end
`;

describe("parseBddFileData", () => {
  it("maps gherkin step lines to playwright step lines", () => {
    const data = parseBddFileData(backgroundSpecText);
    expect(data).toBeDefined();
    expect(data!.stepLines.get(9)).toEqual([12]);
    expect(data!.stepLines.get(10)).toEqual([13]);
    expect(data!.stepLines.get(14)).toEqual([20]);
    expect(data!.stepLines.get(16)).toEqual([22]);
  });

  it("maps pickle (scenario) lines to test() lines", () => {
    const data = parseBddFileData(backgroundSpecText);
    expect(data!.testLines.get(8)).toBe(11);
    expect(data!.testLines.get(13)).toBe(19);
  });

  it("dedupes Background steps repeated across scenario entries", () => {
    const data = parseBddFileData(backgroundSpecText);
    expect(data!.stepLines.get(5)).toEqual([7]);
    expect(data!.stepLines.get(6)).toEqual([8]);
  });

  it("keeps all distinct pwStepLines for Scenario Outline rows, sorted", () => {
    const data = parseBddFileData(outlineSpecText);
    expect(data!.stepLines.get(4)).toEqual([7, 12]);
    expect(data!.stepLines.get(5)).toEqual([8, 13]);
    expect(data!.testLines.get(9)).toBe(6);
    expect(data!.testLines.get(10)).toBe(11);
  });

  it("returns undefined when the markers are missing", () => {
    expect(parseBddFileData("const bddFileData = [];")).toBeUndefined();
    expect(parseBddFileData("")).toBeUndefined();
    expect(parseBddFileData("// bdd-data-end before // bdd-data-start")).toBeUndefined();
  });

  it("returns undefined on malformed JSON between the markers", () => {
    const malformed = `const bddFileData = [ // bdd-data-start
  {"pwTestLine":11,"pickleLine":,
]; // bdd-data-end`;
    expect(parseBddFileData(malformed)).toBeUndefined();
  });
});

describe("resolveGeneratedSpecPath", () => {
  it("resolves the spec path under the features-gen dir, mirroring the feature's relative path", () => {
    const result = resolveGeneratedSpecPath(
      "/work",
      ".features-gen",
      "/work/features/background.feature"
    );
    expect(result).toBe(
      path.resolve("/work", ".features-gen", "features/background.feature.spec.js")
    );
  });

  it("returns undefined when the feature lives outside the working directory", () => {
    expect(
      resolveGeneratedSpecPath("/work", ".features-gen", "/elsewhere/x.feature")
    ).toBeUndefined();
  });

  it("does not reject a child directory literally named ..foo", () => {
    const result = resolveGeneratedSpecPath("/work", ".features-gen", "/work/..foo/x.feature");
    expect(result).toBe(path.resolve("/work", ".features-gen", "..foo/x.feature.spec.js"));
  });

  // path.relative only returns an absolute path on Windows (cross-drive), so this can't be
  // exercised on POSIX hosts.
  it.runIf(process.platform === "win32")(
    "returns undefined for a feature on a different drive",
    () => {
      expect(
        resolveGeneratedSpecPath("C:\\work", ".features-gen", "D:\\elsewhere\\x.feature")
      ).toBeUndefined();
    }
  );
});
