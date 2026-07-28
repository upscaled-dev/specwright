import { describe, it, expect, vi } from "vitest";
import { PendingAttachmentsResult, PublishDialogDelegate, PublishSurface } from "../../traceability/publish-dialog-panel";
import {
  AttachmentSuggestion,
  PublishAttachmentsModel,
  PublishDialogModel,
  PublishRunOption,
} from "../../traceability/publish-flow";
import { PublishRequest, PublishTarget } from "../../traceability/contracts";
import { SurfaceHost, SurfaceName } from "../../traceability/webview-host";

// A fake SurfaceHost driving PublishSurface in isolation: `receive` delivers an inbound (webview)
// message to the surface's handler, `posted` records outbound ones, `activations` records `activate`
// targets, and `dispose` fires the onDidDispose seam. No real webview or extension host is involved.
interface FakeHost {
  host: SurfaceHost;
  posted: Array<{ type: string; [key: string]: unknown }>;
  activations: Array<SurfaceName | undefined>;
  receive: (message: unknown) => void;
  dispose: () => void;
}

function fakeHost(): FakeHost {
  let messageHandler: ((message: unknown) => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  let disposed = false;
  const posted: Array<{ type: string; [key: string]: unknown }> = [];
  const activations: Array<SurfaceName | undefined> = [];
  const host: SurfaceHost = {
    post: (message) => posted.push(message as { type: string }),
    onMessage: (handler) => {
      messageHandler = handler;
    },
    activate: (surface) => activations.push(surface),
    onDidDispose: (handler) => {
      disposeHandler = handler;
    },
    isDisposed: () => disposed,
    setTabVisible: () => undefined,
  };
  return {
    host,
    posted,
    activations,
    receive: (message) => messageHandler?.(message),
    dispose: () => {
      disposed = true;
      disposeHandler?.();
    },
  };
}

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
    defaultSummary: "Specwright run 2026-07-22 (3 scenarios)",
    ...over,
  };
}

function makeModel(over: Partial<PublishDialogModel> = {}): PublishDialogModel {
  return {
    title: "Publish run results",
    runs: [runOption()],
    selectedRunId: "run-1",
    jiraSearchAvailable: true,
    knownProjectKeys: [],
    attachments: attachmentsModel(),
    ...over,
  };
}

interface DeferredCall {
  kind: "execution" | "test-plan" | "project";
  query: string;
  signal: AbortSignal | undefined;
  resolve: (targets: readonly PublishTarget[]) => void;
  reject: (error: unknown) => void;
}

// A delegate whose searchTargets never settles on its own; the test drives each call's resolution,
// letting it exercise superseded/aborted responses. `calls` is also the transport-call ledger.
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

function surface(delegate: PublishDialogDelegate, startPublish: () => void = () => undefined): { rig: FakeHost; publish: PublishSurface } {
  const rig = fakeHost();
  const publish = new PublishSurface(rig.host, delegate, startPublish);
  return { rig, publish };
}

