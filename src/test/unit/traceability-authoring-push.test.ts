import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { AuthoringCommandDeps, TraceabilityAuthoringCommands } from "../../commands/traceability-authoring-commands";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { scenarioDropId } from "../../traceability/board-data";
import {
  AuthoredTest,
  AutomationBindingClassification,
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

const LOGIN: ScenarioRef = { filePath: FEATURE, line: 3, name: "Log in", kind: "scenario" };
const CHECKOUT: ScenarioRef = { filePath: FEATURE, line: 6, name: "Checkout", kind: "scenario" };


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
    scheduleProjectSync: () => undefined,
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
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

  it("releases the push guard before a completed-work warning settles", async () => {
    fakeWorkspace();
    const never = new Promise<never>(() => undefined);
    vi.spyOn(vscode.window, "showWarningMessage").mockImplementation((_message, options) => (
      (options as { modal?: boolean } | undefined)?.modal
        ? Promise.resolve("Push text" as never)
        : never
    ));
    const stale = "Scenario: Log in\n  Given an old step";
    const { commands, pushes } = pushRig({
      snapshot: linkSnapshot({ meta: { key: "CALC-1", issueId: "45678", gherkin: stale } }),
      remote: { key: "CALC-1", issueId: "45678", gherkin: stale },
      mergeError: new Error("offline"),
    });

    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");
    await commands.pushScenarioText(scenarioDropId(LOGIN), "CALC-1");

    expect(pushes).toHaveLength(2);
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
