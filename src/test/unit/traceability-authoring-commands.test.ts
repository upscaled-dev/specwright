import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { AuthoringCommandDeps, TraceabilityAuthoringCommands } from "../../commands/traceability-authoring-commands";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { scenarioDropId } from "../../traceability/board-data";
import {
  AuthoredTest,
  AutomationBindingClassification,
  NewContainerSpec,
  NewExecutionSpec,
  NewTestSpec,
  TestCaseMetadata,
  TraceabilityAdapter,
} from "../../traceability/contracts";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { TraceabilitySnapshot, TraceLink } from "../../traceability/traceability-model";
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
}

interface RigOptions {
  selected?: string[];
  project?: string | undefined;
  authoring?: boolean;
  credentials?: boolean;
  snapshot?: TraceabilitySnapshot;
  create?: (spec: NewTestSpec) => Promise<AuthoredTest>;
}

function rig(options: RigOptions = {}): Rig {
  const specs: NewTestSpec[] = [];
  const merged: string[] = [];
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
  };
  return { commands: new TraceabilityAuthoringCommands(logger, deps), specs, merged, logger };
}

// The board's create runs on a confirmed batch: accept the modal.
function acceptConfirm(): void {
  vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Create tests" as never);
}

const LOGIN_TEXT = "Scenario: Log in\n  Given a user";
const REMOTE: TestCaseMetadata = { key: "CALC-1", issueId: "45678", gherkin: LOGIN_TEXT };

function linkSnapshot(over: Partial<TraceLink> = {}): TraceabilitySnapshot {
  return {
    links: [{ testKey: "CALC-1", scenario: LOGIN, reqKeys: [], meta: REMOTE, ...over }],
    untraced: [],
    orphans: [],
    stale: false,
    completeProjects: ["CALC"],
    errors: [],
  };
}

interface PushRig {
  commands: TraceabilityAuthoringCommands;
  pushes: Array<{ issueId: string; gherkin: string }>;
  searched: string[];
  merged: string[];
  logger: Logger;
}

interface PushRigOptions {
  snapshot?: TraceabilitySnapshot;
  // What the FRESH single-key read answers with; absent means the remote knows no such test.
  remote?: TestCaseMetadata | undefined;
  readBack?: string | undefined;
  pushGherkin?: ((issueId: string, gherkin: string) => Promise<string | undefined>) | undefined;
  classify?: AutomationBindingClassification;
  mergeError?: Error | undefined;
  capability?: boolean;
  remoteSearch?: boolean;
  credentials?: boolean;
}

function pushRig(options: PushRigOptions = {}): PushRig {
  const pushes: Array<{ issueId: string; gherkin: string }> = [];
  const searched: string[] = [];
  const merged: string[] = [];
  const remote = "remote" in options ? options.remote : REMOTE;
  const adapter = {
    label: "Xray",
    keyGrammar: { testPrefix: "TEST_", canonicalizeKey: (key: string) => key.toUpperCase() },
    automationBinding: { classify: () => options.classify ?? "compatible" },
    ...(options.remoteSearch === false
      ? {}
      : {
          remoteSearch: {
            search: (text: string) => {
              searched.push(text);
              return Promise.resolve({ tests: remote ? [remote] : [], complete: true });
            },
            mergeKeys: (keys: readonly string[]) => {
              merged.push(...keys);
              return options.mergeError ? Promise.reject(options.mergeError) : Promise.resolve();
            },
          },
        }),
    testAuthoring: {
      createTest: () => Promise.resolve<AuthoredTest>({ key: "CALC-1", warnings: [] }),
      ...(options.capability === false
        ? {}
        : {
            pushGherkin: (issueId: string, gherkin: string) => {
              pushes.push({ issueId, gherkin });
              return options.pushGherkin
                ? options.pushGherkin(issueId, gherkin)
                : Promise.resolve("readBack" in options ? options.readBack : gherkin);
            },
          }),
    },
  } as unknown as TraceabilityAdapter;
  const logger = Logger.create();
  const deps: AuthoringCommandDeps = {
    workspaceTrust: trustedWorkspace(),
    snapshot: () => options.snapshot ?? linkSnapshot(),
    adapter: () => adapter,
    selectedScenarios: () => [],
    selectedTests: () => [],
    targetProject: () => "CALC",
    credentialsPresent: () => Promise.resolve(options.credentials !== false),
    siteUrl: () => "acme.atlassian.net",
    merge: () => undefined,
    recordExecution: () => Promise.resolve(),
  };
  return { commands: new TraceabilityAuthoringCommands(logger, deps), pushes, searched, merged, logger };
}