describe("PublishSurface: lifecycle", () => {
  it("resolves undefined when the panel is disposed without confirming (the flow's zero-transport signal)", async () => {
    const { delegate, calls } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const promise = publish.present(makeModel());

    rig.dispose();

    await expect(promise).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("resolves undefined, returns to the board, and makes zero delegate calls when the user cancels", async () => {
    const { delegate, calls } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const promise = publish.present(makeModel());

    rig.receive({ type: "cancel" });

    await expect(promise).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(rig.activations).toContain("board");
  });

  it("resolves the confirmed run id, request, and picked attachments untouched", async () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const request: PublishRequest = {
      mode: "create-new",
      project: "CALC",
      summary: "Nightly",
      testPlanKey: "CALC-100",
      environments: ["staging"],
    };
    const promise = publish.present(makeModel());

    rig.receive({ type: "confirm", runId: "run-1", request, attachments: ["/ws/playwright-report/index.html"] });

    await expect(promise).resolves.toEqual({ runId: "run-1", request, attachments: ["/ws/playwright-report/index.html"] });
  });

  it("guards double resolution: a dispose after a confirm neither re-resolves nor throws", async () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const request: PublishRequest = { mode: "append", executionKey: "XNP-9" };
    const promise = publish.present(makeModel());

    rig.receive({ type: "confirm", runId: "run-1", request, attachments: [] });
    expect(await promise).toEqual({ runId: "run-1", request, attachments: [] });

    expect(() => rig.dispose()).not.toThrow();
    await expect(promise).resolves.toEqual({ runId: "run-1", request, attachments: [] });
  });

  it("guards double resolution: a message arriving after the surface settled is dropped", async () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const promise = publish.present(makeModel());

    rig.dispose();
    await expect(promise).resolves.toBeUndefined();

    rig.receive({ type: "confirm", runId: "run-1", request: { mode: "append", executionKey: "LATE-1" }, attachments: [] });
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("PublishSurface: hydrate on present", () => {
  it("paints the run model onto the tab and activates the Publish tab", () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);

    void publish.present(makeModel({ runs: [runOption({ id: "new", label: "newest run" })], selectedRunId: "new" }));

    const model = rig.posted.find((m) => m.type === "model");
    expect(model).toBeDefined();
    expect((model as unknown as { model: PublishDialogModel }).model.runs.map((r) => r.id)).toEqual(["new"]);
    expect(rig.activations).toContain(undefined);
  });

  it("resolves the prior present as undefined when a second one supersedes it, then re-hydrates", async () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);

    const first = publish.present(makeModel({ selectedRunId: "run-1" }));
    void publish.present(makeModel({ runs: [runOption({ id: "run-2", label: "second" })], selectedRunId: "run-2" }));

    await expect(first).resolves.toBeUndefined();
    expect(rig.posted.filter((m) => m.type === "model")).toHaveLength(2);
  });

  it("markSettled clears the busy state to idle after a confirm, staying on the Publish tab", async () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const promise = publish.present(makeModel());

    rig.receive({ type: "confirm", runId: "run-1", request: { mode: "append", executionKey: "XNP-1" }, attachments: [] });
    await promise;

    expect(publish.markSettled()).toBe(true);
    expect(rig.posted.filter((m) => m.type === "settled")).toHaveLength(1);
    expect(rig.activations).not.toContain("board");
  });

  it("markSettled is a no-op once a newer present has superseded the settled one", async () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);

    const first = publish.present(makeModel());
    void publish.present(makeModel({ runs: [runOption({ id: "run-2" })], selectedRunId: "run-2" }));
    await first;

    expect(publish.markSettled()).toBe(false);
    expect(rig.posted.filter((m) => m.type === "settled")).toHaveLength(0);
  });

  // A rebuilt webview comes back on the idle hint, so the tab is dead for a present still waiting.
  it("re-posts the live run model on a re-hydration", () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    void publish.present(makeModel({ runs: [runOption({ id: "run-2", label: "second" })], selectedRunId: "run-2" }));

    publish.rehydrate();

    const models = rig.posted.filter((m) => m.type === "model");
    expect(models).toHaveLength(2);
    expect((models[1] as unknown as { model: PublishDialogModel }).model.selectedRunId).toBe("run-2");
  });

  it("posts nothing on a re-hydration with no publish underway, leaving the idle hint alone", async () => {
    const { delegate } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const promise = publish.present(makeModel());
    rig.receive({ type: "cancel" });
    await promise;

    publish.rehydrate();

    expect(rig.posted.filter((m) => m.type === "model")).toHaveLength(1);
  });
});

describe("PublishSurface: manual activation", () => {
  it("starts a fresh publish when the tab is activated with none underway", () => {
    const { delegate } = deferredDelegate();
    const startPublish = vi.fn();
    const { publish } = surface(delegate, startPublish);

    publish.onManualActivate();

    expect(startPublish).toHaveBeenCalledOnce();
  });

  it("does not start another publish while one is already being presented", () => {
    const { delegate } = deferredDelegate();
    const startPublish = vi.fn();
    const { publish } = surface(delegate, startPublish);

    void publish.present(makeModel());
    publish.onManualActivate();

    expect(startPublish).not.toHaveBeenCalled();
  });
});

describe("PublishSurface: search", () => {
  it("does not call the search delegate until the webview asks for a search", () => {
    const { delegate, calls } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    void publish.present(makeModel());

    expect(calls).toHaveLength(0);

    rig.receive({ type: "search", token: 1, kind: "execution", query: "CALC" });
    expect(calls).toHaveLength(1);
  });

  it("does not post a superseded search response (the aborted token is dropped, the fresh one posts)", async () => {
    const { delegate, calls } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    void publish.present(makeModel());

    rig.receive({ type: "search", token: 1, kind: "execution", query: "A" });
    rig.receive({ type: "search", token: 2, kind: "execution", query: "AB" });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.aborted).toBe(false);

    calls[0]!.resolve([target("XNP-1", "Stale exec")]);
    await flush();
    calls[1]!.resolve([target("XNP-2", "Fresh exec")]);
    await flush();

    const results = rig.posted.filter((m) => m.type === "search-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ token: 2 });
  });

  it("does not post a search response that resolves after the surface is confirmed", async () => {
    const { delegate, calls } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    const request: PublishRequest = { mode: "append", executionKey: "XNP-3" };
    const promise = publish.present(makeModel());

    rig.receive({ type: "search", token: 1, kind: "test-plan", query: "CALC" });
    expect(calls).toHaveLength(1);

    rig.receive({ type: "confirm", runId: "run-1", request, attachments: [] });
    await expect(promise).resolves.toEqual({ runId: "run-1", request, attachments: [] });

    calls[0]!.resolve([target("PLAN-1", "Some plan")]);
    await flush();

    expect(rig.posted.filter((m) => m.type === "search-result")).toHaveLength(0);
  });

  it("scrubs a JWT-shaped thrown value out of the search-result error", async () => {
    const { delegate, calls } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    void publish.present(makeModel());

    rig.receive({ type: "search", token: 3, kind: "execution", query: "CALC" });
    // A non-Error throw reaches the sink verbatim through errMsg's String() fallback.
    calls[0]!.reject("search failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzcGVjd3JpZ2h0In0.c2lnbmF0dXJlLWJ5dGVz");
    await flush();

    const result = rig.posted.filter((m) => m.type === "search-result")[0];
    expect(result).toMatchObject({ token: 3, error: "search failed for [jwt-like-token]" });
  });

  it("carries the project kind through to the delegate and back on the response", async () => {
    const { delegate, calls } = deferredDelegate();
    const { rig, publish } = surface(delegate);
    void publish.present(makeModel());

    rig.receive({ type: "search", token: 7, kind: "project", query: "ca" });
    expect(calls[0]).toMatchObject({ kind: "project", query: "ca" });

    calls[0]!.resolve([target("CALC", "CALC · Calculator")]);
    await flush();

    expect(rig.posted.filter((m) => m.type === "search-result")[0]).toMatchObject({
      token: 7,
      kind: "project",
      items: [{ key: "CALC", label: "CALC · Calculator" }],
    });
  });
});

