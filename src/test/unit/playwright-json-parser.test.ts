import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PlaywrightJsonParser,
  type ScenarioResult,
} from "../../utils/playwright-json-parser";
import { PlaywrightReportTooLargeError } from "../../utils/playwright-report-reader";
import { Logger } from "../../utils/logger";
import { EXECUTION_LIMITS } from "../../core/execution-limits";

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

  it("resolves expected failures and unexpected passes", () => {
    const statusFor = (actual: string): ScenarioResult["status"] | undefined =>
      parser.parse(JSON.stringify({
        suites: [{
          specs: [{
            title: actual,
            tests: [{ expectedStatus: "failed", results: [{ status: actual }] }],
          }],
        }],
      }))[0]?.status;

    expect(statusFor("failed")).toBe("passed");
    expect(statusFor("passed")).toBe("failed");
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

  it("collapses a flaky retry sequence [failed, passed] into passed", () => {
    // Retries within one test entry: the last attempt passed, so Playwright exits 0 (flaky).
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Flaky scenario",
          tests: [{
            results: [
              { status: "failed", error: { message: "transient" } },
              { status: "passed", duration: 12 },
            ],
          }],
        }],
      }],
    });
    const r = parser.parse(report)[0];
    expect(r?.status).toBe("passed");
    expect(r?.durationMs).toBe(12);
    expect(r?.errorMessage).toBeUndefined();
  });

  it("records attempts and the flaky flag for a passed-on-retry sequence", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Flaky scenario",
          tests: [{ results: [{ status: "failed" }, { status: "passed" }] }],
        }],
      }],
    });
    const r = parser.parse(report)[0];
    expect(r?.attempts).toBe(2);
    expect(r?.flaky).toBe(true);
  });

  it("does not mark a skipped-then-passed serial rerun as flaky", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Serial peer",
          tests: [{ results: [{ status: "skipped" }, { status: "passed" }] }],
        }],
      }],
    });
    const result = parser.parse(report)[0];
    expect(result?.status).toBe("passed");
    expect(result?.attempts).toBe(2);
    expect(result?.flaky).toBeUndefined();
  });

  it("leaves attempts and flaky unset for a clean single-attempt run", () => {
    const report = JSON.stringify({
      suites: [{ specs: [{ title: "Clean", tests: [{ results: [{ status: "passed" }] }] }] }],
    });
    const r = parser.parse(report)[0];
    expect(r?.attempts).toBeUndefined();
    expect(r?.flaky).toBeUndefined();
  });

  it("keeps a finer outcome for timed-out and interrupted while status stays failed", () => {
    const outcomeFor = (raw: string): ScenarioResult | undefined => parser.parse(JSON.stringify({
      suites: [{ specs: [{ title: raw, tests: [{ results: [{ status: raw }] }] }] }],
    }))[0];
    expect(outcomeFor("timedout")).toMatchObject({ status: "failed", outcome: "timed-out" });
    expect(outcomeFor("interrupted")).toMatchObject({ status: "failed", outcome: "interrupted" });
    expect(outcomeFor("failed")?.outcome).toBeUndefined();
  });

  it("collects on-disk attachment paths and skips inline blobs", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "With evidence",
          tests: [{
            results: [{
              status: "failed",
              attachments: [
                { name: "trace", path: "/ws/test-results/trace.zip" },
                { name: "inline", contentType: "text/plain" },
              ],
            }],
          }],
        }],
      }],
    });
    expect(parser.parse(report)[0]?.attachmentPaths).toEqual(["/ws/test-results/trace.zip"]);
  });

  it("rejects a report exceeding the per-run byte limit", () => {
    const actualBytes = EXECUTION_LIMITS.reportBytesPerRun + 1;
    expect(() => parser.parse("x".repeat(actualBytes))).toThrow(PlaywrightReportTooLargeError);
    expect(() => parser.parse("x".repeat(actualBytes))).toThrowError(
      new PlaywrightReportTooLargeError(actualBytes)
    );
  });

  it("accepts a report exactly at the per-run byte limit", () => {
    const report = '{"suites":[]}' + " ".repeat(
      EXECUTION_LIMITS.reportBytesPerRun - Buffer.byteLength('{"suites":[]}')
    );

    expect(parser.parse(report)).toEqual([]);
  });

  it("ignores inline attachment bodies of any size and collects only path attachments", () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Inline evidence",
          tests: [{
            results: [{
              status: "passed",
              attachments: [
                { name: "trace", body: Buffer.alloc(2 * 1024 * 1024).toString("base64") },
                { name: "video", path: "/ws/test-results/video.webm" },
              ],
            }],
          }],
        }],
      }],
    });

    expect(parser.parse(report)).toMatchObject([
      { scenarioName: "Inline evidence", attachmentPaths: ["/ws/test-results/video.webm"] },
    ]);
  });

  it("reads extension-launched report files asynchronously and checks their size before reading", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-report-"));
    const reportPath = path.join(tempDir, "results.json");
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        suites: [{ specs: [{ title: "Async", tests: [{ results: [{ status: "passed" }] }] }] }],
      }));
      await expect(parser.parseFromFileAsync(reportPath)).resolves.toMatchObject([
        { scenarioName: "Async", status: "passed" },
      ]);

      fs.truncateSync(reportPath, EXECUTION_LIMITS.reportBytesPerRun + 1);
      const oversizedRead = parser.parseFromFileAsync(reportPath);
      await expect(oversizedRead).rejects.toBeInstanceOf(PlaywrightReportTooLargeError);
      await expect(oversizedRead).rejects.toThrowError(
        new PlaywrightReportTooLargeError(EXECUTION_LIMITS.reportBytesPerRun + 1)
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses a 10,000-scenario report from disk", async () => {
    const report = JSON.stringify({
      suites: [{
        specs: Array.from({ length: 10_000 }, (_, index) => ({
          title: `Scenario ${index}`,
          tests: [{ results: [{ status: "passed", duration: index % 100 }] }],
        })),
      }],
    });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-benchmark-"));
    const reportPath = path.join(tempDir, "results.json");
    fs.writeFileSync(reportPath, report);
    try {
      const results = await parser.parseFromFileAsync(reportPath);

      expect(results).toHaveLength(10_000);
      expect(results[9_999]).toMatchObject({ scenarioName: "Scenario 9999", status: "passed" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("marks a nonempty report incomplete when Playwright records a global error", () => {
    const evidence = parser.inspect(JSON.stringify({
      errors: [{ message: "worker teardown failed" }],
      suites: [{
        specs: [{
          title: "Completed first",
          tests: [{ results: [{ status: "passed" }] }],
        }],
      }],
    }));

    expect(evidence.details).toHaveLength(1);
    expect(evidence.complete).toBe(false);
    expect(evidence.failure).toContain("worker teardown failed");
  });

  it("marks malformed report text incomplete instead of treating it as an empty report", () => {
    expect(parser.inspect("not json")).toMatchObject({
      details: [],
      complete: false,
      failure: "The Playwright JSON report could not be parsed.",
    });
  });

  it("captures outlineName from a placeholder-bearing suite title when spec titles are substituted", () => {
    // An outline TITLE with `<placeholders>` makes playwright-bdd substitute the row values into
    // each generated test title (no "Example #N" shape); the raw placeholders only survive on the
    // enclosing describe, so that suite title is the outline name.
    const report = JSON.stringify({
      suites: [{
        title: "Title repro",
        suites: [{
          title: "Add (<count1>/<count2>) widgets",
          specs: [{
            title: "Add (2/2) widgets",
            tests: [{ results: [{ status: "passed" }] }],
          }],
        }],
      }],
    });
    const r = parser.parse(report)[0];
    expect(r?.scenarioName).toBe("Add (2/2) widgets");
    expect(r?.outlineName).toBe("Add (<count1>/<count2>) widgets");
  });

  it("does not treat a plain (placeholder-free) suite title as an outline for a plain-titled spec", () => {
    const report = JSON.stringify({
      suites: [{
        title: "Plain feature",
        specs: [{
          title: "Plain scenario",
          tests: [{ results: [{ status: "passed" }] }],
        }],
      }],
    });
    expect(parser.parse(report)[0]?.outlineName).toBeUndefined();
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
      expect(out).toContain("✔ Scenario Outline: Test scenario outline (Example #1)");
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

    it("renders Windows-style failure locations relative with forward slashes", () => {
      const out = plain(parser.formatResults(
        [{
          scenarioName: "Adds to cart",
          status: "failed",
          featurePath: "C:\\repo\\features\\cart.feature",
          lineNumber: 9,
          errorMessage: "AssertionError: nope",
        }],
        "C:\\repo"
      ));
      expect(out).toContain("      features/cart.feature:9");
    });

    it("uses the provided wall-clock total for the footer instead of the per-scenario sum", () => {
      // Two entries for the same scenario (e.g. chromium + firefox) each report 5s; summing them
      // would overstate elapsed time as 10.0s. The measured wall-clock total wins when supplied.
      const out = plain(parser.formatResults(
        [
          { scenarioName: "Runs", status: "passed", featurePath: "", durationMs: 5000 },
          { scenarioName: "Runs", status: "passed", featurePath: "", durationMs: 5000 },
        ],
        undefined,
        6000
      ));
      expect(out).toContain("· 6.0s");
      expect(out).not.toContain("10.0s");
    });

    it("falls back to the summed per-scenario durations when no wall-clock total is given", () => {
      const out = plain(parser.formatResults([
        { scenarioName: "A", status: "passed", featurePath: "", durationMs: 500 },
        { scenarioName: "B", status: "passed", featurePath: "", durationMs: 700 },
      ]));
      expect(out).toContain("· 1.2s");
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

    it("clears generated-spec caches between async parses", async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pw-bdd-"));
      tmpDirs.push(projectRoot);
      const genDir = path.join(projectRoot, ".features-gen");
      fs.mkdirSync(path.join(genDir, "features"), { recursive: true });
      const specRel = "features/test.feature.spec.js";
      const specPath = path.join(genDir, specRel);
      const writeSpec = (pickleLine: number): void => fs.writeFileSync(specPath, [
        "// Generated from: features/test.feature",
        "const bddFileData = [ // bdd-data-start",
        `  {"pwTestLine":14,"pickleLine":${pickleLine},"tags":[]},`,
        "];",
      ].join("\n"));
      const report = JSON.stringify({
        config: { rootDir: genDir, configFile: path.join(projectRoot, "playwright.config.ts") },
        suites: [{ specs: [{
          title: "Example #1",
          file: specRel,
          line: 14,
          tests: [{ results: [{ status: "passed" }] }],
        }] }],
      });
      const firstPath = path.join(projectRoot, "first.json");
      const secondPath = path.join(projectRoot, "second.json");
      fs.writeFileSync(firstPath, report);
      fs.writeFileSync(secondPath, report);

      writeSpec(18);
      expect((await parser.parseFromFileAsync(firstPath))[0]?.lineNumber).toBe(18);

      // bddgen rewrites the generated spec between runs; the next parse must pick that up.
      writeSpec(25);
      expect((await parser.parseFromFileAsync(secondPath))[0]?.lineNumber).toBe(25);
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
    // Keys are always forward-slash normalized, regardless of platform.
    const map = parser.toStatusMap(
      [{
        featurePath: "features/x.feature",
        scenarioName: "S",
        status: "passed",
        lineNumber: 5,
      }],
      "/repo/app"
    );
    expect(map["/repo/app/features/x.feature:5"]).toBe("passed");
    expect(map["/repo/app/features/x.feature::S"]).toBe("passed");
    expect(map["features/x.feature:5"]).toBe("passed");
    expect(map["features/x.feature::S"]).toBe("passed");
  });

  it("toStatusMap normalizes Windows-style absolute paths and cwd to forward-slash keys", () => {
    const map = parser.toStatusMap(
      [{
        featurePath: "C:\\repo\\features\\x.feature",
        scenarioName: "S",
        status: "passed",
        lineNumber: 7,
      }],
      "C:\\repo"
    );
    expect(map["C:/repo/features/x.feature:7"]).toBe("passed");
    expect(map["features/x.feature:7"]).toBe("passed");
    expect(map["C:/repo/features/x.feature::S"]).toBe("passed");
    expect(map["features/x.feature::S"]).toBe("passed");
  });

  it("toStatusMap resolves Windows-style relative report paths against a Windows cwd", () => {
    const map = parser.toStatusMap(
      [{
        featurePath: "features\\x.feature",
        scenarioName: "S",
        status: "passed",
        lineNumber: 5,
      }],
      "C:\\repo\\app"
    );
    expect(map["C:/repo/app/features/x.feature:5"]).toBe("passed");
    expect(map["C:/repo/app/features/x.feature::S"]).toBe("passed");
    expect(map["features/x.feature:5"]).toBe("passed");
    expect(map["features/x.feature::S"]).toBe("passed");
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