// The push's own modal; blocked outcomes come back through the same warning channel, so assertions read
// the modal by its `{ modal: true }` options argument.
interface WarnCalls {
  mock: { calls: unknown[][] };
}

function acceptPush(): WarnCalls {
  return vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Push text" as never);
}

function modalCall(warn: WarnCalls): unknown[] | undefined {
  return warn.mock.calls.find((call) => (call[1] as { modal?: boolean } | undefined)?.modal === true);
}

function blockedCall(warn: WarnCalls): unknown[] | undefined {
  return warn.mock.calls.find((call) => (call[1] as { modal?: boolean } | undefined)?.modal !== true);
}

// A snapshot the board's test cards come from: CALC-1 is mapped, CALC-2 is available, and CALC-3 was
// synced without an issue id (the only handle a container create takes).
const CONTAINER_SNAPSHOT: TraceabilitySnapshot = {
  links: [{ testKey: "CALC-1", scenario: LOGIN, reqKeys: [], meta: { key: "CALC-1", issueId: "45678" } }],
  untraced: [],
  orphans: [
    { testKey: "CALC-2", meta: { key: "CALC-2", issueId: "45679" } },
    { testKey: "CALC-3", meta: { key: "CALC-3" } },
  ],
  stale: false,
  completeProjects: ["CALC"],
  errors: [],
};

interface ContainerRig {
  commands: TraceabilityAuthoringCommands;
  sets: NewContainerSpec[];
  plans: NewContainerSpec[];
  executions: NewExecutionSpec[];
  signals: Array<AbortSignal | undefined>;
  // What the standalone create wrote to the publish ledger.
  recorded: Array<{ key: string; summary: string }>;
  logger: Logger;
}

interface ContainerRigOptions {
  selected?: string[];
  project?: string | undefined;
  seams?: boolean;
  credentials?: boolean;
  snapshot?: TraceabilitySnapshot;
  created?: AuthoredTest;
  create?: (signal?: AbortSignal) => Promise<AuthoredTest>;
  recordError?: Error;
}

function containerRig(options: ContainerRigOptions = {}): ContainerRig {
  const sets: NewContainerSpec[] = [];
  const plans: NewContainerSpec[] = [];
  const executions: NewExecutionSpec[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const recorded: Array<{ key: string; summary: string }> = [];
  const created = options.created ?? { key: "CALC-90", issueId: "9000", warnings: [] };
  const create = options.create ?? ((): Promise<AuthoredTest> => Promise.resolve(created));
  const adapter = {
    label: "Xray",
    keyGrammar: { testPrefix: "TEST_", canonicalizeKey: (key: string) => key.toUpperCase() },
    testAuthoring: {
      createTest: () => Promise.resolve<AuthoredTest>({ key: "CALC-1", warnings: [] }),
      ...(options.seams === false
        ? {}
        : {
            createTestSet: (spec: NewContainerSpec, signal?: AbortSignal) => {
              sets.push(spec);
              signals.push(signal);
              return create(signal);
            },
            createTestPlan: (spec: NewContainerSpec, signal?: AbortSignal) => {
              plans.push(spec);
              signals.push(signal);
              return create(signal);
            },
            createTestExecution: (spec: NewExecutionSpec, signal?: AbortSignal) => {
              executions.push(spec);
              signals.push(signal);
              return create(signal);
            },
          }),
    },
  } as unknown as TraceabilityAdapter;
  const logger = Logger.create();
  const deps: AuthoringCommandDeps = {
    workspaceTrust: trustedWorkspace(),
    snapshot: () => options.snapshot ?? CONTAINER_SNAPSHOT,
    adapter: () => adapter,
    selectedScenarios: () => [],
    selectedTests: () => options.selected ?? ["CALC-1", "CALC-2"],
    targetProject: () => ("project" in options ? options.project : "CALC"),
    credentialsPresent: () => Promise.resolve(options.credentials !== false),
    siteUrl: () => "https://acme.atlassian.net",
    merge: () => undefined,
    recordExecution: (key, summary) => {
      recorded.push({ key, summary });
      return options.recordError ? Promise.reject(options.recordError) : Promise.resolve();
    },
  };
  return { commands: new TraceabilityAuthoringCommands(logger, deps), sets, plans, executions, signals, recorded, logger };
}

// The name prompt and the modal, both answered: a container create runs on a named, confirmed batch.
function nameAndConfirm(kind: string, name: string | undefined = "Regression suite"): WarnCalls {
  vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(name as never);
  return vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(`Create ${kind}` as never);
}

function captureProgressCancel(): () => void {
  let cancel = (): void => {};
  vi.spyOn(vscode.window, "withProgress").mockImplementation((_options, task) =>
    (task as (progress: unknown, token: unknown) => Thenable<unknown>)(
      { report: () => {} },
      {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          cancel = listener;
          return { dispose: () => {} };
        },
      }
    )
  );
  return () => cancel();
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
    const { commands, specs, merged } = rig();

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

  it("reports a refused tag write as a failure, logging the reason and offering the output channel", async () => {
    fakeWorkspace();
    acceptConfirm();
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, logger } = rig({ selected: [scenarioDropId(LOGIN)] });
    const logged = vi.spyOn(logger, "warn");

    await commands.bulkCreateTests();

    expect(String(warn.mock.calls.at(-1)?.[0])).toBe("Created 0 Xray tests, 1 scenario failed.");
    expect(warn.mock.calls.at(-1)?.[1]).toBe("Show Output");
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ scenario: "Log in" });
    expect(String((logged.mock.calls[0]?.[1] as { reason: string }).reason)).toContain("CALC-1 was created");
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

