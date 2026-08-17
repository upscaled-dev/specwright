import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Logger } from "../../utils/logger";
import { TraceabilityViewProvider } from "../../traceability/traceability-view-provider";
import type { TraceabilityModel, TraceabilitySnapshot } from "../../traceability/traceability-model";

const snapshot: TraceabilitySnapshot = {
  links: [{ testKey: "CALC-1", scenario: { filePath: "/workspace/a.feature", line: 1, name: "😀 scenario", kind: "scenario" }, reqKeys: [] }],
  untraced: [], orphans: [], stale: false, completeProjects: [], errors: [],
};

function view(posts: unknown[], receive: { current: (message: unknown) => void }, post: (message: unknown) => Promise<boolean> = () => Promise.resolve(true)): vscode.WebviewView {
  const webview = {
    options: undefined,
    html: "",
    cspSource: "vscode-webview://traceability",
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: vi.fn(async (message: unknown) => { posts.push(message); return post(message); }),
    onDidReceiveMessage: (listener: (message: unknown) => void) => { receive.current = listener; return { dispose: () => undefined }; },
  };
  return { webview, visible: true, onDidChangeVisibility: () => ({ dispose: () => undefined }), onDidDispose: () => ({ dispose: () => undefined }) } as unknown as vscode.WebviewView;
}

function visibilityView(posts: unknown[], receive: { current: (message: unknown) => void }, post: (message: unknown) => Promise<boolean> = () => Promise.resolve(true)): { view: vscode.WebviewView; setVisible(value: boolean): void; dispose(): void } {
  let visible = true;
  const visibility = new vscode.EventEmitter<void>();
  const disposal = new vscode.EventEmitter<void>();
  const webview = {
    options: undefined,
    html: "",
    cspSource: "vscode-webview://traceability",
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: vi.fn(async (message: unknown) => { posts.push(message); return post(message); }),
    onDidReceiveMessage: (listener: (message: unknown) => void) => { receive.current = listener; return { dispose: () => undefined }; },
  };
  return {
    view: {
      webview,
      get visible() { return visible; },
      onDidChangeVisibility: visibility.event,
      onDidDispose: disposal.event,
    } as unknown as vscode.WebviewView,
    setVisible: (value) => { visible = value; visibility.fire(); },
    dispose: () => disposal.fire(),
  };
}

async function settleTransfer(provider: TraceabilityViewProvider): Promise<void> {
  let transfer: Promise<void> | undefined;
  do {
    transfer = (provider as unknown as { transfer: Promise<void> | undefined }).transfer;
    await transfer;
  } while (transfer !== (provider as unknown as { transfer: Promise<void> | undefined }).transfer);
}

