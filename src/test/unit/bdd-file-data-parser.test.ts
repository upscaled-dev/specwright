import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseBddFileData,
  parseBddSourceData,
  resolveGeneratedSpecPaths,
} from "../../parsers/bdd-file-data-parser";

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
    expect(data!.pickleLines.get(11)).toBe(8);
    expect(data!.pickleLines.get(19)).toBe(13);
  });

  it("collects skipped pickle lines as missing-step skips", () => {
    const data = parseBddFileData(backgroundSpecText);
    expect([...data!.missingStepPickleLines]).toEqual([13]);
    expect(parseBddFileData(outlineSpecText)!.missingStepPickleLines.size).toBe(0);
  });

  it("does not count a deliberate @skip/@fixme skip as a missing-step skip", () => {
    const specText = [
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":6,"pickleLine":4,"skipped":true,"tags":["@skip"]},',
      '  {"pwTestLine":12,"pickleLine":9,"skipped":true,"tags":["@fixme","@smoke"]},',
      '  {"pwTestLine":18,"pickleLine":14,"skipped":true,"tags":["@smoke"]},',
      "]; // bdd-data-end",
    ].join("\n");
    expect([...parseBddFileData(specText)!.missingStepPickleLines]).toEqual([14]);
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

describe("parseBddSourceData", () => {
  it("maps a generated test line through the feature header and reverse bddFileData map", () => {
    const spec = `// Generated from: features/calculator.feature\n${outlineSpecText}`;
    const source = parseBddSourceData(spec, "/work");

    expect(source?.featurePath).toBe(path.resolve("/work/features/calculator.feature"));
    expect(source?.lineNumbers.get(11)).toBe(10);
  });

  it("returns undefined when the generated feature header is absent", () => {
    expect(parseBddSourceData(outlineSpecText, "/work")).toBeUndefined();
  });

  it("preserves spaces in the generated feature path", () => {
    const spec = `// Generated from: features/account settings.feature\n${outlineSpecText}`;
    expect(parseBddSourceData(spec, "/work")?.featurePath)
      .toBe(path.resolve("/work/features/account settings.feature"));
  });
});

describe("resolveGeneratedSpecPaths", () => {
  it("returns no path until a generated spec exists", () => {
    const result = resolveGeneratedSpecPaths(
      "/work",
      ".features-gen",
      "/work/features/background.feature"
    );
    expect(result).toEqual([]);
  });

  it("returns undefined when the feature lives outside the working directory", () => {
    expect(
      resolveGeneratedSpecPaths("/work", ".features-gen", "/elsewhere/x.feature")
    ).toEqual([]);
  });

  it("does not reject a child directory literally named ..foo", () => {
    const result = resolveGeneratedSpecPaths("/work", ".features-gen", "/work/..foo/x.feature");
    expect(result).toEqual([]);
  });

  // path.relative only returns an absolute path on Windows (cross-drive), so this can't be
  // exercised on POSIX hosts.
  it.runIf(process.platform === "win32")(
    "returns undefined for a feature on a different drive",
    () => {
      expect(
        resolveGeneratedSpecPaths("C:\\work", ".features-gen", "D:\\elsewhere\\x.feature")
      ).toEqual([]);
    }
  );

  // playwright-bdd v9 generates `<feature>.spec.ts`; v8 and earlier generated `.spec.js`.
  describe("suffix selection against generated files on disk", () => {
    let workDir: string;
    let genDir: string;

    beforeEach(() => {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bdd-spec-path-"));
      genDir = path.join(workDir, ".features-gen", "features");
      fs.mkdirSync(genDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    const feature = (): string => path.join(workDir, "features", "a.feature");

    it("picks the .spec.ts file when only it exists (playwright-bdd v9)", () => {
      const tsSpec = path.join(genDir, "a.feature.spec.ts");
      fs.writeFileSync(tsSpec, "// spec");
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([tsSpec]);
    });

    it("picks the newer file when both suffixes exist (stale .js from before a v9 upgrade)", () => {
      const jsSpec = path.join(genDir, "a.feature.spec.js");
      const tsSpec = path.join(genDir, "a.feature.spec.ts");
      fs.writeFileSync(jsSpec, "// old");
      fs.writeFileSync(tsSpec, "// new");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(jsSpec, past, past);
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([tsSpec]);

      // And the other way around: a project that downgraded (or regenerated .js) wins back.
      const older = new Date(Date.now() - 120_000);
      fs.utimesSync(tsSpec, older, older);
      const now = new Date();
      fs.utimesSync(jsSpec, now, now);
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([jsSpec]);
    });

    it("returns no candidate when neither suffix exists", () => {
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([]);
    });

    it("finds the spec when featuresRoot stripped the leading segment from the generated layout", () => {
      // featuresRoot: './features' → bddgen writes .features-gen/a.feature.spec.js
      const spec = path.join(workDir, ".features-gen", "a.feature.spec.js");
      fs.writeFileSync(spec, "// spec");
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([spec]);
    });

    it("prefers the exact mirrored path over a stripped-segment match", () => {
      const exact = path.join(genDir, "a.feature.spec.js"); // .features-gen/features/...
      const stripped = path.join(workDir, ".features-gen", "a.feature.spec.js");
      fs.writeFileSync(exact, "// exact");
      fs.writeFileSync(stripped, "// stripped");
      // Even with the stripped file newer, the more specific path wins.
      const now = new Date();
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(exact, past, past);
      fs.utimesSync(stripped, now, now);
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([exact]);
    });

    it("finds the spec nested under a named BDD project directory", () => {
      // defineBddProject(..., 'browser') → .features-gen/browser/features/a.feature.spec.js
      const projectDir = path.join(workDir, ".features-gen", "browser", "features");
      fs.mkdirSync(projectDir, { recursive: true });
      const spec = path.join(projectDir, "a.feature.spec.js");
      fs.writeFileSync(spec, "// spec");
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([spec]);
    });

    it("finds the spec under a named project combined with featuresRoot stripping", () => {
      // project 'browser' + featuresRoot './features' → .features-gen/browser/a.feature.spec.ts
      const projectDir = path.join(workDir, ".features-gen", "browser");
      fs.mkdirSync(projectDir, { recursive: true });
      const spec = path.join(projectDir, "a.feature.spec.ts");
      fs.writeFileSync(spec, "// spec");
      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([spec]);
    });

    it("returns every same-specificity match from named projects", () => {
      const browserDir = path.join(workDir, ".features-gen", "browser", "features");
      const apiDir = path.join(workDir, ".features-gen", "api", "features");
      fs.mkdirSync(browserDir, { recursive: true });
      fs.mkdirSync(apiDir, { recursive: true });
      const browserSpec = path.join(browserDir, "a.feature.spec.js");
      const apiSpec = path.join(apiDir, "a.feature.spec.js");
      fs.writeFileSync(browserSpec, "// browser");
      fs.writeFileSync(apiSpec, "// api");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(apiSpec, past, past);

      const result = resolveGeneratedSpecPaths(workDir, ".features-gen", feature());
      expect(result).toEqual([apiSpec, browserSpec]);
    });

    it("resolves the most-specific suffix independently for each generated root", () => {
      const exact = path.join(genDir, "a.feature.spec.js");
      const browserDir = path.join(workDir, ".features-gen", "browser");
      const stripped = path.join(browserDir, "a.feature.spec.js");
      fs.mkdirSync(browserDir, { recursive: true });
      fs.writeFileSync(exact, "// unnamed project");
      fs.writeFileSync(stripped, "// browser with featuresRoot");

      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([
        exact,
        stripped,
      ]);
    });

    it("returns one path when only one project generated the feature", () => {
      const browserDir = path.join(workDir, ".features-gen", "browser", "features");
      fs.mkdirSync(browserDir, { recursive: true });
      fs.writeFileSync(path.join(browserDir, "a.feature.spec.js"), "// browser");

      expect(resolveGeneratedSpecPaths(workDir, ".features-gen", feature())).toEqual([
        path.join(browserDir, "a.feature.spec.js"),
      ]);
    });
  });
});
