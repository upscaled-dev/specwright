import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { PublishDialogDelegate, PublishDialogPanel } from "../../traceability/publish-dialog-panel";
import { AttachmentSuggestion, PublishAttachmentsModel, PublishDialogModel } from "../../traceability/publish-flow";
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

function makeModel(overrides: Partial<PublishDialogModel> = {}): PublishDialogModel {
  return {
    title: "Publish run results",
    subtitle: "3 mapped results",
    defaultProjectKey: "CALC",
    defaultSummary: "Local run 2026-07-22 (3 results)",
    jiraSearchAvailable: true,
    attachments: attachmentsModel(),
    ...overrides,
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
// `browseFiles` returns whatever `browseResult` is set to (default: nothing picked).
function deferredDelegate(): { delegate: PublishDialogDelegate; calls: DeferredCall[]; browseResult: AttachmentSuggestion[] } {
  const calls: DeferredCall[] = [];
  const state = { browseResult: [] as AttachmentSuggestion[] };
  const delegate: PublishDialogDelegate = {
    searchTargets: (kind, query, signal) =>
      new Promise<readonly PublishTarget[]>((resolve, reject) => {
        calls.push({ kind, query, signal, resolve, reject });
      }),
    browseFiles: () => Promise.resolve(state.browseResult),
  };
  return {
    delegate,
    calls,
    get browseResult() {
      return state.browseResult;
    },
    set browseResult(files: AttachmentSuggestion[]) {
      state.browseResult = files;
    },
  };
}

function target(key: string, label: string): PublishTarget {
  return { id: key, label, ref: { key } };
}

afterEach(() => {
  win.__resetWebviewPanels();
});

describe("PublishDialogPanel", () => {
  it("resolves undefined when the panel is closed without confirming (the flow's zero-transport signal)", async () => {
    const { delegate, calls } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    panel.dispose();

    // undefined is exactly what makes runPublishFlow skip every transport call.
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

  it("resolves the confirmed PublishRequest with its picked attachments untouched", async () => {
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

    await panel.__receive({ type: "confirm", request, attachments: ["/ws/playwright-report/index.html"] });

    await expect(promise).resolves.toEqual({ request, attachments: ["/ws/playwright-report/index.html"] });
  });

  it("guards double resolution: a dispose after a confirm neither re-resolves nor throws", async () => {
    const { delegate } = deferredDelegate();
    const request: PublishRequest = { mode: "append", executionKey: "XNP-9" };
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "confirm", request, attachments: [] });
    expect(await promise).toEqual({ request, attachments: [] });

    expect(() => panel.dispose()).not.toThrow();
    await expect(promise).resolves.toEqual({ request, attachments: [] });
  });

  it("guards double resolution: a message arriving after the panel settled is dropped", async () => {
    const { delegate } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    panel.dispose();
    await expect(promise).resolves.toBeUndefined();

    // A late confirm must not flip the already-resolved undefined into a request.
    await panel.__receive({ type: "confirm", request: { mode: "append", executionKey: "LATE-1" }, attachments: [] });
    await expect(promise).resolves.toBeUndefined();
  });

  it("does not call the search delegate until the webview asks for a search", async () => {
    const { delegate, calls } = deferredDelegate();
    const promise = PublishDialogPanel.show(makeModel(), delegate);
    const panel = win.__webviewPanels[0]!;

    // Rendering the dialog alone must issue zero searches.
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
    // The second search aborts the first's controller.
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.aborted).toBe(false);

    // Resolve the stale (superseded) response first, then the current one.
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

    await panel.__receive({ type: "confirm", request, attachments: [] });
    await expect(promise).resolves.toEqual({ request, attachments: [] });

    // finish() aborted the in-flight search's controller, so a late resolution posts nothing.
    calls[0]!.resolve([target("PLAN-1", "Some plan")]);
    await flush();

    expect(panel.webview.__posted).toHaveLength(0);
  });

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

  it("renders the disabled attachments reason and the evidence-stream wording into the html", async () => {
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
    await promise;
  });
});
