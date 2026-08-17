/// <reference path="../../webview/client/globals.d.ts" />

import { build } from "esbuild";
import axe from "axe-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { FeatureParser } from "../../parsers/feature-parser";
import { buildBoardViewModel } from "../../traceability/board-data";
import type { TraceabilityAdapter } from "../../traceability/contracts";
import { RunResultStore } from "../../traceability/run-result-store";
import { renderTraceabilityViewDocument } from "../../traceability/traceability-view-document";
import { projectTraceabilityTree } from "../../traceability/traceability-tree-projection";
import { TraceabilityModel, type TraceabilitySnapshot } from "../../traceability/traceability-model";
import { TraceabilityViewProvider } from "../../traceability/traceability-view-provider";
import { Logger } from "../../utils/logger";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { TRACEABILITY_VIEW_PROTOCOL_VERSION, type TraceabilityHostBody, type TraceabilityWireRow } from "../../webview/traceability-view-protocol";

const OPEN = { id: "open", label: "Open", icon: "go-to-file" } as const;
const OPEN_REMOTE = { id: "open", label: "Open in tracker", icon: "link-external" } as const;
const COPY = { id: "copy", label: "Copy", icon: "copy" } as const;

let bundle: Promise<string> | undefined;
function clientCode(): Promise<string> {
  bundle ??= build({ entryPoints: ["src/webview/traceability-view.ts"], bundle: true, platform: "browser", format: "iife", outfile: "dist/traceability-view.js" })
    .then(() => readFile("dist/traceability-view.js", "utf8"));
  return bundle;
}

async function rig(restored?: unknown): Promise<{ dom: JSDOM; messages: unknown[]; states: unknown[]; send(body: TraceabilityHostBody, revision?: number): void }> {
  const webview = { cspSource: "https://traceability.test", asWebviewUri: (uri: vscode.Uri) => uri } as vscode.Webview;
  const html = renderTraceabilityViewDocument(webview, vscode.Uri.file("/dist"), "local").replace(/<script[^>]*src="[^"]*"><\/script>/, "");
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "outside-only", url: "https://traceability.test" });
  Object.defineProperty(dom.window, "TextEncoder", { value: TextEncoder });
  const messages: unknown[] = [];
  const states: unknown[] = [];
  Object.defineProperty(dom.window, "acquireVsCodeApi", { value: () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => restored, setState: (state: unknown) => states.push(state) }) });
  dom.window.eval(await clientCode());
  if (messages.length !== 1) {
    throw new Error(`Traceability client did not initialize: ${html}`);
  }
  const clientSession = (messages[0] as { session?: unknown }).session;
  if (typeof clientSession !== "string") {
    throw new Error("Traceability client did not provide a session.");
  }
  let revision = 0;
  return {
    dom,
    messages,
    states,
    send: (body, nextRevision) => {
      revision = nextRevision ?? revision + 1;
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { version: TRACEABILITY_VIEW_PROTOCOL_VERSION, session: clientSession, revision, surface: "traceability", body } }));
    },
  };
}

