import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { AuthoringCommandDeps, TraceabilityAuthoringCommands } from "../../commands/traceability-authoring-commands";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import {
  AuthoredTest,
  AddTestsToContainerResult,
  NewContainerSpec,
  NewExecutionSpec,
  TestContainerKind,
  TestContainerTarget,
  TraceabilityAdapter,
} from "../../traceability/contracts";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { TraceabilitySnapshot } from "../../traceability/traceability-model";
import { Logger } from "../../utils/logger";
import { RemoteOutcomeUnknownError } from "../../core/workspace-trust";

const FEATURE = "/ws/a.feature";
const LOGIN: ScenarioRef = { filePath: FEATURE, line: 3, name: "Log in", kind: "scenario" };


// A workspace whose documents actually change: every applied edit is replayed into the file's text, so
// a later write in the same batch reads the lines the earlier one shifted. A path with no entry here is
// a file that no longer exists and refuses to open.

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
  resolved: Array<{ kind: TestContainerKind; key: string }>;
  additions: Array<{ kind: TestContainerKind; issueId: string; testIssueIds: readonly string[] }>;
  // What the standalone create wrote to the publish ledger.
  recorded: Array<{ key: string; summary: string }>;
  logger: Logger;
  recoveries: Array<{ project: string; diagnostics?: readonly string[] }>;
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
  target?: TestContainerTarget | undefined;
  resolve?: ((
    kind: TestContainerKind,
    key: string,
    signal?: AbortSignal
  ) => Promise<TestContainerTarget | undefined>) | undefined;
  addResult?: AddTestsToContainerResult;
  add?: ((signal?: AbortSignal) => Promise<AddTestsToContainerResult>) | undefined;
}