describe("TraceabilityAuthoringCommands.pushScenarioText", () => {
  afterEach(() => vi.restoreAllMocks());

  it("points a row-less board message at the board and reads nothing remote", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, searched, pushes } = pushRig();

    await commands.pushScenarioText();

    expect(String(info.mock.calls[0]?.[0])).toContain("Push button on a linked scenario row");
    expect(searched).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("makes no remote call when the adapter cannot push text", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = acceptPush();
    const { commands, searched, pushes } = pushRig({ capability: false });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(String(info.mock.calls[0]?.[0])).toContain("Connect to your test tracker");
    expect(modalCall(warn)).toBeUndefined();
    expect(searched).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("makes no remote call when the adapter cannot re-read the test", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, pushes } = pushRig({ remoteSearch: false });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(String(info.mock.calls[0]?.[0])).toContain("Connect to your test tracker");
    expect(pushes).toEqual([]);
  });

  it("makes no remote call when no credentials are stored for the site", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, searched, pushes } = pushRig({ credentials: false });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(String(info.mock.calls[0]?.[0])).toContain("Connect to your test tracker");
    expect(searched).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("refuses a row the current snapshot no longer links, reading nothing remote", async () => {
    const warn = acceptPush();
    const { commands, searched, pushes } = pushRig();

    await commands.pushScenarioText(scenarioDropId(CHECKOUT), "CALC-1");

    expect(String(blockedCall(warn)?.[0])).toBe("That link is out of date because the board changed. Try again.");
    expect(searched).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("refuses a link whose recorded line no longer opens that scenario, logging the reason", async () => {
    fakeWorkspace();
    const warn = acceptPush();
    const moved: ScenarioRef = { ...LOGIN, line: 6 };
    const { commands, pushes, logger } = pushRig({ snapshot: linkSnapshot({ scenario: moved }) });
    const logged = vi.spyOn(logger, "warn");

    await commands.pushScenarioText(scenarioDropId(moved), "CALC-1");

    expect(String(blockedCall(warn)?.[0])).toContain("out of date");
    expect(pushes).toEqual([]);
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ scenario: "Log in", key: "CALC-1" });
  });

  it("names the test and the site in one modal, and writes nothing when it is dismissed", async () => {
    fakeWorkspace();
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    const { commands, searched, pushes } = pushRig();

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(String(modalCall(warn)?.[0])).toBe(
      "Replace the text of Xray test CALC-1 on acme.atlassian.net with this scenario's Gherkin?"
    );
    expect(searched).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("reads the test fresh, pushes the scenario's own slice by issue id, then refreshes just that key", async () => {
    fakeWorkspace();
    acceptPush();
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const stale = "Scenario: Log in\n  Given an old step";
    const { commands, searched, pushes, merged } = pushRig({
      remote: { key: "CALC-1", issueId: "99999", gherkin: stale },
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: stale } }),
    });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(searched).toEqual(["CALC-1"]);
    // The issue id comes from the fresh read, never the snapshot's stale one; the text is the scenario's
    // own verbatim slice.
    expect(pushes).toEqual([{ issueId: "99999", gherkin: LOGIN_TEXT }]);
    expect(merged).toEqual(["CALC-1"]);
    expect(String(info.mock.calls.at(-1)?.[0])).toBe("Pushed this scenario's text to CALC-1.");
  });

  // A push that landed and refreshed is not an anomaly: warning about it would send the user to an
  // output channel with nothing to answer for.
  it("logs nothing when a push lands and the baseline refreshes", async () => {
    fakeWorkspace();
    acceptPush();
    const stale = "Scenario: Log in\n  Given an old step";
    const { commands, pushes, merged, logger } = pushRig({
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: stale } }),
      remote: { key: "CALC-1", issueId: "45678", gherkin: stale },
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toHaveLength(1);
    expect(merged).toEqual(["CALC-1"]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("blocks and writes nothing when the remote text moved since the last sync", async () => {
    fakeWorkspace();
    const warn = acceptPush();
    const { commands, pushes, merged, logger } = pushRig({
      remote: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: Log in\n  Given someone else edited this" },
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toEqual([]);
    expect(merged).toEqual([]);
    expect(String(blockedCall(warn)?.[0])).toBe(
      "Nothing was pushed: CALC-1 changed in Xray since the last sync. Sync traceability, then try again."
    );
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ outcome: "drift", key: "CALC-1" });
  });

  it("blocks and writes nothing when there is no synced copy to compare against", async () => {
    fakeWorkspace();
    const warn = acceptPush();
    const { commands, pushes, logger } = pushRig({ snapshot: linkSnapshot({ meta: undefined }) });
    const logged = vi.spyOn(logger, "warn");

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toEqual([]);
    expect(String(blockedCall(warn)?.[0])).toBe(
      "Nothing was pushed: there is no synced copy of CALC-1 to compare against. Sync traceability, then try again."
    );
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ outcome: "no-baseline" });
  });

  // A sync cannot conjure a test that is not there, so this one must not ask for one.
  it("says the tracker has no such test, without the re-sync advice, when the fresh read finds nothing", async () => {
    fakeWorkspace();
    const warn = acceptPush();
    const { commands, pushes } = pushRig({ remote: undefined });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toEqual([]);
    expect(String(blockedCall(warn)?.[0])).toBe("Nothing was pushed: Xray has no test CALC-1 to write to.");
  });

  it("says the issue id is missing, without the re-sync advice, when the read returns none", async () => {
    fakeWorkspace();
    const warn = acceptPush();
    const stale = "Scenario: Log in\n  Given an old step";
    const { commands, pushes } = pushRig({
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: stale } }),
      remote: { key: "CALC-1", gherkin: stale },
    });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toEqual([]);
    expect(String(blockedCall(warn)?.[0])).toBe(
      "Nothing was pushed: Xray returned no issue id for CALC-1, which is the only handle the write takes."
    );
  });

  it("names a non-Gherkin remote test instead of advising a sync that could never fix it", async () => {
    fakeWorkspace();
    const warn = acceptPush();
    const { commands, pushes } = pushRig({
      classify: "incompatible-test-type",
      remote: { key: "CALC-1", issueId: "45678", gherkin: LOGIN_TEXT, testType: { name: "Manual", kind: "Steps" } },
    });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toEqual([]);
    expect(String(blockedCall(warn)?.[0])).toBe(
      "Nothing was pushed: CALC-1 is a Manual test in Xray, and only Gherkin tests can hold scenario text."
    );
  });

  it("refuses an example-row link with its own message, reading nothing remote", async () => {
    fakeWorkspace();
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const row: ScenarioRef = { ...LOGIN, kind: "examplesBlock", outlineName: "Log in" };
    const { commands, searched, pushes } = pushRig({ snapshot: linkSnapshot({ scenario: row }) });

    await commands.pushScenarioText(scenarioDropId(row), "CALC-1");

    expect(String(info.mock.calls[0]?.[0])).toBe(
      "Pushing text is not available for an example-row link. Link the outline itself to push its text."
    );
    expect(searched).toEqual([]);
    expect(pushes).toEqual([]);
  });

  it("reports a landed push as a success with a stale-baseline warning when the refresh fails", async () => {
    fakeWorkspace();
    const warn = acceptPush();
    const stale = "Scenario: Log in\n  Given an old step";
    const { commands, pushes, logger } = pushRig({
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: stale } }),
      remote: { key: "CALC-1", issueId: "45678", gherkin: stale },
      mergeError: new Error("offline"),
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toEqual([{ issueId: "45678", gherkin: LOGIN_TEXT }]);
    expect(String(blockedCall(warn)?.[0])).toBe(
      "Pushed this scenario's text to CALC-1. The local baseline could not refresh, so sync to clear the drift badge."
    );
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ outcome: "pushed", refreshError: "offline" });
  });

  it("says so and writes nothing when the test already matches the scenario", async () => {
    fakeWorkspace();
    acceptPush();
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, pushes } = pushRig();

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toEqual([]);
    expect(String(info.mock.calls.at(-1)?.[0])).toBe("CALC-1 already matches this scenario's text.");
  });

  it("reports a read-back that came home different, and still refreshes the baseline", async () => {
    fakeWorkspace();
    acceptPush();
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { commands, merged, logger } = pushRig({
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: Log in\n  Given an old step" } }),
      remote: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: Log in\n  Given an old step" },
      readBack: "Scenario: Log in\n  Given the server rewrote this",
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(merged).toEqual(["CALC-1"]);
    expect(String(error.mock.calls[0]?.[0])).toContain("did not read it back unchanged");
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ outcome: "unverified" });
  });

  it("surfaces a failed write as an error and logs it", async () => {
    fakeWorkspace();
    acceptPush();
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { commands, logger } = pushRig({
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: Log in\n  Given an old step" } }),
      remote: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: Log in\n  Given an old step" },
      pushGherkin: () => Promise.reject(new Error("permission denied")),
    });
    const logged = vi.spyOn(logger, "error");

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(String(error.mock.calls[0]?.[0])).toBe("Could not push this scenario's text to CALC-1: permission denied");
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ key: "CALC-1" });
  });

  it("runs one push at a time, so a second door cannot double-write the same test", async () => {
    fakeWorkspace();
    acceptPush();
    let release!: () => void;
    const { commands, pushes } = pushRig({
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: Log in\n  Given an old step" } }),
      remote: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: Log in\n  Given an old step" },
      pushGherkin: (_issueId, gherkin) =>
        new Promise<string>((resolve) => {
          release = () => resolve(gherkin);
        }),
    });

    const first = commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");
    await flush();
    const second = commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");
    await flush();
    expect(pushes).toHaveLength(1);

    release();
    await Promise.all([first, second]);

    expect(pushes).toHaveLength(1);
  });
});

