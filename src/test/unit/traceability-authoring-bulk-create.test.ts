import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { AuthoringCommandDeps, TraceabilityAuthoringCommands } from "../../commands/traceability-authoring-commands";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { scenarioDropId } from "../../traceability/board-data";
import {
  AuthoredTest,
  NewTestSpec,
  TraceabilityAdapter,
} from "../../traceability/contracts";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { TraceabilitySnapshot } from "../../traceability/traceability-model";
import { Logger } from "../../utils/logger";
import { applyWsEdit, EditEntry } from "./helpers/workspace-edit";

const FEATURE = "/ws/a.feature";
const SOURCE = [
  "Feature: F",
  "",
  "Scenario: Log in",
  "  Given a user",
  "",
  "Scenario: Checkout",
  "  Given a cart",
  "",
  "Scenario: Refund",
  "  Given an order",
  "",
  "Scenario: Ship",
  "  Given a parcel",
  "",
].join("\n");

const SECOND = "/ws/b.feature";
const SECOND_SOURCE = [
  "Feature: B",
  "",
  "Scenario: Browse",
  "  Given a catalog",
  "",
  "Scenario: Filter",
  "  Given filters",
  "",
  "Scenario: Sort",
  "  Given sorting",
  "",
].join("\n");

const LOGIN: ScenarioRef = { filePath: FEATURE, line: 3, name: "Log in", kind: "scenario" };
const CHECKOUT: ScenarioRef = { filePath: FEATURE, line: 6, name: "Checkout", kind: "scenario" };
const REFUND: ScenarioRef = { filePath: FEATURE, line: 9, name: "Refund", kind: "scenario" };
const SHIP: ScenarioRef = { filePath: FEATURE, line: 12, name: "Ship", kind: "scenario" };
const BROWSE: ScenarioRef = { filePath: SECOND, line: 3, name: "Browse", kind: "scenario" };
const SORT: ScenarioRef = { filePath: SECOND, line: 9, name: "Sort", kind: "scenario" };

function snapshot(refs: ScenarioRef[] = [LOGIN, CHECKOUT]): TraceabilitySnapshot {
  return {
    links: [],
    untraced: refs.map((scenario) => ({ scenario, reqKeys: [] })),
    orphans: [],
    stale: false,
    completeProjects: ["CALC"],
    errors: [],
  };
}

type Recorded = EditEntry & { uri: { fsPath: string } };

interface FakeWorkspace {
  applied: Recorded[][];
  text(filePath?: string): string;
}

function docFor(filePath: string, text: string): vscode.TextDocument {
  const lines = text.split("\n");
  return {
    uri: vscode.Uri.file(filePath),
    eol: vscode.EndOfLine.LF,
    getText: () => text,
    lineAt: (n: number) => ({ text: lines[n] ?? "", rangeIncludingLineBreak: new vscode.Range(n, 0, n + 1, 0) }),
    save: () => Promise.resolve(true),
  } as unknown as vscode.TextDocument;
}

// A workspace whose documents actually change: every applied edit is replayed into the file's text, so
// a later write in the same batch reads the lines the earlier one shifted. A path with no entry here is
// a file that no longer exists and refuses to open.
function fakeWorkspace(files: Record<string, string> = { [FEATURE]: SOURCE }): FakeWorkspace {
  const contents = new Map(Object.entries(files));
  vi.spyOn(vscode.workspace, "openTextDocument").mockImplementation((uri: unknown) => {
    const filePath = (uri as vscode.Uri).fsPath;
    const text = contents.get(filePath);
    return text === undefined
      ? Promise.reject(new Error(`cannot open ${filePath}`))
      : Promise.resolve(docFor(filePath, text));
  });
  const applied: Recorded[][] = [];
  vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
    const entries = (edit as unknown as { __entries: Recorded[] }).__entries;
    applied.push(entries);
    const filePath = entries[0]!.uri.fsPath;
    contents.set(filePath, applyWsEdit(contents.get(filePath) ?? "", entries));
    return Promise.resolve(true);
  });
  return { applied, text: (filePath = FEATURE) => contents.get(filePath) ?? "" };
}

interface Rig {
  commands: TraceabilityAuthoringCommands;
  specs: NewTestSpec[];
  merged: string[];
  logger: Logger;
  recoveries: Array<{ project: string; diagnostics?: readonly string[] }>;
}

interface RigOptions {
  selected?: string[];
  project?: string | undefined;
  authoring?: boolean;
  credentials?: boolean;
  snapshot?: TraceabilitySnapshot;
  create?: (spec: NewTestSpec) => Promise<AuthoredTest>;
  scheduleProjectSync?: (project: string, diagnostics?: Iterable<string>) => void;
}