async function mountProviderClient(
  provider: TraceabilityViewProvider,
  accept: (message: unknown) => Promise<boolean> = () => Promise.resolve(true)
): Promise<{ dom: JSDOM; setVisible(visible: boolean): void }> {
  let source = "";
  let receive = (_message: unknown): void => undefined;
  let post = (_message: unknown): void => undefined;
  let visible = true;
  const visibility = new vscode.EventEmitter<void>();
  const webview = {
    options: undefined,
    cspSource: "https://traceability.test",
    asWebviewUri: (uri: vscode.Uri) => uri,
    set html(value: string) { source = value; },
    postMessage: async (message: unknown): Promise<boolean> => {
      const sent = await accept(message);
      if (sent) { setImmediate(() => post(message)); }
      return sent;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receive = listener;
      return { dispose: () => undefined };
    },
  } as unknown as vscode.Webview;
  provider.resolveWebviewView({
    webview,
    get visible() { return visible; },
    onDidChangeVisibility: visibility.event,
    onDidDispose: () => ({ dispose: () => undefined }),
  } as unknown as vscode.WebviewView);
  const dom = new JSDOM(source.replace(/<script[^>]*src="[^"]*"><\/script>/, ""), { pretendToBeVisual: true, runScripts: "outside-only", url: "https://traceability.test" });
  Object.defineProperty(dom.window, "TextEncoder", { value: TextEncoder });
  Object.defineProperty(dom.window, "acquireVsCodeApi", { value: () => ({ postMessage: receive, getState: () => undefined, setState: () => undefined }) });
  post = (message) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
  dom.window.eval(await clientCode());
  return {
    dom,
    setVisible: (next) => {
      visible = next;
      visibility.fire();
    },
  };
}

function focusCommittedGeneration(provider: TraceabilityViewProvider): Promise<void> {
  const acknowledged = provider.acknowledgedFocusCount;
  return new Promise((resolve) => {
    const subscription = provider.onDidReceiveClientSignal((signal) => {
      if (signal === "focused" && provider.acknowledgedFocusCount > acknowledged) {
        subscription.dispose();
        resolve();
      }
    });
    provider.focusFilter();
  });
}

describe("traceability view client", () => {
  it("renders the same Xray-tagged feature mapping as Coverage Board and recovers it after a failed visible transfer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "traceability-view-client-"));
    const feature = path.join(root, "calculator.feature");
    const logger = Logger.create();
    const adapter: TraceabilityAdapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^[A-Z]+-\d+$/, canonicalizeKey: (key) => key.toUpperCase() },
      browseUrl: () => undefined,
    };
    const discovery = {
      discoverTestFiles: () => Promise.resolve([feature]),
      dispose: () => undefined,
    } as unknown as TestDiscoveryManager;
    const model = new TraceabilityModel(
      FeatureParser.create(logger), discovery, PlaywrightJsonParser.create(logger), adapter, new RunResultStore(), logger
    );
    const writeFeature = (key: string, name: string): void => fs.writeFileSync(feature, `Feature: Calculator\n\n@TEST_${key}\nScenario: ${name}\n  Given a calculator\n`, "utf8");
    try {
      writeFeature("CALC-41", "Initial Xray calculation");
      await model.rebuild();

      let dropNextPopulatedChunk = false;
      let droppedChunk = (): void => undefined;
      const dropped = new Promise<void>((resolve) => { droppedChunk = resolve; });
      const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), logger);
      provider.attach(model, "Xray", "test");
      provider.setConnected(true);
      const client = await mountProviderClient(provider, (message) => {
        const body = (message as { body: { type: string; total?: number } }).body;
        if (dropNextPopulatedChunk && body.type === "chunk") {
          dropNextPopulatedChunk = false;
          droppedChunk();
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      });
      await focusCommittedGeneration(provider);
      const board = (): ReturnType<typeof buildBoardViewModel> => buildBoardViewModel(model.snapshot, [root], "TEST_", false);
      expect(board().mapped).toEqual(expect.arrayContaining([expect.objectContaining({ key: "CALC-41", links: [expect.objectContaining({ name: "Initial Xray calculation" })] })]));
      const filter = client.dom.window.document.getElementById("filter") as HTMLInputElement;
      filter.value = "initial xray";
      filter.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("Initial Xray calculation");
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("CALC-41");

      dropNextPopulatedChunk = true;
      writeFeature("CALC-42", "Dropped Xray calculation");
      await model.rebuild();
      await dropped;
      expect(board().mapped).toEqual(expect.arrayContaining([expect.objectContaining({ key: "CALC-42", links: [expect.objectContaining({ name: "Dropped Xray calculation" })] })]));

      writeFeature("CALC-43", "Recovered Xray calculation");
      await model.rebuild();
      await focusCommittedGeneration(provider);
      filter.value = "recovered xray";
      filter.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      expect(board().mapped).toEqual(expect.arrayContaining([expect.objectContaining({ key: "CALC-43", links: [expect.objectContaining({ name: "Recovered Xray calculation" })] })]));
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("Recovered Xray calculation");
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("CALC-43");
      expect(client.dom.window.document.getElementById("tree")?.hasAttribute("aria-busy")).toBe(false);
      expect(client.dom.window.document.getElementById("tree")?.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      model.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits populated provider projections on initial reveal, rebuild, and re-reveal", async () => {
    const changes = new vscode.EventEmitter<void>();
    let snapshot: TraceabilitySnapshot = {
      links: [{
        testKey: "CALC-1",
        scenario: { filePath: "/workspace/calculator.feature", line: 1, name: "Mapped calculation", kind: "scenario" },
        reqKeys: [],
      }],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: [],
      errors: [],
    };
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: changes.event } as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);

    const initial = await mountProviderClient(provider);
    await focusCommittedGeneration(provider);
    const initialFilter = initial.dom.window.document.getElementById("filter") as HTMLInputElement;
    initialFilter.value = "mapped calculation";
    initialFilter.dispatchEvent(new initial.dom.window.Event("input", { bubbles: true }));
    expect(initial.dom.window.document.getElementById("tree")?.textContent).toContain("Mapped calculation");

    initial.setVisible(false);
    snapshot = {
      ...snapshot,
      links: [{ ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, name: "Rebuilt calculation" } }],
    };
    changes.fire();
    initial.setVisible(true);
    await focusCommittedGeneration(provider);
    initialFilter.value = "rebuilt calculation";
    initialFilter.dispatchEvent(new initial.dom.window.Event("input", { bubbles: true }));
    expect(initial.dom.window.document.getElementById("tree")?.textContent).toContain("Rebuilt calculation");
  });

  it("commits populated projected rows and filters them", async () => {
    const snapshot: TraceabilitySnapshot = {
      links: [{
        testKey: "CALC-1",
        scenario: { filePath: "/workspace/calculator.feature", line: 1, name: "Mapped calculation", kind: "scenario" },
        reqKeys: [],
      }],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: [],
      errors: [],
    };
    const projection = projectTraceabilityTree(
      { get snapshot(): TraceabilitySnapshot { return snapshot; } } as TraceabilityModel,
      "Xray",
      "test",
      true,
      undefined,
      true
    );
    expect(projection.rows.find((row) => row.label === "Mapped calculation")?.description).toBeUndefined();

    const view = await rig();
    view.send({ type: "begin", generation: 1, state: projection.state, total: projection.rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: projection.rows as readonly TraceabilityWireRow[] });
    view.send({ type: "end", generation: 1 });

    expect(view.dom.window.document.querySelector("[role=treeitem]")?.textContent).toContain("Untraced scenarios");
    const filter = view.dom.window.document.getElementById("filter") as HTMLInputElement;
    filter.value = "mapped calculation";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    expect(view.dom.window.document.getElementById("tree")?.textContent).toContain("Mapped calculation");
  });

  it("keeps a chunked generation non-actionable until its exact end", async () => {
    const view = await rig();
    view.send({ type: "begin", generation: 1, state: "ready", total: 2 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [{ id: "root", label: "Mapped", icon: "folder", expandable: true, actions: [] }] });
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]")).toHaveLength(0);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-busy")).toBe("true");
    view.send({ type: "chunk", generation: 1, offset: 1, rows: [{ id: "child", parentId: "root", label: "Scenario", icon: "circle-outline", expandable: false, actions: [OPEN] }] });
    view.send({ type: "end", generation: 1 });
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]").length).toBeGreaterThan(0);
    expect(view.dom.window.document.getElementById("tree")?.hasAttribute("aria-busy")).toBe(false);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("acknowledges host filter focus only for the committed generation", async () => {
    const view = await rig();
    view.send({ type: "begin", generation: 1, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [{ id: "row", label: "Row", icon: "info", expandable: false, actions: [] }] });
    view.send({ type: "end", generation: 1 });
    view.send({ type: "focus-filter", generation: 1 });
    expect(view.dom.window.document.activeElement?.id).toBe("filter");
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "focused", generation: 1 } });
  });

  it("virtualizes a large committed tree and retains matching ancestors when filtered", async () => {
    const view = await rig();
    Object.defineProperty(view.dom.window.document.getElementById("tree"), "clientHeight", { configurable: true, value: 84 });
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      id: index === 0 ? "root" : `row-${index}`,
      ...(index === 0 ? {} : { parentId: "root" }),
      label: index === 0 ? "Root" : `Scenario ${index}`,
      icon: "circle",
      expandable: index === 0,
      actions: [],
    }));
    view.send({ type: "begin", generation: 2, state: "ready", total: rows.length });
    for (let offset = 0; offset < rows.length; offset += 256) {
      view.send({ type: "chunk", generation: 2, offset, rows: rows.slice(offset, offset + 256) });
    }
    view.send({ type: "end", generation: 2 });
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]").length).toBeLessThan(32);
    expect(view.states.at(-1)).toMatchObject({ expanded: [], collapsedRoots: [] });
    const tree = view.dom.window.document.getElementById("tree") as HTMLElement;
    tree.scrollTop = 9_000 * 28;
    tree.dispatchEvent(new view.dom.window.Event("scroll"));
    const deep = view.dom.window.document.querySelector("[data-id=row-9000]");
    expect(deep).not.toBeNull();
    expect(deep?.getAttribute("aria-posinset")).toBe("9000");
    expect(deep?.getAttribute("aria-setsize")).toBe("10000");
    const filter = view.dom.window.document.getElementById("filter") as HTMLInputElement;
    filter.value = "Scenario 10000";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    expect(view.dom.window.document.getElementById("tree")?.textContent).toContain("Root");
    expect(view.dom.window.document.getElementById("tree")?.textContent).toContain("Scenario 10000");
    filter.value = "no matching traceability row";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]")).toHaveLength(0);
    filter.value = "";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 168 });
    view.dom.window.dispatchEvent(new view.dom.window.Event("resize"));
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]").length).toBeLessThan(40);
  });

  it("activates a row default action on primary click without activating multi-selection", async () => {
    const view = await rig();
    const rows = [{ id: "scenario", label: "Scenario", icon: "circle-outline", expandable: false, actions: [COPY, OPEN], defaultAction: "open" }];
    view.send({ type: "begin", generation: 1, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const row = view.dom.window.document.querySelector<HTMLElement>("[data-id=scenario]")!;
    expect(row.querySelector(".codicon[data-icon=circle-outline]")).not.toBeNull();
    expect(row.querySelector<HTMLButtonElement>(".actions button")?.title).toBe("Copy");
    expect(row.querySelector(".actions button .codicon")).not.toBeNull();
    row.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true }));
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", id: "scenario", action: "open" } });
    const messages = view.messages.length;
    row.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(view.messages).toHaveLength(messages);
  });

  it("restores primary activation only for rows that had a native TreeItem command", async () => {
    const view = await rig();
    const rows: readonly TraceabilityWireRow[] = [
      { id: "connection", label: "Xray Cloud", icon: "cloud", expandable: false, actions: [{ id: "connect", label: "Set up connection", icon: "plug" }], defaultAction: "connect" },
      { id: "scenario", label: "Mapped scenario", icon: "circle-outline", expandable: false, actions: [OPEN], defaultAction: "open" },
      { id: "untraced", label: "Untraced scenario", icon: "circle-large-outline", expandable: false, actions: [OPEN], defaultAction: "open" },
      { id: "orphan", label: "CALC-9", icon: "beaker", expandable: false, actions: [OPEN_REMOTE], defaultAction: "open" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    for (const row of rows) {
      view.dom.window.document.querySelector<HTMLElement>(`[data-id="${row.id}"]`)?.click();
    }
    expect(view.messages.slice(1).map((message) => (message as { body: { action: string } }).body.action)).toEqual(["connect", "open", "open", "open"]);
  });

  it("defaults returning and new roots while preserving an explicit collapse across grouping changes", async () => {
    const view = await rig();
    const send = (generation: number, rows: readonly TraceabilityWireRow[]): void => {
      view.send({ type: "begin", generation, state: "ready", total: rows.length });
      view.send({ type: "chunk", generation, offset: 0, rows });
      view.send({ type: "end", generation });
    };
    const testRows: readonly TraceabilityWireRow[] = [{ id: "test-root", label: "Mapped tests", icon: "folder", expandable: true, actions: [] }, { id: "test-child", parentId: "test-root", label: "Test child", icon: "circle-outline", expandable: false, actions: [] }];
    send(1, testRows);
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).not.toBeNull();
    send(2, [{ id: "file-root", label: "feature.feature", icon: "file", expandable: true, actions: [] }, { id: "file-child", parentId: "file-root", label: "File child", icon: "circle-outline", expandable: false, actions: [] }]);
    expect(view.dom.window.document.querySelector("[data-id=file-child]")).not.toBeNull();
    send(3, testRows);
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).not.toBeNull();
    (view.dom.window.document.querySelector<HTMLButtonElement>("[data-id=test-root] button")!).click();
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).toBeNull();
    send(4, [{ id: "file-root", label: "feature.feature", icon: "file", expandable: true, actions: [] }]);
    send(5, testRows);
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).toBeNull();
    send(6, [...testRows, { id: "new-root", label: "New section", icon: "folder", expandable: true, actions: [] }, { id: "new-child", parentId: "new-root", label: "New child", icon: "circle-outline", expandable: false, actions: [] }]);
    expect(view.dom.window.document.querySelector("[data-id=new-child]")).not.toBeNull();
  });

  it("rejects skipped and mixed transfers without making stale rows actionable, then recovers on a later begin", async () => {
    const view = await rig();
    const row = { id: "scenario", label: "Scenario", icon: "circle-outline", expandable: false, actions: [OPEN], defaultAction: "open" };
    view.send({ type: "begin", generation: 1, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [row] });
    view.send({ type: "end", generation: 1 });
    const readyMessages = view.messages.length;
    view.send({ type: "begin", generation: 2, state: "ready", total: 1 });
    const item = view.dom.window.document.querySelector<HTMLElement>("[role=treeitem]")!;
    item.dispatchEvent(new view.dom.window.MouseEvent("dblclick", { bubbles: true }));
    item.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages).toHaveLength(readyMessages);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-disabled")).toBe("true");
    view.send({ type: "chunk", generation: 3, offset: 0, rows: [row] });
    view.send({ type: "end", generation: 2 });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-busy")).toBe("true");
    view.send({ type: "chunk", generation: 2, offset: 0, rows: [row] }, 99);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-busy")).toBe("true");
    view.send({ type: "begin", generation: 3, state: "ready", total: 1 }, 7);
    view.send({ type: "chunk", generation: 3, offset: 0, rows: [row] });
    view.send({ type: "end", generation: 3 });
    expect(view.dom.window.document.getElementById("tree")?.hasAttribute("aria-busy")).toBe(false);
    view.dom.window.document.querySelector<HTMLElement>("[role=treeitem]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages).toHaveLength(readyMessages + 1);
  });

  it("keeps a persisted root collapse and uses defaultAction", async () => {
    const view = await rig({ expanded: [], collapsedRoots: ["root"], selected: [] });
    const rows = [
      { id: "root", label: "Root", icon: "folder", expandable: true, actions: [] },
      { id: "child", parentId: "root", label: "Child", icon: "circle-outline", expandable: false, actions: [COPY, OPEN], defaultAction: "open" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    expect(view.dom.window.document.querySelector("[data-id=child]")).toBeNull();
    const root = view.dom.window.document.querySelector<HTMLElement>("[data-id=root]")!;
    const right = new view.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    root.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    const child = view.dom.window.document.querySelector<HTMLElement>("[data-id=child]")!;
    child.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", action: "open", id: "child" } });
  });

  it("maintains one roving row and focuses an offscreen keyboard target", async () => {
    const view = await rig();
    Object.defineProperty(view.dom.window.document.getElementById("tree"), "clientHeight", { configurable: true, value: 84 });
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}`, icon: "circle", expandable: false, actions: [] }));
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const first = view.dom.window.document.querySelector<HTMLElement>("[data-id=row-0]")!;
    expect(view.dom.window.document.querySelectorAll("[role=treeitem][tabindex=\"0\"]")).toHaveLength(1);
    expect(first.getAttribute("aria-level")).toBe("1");
    first.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    expect(view.dom.window.document.activeElement?.getAttribute("data-id")).toBe("row-3");
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-3]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(view.dom.window.document.querySelector("[data-id=row-39]")).not.toBeNull();
    expect(view.dom.window.document.activeElement?.getAttribute("data-id")).toBe("row-39");
  });

  it("keeps one range anchor across repeated Shift movement and preserves selection on Ctrl movement", async () => {
    const view = await rig();
    Object.defineProperty(view.dom.window.document.getElementById("tree"), "clientHeight", { configurable: true, value: 140 });
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}`, icon: "circle-outline", expandable: false, actions: [] }));
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-0]")?.click();
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-0]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-1]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    expect([...view.dom.window.document.querySelectorAll("[aria-selected=true]")].map((item) => item.getAttribute("data-id"))).toEqual(["row-0", "row-1", "row-2"]);
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-2]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true }));
    expect(view.dom.window.document.activeElement?.getAttribute("data-id")).toBe("row-3");
    expect([...view.dom.window.document.querySelectorAll("[aria-selected=true]")].map((item) => item.getAttribute("data-id"))).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("does not let twisty or inline action key events trigger their row handlers", async () => {
    const view = await rig();
    const rows = [
      { id: "root", label: "Root", icon: "folder", expandable: true, actions: [] },
      { id: "child", parentId: "root", label: "Child", icon: "circle-outline", expandable: false, actions: [COPY], defaultAction: "copy" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const twisty = view.dom.window.document.querySelector<HTMLButtonElement>("[data-id=root] button")!;
    twisty.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.dom.window.document.querySelector("[data-id=child]")).not.toBeNull();
    const action = view.dom.window.document.querySelector<HTMLButtonElement>("[data-id=child] .actions button")!;
    action.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages).toHaveLength(1);
  });

  it("caps multi-selection at 256 rows and announces the limit", async () => {
    const view = await rig();
    const rows = Array.from({ length: 257 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}`, icon: "circle", expandable: false, actions: [] }));
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    for (let offset = 0; offset < rows.length; offset += 256) {
      view.send({ type: "chunk", generation: 1, offset, rows: rows.slice(offset, offset + 256) });
    }
    view.send({ type: "end", generation: 1 });
    const tree = view.dom.window.document.getElementById("tree") as HTMLElement;
    for (let index = 0; index < rows.length; index += 1) {
      tree.scrollTop = index * 28;
      tree.dispatchEvent(new view.dom.window.Event("scroll"));
      const item = view.dom.window.document.querySelector<HTMLElement>(`[data-id="row-${index}"]`)!;
      item.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    }
    expect(view.dom.window.document.getElementById("status")?.textContent).toBe("Selection is limited to 256 rows.");
  });

  it("has no serious or critical accessibility violations after a bundled render", async () => {
    const view = await rig();
    const rows = [
      { id: "root", label: "Mapped", icon: "folder", tone: "info" as const, expandable: true, actions: [] },
      { id: "child", parentId: "root", label: "Scenario", icon: "pass", tone: "success" as const, expandable: false, actions: [OPEN], defaultAction: "open" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const result = await axe.run(view.dom.window.document.documentElement, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  });

  it("renders host-authorized disconnected, untrusted, and empty state affordances", async () => {
    const view = await rig({ filter: "x".repeat(5_000), expanded: ["stale"] });
    const disconnected = { id: "state-disconnected", label: "Set up Xray", description: "Set up Xray integration to map scenarios and publish results.", tooltip: "Set up", icon: "plug", tone: "info" as const, expandable: false, actions: [{ id: "connect", label: "Set up connection", icon: "plug" }, { id: "hide", label: "Hide Traceability", icon: "eye-closed" }], defaultAction: "connect" };
    view.send({ type: "begin", generation: 1, state: "disconnected", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [disconnected] });
    view.send({ type: "end", generation: 1 });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("role")).toBe("region");
    expect(view.dom.window.document.querySelector(".state-title")?.textContent).toBe("Set up Xray");
    const filter = view.dom.window.document.getElementById("filter") as HTMLInputElement;
    expect(filter.maxLength).toBe(4_096);
    expect(filter.value).toHaveLength(4_096);
    expect(view.states.at(-1)).toMatchObject({ expanded: ["stale"] });
    (view.dom.window.document.querySelector(".state-actions button") as HTMLButtonElement).click();
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", action: "connect", id: "state-disconnected" } });
    const result = await axe.run(view.dom.window.document.documentElement, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);

    const untrusted = { id: "state-untrusted", label: "Workspace trust required", description: "Traceability stays offline while this workspace is untrusted.", tooltip: "Trust", icon: "shield", tone: "warning" as const, expandable: false, actions: [{ id: "manage-trust", label: "Manage workspace trust", icon: "shield" }], defaultAction: "manage-trust" };
    view.send({ type: "begin", generation: 2, state: "untrusted", total: 1 });
    view.send({ type: "chunk", generation: 2, offset: 0, rows: [untrusted] });
    view.send({ type: "end", generation: 2 });
    (view.dom.window.document.querySelector(".state-actions button") as HTMLButtonElement).click();
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", action: "manage-trust", id: "state-untrusted" } });

    const empty = { id: "state-empty", label: "No Xray-tagged scenarios found yet.", description: "Add @TEST_KEY tags to scenarios. Local mappings update automatically.", tooltip: "Add tags", icon: "info", tone: "muted" as const, expandable: false, actions: [] };
    view.send({ type: "begin", generation: 3, state: "empty", total: 1 });
    view.send({ type: "chunk", generation: 3, offset: 0, rows: [empty] });
    view.send({ type: "end", generation: 3 });
    expect(view.dom.window.document.querySelector(".state-title")?.textContent).toBe("No Xray-tagged scenarios found yet.");
    expect(view.dom.window.document.querySelector(".state-actions")).toBeNull();
    expect(view.dom.window.document.getElementById("tree")?.tabIndex).toBe(0);

    const ready = { id: "ready", label: "Ready", icon: "info", expandable: false, actions: [] };
    view.send({ type: "begin", generation: 4, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 4, offset: 0, rows: [ready] });
    view.send({ type: "end", generation: 4 });
    expect(view.states.at(-1)).toMatchObject({ expanded: [] });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-multiselectable")).toBe("true");

    view.send({ type: "begin", generation: 5, state: "disconnected", total: 1 });
    view.send({ type: "chunk", generation: 5, offset: 0, rows: [disconnected] });
    view.send({ type: "end", generation: 5 });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("role")).toBe("region");
    expect(view.dom.window.document.getElementById("tree")?.hasAttribute("aria-multiselectable")).toBe(false);
  });
});