describe("TraceabilityAuthoringCommands container creates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("points at the board and creates nothing when no test is checked", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const input = vi.spyOn(vscode.window, "showInputBox");
    const { commands, sets } = containerRig({ selected: [] });

    await commands.createTestSet();

    expect(String(info.mock.calls[0]?.[0])).toBe("Select tests on the Coverage Board's Mapping tab first.");
    expect(input).not.toHaveBeenCalled();
    expect(sets).toEqual([]);
  });

  it("makes no remote call when the adapter does not expose the container seams", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const input = vi.spyOn(vscode.window, "showInputBox");
    const { commands, plans } = containerRig({ seams: false });

    await commands.createTestPlan();

    expect(String(info.mock.calls[0]?.[0])).toBe("Connect to your test tracker before creating a Test Plan.");
    expect(input).not.toHaveBeenCalled();
    expect(plans).toEqual([]);
  });

  it("makes no remote call when no credentials are stored for the site", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, sets } = containerRig({ credentials: false });

    await commands.createTestSet();

    expect(String(info.mock.calls[0]?.[0])).toContain("Connect to your test tracker");
    expect(sets).toEqual([]);
  });

  it("asks for a project instead of guessing one under All Projects", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, sets } = containerRig({ project: undefined });

    await commands.createTestSet();

    expect(String(info.mock.calls[0]?.[0])).toBe("Pick a project on the Coverage Board to create this Test Set in.");
    expect(sets).toEqual([]);
  });

  it("defaults the name to the project and the count, and creates nothing when the prompt is dismissed", async () => {
    const input = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined as never);
    const confirm = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, sets } = containerRig();

    await commands.createTestSet();

    expect(input.mock.calls[0]?.[0]).toMatchObject({ value: "CALC Test Set (2 tests)" });
    expect(confirm).not.toHaveBeenCalled();
    expect(sets).toEqual([]);
  });

  it("names the container type, the project, the count and the site in the one confirmation modal", async () => {
    const confirm = nameAndConfirm("Test Set");
    const { commands } = containerRig();

    await commands.createTestSet();

    expect(String(confirm.mock.calls[0]?.[0])).toBe(
      "Create a new Xray Test Set in project CALC on https://acme.atlassian.net holding 2 selected tests?"
    );
    expect(confirm.mock.calls[0]?.[1]).toMatchObject({ modal: true });
  });

  it("creates nothing when the confirmation modal is dismissed", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("Regression suite" as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    const { commands, sets, plans } = containerRig();

    await commands.createTestSet();

    expect(sets).toEqual([]);
    expect(plans).toEqual([]);
  });

  it("sends one Test Set holding the checked tests' issue ids and reports the created key", async () => {
    nameAndConfirm("Test Set");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const progress = vi.spyOn(vscode.window, "withProgress");
    const { commands, sets, plans, signals } = containerRig();

    await commands.createTestSet();

    expect(sets).toEqual([{ project: "CALC", summary: "Regression suite", testIssueIds: ["45678", "45679"] }]);
    expect(plans).toEqual([]);
    expect(progress.mock.calls[0]?.[0]).toMatchObject({
      location: vscode.ProgressLocation.Notification,
      title: "Creating Xray Test Set in CALC…",
      cancellable: true,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(String(info.mock.calls.at(-1)?.[0])).toBe("Created Test Set CALC-90 holding 2 tests.");
  });

  it("routes the plan verb to its own seam, trimming the name it was given", async () => {
    nameAndConfirm("Test Plan", "  Release 4  ");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, sets, plans, signals } = containerRig({ selected: ["CALC-2"] });

    await commands.createTestPlan();

    expect(plans).toEqual([{ project: "CALC", summary: "Release 4", testIssueIds: ["45679"] }]);
    expect(sets).toEqual([]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(String(info.mock.calls.at(-1)?.[0])).toBe("Created Test Plan CALC-90 holding 1 test.");
  });

  it("creates nothing and names every unresolvable key when a checked test has no synced issue id", async () => {
    const warn = nameAndConfirm("Test Set");
    const { commands, sets, logger } = containerRig({ selected: ["CALC-3", "CALC-1", "CALC-4"] });
    const logged = vi.spyOn(logger, "warn");

    await commands.createTestSet();

    expect(sets).toEqual([]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "Nothing was created: there is no synced issue id for CALC-3, CALC-4, which is the only handle a Test Set takes. Sync traceability, then try again."
    );
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ keys: "CALC-3, CALC-4" });
  });

  it("reports a container created without a readable key as created, naming the issue id", async () => {
    const warn = nameAndConfirm("Test Set");
    const { commands, sets } = containerRig({ created: { issueId: "9000", warnings: [] } });

    await commands.createTestSet();

    expect(sets).toHaveLength(1);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "The Test Set was created (issue id 9000) but its key could not be read back, so it could not be named here."
    );
  });

  it("carries the tracker's warnings into the report and logs them verbatim", async () => {
    nameAndConfirm("Test Plan");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, logger } = containerRig({
      created: { key: "CALC-91", warnings: ["45679 is not a test"] },
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.createTestPlan();

    expect(String(info.mock.calls.at(-1)?.[0])).toBe(
      "Created Test Plan CALC-91 holding 2 tests. Warnings: 45679 is not a test"
    );
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ warnings: "45679 is not a test" });
  });

  it("surfaces a failed create as an error and logs it", async () => {
    nameAndConfirm("Test Set");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { commands, logger } = containerRig({ create: () => Promise.reject(new Error("permission denied")) });
    const logged = vi.spyOn(logger, "error");

    await commands.createTestSet();

    expect(String(error.mock.calls[0]?.[0])).toBe("Could not create this Test Set: permission denied");
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ project: "CALC" });
  });

  it("does not start the POST or report an ambiguous result when progress was already cancelled", async () => {
    const warn = nameAndConfirm("Test Plan");
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_options, task) =>
      (task as (progress: unknown, token: unknown) => Thenable<unknown>)(
        { report: () => {} },
        {
          isCancellationRequested: true,
          onCancellationRequested: (listener: () => void) => {
            listener();
            return { dispose: () => {} };
          },
        }
      )
    );
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { commands, plans } = containerRig();

    await commands.createTestPlan();

    expect(plans).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("aborts an in-flight Test Set and warns that the POST may still have landed", async () => {
    const warn = nameAndConfirm("Test Set");
    const cancel = captureProgressCancel();
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { commands, sets, signals } = containerRig({
      create: (signal) =>
        new Promise<AuthoredTest>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });

    const pending = commands.createTestSet();
    await flush();
    cancel();
    await pending;

    expect(sets).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "Cancelled while waiting for Xray. The Test Set may still have been created; check in Jira before retrying."
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("runs one container create at a time, so a second click cannot author a duplicate", async () => {
    nameAndConfirm("Test Set");
    let release!: () => void;
    const { commands, sets } = containerRig({
      create: () =>
        new Promise<AuthoredTest>((resolve) => {
          release = () => resolve({ key: "CALC-90", warnings: [] });
        }),
    });

    const first = commands.createTestSet();
    await flush();
    const second = commands.createTestSet();
    await flush();
    expect(sets).toHaveLength(1);

    release();
    await Promise.all([first, second]);

    expect(sets).toHaveLength(1);
  });

  // One guard covers BOTH verbs: they act on the same selection, so the plan must wait rather than
  // write alongside a set already in flight.
  it("holds the other verb too while a container create is running", async () => {
    nameAndConfirm("Test Set");
    let release!: () => void;
    const { commands, sets, plans } = containerRig({
      create: () =>
        new Promise<AuthoredTest>((resolve) => {
          release = () => resolve({ key: "CALC-90", warnings: [] });
        }),
    });

    const set = commands.createTestSet();
    await flush();
    const plan = commands.createTestPlan();
    await flush();
    expect(sets).toHaveLength(1);
    expect(plans).toEqual([]);

    release();
    await Promise.all([set, plan]);

    expect(sets).toHaveLength(1);
    expect(plans).toEqual([]);
  });
});