function rig(options: RigOptions = {}): Rig {
  const specs: NewTestSpec[] = [];
  const merged: string[] = [];
  const recoveries: Array<{ project: string; diagnostics?: readonly string[] }> = [];
  const create = options.create ?? (() => Promise.resolve<AuthoredTest>({ key: `CALC-${specs.length}`, warnings: [] }));
  const adapter = {
    label: "Xray",
    keyGrammar: { testPrefix: "TEST_", canonicalizeKey: (key: string) => key.toUpperCase() },
    ...(options.authoring === false
      ? {}
      : {
          testAuthoring: {
            createTest: (spec: NewTestSpec) => {
              specs.push(spec);
              return create(spec);
            },
          },
        }),
  } as unknown as TraceabilityAdapter;
  const logger = Logger.create();
  const deps: AuthoringCommandDeps = {
    workspaceTrust: trustedWorkspace(),
    snapshot: () => options.snapshot ?? snapshot(),
    adapter: () => adapter,
    selectedScenarios: () => options.selected ?? [scenarioDropId(LOGIN), scenarioDropId(CHECKOUT)],
    selectedTests: () => [],
    targetProject: () => ("project" in options ? options.project : "CALC"),
    credentialsPresent: () => Promise.resolve(options.credentials !== false),
    siteUrl: () => "https://acme.atlassian.net",
    merge: (key) => merged.push(key),
    recordExecution: () => Promise.resolve(),
    scheduleProjectSync: options.scheduleProjectSync ?? ((project, diagnostics) => recoveries.push({
      project,
      ...(diagnostics !== undefined ? { diagnostics: [...diagnostics] } : {}),
    })),
  };
  return { commands: new TraceabilityAuthoringCommands(logger, deps), specs, merged, logger, recoveries };
}

