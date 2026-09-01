import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function fakeMemento(): import("vscode").Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: (key: string, def?: unknown) => (store.has(key) ? store.get(key) : def),
    update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
  } as unknown as import("vscode").Memento;
}

const FEATURE = [
  "@feature",
  "Feature: Sample feature",
  "",
  "  Scenario: Passing scenario",
  "    Given I am on the test page",
  "",
  "  Scenario Outline: Math",
  "    Given <a> plus <b>",
  "",
  "    Examples:",
  "      | a | b |",
  "      | 1 | 2 |",
  "      | 3 | 4 |",
].join("\n");

export interface Fixture {
  root: string;
  featurePath: string;
  genSpecPath: string;
}

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbdd-int-"));
  const featurePath = path.join(root, "features", "test.feature");
  fs.mkdirSync(path.dirname(featurePath), { recursive: true });
  fs.writeFileSync(featurePath, FEATURE);
  const genSpecPath = path.join(root, ".features-gen", "features", "test.feature.spec.js");
  fs.mkdirSync(path.dirname(genSpecPath), { recursive: true });
  fs.writeFileSync(genSpecPath, [
    "// Generated from: features/test.feature",
    "const bddFileData = [ // bdd-data-start",
    '  {"pwTestLine":6,"pickleLine":4},',
    '  {"pwTestLine":18,"pickleLine":12},',
    '  {"pwTestLine":24,"pickleLine":13},',
    "]; // bdd-data-end",
  ].join("\n"));
  return { root, featurePath, genSpecPath };
}

export function reportJson(
  fixture: Fixture,
  specs: Array<{
    title: string;
    line: number;
    status: string;
    steps?: Array<{ title: string; duration: number }>;
  }>
): string {
  return JSON.stringify({
    config: {
      rootDir: path.join(fixture.root, ".features-gen"),
      configFile: path.join(fixture.root, "playwright.config.ts"),
    },
    suites: [{
      title: "Sample feature",
      specs: specs.map((spec) => ({
        title: spec.title,
        file: "features/test.feature.spec.js",
        line: spec.line,
        tests: [{ results: [{ status: spec.status, duration: 5, steps: spec.steps ?? [] }] }],
      })),
    }],
  });
}