describe("TraceabilityAuthoringCommands.createTestExecution", () => {
  afterEach(() => vi.restoreAllMocks());

  const TODAY = new Date().toISOString().slice(0, 10);

  it("makes no remote call when the adapter cannot create executions", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const input = vi.spyOn(vscode.window, "showInputBox");
    const { commands, executions } = containerRig({ seams: false });

    await commands.createTestExecution();

    expect(String(info.mock.calls[0]?.[0])).toBe("Connect to your test tracker before creating a Test Execution.");
    expect(input).not.toHaveBeenCalled();
    expect(executions).toEqual([]);
  });

  it("makes no remote call when no credentials are stored for the site", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, executions } = containerRig({ credentials: false });

    await commands.createTestExecution();

    expect(String(info.mock.calls[0]?.[0])).toContain("Connect to your test tracker");
    expect(executions).toEqual([]);
  });

  it("asks for a project instead of guessing one under All Projects", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const input = vi.spyOn(vscode.window, "showInputBox");
    const { commands, executions } = containerRig({ project: undefined });

    await commands.createTestExecution();

    expect(String(info.mock.calls[0]?.[0])).toBe(
      "Pick a project on the Coverage Board to create this Test Execution in."
    );
    expect(input).not.toHaveBeenCalled();
    expect(executions).toEqual([]);
  });

  // The execution holds no tests, so an empty board selection is a normal invocation, not a blocked one.
  it("runs with nothing checked on the board, defaulting the name to the project and today", async () => {
    const input = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined as never);
    const { commands, executions } = containerRig({ selected: [] });

    await commands.createTestExecution();

    expect(input.mock.calls[0]?.[0]).toMatchObject({ value: `CALC Test Execution (${TODAY})` });
    expect(executions).toEqual([]);
  });

  it("names the container type, the project and the site in the one confirmation modal", async () => {
    const confirm = nameAndConfirm("Test Execution");
    const { commands } = containerRig();

    await commands.createTestExecution();

    expect(String(confirm.mock.calls[0]?.[0])).toBe(
      "Create a new Xray Test Execution in project CALC on https://acme.atlassian.net with no tests yet?"
    );
    expect(confirm.mock.calls[0]?.[1]).toMatchObject({ modal: true });
  });

  it("creates nothing when the confirmation modal is dismissed", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("Nightly" as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    const { commands, executions, recorded } = containerRig();

    await commands.createTestExecution();

    expect(executions).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("creates the empty execution, ledgers it, and reports the created key", async () => {
    nameAndConfirm("Test Execution", "  Nightly regression  ");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, executions, recorded, sets, plans } = containerRig({
      created: { key: "XNP-7", issueId: "7000", warnings: [] },
    });

    await commands.createTestExecution();

    expect(executions).toEqual([{ project: "CALC", summary: "Nightly regression" }]);
    expect(recorded).toEqual([{ key: "XNP-7", summary: "Nightly regression" }]);
    expect(sets).toEqual([]);
    expect(plans).toEqual([]);
    expect(String(info.mock.calls.at(-1)?.[0])).toBe("Created Test Execution XNP-7 in CALC.");
  });

  it("writes no ledger entry when the response carried no readable key, reporting it honestly", async () => {
    const warn = nameAndConfirm("Test Execution");
    const { commands, executions, recorded } = containerRig({ created: { issueId: "7000", warnings: [] } });

    await commands.createTestExecution();

    expect(executions).toHaveLength(1);
    expect(recorded).toEqual([]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "The Test Execution was created (issue id 7000) but its key could not be read back, so it could not be named here."
    );
  });

  it("carries the tracker's warnings into the report and logs them verbatim", async () => {
    nameAndConfirm("Test Execution");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, logger } = containerRig({ created: { key: "XNP-7", warnings: ["summary was trimmed"] } });
    const logged = vi.spyOn(logger, "warn");

    await commands.createTestExecution();

    expect(String(info.mock.calls.at(-1)?.[0])).toBe(
      "Created Test Execution XNP-7 in CALC. Warnings: summary was trimmed"
    );
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ warnings: "summary was trimmed" });
  });

  // The execution exists remotely by then, so a ledger fault costs the Executions row, never the report.
  it("still reports the created key when the ledger write fails, logging the fault", async () => {
    nameAndConfirm("Test Execution");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, logger } = containerRig({
      created: { key: "XNP-7", warnings: [] },
      recordError: new Error("memento unavailable"),
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.createTestExecution();

    expect(String(info.mock.calls.at(-1)?.[0])).toBe("Created Test Execution XNP-7 in CALC.");
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ key: "XNP-7", error: "memento unavailable" });
  });

  it("surfaces a failed create as an error and logs it", async () => {
    nameAndConfirm("Test Execution");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { commands, recorded, logger } = containerRig({
      create: () => Promise.reject(new Error("permission denied")),
    });
    const logged = vi.spyOn(logger, "error");

    await commands.createTestExecution();

    expect(String(error.mock.calls[0]?.[0])).toBe("Could not create this Test Execution: permission denied");
    expect(recorded).toEqual([]);
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ project: "CALC" });
  });

  it("aborts an in-flight execution without writing a ledger entry", async () => {
    const warn = nameAndConfirm("Test Execution");
    const cancel = captureProgressCancel();
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    let release!: () => void;
    const { commands, executions, signals, recorded } = containerRig({
      create: () =>
        new Promise<AuthoredTest>((resolve) => {
          release = () => resolve({ key: "XNP-7", warnings: [] });
        }),
    });

    const pending = commands.createTestExecution();
    await flush();
    cancel();
    release();
    await pending;

    expect(executions).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(recorded).toEqual([]);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "Cancelled while waiting for Xray. The Test Execution may still have been created; check in Jira before retrying."
    );
    expect(error).not.toHaveBeenCalled();
  });

  // The guard takes a thunk, so the joined invocation never even opens its prompt: one input box across
  // both calls is what proves it was never started, rather than started and stopped at the confirm.
  it("shares the container guard, so an execution cannot ride alongside a running set create", async () => {
    nameAndConfirm("Test Set");
    const input = vi.spyOn(vscode.window, "showInputBox");
    let release!: () => void;
    const { commands, sets, executions } = containerRig({
      create: () =>
        new Promise<AuthoredTest>((resolve) => {
          release = () => resolve({ key: "CALC-90", warnings: [] });
        }),
    });

    const set = commands.createTestSet();
    await flush();
    const execution = commands.createTestExecution();
    await flush();
    expect(sets).toHaveLength(1);
    expect(executions).toEqual([]);
    expect(input).toHaveBeenCalledOnce();

    release();
    await Promise.all([set, execution]);

    expect(executions).toEqual([]);
    expect(input).toHaveBeenCalledOnce();
  });
});
