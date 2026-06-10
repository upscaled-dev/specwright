import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlaywrightJsonParser, type ScenarioResult } from "../../utils/playwright-json-parser";
import { Logger } from "../../utils/logger";

describe("PlaywrightJsonParser", () => {
  const parser = PlaywrightJsonParser.create(Logger.create());

  it("returns [] on empty or malformed input", () => {
    expect(parser.parse("")).toEqual([]);
    expect(parser.parse("not json")).toEqual([]);
  });

  it("aggregates one passing scenario", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Passing scenario",
          file: "/abs/.features-gen/test.feature.spec.js",
          tests: [{ results: [{ status: "passed", duration: 10 }] }],
        }],
      }],
    });
    const results = parser.parse(report);
    expect(results).toHaveLength(1);
    expect(results[0]?.scenarioName).toBe("Passing scenario");
    expect(results[0]?.status).toBe("passed");
  });

  it("collapses timedOut into failed", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Slow scenario",
          tests: [{ results: [{ status: "timedout" }] }],
        }],
      }],
    });
    expect(parser.parse(report)[0]?.status).toBe("failed");
  });

  it("extracts feature path + line from annotation", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Annotated scenario",
          tests: [{
            annotations: [{ type: "/abs/path/test.feature:12" }],
            results: [{ status: "passed" }],
          }],
        }],
      }],
    });
    const r = parser.parse(report)[0];
    expect(r?.featurePath).toBe("/abs/path/test.feature");
    expect(r?.lineNumber).toBe(12);
  });

  it("strips ANSI escape codes from error messages", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Failing scenario",
          tests: [{
            results: [{
              status: "failed",
              error: { message: "[31mexpected[39m 1 to equal 2" },
            }],
          }],
        }],
      }],
    });
    expect(parser.parse(report)[0]?.errorMessage).toBe("expected 1 to equal 2");
  });

  describe("formatResults", () => {
    // Strip ANSI SGR codes so assertions read plainly regardless of coloring.
    const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

    it("reports when nothing ran", () => {
      expect(parser.formatResults([])).toBe("No scenarios were executed.");
    });

    it("renders a scenario heading, a tally, and no step lines when none are present", () => {
      const out = plain(parser.formatResults([
        { scenarioName: "Logs in", status: "passed", featurePath: "", durationMs: 1200 },
        { scenarioName: "Logs out", status: "skipped", featurePath: "" },
      ]));
      expect(out).toContain("✔ Scenario: Logs in  (1.2s)");
      expect(out).toContain("○ Scenario: Logs out");
      expect(out).toContain("2 scenarios · 1 passed, 1 skipped · 1.2s");
    });

    it("renders per-step lines with durations", () => {
      const out = plain(parser.formatResults([{
        scenarioName: "Logs in",
        status: "passed",
        featurePath: "",
        durationMs: 30,
        steps: [
          { title: "Given I am on the login page", status: "passed", durationMs: 12 },
          { title: "When I submit credentials", status: "passed", durationMs: 8 },
        ],
      }]));
      expect(out).toContain("✔ Scenario: Logs in");
      expect(out).toContain("    ✔ Given I am on the login page  (12ms)");
      expect(out).toContain("    ✔ When I submit credentials  (8ms)");
    });

    it("labels outline examples with their outline name and shows substituted step values", () => {
      const out = plain(parser.formatResults([{
        scenarioName: "Example #1",
        outlineName: "Test scenario outline",
        status: "passed",
        featurePath: "",
        steps: [{ title: 'Given I have a "hello" value', status: "passed" }],
      }]));
      expect(out).toContain("✔ Scenario Outline: Test scenario outline — Example #1");
      expect(out).toContain('    ✔ Given I have a "hello" value');
    });

    it("marks the failing step, then shows location, message, and clickable stack frames", () => {
      const out = plain(parser.formatResults(
        [{
          scenarioName: "Adds to cart",
          status: "failed",
          featurePath: "/repo/features/cart.feature",
          lineNumber: 9,
          errorMessage: "AssertionError: nope",
          errorStack: "AssertionError: nope\n    at addToCart (/repo/features/steps/cart.steps.ts:10:5)",
          steps: [
            { title: "Given a product", status: "passed" },
            { title: "When I add it", status: "failed" },
          ],
        }],
        "/repo"
      ));
      expect(out).toContain("✘ Scenario: Adds to cart");
      expect(out).toContain("    ✔ Given a product");
      expect(out).toContain("    ✘ When I add it");
      expect(out).toContain("      features/cart.feature:9");
      expect(out).toContain("      AssertionError: nope");
      expect(out).toContain("at addToCart (/repo/features/steps/cart.steps.ts:10:5)");
      expect(out).toContain("1 scenario · 0 passed, 1 failed");
    });

    it("colors passed steps green and failed steps red", () => {
      const out = parser.formatResults([{
        scenarioName: "X",
        status: "failed",
        featurePath: "",
        steps: [
          { title: "Given ok", status: "passed" },
          { title: "Then bad", status: "failed" },
        ],
      }]);
      expect(out).toContain("[32m✔ Given ok");
      expect(out).toContain("[31m✘ Then bad");
    });
  });

  describe("source resolution via generated-spec bddFileData", () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      for (const d of tmpDirs) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      tmpDirs.length = 0;
    });

    it("maps an outline example (no annotation) back to its .feature path + line", () => {
      // playwright-bdd emits "Example #N" titles with no annotation; the source line lives only
      // in the generated spec's bddFileData (spec line 14 → .feature line 18).
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pw-bdd-"));
      tmpDirs.push(projectRoot);
      const genDir = path.join(projectRoot, ".features-gen");
      fs.mkdirSync(path.join(genDir, "features"), { recursive: true });
      const specRel = "features/test.feature.spec.js";
      fs.writeFileSync(
        path.join(genDir, specRel),
        [
          "// Generated from: features/test.feature",
          "test('Example #1', async () => {});",
          'const bddFileData = [ // bdd-data-start',
          '  {"pwTestLine":14,"pickleLine":18,"tags":[]},',
          "];",
        ].join("\n")
      );

      const report = JSON.stringify({
        config: { rootDir: genDir, configFile: path.join(projectRoot, "playwright.config.ts") },
        suites: [{
          specs: [{
            title: "Example #1",
            file: specRel,
            line: 14,
            tests: [{ results: [{ status: "passed", duration: 4 }] }],
          }],
        }],
      });

      const r = parser.parse(report)[0];
      expect(r?.featurePath).toBe(path.join(projectRoot, "features/test.feature"));
      expect(r?.lineNumber).toBe(18);
      expect(r?.status).toBe("passed");
    });

    it("re-reads generated spec data on each parse, so rewritten bddFileData is not stale", () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pw-bdd-"));
      tmpDirs.push(projectRoot);
      const genDir = path.join(projectRoot, ".features-gen");
      fs.mkdirSync(path.join(genDir, "features"), { recursive: true });
      const specRel = "features/test.feature.spec.js";
      const writeSpec = (pickleLine: number): void => {
        fs.writeFileSync(
          path.join(genDir, specRel),
          [
            "// Generated from: features/test.feature",
            "test('Example #1', async () => {});",
            "const bddFileData = [ // bdd-data-start",
            `  {"pwTestLine":14,"pickleLine":${pickleLine},"tags":[]},`,
            "];",
          ].join("\n")
        );
      };
      const report = JSON.stringify({
        config: { rootDir: genDir, configFile: path.join(projectRoot, "playwright.config.ts") },
        suites: [{
          specs: [{
            title: "Example #1",
            file: specRel,
            line: 14,
            tests: [{ results: [{ status: "passed" }] }],
          }],
        }],
      });

      writeSpec(18);
      expect(parser.parse(report)[0]?.lineNumber).toBe(18);

      // bddgen rewrites the generated spec between runs; the next parse must pick that up.
      writeSpec(25);
      expect(parser.parse(report)[0]?.lineNumber).toBe(25);
    });

    it("falls back to the spec file when the generated spec can't be read", () => {
      const report = JSON.stringify({
        config: { rootDir: "/does/not/exist" },
        suites: [{
          specs: [{
            title: "Example #1",
            file: "features/test.feature.spec.js",
            line: 14,
            tests: [{ results: [{ status: "passed" }] }],
          }],
        }],
      });
      const r = parser.parse(report)[0];
      expect(r?.featurePath).toBe("features/test.feature.spec.js");
      expect(r?.lineNumber).toBeUndefined();
    });
  });

  it("toStatusMap emits both line and name keys", () => {
    const results = parser.parse(JSON.stringify({
      suites: [{
        specs: [{
          title: "Annotated scenario",
          tests: [{
            annotations: [{ type: "/repo/features/x.feature:7" }],
            results: [{ status: "passed" }],
          }],
        }],
      }],
    }));
    const map = parser.toStatusMap(results, "/repo");
    expect(map["/repo/features/x.feature:7"]).toBe("passed");
    expect(map["features/x.feature:7"]).toBe("passed");
    expect(map["/repo/features/x.feature::Annotated scenario"]).toBe("passed");
    expect(map["features/x.feature::Annotated scenario"]).toBe("passed");
  });

  it("toStatusMap marks a scenario failed when any project failed it", () => {
    const results = parser.parse(JSON.stringify({
      suites: [{
        specs: [{
          title: "Cross-browser scenario",
          tests: [
            {
              annotations: [{ type: "/repo/features/x.feature:7" }],
              results: [{ status: "failed" }],
            },
            {
              annotations: [{ type: "/repo/features/x.feature:7" }],
              results: [{ status: "passed" }],
            },
          ],
        }],
      }],
    }));
    const map = parser.toStatusMap(results, "/repo");
    expect(map["/repo/features/x.feature:7"]).toBe("failed");
    expect(map["features/x.feature:7"]).toBe("failed");
    expect(map["features/x.feature::Cross-browser scenario"]).toBe("failed");
  });

  it("toStatusMap merges duplicate keys by severity: failed > skipped > passed", () => {
    const result = (status: ScenarioResult["status"]): ScenarioResult => ({
      featurePath: "/repo/f.feature",
      scenarioName: "S",
      lineNumber: 2,
      status,
    });
    expect(
      parser.toStatusMap([result("skipped"), result("passed")], "/repo")["f.feature:2"]
    ).toBe("skipped");
    expect(
      parser.toStatusMap([result("failed"), result("skipped")], "/repo")["f.feature:2"]
    ).toBe("failed");
  });

  it("toStatusMap resolves relative report paths to absolute keys against the cwd", () => {
    // The working directory differs from the workspace root; the absolute keys are what
    // lets the test provider still match when its relative keys are rooted elsewhere.
    const cwd = path.join(path.sep, "repo", "app");
    const map = parser.toStatusMap(
      [{
        featurePath: path.join("features", "x.feature"),
        scenarioName: "S",
        status: "passed",
        lineNumber: 5,
      }],
      cwd
    );
    const abs = path.join(cwd, "features", "x.feature");
    expect(map[`${abs}:5`]).toBe("passed");
    expect(map[`${abs}::S`]).toBe("passed");
    expect(map[`${path.join("features", "x.feature")}:5`]).toBe("passed");
    expect(map[`${path.join("features", "x.feature")}::S`]).toBe("passed");
  });

  it("paints with real ESC control characters at runtime", () => {
    const out = parser.formatResults([{
      scenarioName: "X",
      status: "passed",
      featurePath: "",
      steps: [{ title: "Given ok", status: "passed" }],
    }]);
    const esc = String.fromCodePoint(0x1b);
    expect(out).toContain(`${esc}[32m✔ Given ok`);
    expect(out).toContain(`${esc}[0m`);
  });
});