function signal(): { readonly settled: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { settled: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

describe("TraceabilityViewProvider", () => {
  it("coalesces hidden updates and focus until the retained view becomes visible", async () => {
    const changes = new vscode.EventEmitter<void>();
    let current = snapshot;
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const controlled = visibilityView(posts, receive);
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return current; }, onDidChange: changes.event } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(controlled.view);
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const before = posts.length;

    controlled.setVisible(false);
    current = { ...snapshot, links: [{ ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, name: "first hidden" } }] };
    changes.fire();
    current = { ...snapshot, links: [{ ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, name: "latest hidden" } }] };
    changes.fire();
    provider.focusFilter();
    await settleTransfer(provider);
    expect(posts).toHaveLength(before);

    controlled.setVisible(true);
    await settleTransfer(provider);
    const replay = posts.slice(before).map((message) => (message as { body: { type: string; rows?: Array<{ label: string }> } }).body);
    expect(replay.map((body) => body.type)).toEqual(["begin", "chunk", "end", "focus-filter"]);
    expect(replay.find((body) => body.type === "chunk")?.rows?.some((row) => row.label === "latest hidden")).toBe(true);
  });

  it.each([
    ["false", () => Promise.resolve(false)],
    ["rejection", () => Promise.reject(new Error("hidden post failed"))],
  ])("replays the latest generation when hiding causes a chunk %s", async (_kind, failed) => {
    const large: TraceabilitySnapshot = { ...snapshot, links: Array.from({ length: 300 }, (_, index) => ({
      ...snapshot.links[0]!, testKey: `CALC-${index}`, scenario: { ...snapshot.links[0]!.scenario, line: index + 1, name: `Scenario ${index}` },
    })) };
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    let hidden = false;
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return large; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    const controlled = visibilityView(posts, receive, (message) => {
      if (!hidden && (message as { body: { type: string } }).body.type === "chunk") {
        hidden = true;
        controlled.setVisible(false);
        return failed();
      }
      return Promise.resolve(true);
    });
    provider.resolveWebviewView(controlled.view);
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    expect(posts.map((message) => (message as { body: { type: string } }).body.type)).toEqual(["begin", "chunk"]);
    expect((provider as unknown as { deliveryFailed: boolean }).deliveryFailed).toBe(false);

    controlled.setVisible(true);
    await settleTransfer(provider);
    const bodies = posts.map((message) => (message as { body: { generation: number; type: string } }).body);
    const latest = Math.max(...bodies.map((body) => body.generation));
    expect(bodies.filter((body) => body.generation === latest).slice(-5).map((body) => body.type)).toEqual(["begin", "chunk", "chunk", "chunk", "end"]);
  });

  it("ignores stale visibility and disposal events", async () => {
    const changes = new vscode.EventEmitter<void>();
    const firstPosts: unknown[] = [];
    const secondPosts: unknown[] = [];
    const firstReceive = { current: (_message: unknown) => undefined };
    const secondReceive = { current: (_message: unknown) => undefined };
    const first = visibilityView(firstPosts, firstReceive);
    const second = visibilityView(secondPosts, secondReceive);
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: changes.event } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(first.view);
    const firstSession = (provider as unknown as { session: string }).session;
    firstReceive.current({ version: 1, session: firstSession, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    provider.resolveWebviewView(second.view);
    const secondSession = (provider as unknown as { session: string }).session;
    secondReceive.current({ version: 1, session: secondSession, revision: 0, surface: "traceability", body: { type: "ready" } });
    changes.fire();
    await settleTransfer(provider);
    const before = secondPosts.length;
    first.setVisible(false);
    first.dispose();
    await settleTransfer(provider);
    expect(secondPosts).toHaveLength(before);
  });

  it("renders only after ready, then sends one atomic generation and ignores a healthy duplicate ready", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive));
    expect(posts).toEqual([]);
    receive.current({ version: 1, session: (provider as unknown as { session: string }).session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const types = posts.map((message) => (message as { body: { type: string } }).body.type);
    expect(types).toEqual(["begin", "chunk", "end"]);
    receive.current({ version: 1, session: (provider as unknown as { session: string }).session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    expect(posts).toHaveLength(3);
  });

  it("renders the production document and forwards ready, transfer, and filter focus through one WebviewView", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    const signals: string[] = [];
    provider.onDidReceiveClientSignal((signal) => signals.push(signal));
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    const resolved = view(posts, receive);
    provider.resolveWebviewView(resolved);
    expect(resolved.webview.html).toContain('src="file:///dist/traceability-view.js"');
    expect(resolved.webview.html).toContain('href="file:///dist/codicon.css"');
    expect(resolved.webview.html).toContain("font-src vscode-webview://traceability");
    expect(resolved.webview.html).toContain("Content-Security-Policy");
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    provider.focusFilter();
    await settleTransfer(provider);
    expect(posts.map((message) => (message as { body: { type: string } }).body.type)).toEqual(["begin", "chunk", "end", "focus-filter"]);
    const focused = posts.at(-1) as { body: { generation: number } };
    receive.current({ version: 1, session, revision: (provider as unknown as { revision: number }).revision, surface: "traceability", body: { type: "focused", generation: focused.body.generation } });
    expect(provider.acknowledgedFocusCount).toBe(1);
    expect(signals).toEqual(["ready", "focused"]);
  });

  it.each([
    ["false", () => Promise.resolve(false)],
    ["rejection", () => Promise.reject(new Error("post failed"))],
  ])("does not advance or retry after a %s post until one recovery ready", async (_kind, failed) => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive, failed));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    expect((provider as unknown as { revision: number }).revision).toBe(0);
    expect((provider as unknown as { deliveryFailed: boolean }).deliveryFailed).toBe(true);
    const failedPosts = posts.length;
    await settleTransfer(provider);
    expect(posts).toHaveLength(failedPosts);
    const recovered: unknown[] = [];
    provider.resolveWebviewView(view(recovered, receive));
    const newSession = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session: newSession, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    expect(recovered.map((message) => (message as { body: { type: string } }).body.type)).toEqual(["begin", "chunk", "end"]);
  });

  it("coalesces identical grouping, connection, and indicator values", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const before = posts.length;
    provider.setGrouping("test");
    provider.setConnected(true);
    provider.setConnectionIndicator({ state: "ok", label: "site", message: "detail", sync: { syncedAt: 1, stale: false } });
    await settleTransfer(provider);
    const afterChange = posts.length;
    provider.setConnectionIndicator({ state: "ok", label: "site", message: "detail", sync: { syncedAt: 1, stale: false } });
    await settleTransfer(provider);
    expect(afterChange).toBeGreaterThan(before);
    expect(posts).toHaveLength(afterChange);
  });

  it("posts only one focus message for an idle ready view, without replaying a large projection", async () => {
    const large: TraceabilitySnapshot = {
      ...snapshot,
      links: Array.from({ length: 10_001 }, (_, index) => ({
        ...snapshot.links[0]!,
        testKey: `CALC-${index}`,
        scenario: { ...snapshot.links[0]!.scenario, line: index + 1, name: `Scenario ${index}` },
      })),
    };
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return large; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const before = posts.length;
    const generation = (provider as unknown as { generation: number }).generation;
    expect(posts.at(-1)).toMatchObject({ body: { type: "end", generation } });
    provider.focusFilter();
    await settleTransfer(provider);
    expect(posts).toHaveLength(before + 1);
    expect(posts.at(-1)).toMatchObject({ body: { type: "focus-filter", generation } });
  });

  it("coalesces focus behind an active transfer and admits one retry only after an external invalidation", async () => {
    const changes = new vscode.EventEmitter<void>();
    const large: TraceabilitySnapshot = { ...snapshot, links: Array.from({ length: 300 }, (_, index) => ({
      ...snapshot.links[0]!, testKey: `CALC-${index}`, scenario: { ...snapshot.links[0]!.scenario, line: index + 1, name: `Scenario ${index}` },
    })) };
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    let release: (() => void) | undefined;
    const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const entered = signal();
    let hold = true;
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return large; }, onDidChange: changes.event } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive, (message) => {
      const type = (message as { body: { type: string } }).body.type;
      if (type === "chunk" && hold) { hold = false; entered.resolve(); return held; }
      return Promise.resolve(true);
    }));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await entered.settled;
    provider.focusFilter();
    provider.focusFilter();
    release!();
    await settleTransfer(provider);
    expect(posts.filter((message) => (message as { body: { type: string } }).body.type === "focus-filter")).toHaveLength(1);

    const failedPosts: unknown[] = [];
    let fail = true;
    const failedReceive = { current: (_message: unknown) => undefined };
    const failedProvider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    failedProvider.attach({ get snapshot(): TraceabilitySnapshot { return large; }, onDidChange: changes.event } as unknown as TraceabilityModel, "Xray", "test");
    failedProvider.setConnected(true);
    failedProvider.resolveWebviewView(view(failedPosts, failedReceive, () => Promise.resolve(!fail)));
    const failedSession = (failedProvider as unknown as { session: string }).session;
    failedReceive.current({ version: 1, session: failedSession, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(failedProvider);
    const beforeRetry = failedPosts.length;
    changes.fire();
    failedProvider.focusFilter();
    await settleTransfer(failedProvider);
    expect(failedPosts).toHaveLength(beforeRetry + 1);
    fail = false;
    changes.fire();
    await settleTransfer(failedProvider);
    expect(failedPosts.slice(beforeRetry).some((message) => (message as { body: { type: string } }).body.type === "end")).toBe(true);
  });

  it.each([
    ["false", (resolve: (sent: boolean) => void, _reject: (error: Error) => void) => resolve(false)],
    ["rejection", (_resolve: (sent: boolean) => void, reject: (error: Error) => void) => reject(new Error("post failed"))],
  ])("does not let a stale %s post strand a newer queued generation", async (_kind, settle) => {
    const changes = new vscode.EventEmitter<void>();
    let current = snapshot;
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    let settleFirst: (() => void) | undefined;
    const entered = signal();
    let first = true;
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return current; }, onDidChange: changes.event } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive, (message) => {
      if (first && (message as { body: { type: string } }).body.type === "begin") {
        first = false;
        entered.resolve();
        return new Promise<boolean>((resolve, reject) => { settleFirst = () => settle(resolve, reject); });
      }
      return Promise.resolve(true);
    }));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await entered.settled;

    current = { ...snapshot, links: [{ ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, name: "Latest scenario" } }] };
    changes.fire();
    settleFirst!();
    await settleTransfer(provider);

    const bodies = posts.map((message) => (message as { body: { generation: number; rows?: Array<{ label: string }>; type: string } }).body);
    const latest = Math.max(...bodies.map((body) => body.generation));
    expect(bodies.filter((body) => body.generation === latest).map((body) => body.type)).toEqual(["begin", "chunk", "end"]);
    expect(bodies.find((body) => body.generation === latest && body.type === "chunk")?.rows?.map((row) => row.label)).toContain("Latest scenario");
    expect((provider as unknown as { deliveryFailed: boolean }).deliveryFailed).toBe(false);
  });

  it.each([
    ["false", (resolve: (sent: boolean) => void, _reject: (error: Error) => void) => resolve(false)],
    ["rejection", (_resolve: (sent: boolean) => void, reject: (error: Error) => void) => reject(new Error("focus failed"))],
  ])("does not let a stale focus-filter %s strand a newer queued generation", async (_kind, settle) => {
    const changes = new vscode.EventEmitter<void>();
    let current = snapshot;
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    let settleFocus: (() => void) | undefined;
    let holdFocus = true;
    const entered = signal();
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return current; }, onDidChange: changes.event } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive, (message) => {
      if (holdFocus && (message as { body: { type: string } }).body.type === "focus-filter") {
        holdFocus = false;
        entered.resolve();
        return new Promise<boolean>((resolve, reject) => { settleFocus = () => settle(resolve, reject); });
      }
      return Promise.resolve(true);
    }));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);

    provider.focusFilter();
    await entered.settled;
    current = { ...snapshot, links: [{ ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, name: "Focus recovery scenario" } }] };
    changes.fire();
    settleFocus!();
    await settleTransfer(provider);

    const bodies = posts.map((message) => (message as { body: { generation: number; rows?: Array<{ label: string }>; type: string } }).body);
    const latest = Math.max(...bodies.map((body) => body.generation));
    expect(bodies.filter((body) => body.generation === latest).map((body) => body.type)).toEqual(["begin", "chunk", "end", "focus-filter"]);
    expect(bodies.find((body) => body.generation === latest && body.type === "chunk")?.rows?.map((row) => row.label)).toContain("Focus recovery scenario");
    expect((provider as unknown as { deliveryFailed: boolean }).deliveryFailed).toBe(false);
  });

  it("detaches the old model subscription and keeps focus requests coalesced", () => {
    const first = new vscode.EventEmitter<void>();
    const second = new vscode.EventEmitter<void>();
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: first.event } as unknown as TraceabilityModel, "Xray", "test");
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: second.event } as unknown as TraceabilityModel, "Xray", "test");
    const generation = (provider as unknown as { generation: number }).generation;
    first.fire();
    expect((provider as unknown as { generation: number }).generation).toBe(generation);
    second.fire();
    expect((provider as unknown as { generation: number }).generation).toBe(generation + 1);
    provider.focusFilter();
    provider.focusFilter();
    expect((provider as unknown as { focusRequested: boolean }).focusRequested).toBe(true);
    provider.detach();
    const detached = (provider as unknown as { generation: number }).generation;
    second.fire();
    expect((provider as unknown as { generation: number }).generation).toBe(detached);
  });

  it("supersedes an in-flight multi-chunk generation without ending or admitting it", async () => {
    const changes = new vscode.EventEmitter<void>();
    const large: TraceabilitySnapshot = { ...snapshot, links: Array.from({ length: 300 }, (_, index) => ({
      ...snapshot.links[0]!, testKey: `CALC-${index}`, scenario: { ...snapshot.links[0]!.scenario, line: index + 1, name: `Scenario ${index}` },
    })) };
    let release: (() => void) | undefined;
    const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    let heldOnce = false;
    const entered = signal();
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return large; }, onDidChange: changes.event } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive, (message) => {
      const body = (message as { body: { type: string } }).body;
      if (body.type === "chunk" && !heldOnce) { heldOnce = true; entered.resolve(); return held; }
      return Promise.resolve(true);
    }));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await entered.settled;
    changes.fire();
    release!();
    await settleTransfer(provider);
    const bodies = posts.map((message) => (message as { body: { generation?: number; type: string; rows?: unknown[] } }).body);
    const old = bodies.filter((body) => body.generation === 2);
    expect(old.some((body) => body.type === "end")).toBe(false);
    const latest = Math.max(...bodies.map((body) => body.generation ?? 0));
    expect(bodies.filter((body) => body.generation === latest && body.type === "end")).toHaveLength(1);
    expect(bodies.filter((body) => body.type === "chunk").every((body) => (body.rows?.length ?? 0) <= 256)).toBe(true);
  });

  it("admits only current advertised actions and deduplicates run selection nodes", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const chunk = posts.find((message) => (message as { body: { type: string } }).body.type === "chunk") as { body: { generation: number; rows: Array<{ id: string }> } };
    const target = chunk.body.rows.find((candidate) => candidate.id.includes("scenario")) ?? chunk.body.rows[0]!;
    const revision = (provider as unknown as { revision: number }).revision;
    receive.current({ version: 1, session, revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation, id: target.id, action: "run", selection: [target.id, target.id] } });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledWith("playwrightBddRunner.traceability.runAndPublish", expect.anything(), [expect.anything()]);
    const calls = execute.mock.calls.length;
    receive.current({ version: 1, session: "foreign", revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation, id: target.id, action: "run", selection: [] } });
    receive.current({ version: 1, session, revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation - 1, id: target.id, action: "run", selection: [] } });
    receive.current({ version: 1, session, revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation, id: target.id, action: "unknown", selection: [] } });
    expect(execute).toHaveBeenCalledTimes(calls);
    execute.mockRestore();
  });

  it("rejects unknown targets and any unknown selected id before dispatch", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const chunk = posts.find((message) => (message as { body: { type: string } }).body.type === "chunk") as { body: { generation: number; rows: Array<{ id: string }> } };
    const target = chunk.body.rows.find((candidate) => candidate.id.includes("scenario")) ?? chunk.body.rows[0]!;
    const revision = (provider as unknown as { revision: number }).revision;
    receive.current({ version: 1, session, revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation, id: "unknown", action: "run", selection: [] } });
    receive.current({ version: 1, session, revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation, id: target.id, action: "run", selection: [target.id, "unknown"] } });
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it("replays the latest generation on one same-document ready after a failed post", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    let fail = true;
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive, () => Promise.resolve(!fail)));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const failed = posts.length;
    fail = false;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    expect(posts.length).toBeGreaterThan(failed);
    expect(posts.slice(-3).map((message) => (message as { body: { type: string } }).body.type)).toEqual(["begin", "chunk", "end"]);
  });

  it("dispatches every advertised projection action through registered command seams", async () => {
    const value: TraceabilitySnapshot = { ...snapshot, orphans: [{ testKey: "CALC-9", meta: { key: "CALC-9", summary: "Unused" } }], completeProjects: ["CALC"] };
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return value; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.setConnectionIndicator({ state: "ok", label: "site", message: "detail" });
    provider.resolveWebviewView(view(posts, receive));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const chunk = posts.find((message) => (message as { body: { type: string } }).body.type === "chunk") as { body: { generation: number; rows: Array<{ id: string; label: string; actions: Array<{ id: string }> }> } };
    const revision = (provider as unknown as { revision: number }).revision;
    for (const candidate of chunk.body.rows) {
      for (const action of candidate.actions) {
        receive.current({ version: 1, session, revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation, id: candidate.id, action: action.id, selection: [candidate.id] } });
      }
    }
    await Promise.resolve();
    const commands = execute.mock.calls.map(([command]) => command);
    expect(commands).toContain("vscode.open");
    expect(commands).toContain("playwrightBddRunner.traceability.openIssue");
    expect(commands).toContain("playwrightBddRunner.traceability.copyKey");
    expect(commands).toContain("playwrightBddRunner.traceability.linkScenario");
    expect(commands).toContain("playwrightBddRunner.traceability.runAndPublish");
    expect(commands).toContain("playwrightBddRunner.traceability.connect");
    expect(commands).toContain("playwrightBddRunner.traceability.switchDefaultProject");
    const open = execute.mock.calls.find(([command]) => command === "vscode.open")!;
    expect(open[1]).toMatchObject({ fsPath: "/workspace/a.feature" });
    expect(open[2]).toMatchObject({ selection: new vscode.Range(0, 0, 0, 0) });
    execute.mockRestore();
  });

  it("dispatches disconnected and untrusted state actions through the current projection only", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.resolveWebviewView(view(posts, receive));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const disconnected = posts.find((message) => (message as { body: { type: string } }).body.type === "chunk") as { body: { generation: number; rows: Array<{ id: string }> } };
    const revision = (provider as unknown as { revision: number }).revision;
    for (const action of ["connect", "hide"] as const) {
      receive.current({ version: 1, session, revision, surface: "traceability", body: { type: "action", generation: disconnected.body.generation, id: disconnected.body.rows[0]!.id, action, selection: [] } });
    }
    provider.setTrusted(false);
    await settleTransfer(provider);
    const untrusted = posts.filter((message) => (message as { body: { type: string } }).body.type === "chunk").at(-1) as { body: { generation: number; rows: Array<{ id: string }> } };
    receive.current({ version: 1, session, revision: (provider as unknown as { revision: number }).revision, surface: "traceability", body: { type: "action", generation: untrusted.body.generation, id: untrusted.body.rows[0]!.id, action: "manage-trust", selection: [] } });
    await Promise.resolve();
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      "playwrightBddRunner.traceability.connect",
      "playwrightBddRunner.traceability.hidePanel",
      "workbench.trust.manage",
    ]);
    expect(execute.mock.calls.every((call) => call.length === 1)).toBe(true);
    execute.mockRestore();
  });

  it("contains one command rejection and leaves the current projection usable", async () => {
    const posts: unknown[] = [];
    const receive = { current: (_message: unknown) => undefined };
    const logger = Logger.create();
    const warning = vi.spyOn(logger, "warn");
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const provider = new TraceabilityViewProvider(vscode.Uri.joinPath(vscode.Uri.file("/"), "dist"), logger);
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: () => ({ dispose: () => undefined }) } as unknown as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);
    provider.resolveWebviewView(view(posts, receive));
    const session = (provider as unknown as { session: string }).session;
    receive.current({ version: 1, session, revision: 0, surface: "traceability", body: { type: "ready" } });
    await settleTransfer(provider);
    const chunk = posts.find((message) => (message as { body: { type: string } }).body.type === "chunk") as { body: { generation: number; rows: Array<{ id: string }> } };
    const target = chunk.body.rows.find((candidate) => candidate.id.includes("scenario")) ?? chunk.body.rows[0]!;
    const revision = (provider as unknown as { revision: number }).revision;
    const action = { version: 1, session, revision, surface: "traceability", body: { type: "action", generation: chunk.body.generation, id: target.id, action: "open", selection: [] } };
    receive.current(action);
    await Promise.resolve();
    receive.current(action);
    await Promise.resolve();
    expect(warning).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockRestore();
    warning.mockRestore();
  });
});
