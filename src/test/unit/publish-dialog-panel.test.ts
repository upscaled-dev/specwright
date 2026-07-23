import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { PendingAttachmentsResult, PublishDialogDelegate, PublishDialogPanel } from "../../traceability/publish-dialog-panel";
import {
  AttachmentSuggestion,
  PublishAttachmentsModel,
  PublishDialogModel,
  PublishRunOption,
} from "../../traceability/publish-flow";
import { PublishRequest, PublishTarget } from "../../traceability/contracts";

// The panel drives the real `vscode.window.createWebviewPanel` stub (src/test/__mocks__/vscode.ts):
// `__receive` delivers an inbound webview message, `webview.__posted` records outbound ones, and
// `dispose()` fires the onDidDispose seam — the same rig the Xray setup-panel tests use. No real
// extension host is needed, so this stays a unit test rather than an integration one.
interface StubPanel {
  viewType: string;
  title: string;
  webview: { html: string; __posted: unknown[] };
  __disposed: boolean;
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}

const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function attachmentsModel(over: Partial<PublishAttachmentsModel> = {}): PublishAttachmentsModel {
  return { available: true, suggestions: [], uploadLimitBytes: 5 * 1024 * 1024, evidenceStream: "evidence", ...over };
}

function runOption(over: Partial<PublishRunOption> = {}): PublishRunOption {
  return {
    id: "run-1",
    label: "2026-07-22 3:00 PM · all-mapped",
    subtitle: "3 mapped results",
    project: { value: "CALC", fromDerivation: true },
    defaultSummary: "Specwright run 2026-07-22 — 3 scenarios",
    ...over,
  };
}

function makeModel(over: Partial<PublishDialogModel> = {}): PublishDialogModel {
  return {
    title: "Publish run results",
    runs: [runOption()],
    selectedRunId: "run-1",
    jiraSearchAvailable: true,
    attachments: attachmentsModel(),
    ...over,
  };
}

interface DeferredCall {
  kind: "execution" | "test-plan";
  query: string;
  signal: AbortSignal | undefined;
  resolve: (targets: readonly PublishTarget[]) => void;
  reject: (error: unknown) => void;
}

// A delegate whose searchTargets never settles on its own — the test drives each call's resolution,
// letting it exercise superseded/aborted responses. `calls` is also the transport-call ledger.
// `browseFiles` returns `browseResult`; `attachPending` returns `pendingResult` and records its runIds.
function deferredDelegate(): {
  delegate: PublishDialogDelegate;
  calls: DeferredCall[];
  attachPending: ReturnType<typeof vi.fn>;
  browseResult: AttachmentSuggestion[];
  pendingResult: PendingAttachmentsResult;
} {
  const calls: DeferredCall[] = [];
  const state = { browseResult: [] as AttachmentSuggestion[], pendingResult: { remaining: 0 } as PendingAttachmentsResult };
  const attachPending = vi.fn((_runId: string) => Promise.resolve(state.pendingResult));
  const delegate: PublishDialogDelegate = {
    searchTargets: (kind, query, signal) =>
      new Promise<readonly PublishTarget[]>((resolve, reject) => {
        calls.push({ kind, query, signal, resolve, reject });
      }),
    browseFiles: () => Promise.resolve(state.browseResult),
    attachPending,
  };
  return {
    delegate,
    calls,
    attachPending,
    get browseResult() {
      return state.browseResult;
    },
    set browseResult(files: AttachmentSuggestion[]) {
      state.browseResult = files;
    },
    get pendingResult() {
      return state.pendingResult;
    },
    set pendingResult(value: PendingAttachmentsResult) {
      state.pendingResult = value;
    },
  };
}

function target(key: string, label: string): PublishTarget {
  return { id: key, label, ref: { key } };
}

afterEach(() => {
  win.__resetWebviewPanels();
});