function containerRig(options: ContainerRigOptions = {}): ContainerRig {
  const sets: NewContainerSpec[] = [];
  const plans: NewContainerSpec[] = [];
  const executions: NewExecutionSpec[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const resolved: Array<{ kind: TestContainerKind; key: string }> = [];
  const additions: Array<{ kind: TestContainerKind; issueId: string; testIssueIds: readonly string[] }> = [];
  const recorded: Array<{ key: string; summary: string }> = [];
  const recoveries: Array<{ project: string; diagnostics?: readonly string[] }> = [];
  const created = options.created ?? { key: "CALC-90", issueId: "9000", warnings: [] };
  const create = options.create ?? ((): Promise<AuthoredTest> => Promise.resolve(created));
  const adapter = {
    label: "Xray",
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^[A-Za-z][A-Za-z0-9_-]*-\d+$/,
      canonicalizeKey: (key: string) => key.toUpperCase(),
      projectOf: (key: string) => key.replace(/-\d+$/, ""),
    },
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
            resolveTestContainer: (kind: TestContainerKind, key: string, signal?: AbortSignal) => {
              resolved.push({ kind, key });
              return options.resolve
                ? options.resolve(kind, key, signal)
                : Promise.resolve("target" in options
                  ? options.target
                  : { kind, key, issueId: kind === "test-set" ? "5000" : "6000" });
            },
            addTestsToContainer: (
              kind: TestContainerKind,
              issueId: string,
              testIssueIds: readonly string[],
              signal?: AbortSignal
            ) => {
              additions.push({ kind, issueId, testIssueIds });
              signals.push(signal);
              return options.add
                ? options.add(signal)
                : Promise.resolve(options.addResult ?? { addedTests: [...testIssueIds] });
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
    scheduleProjectSync: (project, diagnostics) => recoveries.push({
      project,
      ...(diagnostics !== undefined ? { diagnostics: [...diagnostics] } : {}),
    }),
  };
  return {
    commands: new TraceabilityAuthoringCommands(logger, deps),
    sets,
    plans,
    executions,
    signals,
    resolved,
    additions,
    recorded,
    logger,
    recoveries,
  };
}

interface WarnCalls {
  mock: { calls: unknown[][] };
}

function modalCall(warn: WarnCalls): unknown[] | undefined {
  return warn.mock.calls.find((call) => (call[1] as { modal?: boolean } | undefined)?.modal === true);
}

// The name prompt and the modal, both answered: a container create runs on a named, confirmed batch.
function nameAndConfirm(kind: string, name: string | undefined = "Regression suite"): WarnCalls {
  vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(name as never);
  return vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(`Create ${kind}` as never);
}

function targetAndConfirm(noun: string, key = "CALC-90"): WarnCalls {
  vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(key as never);
  return vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(`Add to ${noun}` as never);
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

  it("counts the tracker's warnings in the toast and logs bounded detail", async () => {
    nameAndConfirm("Test Plan");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, logger } = containerRig({
      created: { key: "CALC-91", warnings: ["45679 is not a test"] },
    });
    const logged = vi.spyOn(logger, "warn");

    await commands.createTestPlan();

    expect(String(info.mock.calls.at(-1)?.[0])).toBe(
      "Created Test Plan CALC-91 holding 2 tests. 1 provider warning logged."
    );
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ warnings: "45679 is not a test" });
  });

  it("releases the shared container guard before a successful warning toast settles", async () => {
    nameAndConfirm("Test Set");
    const warning = "Project CALC may require administrator reindexing";
    vi.spyOn(vscode.window, "showInformationMessage").mockImplementation(() => new Promise<never>(() => undefined));
    const { commands, sets, recoveries } = containerRig({ created: { key: "CALC-90", warnings: [warning] } });

    await commands.createTestSet();
    await commands.createTestSet();

    expect(sets).toHaveLength(2);
    expect(recoveries).toEqual([
      { project: "CALC" },
      { project: "CALC" },
    ]);
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

describe("TraceabilityAuthoringCommands existing containers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails the whole append before any read or mutation and names every test without an issue id", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const input = vi.spyOn(vscode.window, "showInputBox");
    const { commands, resolved, additions } = containerRig({ selected: ["CALC-3", "CALC-1", "CALC-4"] });

    await commands.addToTestSet();

    expect(resolved).toEqual([]);
    expect(additions).toEqual([]);
    expect(input).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("CALC-3, CALC-4");
  });

  it("rejects malformed and cross-project keys before the target read", async () => {
    const input = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("PAY-9" as never);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, resolved, additions } = containerRig();

    await commands.addToTestPlan();

    const validate = input.mock.calls[0]?.[0]?.validateInput;
    expect(validate?.("not a key")).toBe("Enter an exact issue key, such as CALC-123.");
    expect(validate?.("PAY-9")).toBe("The target must be in project CALC.");
    expect(String(warn.mock.calls[0]?.[0])).toBe("The target must be in project CALC.");
    expect(resolved).toEqual([]);
    expect(additions).toEqual([]);
  });

  it("requires the exact expected container type before mutation", async () => {
    targetAndConfirm("Test Set");
    const { commands, resolved, additions } = containerRig({
      target: { kind: "test-plan", key: "CALC-90", issueId: "6000" },
    });

    await commands.addToTestSet();

    expect(resolved).toEqual([{ kind: "test-set", key: "CALC-90" }]);
    expect(additions).toEqual([]);
  });

  it("treats a clean missing target as not found and sends no mutation", async () => {
    targetAndConfirm("Test Plan", "CALC-91");
    const { commands, resolved, additions } = containerRig({ target: undefined });

    await commands.addToTestPlan();

    expect(resolved).toEqual([{ kind: "test-plan", key: "CALC-91" }]);
    expect(additions).toEqual([]);
  });

  it("exits silently when target resolution progress is already cancelled", async () => {
    const warn = targetAndConfirm("Test Set");
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
    const { commands, resolved, additions } = containerRig();

    await commands.addToTestSet();

    expect(resolved).toEqual([]);
    expect(additions).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("exits silently when target resolution is cancelled in flight", async () => {
    const warn = targetAndConfirm("Test Plan", "CALC-91");
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
    const resolve = vi.fn((_kind: TestContainerKind, _key: string, signal?: AbortSignal) =>
      new Promise<TestContainerTarget | undefined>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    );
    const { commands, additions } = containerRig({ resolve });

    const pending = commands.addToTestPlan();
    await flush();
    cancel();
    await pending;

    expect(resolve).toHaveBeenCalledOnce();
    expect(additions).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("discards a target returned while its resolution is being cancelled", async () => {
    const warn = targetAndConfirm("Test Set");
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
    const resolve = vi.fn((kind: TestContainerKind, key: string, signal?: AbortSignal) =>
      new Promise<TestContainerTarget | undefined>((complete) => {
        signal?.addEventListener("abort", () => complete({ kind, key, issueId: "5000" }), { once: true });
      })
    );
    const { commands, additions } = containerRig({ resolve });

    const pending = commands.addToTestSet();
    await flush();
    cancel();
    await pending;

    expect(resolve).toHaveBeenCalledOnce();
    expect(additions).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("confirms site, exact key and type, project and count immediately before one mutation", async () => {
    const confirm = targetAndConfirm("Test Set", "calc-90");
    const progress = vi.spyOn(vscode.window, "withProgress");
    const { commands, additions, signals } = containerRig();

    await commands.addToTestSet();

    const modal = modalCall(confirm)!;
    expect(String(modal[0])).toBe(
      "Add 2 selected tests to Xray Test Set CALC-90 in project CALC on https://acme.atlassian.net?"
    );
    expect(modal[1]).toMatchObject({ modal: true });
    expect(additions).toEqual([{ kind: "test-set", issueId: "5000", testIssueIds: ["45678", "45679"] }]);
    expect(signals.at(-1)?.aborted).toBe(false);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      title: "Adding selected tests to Xray Test Set CALC-90…",
      cancellable: true,
    });
  });

  it("sends no mutation when the target-key prompt or confirmation is dismissed", async () => {
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce(undefined as never);
    const first = containerRig();
    await first.commands.addToTestPlan();
    expect(first.resolved).toEqual([]);
    expect(first.additions).toEqual([]);

    vi.restoreAllMocks();
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("CALC-91" as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    const second = containerRig();
    await second.commands.addToTestPlan();
    expect(second.resolved).toEqual([{ kind: "test-plan", key: "CALC-91" }]);
    expect(second.additions).toEqual([]);
  });

  it("reports partial acceptance and warnings without treating existing membership as failure", async () => {
    targetAndConfirm("Test Plan", "CALC-91");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, additions, recoveries } = containerRig({
      addResult: { addedTests: ["45678"], warning: "45679 was already a member" },
    });

    await commands.addToTestPlan();

    expect(additions).toHaveLength(1);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "Xray reported 1 of 2 selected tests added to Test Plan CALC-91. The others may already be members or may not have been accepted; inspect CALC-91 before retrying. 1 provider warning logged."
    );
    expect(recoveries).toEqual([{ project: "CALC", diagnostics: ["45679 was already a member"] }]);
  });

  it("reports an empty added list as known zero, which may mean existing membership", async () => {
    targetAndConfirm("Test Set");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands } = containerRig({ addResult: { addedTests: [] } });

    await commands.addToTestSet();

    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("Xray reported 0 of 2 selected tests added");
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("may already be members");
  });

  it("reports an unreadable added count honestly and instructs inspection", async () => {
    targetAndConfirm("Test Set");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands } = containerRig({ addResult: { warning: "membership changed" } });

    await commands.addToTestSet();

    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("did not return a readable added count");
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("Inspect CALC-90 before retrying");
    expect(String(warn.mock.calls.at(-1)?.[0])).not.toContain("0 of 2");
  });

  it("does not retry an ambiguous mutation and tells the user to inspect the exact target", async () => {
    targetAndConfirm("Test Set");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const add = vi.fn(() => Promise.reject(new RemoteOutcomeUnknownError("add tests", "op-1")));
    const { commands } = containerRig({ add });

    await commands.addToTestSet();

    expect(add).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "The request outcome is unknown. Tests may have been added to Test Set CALC-90; inspect CALC-90 before retrying."
    );
  });

  it("sends nothing when mutation progress is already cancelled", async () => {
    targetAndConfirm("Test Set");
    vi.spyOn(vscode.window, "withProgress").mockImplementation((options, task) => {
      const cancelled = String(options.title).startsWith("Adding selected tests");
      return (task as (progress: unknown, token: unknown) => Thenable<unknown>)(
        { report: () => {} },
        {
          isCancellationRequested: cancelled,
          onCancellationRequested: (listener: () => void) => {
            if (cancelled) {listener();}
            return { dispose: () => {} };
          },
        }
      );
    });
    const add = vi.fn(() => Promise.resolve({ addedTests: ["45678", "45679"] }));
    const { commands, additions } = containerRig({ add });

    await commands.addToTestSet();

    expect(add).not.toHaveBeenCalled();
    expect(additions).toEqual([]);
  });

  it("marks cancellation after dispatch ambiguous and never retries", async () => {
    targetAndConfirm("Test Plan", "CALC-91");
    let cancel = (): void => {};
    vi.spyOn(vscode.window, "withProgress").mockImplementation((options, task) => {
      const writing = String(options.title).startsWith("Adding selected tests");
      return (task as (progress: unknown, token: unknown) => Thenable<unknown>)(
        { report: () => {} },
        {
          isCancellationRequested: false,
          onCancellationRequested: (listener: () => void) => {
            if (writing) {cancel = listener;}
            return { dispose: () => {} };
          },
        }
      );
    });
    const add = vi.fn((signal?: AbortSignal) => new Promise<AddTestsToContainerResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { commands, additions } = containerRig({ add });

    const pending = commands.addToTestPlan();
    await flush();
    cancel();
    await pending;

    expect(add).toHaveBeenCalledOnce();
    expect(additions).toHaveLength(1);
    expect(String(warn.mock.calls.at(-1)?.[0])).toBe(
      "Cancelled while waiting for Xray. Tests may still have been added to Test Plan CALC-91; inspect CALC-91 before retrying."
    );
  });

  it("shares the create/append guard so a second container action cannot dispatch alongside the first", async () => {
    targetAndConfirm("Test Set");
    let release!: () => void;
    const { commands, additions, sets } = containerRig({
      add: () => new Promise((resolve) => {release = () => resolve({ addedTests: ["45678", "45679"] });}),
    });

    const append = commands.addToTestSet();
    await flush();
    const create = commands.createTestSet();
    await flush();
    expect(additions).toHaveLength(1);
    expect(sets).toEqual([]);

    release();
    await Promise.all([append, create]);
    expect(sets).toEqual([]);
  });
});
