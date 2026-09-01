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

  it("counts the tracker's warnings in the toast and logs bounded detail", async () => {
    nameAndConfirm("Test Execution");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const { commands, logger } = containerRig({ created: { key: "XNP-7", warnings: ["summary was trimmed"] } });
    const logged = vi.spyOn(logger, "warn");

    await commands.createTestExecution();

    expect(String(info.mock.calls.at(-1)?.[0])).toBe(
      "Created Test Execution XNP-7 in CALC. 1 provider warning logged."
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