describe("PublishDialogPanel — lifecycle", () => {
  it("resolves undefined when the panel is closed without confirming (the flow's zero-transport signal)", async () => {
    const { delegate, calls } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    panel.dispose();

    await expect(promise).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("resolves undefined and makes zero delegate calls when the user cancels", async () => {
    const { delegate, calls } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "cancel" });

    await expect(promise).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("resolves the confirmed run id, request, and picked attachments untouched", async () => {
    const { delegate } = deferredDelegate();
    const request: PublishRequest = {
      mode: "create-new",
      project: "CALC",
      summary: "Nightly",
      testPlanKey: "CALC-100",
      environments: ["staging"],
    };
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "confirm", runId: "run-1", request, attachments: ["/ws/playwright-report/index.html"] });

    await expect(promise).resolves.toEqual({ runId: "run-1", request, attachments: ["/ws/playwright-report/index.html"] });
  });

  it("guards double resolution: a dispose after a confirm neither re-resolves nor throws", async () => {
    const { delegate } = deferredDelegate();
    const request: PublishRequest = { mode: "append", executionKey: "XNP-9" };
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "confirm", runId: "run-1", request, attachments: [] });
    expect(await promise).toEqual({ runId: "run-1", request, attachments: [] });

    expect(() => panel.dispose()).not.toThrow();
    await expect(promise).resolves.toEqual({ runId: "run-1", request, attachments: [] });
  });

  it("guards double resolution: a message arriving after the panel settled is dropped", async () => {
    const { delegate } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    panel.dispose();
    await expect(promise).resolves.toBeUndefined();

    await panel.__receive({ type: "confirm", runId: "run-1", request: { mode: "append", executionKey: "LATE-1" }, attachments: [] });
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("PublishDialogPanel — rendered shell", () => {
  it("renders a newest-first run dropdown with an option per run", () => {
    const rig = deferredDelegate();
    const model = makeModel({
      runs: [
        runOption({ id: "new", label: "newest run" }),
        runOption({ id: "old", label: "older run" }),
      ],
      selectedRunId: "new",
    });
    const promise = PublishDialogPanel.show(model, rig.delegate);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.html).toContain('id="run-select"');
    expect(panel.webview.html).toContain("newest run");
    expect(panel.webview.html).toContain("older run");

    panel.dispose();
    return promise;
  });

  it("renders the selected run's project prefill and the derivation hint", () => {
    const rig = deferredDelegate();
    const model = makeModel({ runs: [runOption({ project: { value: "SHOP", fromDerivation: true } })] });
    const promise = PublishDialogPanel.show(model, rig.delegate);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.html).toContain('value="SHOP"');
    expect(panel.webview.html).toContain("from this run's test keys");

    panel.dispose();
    return promise;
  });

  it("hides the derivation hint when the prefill came from the setting", () => {
    const rig = deferredDelegate();
    const model = makeModel({ runs: [runOption({ project: { value: "PAY", fromDerivation: false } })] });
    const promise = PublishDialogPanel.show(model, rig.delegate);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.html).toContain('<div class="hint" id="project-hint" hidden>');

    panel.dispose();
    return promise;
  });

  it("renders the republish banner (target, time, mode) for a previously-published run", () => {
    const rig = deferredDelegate();
    const model = makeModel({
      runs: [runOption({ republish: { key: "XNP-9", publishedAt: Date.UTC(2026, 6, 20, 12, 0, 0), mode: "append" } })],
    });
    const promise = PublishDialogPanel.show(model, rig.delegate);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.html).toContain("Already published to XNP-9");
    expect(panel.webview.html).toContain("(appended)");
    expect(panel.webview.html).toContain("Publishing again creates a duplicate.");

    panel.dispose();
    return promise;
  });

  it("renders the pending-attachments banner with its attach action", () => {
    const rig = deferredDelegate();
    const model = makeModel({ runs: [runOption({ pendingAttachments: { key: "XNP-9", count: 2 } })] });
    const promise = PublishDialogPanel.show(model, rig.delegate);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.html).toContain("2 attachment files from the last publish to XNP-9 did not upload.");
    expect(panel.webview.html).toContain("Attach pending files");

    panel.dispose();
    return promise;
  });

  it("renders the disabled attachments reason and the evidence-stream wording into the html", () => {
    const rig = deferredDelegate();
    const model = makeModel({
      attachments: {
        available: false,
        reason: "Add Jira access in Xray setup to attach files.",
        suggestions: [],
        uploadLimitBytes: 5 * 1024 * 1024,
        evidenceStream: "issue",
      },
    });
    const promise = PublishDialogPanel.show(model, rig.delegate);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.html).toContain("Add Jira access in Xray setup to attach files.");
    expect(panel.webview.html).toContain("uploads to the execution's Jira issue");

    panel.dispose();
    return promise;
  });
});