describe("PublishSurface: attachments", () => {
  it("calls the browse seam on a browse message and posts the picked files back", async () => {
    const rig = deferredDelegate();
    rig.browseResult = [{ path: "/ws/trace.zip", name: "trace.zip", size: 2048 }];
    const { rig: host, publish } = surface(rig.delegate);
    void publish.present(makeModel());

    host.receive({ type: "browse" });
    await flush();

    const results = host.posted.filter((m) => m.type === "browse-result");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "browse-result",
      items: [{ path: "/ws/trace.zip", name: "trace.zip", size: 2048 }],
    });
  });

  it("runs the attach-pending action and posts the remaining count back", async () => {
    const rig = deferredDelegate();
    rig.pendingResult = { remaining: 1 };
    const { rig: host, publish } = surface(rig.delegate);
    void publish.present(makeModel({ runs: [runOption({ pendingAttachments: { key: "XNP-9", count: 2 } })] }));

    host.receive({ type: "attachPending", runId: "run-1" });
    await flush();

    expect(rig.attachPending).toHaveBeenCalledWith("run-1");
    expect(host.posted.filter((m) => m.type === "pending-result")).toEqual([{ type: "pending-result", runId: "run-1", remaining: 1 }]);
  });

  // The picked files and the retried banner are dialog state the host owns; a re-hydration that replayed
  // the present-time model would drop them and let the user publish without evidence they chose.
  it("carries the browsed files into what a re-hydration replays", async () => {
    const rig = deferredDelegate();
    rig.browseResult = [{ path: "/ws/trace.zip", name: "trace.zip", size: 2048 }];
    const { rig: host, publish } = surface(rig.delegate);
    void publish.present(makeModel());

    host.receive({ type: "browse" });
    await flush();
    publish.rehydrate();

    const replayed = host.posted.filter((m) => m.type === "model").at(-1) as unknown as { model: PublishDialogModel };
    expect(replayed.model.attachments.suggestions).toEqual([{ path: "/ws/trace.zip", name: "trace.zip", size: 2048 }]);
  });

  it("carries the retried pending count into what a re-hydration replays, dropping the banner at zero", async () => {
    const rig = deferredDelegate();
    rig.pendingResult = { remaining: 1 };
    const { rig: host, publish } = surface(rig.delegate);
    void publish.present(makeModel({ runs: [runOption({ pendingAttachments: { key: "XNP-9", count: 2 } })] }));

    host.receive({ type: "attachPending", runId: "run-1" });
    await flush();
    publish.rehydrate();
    const retried = host.posted.filter((m) => m.type === "model").at(-1) as unknown as { model: PublishDialogModel };
    expect(retried.model.runs[0]!.pendingAttachments).toEqual({ key: "XNP-9", count: 1 });

    rig.pendingResult = { remaining: 0 };
    host.receive({ type: "attachPending", runId: "run-1" });
    await flush();
    publish.rehydrate();

    const cleared = host.posted.filter((m) => m.type === "model").at(-1) as unknown as { model: PublishDialogModel };
    expect(cleared.model.runs[0]!.pendingAttachments).toBeUndefined();
  });

  it("drops an attach-pending response that resolves after the surface settled", async () => {
    const rig = deferredDelegate();
    let resolvePending: (value: PendingAttachmentsResult) => void = () => undefined;
    rig.attachPending.mockImplementation(
      () => new Promise<PendingAttachmentsResult>((resolve) => { resolvePending = resolve; })
    );
    const { rig: host, publish } = surface(rig.delegate);
    const promise = publish.present(makeModel());

    host.receive({ type: "attachPending", runId: "run-1" });
    host.dispose();
    await expect(promise).resolves.toBeUndefined();

    resolvePending({ remaining: 0 });
    await flush();

    expect(host.posted.filter((m) => m.type === "pending-result")).toHaveLength(0);
  });
});
