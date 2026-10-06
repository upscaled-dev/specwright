import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { associateCreatedTests, prepareTestCreateAssociations } from "../../commands/test-create-associations";
import { WorkspaceTrust } from "../../core/workspace-trust";
import type { AddTestsToContainerResult, TestContainerTarget, TraceabilityAdapter } from "../../traceability/contracts";
import { Logger } from "../../utils/logger";
import { trustedWorkspace } from "./helpers/test-workspace-trust";

const TARGETS: readonly TestContainerTarget[] = [
  { kind: "test-set", key: "CALC-111", issueId: "set-111" },
  { kind: "test-plan", key: "CALC-222", issueId: "plan-222" },
];
const CREATED = [{ key: "CALC-9", issueId: "returned-9", warnings: [] }];

describe("associations after test creation", () => {
  afterEach(() => vi.restoreAllMocks());

  function adapter(add: (kind: string, id: string, ids: readonly string[], signal?: AbortSignal) => Promise<AddTestsToContainerResult>): TraceabilityAdapter {
    return { testAuthoring: { addTestsToContainer: add } } as unknown as TraceabilityAdapter;
  }

  it.each([0, 1, 2, 3])("resolves only the targets from native association choice %s", async (choice) => {
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (items) => (items as readonly vscode.QuickPickItem[])[choice] as never);
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("CALC-111").mockResolvedValueOnce("CALC-222");
    const resolve = vi.fn(async (kind: string, key: string) => ({ kind, key, issueId: key }));
    const tracker = {
      keyGrammar: { canonicalizeKey: (key: string) => key.toUpperCase(), keyShape: /^CALC-\d+$/, projectOf: () => "CALC" },
      testAuthoring: { resolveTestContainer: resolve, addTestsToContainer: vi.fn() },
    } as unknown as TraceabilityAdapter;
    const targets = await prepareTestCreateAssociations(tracker, "CALC", Logger.create());
    expect(targets?.map((target) => target.kind)).toEqual([[], ["test-set"], ["test-plan"], ["test-set", "test-plan"]][choice]);
    expect(resolve).toHaveBeenCalledTimes(choice === 3 ? 2 : choice === 0 ? 0 : 1);
  });

  it("keeps the prior create-only flow without prompting when either association seam is absent", async () => {
    const picker = vi.spyOn(vscode.window, "showQuickPick");
    for (const authoring of [{}, { resolveTestContainer: vi.fn() }, { addTestsToContainer: vi.fn() }]) {
      expect(await prepareTestCreateAssociations({ testAuthoring: authoring } as unknown as TraceabilityAdapter, "CALC", Logger.create())).toEqual([]);
    }
    expect(picker).not.toHaveBeenCalled();
  });

  it("reports a membership error separately and still attempts the other known target", async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error("set rejected")).mockResolvedValueOnce({ addedTests: ["returned-9"] });
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await associateCreatedTests(adapter(add), TARGETS, CREATED, "CALC", Logger.create(), trustedWorkspace());
    expect(add).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("Created tests remain: CALC-9. Could not add tests to Test Set CALC-111: set rejected");
    expect(info).toHaveBeenCalledWith("Added 1 of 1 created tests to Test Plan CALC-222.");
  });

  it("stops after an unreadable added count and names the unattempted target", async () => {
    const add = vi.fn().mockResolvedValue({});
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS, CREATED, "CALC", Logger.create(), trustedWorkspace());
    expect(add).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("did not return a readable added count"));
    expect(warning).toHaveBeenCalledWith("Created tests remain: CALC-9. Association not attempted for Test Plan CALC-222.");
  });

  it("reports a partial membership response without claiming all tests were added", async () => {
    const add = vi.fn().mockResolvedValue({ addedTests: [] });
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS.slice(0, 1), CREATED, "CALC", Logger.create(), trustedWorkspace());
    expect(add).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("0 of 1 created tests added to Test Set CALC-111"));
  });

  it("reports keyless remote tests by their returned id and associates them without a metadata lookup", async () => {
    const add = vi.fn().mockResolvedValue({ addedTests: ["returned-9"] });
    await associateCreatedTests(adapter(add), TARGETS.slice(0, 1), [{ issueId: "returned-9", warnings: [] }], "CALC", Logger.create(), trustedWorkspace());
    expect(add).toHaveBeenCalledWith("test-set", "set-111", ["returned-9"], expect.any(AbortSignal));
  });

  it("sends no membership request when created tests have no returned ids", async () => {
    const add = vi.fn();
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS, [{ key: "CALC-9", warnings: [] }], "CALC", Logger.create(), trustedWorkspace());
    expect(add).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("No returned issue id for CALC-9"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Association not attempted for Test Set CALC-111 and Test Plan CALC-222"));
  });

  it.each([false, true])("stops membership writes on progress cancellation (request started: %s)", async (started) => {
    let cancel = (): void => {};
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_options, task) => task(
      { report: () => {} }, {
        isCancellationRequested: !started,
        onCancellationRequested: (callback) => {cancel = () => callback(undefined); return { dispose: () => {} };},
      }
    ));
    const add = vi.fn(async () => {cancel(); return { addedTests: ["returned-9"] };});
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS, CREATED, "CALC", Logger.create(), trustedWorkspace());
    expect(add).toHaveBeenCalledTimes(started ? 1 : 0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(started ? "Tests may still have been added to Test Set CALC-111" : "Association not attempted for Test Set CALC-111"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(started
      ? "Association cancelled. Association not attempted for Test Plan CALC-222"
      : "Association cancelled. Association not attempted for Test Set CALC-111 and Test Plan CALC-222"));
    if (started) {expect(warning).toHaveBeenCalledWith(expect.stringContaining("Association not attempted for Test Plan CALC-222"));}
  });

  it("forwards cancellation arriving during membership to the adapter and stops the next target", async () => {
    const controller = new AbortController();
    const add = vi.fn(async (_kind, _id, _ids, signal?: AbortSignal) => {
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { addedTests: ["returned-9"] };
    });
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS, CREATED, "CALC", Logger.create(), trustedWorkspace(), controller.signal);
    expect(add).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Association not attempted for Test Plan CALC-222"));
  });

  it("stops before another membership write when workspace trust is revoked", async () => {
    let trusted = true;
    const add = vi.fn(async () => {
      trusted = false;
      return { addedTests: ["returned-9"] };
    });
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS, CREATED, "CALC", Logger.create(), new WorkspaceTrust(() => trusted));
    expect(add).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("Created tests remain: CALC-9. Workspace trust is no longer available. Association not attempted for Test Plan CALC-222.");
  });

  it.each(["cancellation", "workspace trust"])("reports %s before the first membership request", async (reason) => {
    const add = vi.fn();
    const controller = new AbortController();
    if (reason === "cancellation") {controller.abort();}
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS, [{ issueId: "returned-9", warnings: [] }], "CALC", Logger.create(), new WorkspaceTrust(() => reason !== "workspace trust"), controller.signal);
    expect(add).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(`Created tests remain: issue id returned-9. ${reason === "cancellation" ? "Association cancelled." : "Workspace trust is no longer available."} Association not attempted for Test Set CALC-111 and Test Plan CALC-222.`);
  });

  it("names cancellation between membership requests without losing the confirmed first result", async () => {
    const controller = new AbortController();
    const add = vi.fn().mockResolvedValue({ addedTests: ["returned-9"] });
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockImplementation((message) => {
      if (message.includes("Added 1 of 1 created tests to Test Set CALC-111")) {controller.abort();}
      return Promise.resolve(undefined);
    });
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    await associateCreatedTests(adapter(add), TARGETS, CREATED, "CALC", Logger.create(), trustedWorkspace(), controller.signal);
    expect(add).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("Added 1 of 1 created tests to Test Set CALC-111.");
    expect(warning).toHaveBeenCalledWith("Created tests remain: CALC-9. Association cancelled. Association not attempted for Test Plan CALC-222.");
  });
});