describe("PublishDialogPanel — search", () => {
  it("does not call the search delegate until the webview asks for a search", async () => {
    const { delegate, calls } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    expect(calls).toHaveLength(0);

    await panel.__receive({ type: "search", token: 1, kind: "execution", query: "CALC" });
    expect(calls).toHaveLength(1);

    panel.dispose();
    await promise;
  });

  it("does not post a superseded search response (the aborted token is dropped, the fresh one posts)", async () => {
    const { delegate, calls } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "search", token: 1, kind: "execution", query: "A" });
    await panel.__receive({ type: "search", token: 2, kind: "execution", query: "AB" });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.aborted).toBe(false);

    calls[0]!.resolve([target("XNP-1", "Stale exec")]);
    await flush();
    calls[1]!.resolve([target("XNP-2", "Fresh exec")]);
    await flush();

    const posted = panel.webview.__posted as Array<{ type: string; token: number }>;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "search-result", token: 2 });

    panel.dispose();
    await promise;
  });

  it("does not post a search response that resolves after the dialog is confirmed", async () => {
    const { delegate, calls } = deferredDelegate();
    const request: PublishRequest = { mode: "append", executionKey: "XNP-3" };
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "search", token: 1, kind: "test-plan", query: "CALC" });
    expect(calls).toHaveLength(1);

    await panel.__receive({ type: "confirm", runId: "run-1", request, attachments: [] });
    await expect(promise).resolves.toEqual({ runId: "run-1", request, attachments: [] });

    calls[0]!.resolve([target("PLAN-1", "Some plan")]);
    await flush();

    expect(panel.webview.__posted).toHaveLength(0);
  });
});

describe("PublishDialogPanel — attachments", () => {
  it("calls the browse seam on a browse message and posts the picked files back", async () => {
    const rig = deferredDelegate();
    rig.browseResult = [{ path: "/ws/trace.zip", name: "trace.zip", size: 2048 }];
    const promise = PublishDialogPanel.show(makeModel(), rig.delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "browse" });
    await flush();

    const posted = panel.webview.__posted as Array<{ type: string; items: unknown }>;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "browse-result",
      items: [{ path: "/ws/trace.zip", name: "trace.zip", size: 2048 }],
    });

    panel.dispose();
    await promise;
  });

  it("runs the attach-pending action and posts the remaining count back", async () => {
    const rig = deferredDelegate();
    rig.pendingResult = { remaining: 1 };
    const promise = PublishDialogPanel.show(
      makeModel({ runs: [runOption({ pendingAttachments: { key: "XNP-9", count: 2 } })] }),
      rig.delegate
    );
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "attachPending", runId: "run-1" });
    await flush();

    expect(rig.attachPending).toHaveBeenCalledWith("run-1");
    expect(panel.webview.__posted).toEqual([{ type: "pending-result", runId: "run-1", remaining: 1 }]);

    panel.dispose();
    await promise;
  });

  it("drops an attach-pending response that resolves after the dialog settled", async () => {
    const rig = deferredDelegate();
    let resolvePending: (value: PendingAttachmentsResult) => void = () => undefined;
    rig.attachPending.mockImplementation(
      () => new Promise<PendingAttachmentsResult>((resolve) => { resolvePending = resolve; })
    );
    const promise = PublishDialogPanel.show(makeModel(), rig.delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "attachPending", runId: "run-1" });
    panel.dispose();
    await expect(promise).resolves.toBeUndefined();

    resolvePending({ remaining: 0 });
    await flush();

    expect(panel.webview.__posted).toHaveLength(0);
  });
});