// The board's create runs on a confirmed batch: accept the modal.
function acceptConfirm(): void {
  vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Create tests" as never);
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("TraceabilityAuthoringCommands.bulkCreateTests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("points at the board and creates nothing when nothing is selected", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, specs } = rig({ selected: [] });

    await commands.bulkCreateTests();

    expect(String(info.mock.calls[0]?.[0])).toBe("Select scenarios on the Coverage Board's Mapping tab first.");
    expect(specs).toEqual([]);
  });

  it("makes no remote call when the adapter cannot author tests", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const confirm = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, specs } = rig({ authoring: false });

    await commands.bulkCreateTests();

    expect(String(info.mock.calls[0]?.[0])).toContain("Connect to your test tracker");
    expect(confirm).not.toHaveBeenCalled();
    expect(specs).toEqual([]);
  });

  it("makes no remote call when no credentials are stored for the site", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, specs } = rig({ credentials: false });

    await commands.bulkCreateTests();

    expect(String(info.mock.calls[0]?.[0])).toContain("Connect to your test tracker");
    expect(specs).toEqual([]);
  });

  it("asks for a project instead of guessing one under All Projects", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, specs } = rig({ project: undefined });

    await commands.bulkCreateTests();

    expect(String(info.mock.calls[0]?.[0])).toContain("Pick a project");
    expect(specs).toEqual([]);
  });

  it("creates nothing when the confirmation modal is dismissed", async () => {
    fakeWorkspace();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    const { commands, specs } = rig();

    await commands.bulkCreateTests();

    expect(specs).toEqual([]);
  });

  it("names the project, the count and the site in the one confirmation modal", async () => {
    fakeWorkspace();
    acceptConfirm();
    const confirm = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands } = rig();

    await commands.bulkCreateTests();

    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toBe(
      "Create 2 new Xray tests in project CALC on https://acme.atlassian.net, one per selected scenario?"
    );
    expect(confirm.mock.calls[0]?.[1]).toMatchObject({ modal: true });
  });

  it("writes each tag at its own scenario's line, bottom-up, so an insert never shifts a later one", async () => {
    const workspace = fakeWorkspace();
    acceptConfirm();
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, specs, merged, recoveries } = rig();

    await commands.bulkCreateTests();

    // Bottom-up: Checkout (line 6) is created first, so Log in's line 3 is still line 3 when it lands.
    expect(specs.map((spec) => spec.summary)).toEqual(["Checkout", "Log in"]);
    expect(workspace.applied.map((entries) => entries[0]!.position?.line)).toEqual([5, 2]);
    expect(workspace.text()).toBe(
      [
        "Feature: F",
        "",
        "@TEST_CALC-2",
        "Scenario: Log in",
        "  Given a user",
        "",
        "@TEST_CALC-1",
        "Scenario: Checkout",
        "  Given a cart",
        "",
        "Scenario: Refund",
        "  Given an order",
        "",
        "Scenario: Ship",
        "  Given a parcel",
        "",
      ].join("\n")
    );
    expect(merged).toEqual(["CALC-1", "CALC-2"]);
    expect(recoveries).toEqual([{ project: "CALC" }]);
    expect(String(info.mock.calls.at(-1)?.[0])).toBe("Created 2 Xray tests.");
  });

  it("lands all three tags on their own scenarios when the board is checked top-down", async () => {
    const workspace = fakeWorkspace();
    acceptConfirm();
    const { commands } = rig({
      snapshot: snapshot([LOGIN, CHECKOUT, REFUND]),
      selected: [LOGIN, CHECKOUT, REFUND].map(scenarioDropId),
    });

    await commands.bulkCreateTests();

    expect(workspace.text()).toBe(
      [
        "Feature: F",
        "",
        "@TEST_CALC-3",
        "Scenario: Log in",
        "  Given a user",
        "",
        "@TEST_CALC-2",
        "Scenario: Checkout",
        "  Given a cart",
        "",
        "@TEST_CALC-1",
        "Scenario: Refund",
        "  Given an order",
        "",
        "Scenario: Ship",
        "  Given a parcel",
        "",
      ].join("\n")
    );
  });

  it("keeps each file's writes together and bottom-up when the selection interleaves two files", async () => {
    const workspace = fakeWorkspace({ [FEATURE]: SOURCE, [SECOND]: SECOND_SOURCE });
    acceptConfirm();
    const { commands, specs } = rig({
      snapshot: snapshot([CHECKOUT, SHIP, BROWSE, SORT]),
      selected: [BROWSE, SHIP, SORT, CHECKOUT].map(scenarioDropId),
    });

    await commands.bulkCreateTests();

    expect(specs.map((spec) => spec.summary)).toEqual(["Ship", "Checkout", "Sort", "Browse"]);
    expect(workspace.text()).toBe(
      [
        "Feature: F",
        "",
        "Scenario: Log in",
        "  Given a user",
        "",
        "@TEST_CALC-2",
        "Scenario: Checkout",
        "  Given a cart",
        "",
        "Scenario: Refund",
        "  Given an order",
        "",
        "@TEST_CALC-1",
        "Scenario: Ship",
        "  Given a parcel",
        "",
      ].join("\n")
    );
    expect(workspace.text(SECOND)).toBe(
      [
        "Feature: B",
        "",
        "@TEST_CALC-4",
        "Scenario: Browse",
        "  Given a catalog",
        "",
        "Scenario: Filter",
        "  Given filters",
        "",
        "@TEST_CALC-3",
        "Scenario: Sort",
        "  Given sorting",
        "",
      ].join("\n")
    );
  });

  it("creates one test per selected scenario from its own Gherkin slice", async () => {
    fakeWorkspace();
    acceptConfirm();
    const { commands, specs } = rig();

    await commands.bulkCreateTests();

    expect(specs).toEqual([
      { project: "CALC", summary: "Checkout", gherkin: "Scenario: Checkout\n  Given a cart" },
      { project: "CALC", summary: "Log in", gherkin: "Scenario: Log in\n  Given a user" },
    ]);
  });

  it("refuses to tag a scenario whose line no longer holds it, and creates no test for it", async () => {
    const MOVED: ScenarioRef = { filePath: "/ws/b.feature", line: 9, name: "Moved", kind: "scenario" };
    const workspace = fakeWorkspace({
      [FEATURE]: SOURCE,
      "/ws/b.feature": "Feature: B\n\nScenario: Moved\n  Given x\n",
    });
    acceptConfirm();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, specs, logger } = rig({
      snapshot: snapshot([LOGIN, MOVED]),
      selected: [scenarioDropId(LOGIN), scenarioDropId(MOVED)],
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.bulkCreateTests();

    expect(specs.map((spec) => spec.summary)).toEqual(["Log in"]);
    expect(workspace.text("/ws/b.feature")).toBe("Feature: B\n\nScenario: Moved\n  Given x\n");
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe("Created 1 Xray test, 1 scenario failed.");
    expect(String((logged.mock.calls.at(-1)?.[1] as { reason: string }).reason)).toBe(
      "the feature file changed during the batch"
    );
  });

  it("carries on when one scenario's feature file is gone, counting it as not attempted", async () => {
    fakeWorkspace();
    acceptConfirm();
    const GONE: ScenarioRef = { filePath: "/ws/gone.feature", line: 3, name: "Gone", kind: "scenario" };
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, specs, logger } = rig({
      snapshot: snapshot([LOGIN, CHECKOUT, GONE]),
      selected: [LOGIN, CHECKOUT, GONE].map(scenarioDropId),
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.bulkCreateTests();

    expect(specs.map((spec) => spec.summary)).toEqual(["Checkout", "Log in"]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe("Created 2 Xray tests, 1 not attempted.");
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ scenario: "Gone" });
    // The drop wrote its reason to the log, so the toast carries the route to it.
    expect(warn.mock.calls.at(-1)?.[1]).toBe("Show Output");
  });

  it("counts a selection the board has moved on from as not attempted, not as a smaller batch", async () => {
    fakeWorkspace();
    acceptConfirm();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, specs } = rig({
      snapshot: snapshot([LOGIN]),
      selected: [LOGIN, CHECKOUT].map(scenarioDropId),
    });

    await commands.bulkCreateTests();

    expect(specs.map((spec) => spec.summary)).toEqual(["Log in"]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe("Created 1 Xray test, 1 not attempted.");
  });

  it("runs one batch at a time, so a second click cannot double-create the same selection", async () => {
    fakeWorkspace();
    acceptConfirm();
    let release!: () => void;
    const { commands, specs } = rig({
      selected: [scenarioDropId(LOGIN)],
      create: () =>
        new Promise<AuthoredTest>((resolve) => {
          release = () => resolve({ key: "CALC-1", warnings: [] });
        }),
    });

    const first = commands.bulkCreateTests();
    await flush();
    const second = commands.bulkCreateTests();
    await flush();
    expect(specs).toHaveLength(1);

    release();
    await Promise.all([first, second]);

    expect(specs).toHaveLength(1);
  });

  it("releases the bulk guard before an optional warning summary settles", async () => {
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(docFor(FEATURE, SOURCE));
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(true);
    const never = new Promise<never>(() => undefined);
    const warning = "Project CALC may require administrator reindexing";
    const toast = vi.spyOn(vscode.window, "showWarningMessage").mockImplementation((_message, options) => (
      (options as { modal?: boolean } | undefined)?.modal
        ? Promise.resolve("Create tests" as never)
        : never
    ));
    const { commands, specs, logger, recoveries } = rig({
      selected: [scenarioDropId(LOGIN)],
      create: () => Promise.resolve({ key: `CALC-${specs.length}`, warnings: [warning] }),
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.bulkCreateTests();
    await commands.bulkCreateTests();

    expect(specs).toHaveLength(2);
    const summaries = toast.mock.calls.filter((call) => !(call[1] as { modal?: boolean } | undefined)?.modal);
    expect(String(summaries[0]?.[0])).toBe("Created 1 Xray test, 1 provider warning on 1 remote create.");
    expect(String(summaries[0]?.[0])).not.toContain(warning);
    expect(logged).toHaveBeenCalledWith(
      "Xray returned warnings creating a test",
      expect.objectContaining({ scenario: "Log in", key: "CALC-1", warnings: warning })
    );
    expect(recoveries).toHaveLength(2);
    expect(recoveries[0]).toEqual({ project: "CALC" });
  });

  it("reports a refused tag write as a failure while retaining its provider warning", async () => {
    fakeWorkspace();
    acceptConfirm();
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const warning = "Project CALC may require administrator reindexing";
    const { commands, logger, recoveries } = rig({
      selected: [scenarioDropId(LOGIN)],
      create: () => Promise.resolve({ key: "CALC-1", warnings: [warning] }),
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.bulkCreateTests();

    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "Created 0 Xray tests, 1 scenario failed, 1 provider warning on 1 remote create."
    );
    expect(warn.mock.calls.at(-1)?.[1]).toBe("Show Output");
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ scenario: "Log in" });
    expect(String((logged.mock.calls[0]?.[1] as { reason: string }).reason)).toContain("CALC-1 was created");
    expect(logged).toHaveBeenCalledWith(
      "Xray returned warnings creating a test",
      expect.objectContaining({ scenario: "Log in", key: "CALC-1", warnings: warning })
    );
    expect(recoveries).toEqual([{ project: "CALC" }]);
  });

  it("logs provider warnings from a keyless create without counting it as fully created", async () => {
    fakeWorkspace();
    acceptConfirm();
    const warning = "Project CALC may require administrator reindexing";
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, logger } = rig({
      selected: [scenarioDropId(LOGIN)],
      create: () => Promise.resolve({ issueId: "9000", warnings: [warning] }),
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.bulkCreateTests();

    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "Created 0 Xray tests, 1 scenario failed, 1 provider warning on 1 remote create."
    );
    expect(logged).toHaveBeenCalledWith(
      "Xray returned warnings creating a test",
      expect.not.objectContaining({ key: expect.anything() })
    );
  });

  it("coalesces multiple successful creates into one unconditional project sync request", async () => {
    fakeWorkspace();
    acceptConfirm();
    let calls = 0;
    const { commands, recoveries } = rig({
      create: () => Promise.resolve({
        key: `CALC-${++calls}`,
        warnings: [`Project CALC reindex diagnostic ${calls}`],
      }),
    });

    await commands.bulkCreateTests();

    expect(recoveries).toEqual([{ project: "CALC" }]);
  });

  it("does not inspect recovery diagnostics once any remote create is confirmed", async () => {
    fakeWorkspace();
    acceptConfirm();
    const warnings = new Proxy(["ordinary warning"], {
      get: (target, property, receiver) => {
        if (property === Symbol.iterator || property === "map" || property === "flatMap") {
          return (): never => {
            throw new Error("warning collection was enumerated");
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    let calls = 0;
    const unconditional: boolean[] = [];
    const { commands } = rig({
      create: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ key: "CALC-1", warnings })
          : Promise.reject(new Error("Project CALC needs reindexing"));
      },
      scheduleProjectSync: (_project, diagnostics) => unconditional.push(diagnostics === undefined),
    });

    await commands.bulkCreateTests();

    expect(unconditional).toEqual([true]);
  });

  it("does not quarantine authoring after a reindex-like provider error", async () => {
    fakeWorkspace();
    acceptConfirm();
    let calls = 0;
    const { commands, specs, recoveries } = rig({
      selected: [scenarioDropId(LOGIN)],
      create: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("Project CALC must be reindexed"))
          : Promise.resolve({ key: "CALC-2", warnings: [] });
      },
    });

    await commands.bulkCreateTests();
    await commands.bulkCreateTests();

    expect(specs).toHaveLength(2);
    expect(recoveries[0]?.diagnostics).toContain("Project CALC must be reindexed");
  });

  it("reports the created ones alongside the failed ones when a create rejects", async () => {
    fakeWorkspace();
    acceptConfirm();
    let calls = 0;
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands } = rig({
      create: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve<AuthoredTest>({ key: "CALC-1", warnings: [] }) : Promise.reject(new Error("offline"));
      },
    });

    await commands.bulkCreateTests();

    expect(String(warn.mock.calls.at(-1)?.[0])).toBe("Created 1 Xray test, 1 scenario failed.");
  });

  it("drops a selection the rebuild invalidated instead of creating against a stale slice", async () => {
    fakeWorkspace();
    acceptConfirm();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, specs } = rig({ snapshot: snapshot([CHECKOUT]), selected: [scenarioDropId(LOGIN)] });

    await commands.bulkCreateTests();

    expect(specs).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("out of date");
  });

  it("counts the scenarios a cancellation never reached, so a stopped batch never reads as a whole one", async () => {
    fakeWorkspace();
    acceptConfirm();
    let cancel = (): void => {};
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_options, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        {
          isCancellationRequested: false,
          onCancellationRequested: (cb: () => void) => {
            cancel = cb;
            return { dispose: () => {} };
          },
        }
      )
    );
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    let calls = 0;
    const { commands, specs } = rig({
      snapshot: snapshot([LOGIN, CHECKOUT, REFUND, SHIP]),
      selected: [LOGIN, CHECKOUT, REFUND, SHIP].map(scenarioDropId),
      create: () => {
        calls += 1;
        if (calls === 2) {
          cancel();
        }
        return Promise.resolve<AuthoredTest>({ key: `CALC-${calls}`, warnings: [] });
      },
    });

    await commands.bulkCreateTests();

    expect(specs).toHaveLength(2);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe("Created 2 Xray tests, 2 not attempted.");
    // Nothing failed, so nothing was logged: offering the output channel would send the user nowhere.
    expect(warn.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it("maps the progress cancellation to the abort signal, so a cancelled batch creates nothing", async () => {
    fakeWorkspace();
    acceptConfirm();
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_options, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        { isCancellationRequested: true, onCancellationRequested: (cb: () => void) => { cb(); return { dispose: () => {} }; } }
      )
    );
    const { commands, specs } = rig();

    await commands.bulkCreateTests();

    expect(specs).toEqual([]);
  });
});
