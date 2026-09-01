import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { CommandManager } from "../../commands/command-manager";
import { TraceabilityCommands } from "../../commands/traceability-commands";
import { TraceabilityLinkCommands } from "../../commands/traceability-link-commands";
import { Logger } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import { ExternalRef, SyncProgress, SyncScope, TraceabilityAdapter } from "../../traceability/contracts";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { NO_MAPPING_PAGE_SIZE } from "../../traceability/mapping-page-size";
import { NO_PROJECT_SCOPE, ProjectScopeStore, projectScopeStore } from "../../traceability/project-scope";
import { BoardViewModel, scenarioDropId } from "../../traceability/board-data";
import type { TraceabilitySnapshot } from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import { applyWsEdit, EditEntry } from "./helpers/workspace-edit";
import { captureHandlers, fakeDoc, makeContext, memento } from "./helpers/command-manager-harness";
import { trustedWorkspace } from "./helpers/test-workspace-trust";



// The webview-panel stub the board opens onto: `__posted` records what the host sent, `__receive`
// delivers an inbound message, and the reset disposes every panel between tests.
interface StubBoardPanel {
  title: string;
  webview: {
    html: string;
    __posted: Array<{ session: string; revision: number; surface: string; body: { type: string; [key: string]: unknown } }>;
  };
  __revealCount: number;
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}
const win = vscode.window as unknown as {
  __webviewPanels: StubBoardPanel[];
  __resetWebviewPanels: () => void;
};

function traceabilityCommands(manager: CommandManager): TraceabilityCommands {
  return (manager as unknown as { traceabilityCommands: TraceabilityCommands })
    .traceabilityCommands;
}

function linkCommands(manager: CommandManager): TraceabilityLinkCommands {
  return (
    traceabilityCommands(manager) as unknown as {
      getLinkCommands: () => TraceabilityLinkCommands;
    }
  ).getLinkCommands();
}


function traceabilityBoardDeps(manager: CommandManager): BoardPanelDeps {
  return (
    traceabilityCommands(manager) as unknown as {
      boardDeps: () => BoardPanelDeps;
    }
  ).boardDeps();
}

function boardPosts(panel: StubBoardPanel): Array<{ surface: string; type: string; [key: string]: unknown }> {
  return panel.webview.__posted.map((message) => ({ surface: message.surface, ...message.body }));
}

function receiveBoard(
  panel: StubBoardPanel,
  surface: string,
  body: { type: string; [key: string]: unknown }
): Promise<void> {
  const session = panel.webview.html.match(/data-session="([^"]+)"/)?.[1] ?? "";
  const revision = body.type === "ready" ? 0 : (panel.webview.__posted.at(-1)?.revision ?? 0);
  return panel.__receive({ version: 1, session, revision, surface, body });
}

interface EnvHooks {
  __openExternalCalls: string[];
  __clipboardText: string;
  __resetEnv: () => void;
}

const envHooks = (vscode as unknown as { env: EnvHooks }).env;

function stubAdapter(resolve: (key: string) => string | undefined): TraceabilityAdapter {
  return {
    id: "xray",
    label: "Xray",
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^[A-Z]+-\d+$/,
      canonicalizeKey: (key) => key.toUpperCase(),
    },
    browseUrl: (ref: ExternalRef) => resolve(ref.key),
  };
}

describe("traceability browse/copy command handlers", () => {
  beforeEach(() => envHooks.__resetEnv());

  async function openIssue(adapter: TraceabilityAdapter, arg: unknown): Promise<void> {
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await handlers.get("playwrightBddRunner.traceability.openIssue")!(arg);
  }

  it("opens the browse URL the adapter resolves for the key", async () => {
    await openIssue(stubAdapter((key) => `https://acme.atlassian.net/browse/${key}`), { testKey: "CALC-1" });
    expect(envHooks.__openExternalCalls).toEqual(["https://acme.atlassian.net/browse/CALC-1"]);
  });

  it("warns and opens nothing when the adapter yields no browse URL", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    await openIssue(stubAdapter(() => undefined), { testKey: "CALC-1" });
    expect(envHooks.__openExternalCalls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  // A card key on the board is the same request as the panel's Open in tracker action, so it must land
  // on the same browse URL rather than a second, board-only path.
  it("opens the same browse URL from a board card's key link", async () => {
    let manager: CommandManager | undefined;
    captureHandlers(
      makeContext({ traceabilityAdapter: stubAdapter((key) => `https://acme.atlassian.net/browse/${key}`) }),
      (created) => { manager = created; }
    );

    traceabilityBoardDeps(manager!).openIssue("CALC-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(envHooks.__openExternalCalls).toEqual(["https://acme.atlassian.net/browse/CALC-1"]);
  });

  it("no-ops when the item carries no issue key", async () => {
    await openIssue(stubAdapter((key) => `https://acme.atlassian.net/browse/${key}`), { notAKey: true });
    expect(envHooks.__openExternalCalls).toEqual([]);
  });

  it("copies the issue key to the clipboard", async () => {
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.copyKey")!({ testKey: "CALC-1" });
    expect(envHooks.__clipboardText).toBe("CALC-1");
  });
});

describe("traceability hidePanel command handler", () => {
  interface Update {
    key: string;
    value: unknown;
    target: vscode.ConfigurationTarget;
  }

  function stubWorkspaceConfig(inspected: Record<string, unknown>): Update[] {
    const updates: Update[] = [];
    const wsConfig = {
      get: (): unknown => undefined,
      inspect: (): Record<string, unknown> => inspected,
      update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
        updates.push({ key, value, target });
        return Promise.resolve();
      },
    } as unknown as vscode.WorkspaceConfiguration;
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
    return updates;
  }

  afterEach(() => vi.restoreAllMocks());

  it("writes traceability.enablePanel=false to Global when it is not workspace-pinned", async () => {
    const updates = stubWorkspaceConfig({});
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.hidePanel")!();
    expect(updates).toEqual([
      { key: "traceability.enablePanel", value: false, target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes it back to the Workspace when the setting is pinned there", async () => {
    const updates = stubWorkspaceConfig({ workspaceValue: true });
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.hidePanel")!();
    expect(updates[0]?.target).toBe(vscode.ConfigurationTarget.Workspace);
  });
});

describe("traceability panel connection UX contributions", () => {
  interface PackageJson {
    contributes: {
      viewsWelcome: Array<{ view: string; when?: string; contents: string }>;
      menus: Record<string, Array<{ command?: string; when?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as PackageJson;

  it("moves traceability welcome states into the webview", () => {
    const welcomes = pkg.contributes.viewsWelcome.filter(
      (w) => w.view === "playwrightBddRunner.traceability"
    );
    expect(welcomes).toEqual([]);
  });

  it("keeps the welcome-only hidePanel command out of the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(
      palette.find((e) => e.command === "playwrightBddRunner.traceability.hidePanel")?.when
    ).toBe("false");
  });

  it("offers a real discovery recovery action in the empty Testing view", () => {
    const welcome = pkg.contributes.viewsWelcome.find(
      (item) => item.view === "workbench.view.testing"
    );
    expect(welcome?.contents).toContain("command:playwrightBddRunner.discoverTests");
  });
});

describe("traceability linkScenario command", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  const untracedNode = {
    kind: "untraced",
    item: { scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" } },
  };

  // The command opens the board and begins a Link session on it; drive a link-tagged confirm on the
  // board panel, then await the handler so the tag-write side effect has run.
  async function confirmLink(pending: Promise<void>, id: string): Promise<void> {
    const panel = win.__webviewPanels.at(-1)!;
    if (panel.webview.__posted.length === 0) {
      await receiveBoard(panel, "shell", { type: "ready" });
    }
    await receiveBoard(panel, "link", { type: "search", value: id });
    const rows = boardPosts(panel).filter((message) => message.surface === "link" && message.type === "rows").at(-1)?.["rows"];
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    const current = (BoardPanel as unknown as { current?: { revision: number } }).current;
    expect(panel.webview.__posted.at(-1)?.revision).toBe(current?.revision);
    await receiveBoard(panel, "link", { type: "confirm", id });
    await pending;
  }

  async function syncedAdapter(): Promise<InMemoryTraceabilityAdapter> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "5", summary: "Five" }], []);
    await adapter.metadata.sync({ testKeys: ["5"] });
    return adapter;
  }

  it("prompts to connect/sync when the active adapter exposes no metadata capability", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);
    expect(String(info.mock.calls[0]?.[0])).toContain("Sync");
  });

  it("no-ops with guidance when invoked from the palette without a scenario row", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!();
    expect(String(info.mock.calls[0]?.[0])).toContain("Traceability view");
  });

  it("informs the user when the snapshot has no synced tests instead of showing a blank picker", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: new InMemoryTraceabilityAdapter() }));
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);
    expect(String(info.mock.calls[0]?.[0])).toContain("No synced tests");
  });

  it("inserts the grammar-built test tag above the untraced scenario via a WorkspaceEdit", async () => {
    const adapter = await syncedAdapter();
    const feature = "Feature: F\n\nScenario: A\n  Given x\n";
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => feature,
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });

    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode), "5");

    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "insert", text: "@TC-5\n" });
  });

  it("reports an error rather than a link when the workspace refuses the tag edit", async () => {
    const adapter = await syncedAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode), "5");

    expect(error.mock.calls[0]?.[0]).toBe("Could not link 5: the feature file edit was not applied.");
  });

  it("opens the Coverage Board and reveals the contextual Link tab", async () => {
    const adapter = await syncedAdapter();
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    const pending = handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);

    const board = win.__webviewPanels.at(-1)!;
    expect(board.title).toBe("Coverage Board");
    await receiveBoard(board, "shell", { type: "ready" });
    expect(boardPosts(board).find((m) => m.type === "linkTab" && m["visible"] === true)).toBeDefined();

    await confirmLink(pending, "5");
  });

  it("quietly forces a project sync after a newly created test is tagged", async () => {
    const changed = new vscode.EventEmitter<void>();
    const created = vi.fn(() => Promise.resolve({ key: "CALC-9", warnings: [] }));
    const merged: string[] = [];
    let finishMerge!: () => void;
    const pendingMerge = new Promise<void>((resolve) => {finishMerge = resolve;});
    const adapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: {
        testPrefix: "TEST_",
        reqPrefix: "REQ_",
        keyShape: /^[A-Za-z][A-Za-z0-9_-]*-\d+$/,
        canonicalizeKey: (key: string) => key.toUpperCase(),
        projectOf: (key: string) => key.replace(/-\d+$/, ""),
      },
      browseUrl: () => undefined,
      metadata: {
        onDidChange: changed.event,
        snapshot: () => ({
          tests: new Map(), fetchedScopes: [], catalogueProjects: ["CALC"], completeProjects: ["CALC"],
          verifiedAbsentKeys: [], stale: false, errors: [], syncedAt: 1,
        }),
        sync: () => Promise.resolve(),
      },
      remoteSearch: {
        search: () => Promise.resolve({ tests: [], complete: true }),
        mergeKeys: (keys: readonly string[]) => {merged.push(...keys); return pendingMerge;},
      },
      testAuthoring: { createTest: created },
    } as TraceabilityAdapter;
    const scenario = untracedNode.item.scenario as ScenarioRef;
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(
      fakeDoc("Feature: F\n\nScenario: A\n  Given x\n")
    );
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(true);
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("CALC" as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Create test" as never);

    const manager = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    manager.setTraceabilitySubsystem({
      traceabilityPanelActive: true,
      connected: true,
      getActiveAdapter: () => adapter,
      getSnapshot: () => ({
        links: [], untraced: [{ scenario, reqKeys: [] }], orphans: [], stale: false,
        completeProjects: ["CALC"], errors: [],
      }),
      knownTestKeys: () => [],
      tagDerivedProjectKeys: () => [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: changed.event,
    } as unknown as TraceabilitySubsystem);
    const commands = traceabilityCommands(manager);
    const sync = vi.spyOn(commands, "syncTraceability").mockResolvedValue();

    await confirmLink(commands.linkScenario(untracedNode), " create");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created).toHaveBeenCalledOnce();
    expect(merged).toEqual(["CALC-9"]);
    expect(sync).not.toHaveBeenCalled();

    finishMerge();
    await pendingMerge;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sync).toHaveBeenCalledWith({ announce: false, explicitKey: "CALC", forceProject: true });
    changed.dispose();
  });

  async function reMap(feature: string): Promise<string> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "9", summary: "Nine" }], []);
    await adapter.metadata.sync({ testKeys: ["9"] });
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(fakeDoc(feature));
    const applied: EditEntry[][] = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push((edit as unknown as { __entries: EditEntry[] }).__entries);
      return Promise.resolve(true);
    });
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(
      handlers.get("playwrightBddRunner.traceability.linkScenario")!({
        kind: "link",
        link: { scenario: { filePath: "/ws/a.feature", line: 4, name: "A", kind: "scenario" } },
      }),
      "9"
    );
    expect(applied).toHaveLength(1);
    return applyWsEdit(feature, applied[0]!);
  }

  it("re-maps an already-linked LF document to the picked key, byte-exact", async () => {
    expect(await reMap("Feature: F\n\n@TC-5\nScenario: A\n  Given x\n")).toBe(
      "Feature: F\n\n@TC-9\nScenario: A\n  Given x\n"
    );
  });

  it("re-maps an already-linked CRLF document without a doubled carriage return", async () => {
    const out = await reMap("Feature: F\r\n\r\n@TC-5\r\nScenario: A\r\n  Given x\r\n");
    expect(out).toBe("Feature: F\r\n\r\n@TC-9\r\nScenario: A\r\n  Given x\r\n");
    expect(out).not.toContain("\r\r");
  });
});

describe("traceability linkScenario contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.linkScenario";

  it("declares the command under the Specwright category", () => {
    expect(pkg.contributes.commands.find((c) => c.command === CMD)?.category).toBe("Specwright");
  });

  it("keeps link actions out of native item menus", () => {
    const items = pkg.contributes.menus["view/item/context"]!.filter((e) => e.command === CMD);
    expect(items).toEqual([]);
  });

  it("hides the node action from the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    const entries = palette.filter((entry) => entry.command === CMD);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.when).toBe("false");
  });
});

describe("traceability sync command handler", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  it("guides the user when no metadata capability is active", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.sync")!();
    expect(String(info.mock.calls[0]?.[0])).toContain("Connect");
  });

  // A subsystem whose adapter derives projects from its keys, with every seam the sync scope reads:
  // the tag-derived keys, the catalogue the last sync left, the provider directory, and the board's
  // stored project selection. Its sync commits like the real one (a fresh `syncedAt` per run) unless
  // `commits: false` reproduces a run that discarded its pages and left the snapshot untouched.
  function syncSubsystem(over: {
    sync?: (scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress) => Promise<void>;
    snapshotErrors?: string[];
    tests?: Map<string, unknown>;
    catalogueProjects?: string[];
    tagDerived?: string[];
    testKeys?: string[];
    directory?: string[];
    scope?: ProjectScopeStore;
    completeProjects?: string[];
    commits?: boolean;
    connected?: boolean;
  } = {}): TraceabilitySubsystem {
    const run = over.sync ?? ((): Promise<void> => Promise.resolve());
    let syncedAt: number | undefined;
    const adapter = {
      keyGrammar: { testPrefix: "TEST_", projectOf: (k: string) => k.split("-")[0] },
      metadata: {
        sync: async (scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress): Promise<void> => {
          await run(scope, signal, onProgress);
          if (over.commits !== false) {
            syncedAt = (syncedAt ?? 0) + 1;
          }
        },
        snapshot: () => ({
          tests: over.tests ?? new Map(),
          fetchedScopes: [],
          catalogueProjects: over.catalogueProjects ?? [],
          completeProjects: [],
          verifiedAbsentKeys: [],
          stale: false,
          errors: over.snapshotErrors ?? [],
          syncedAt,
        }),
      },
      ...(over.directory
        ? {
            projectDirectory: {
              cached: () => ({ projects: over.directory!.map((key) => ({ key, name: key })), truncated: false }),
              list: () => Promise.resolve({ projects: [], truncated: false }),
            },
          }
        : {}),
    };
    return {
      traceabilityPanelActive: true,
      connected: over.connected ?? true,
      getSnapshot: () => ({
        links: [],
        untraced: [],
        orphans: [],
        stale: false,
        completeProjects: over.completeProjects ?? ["CALC"],
        errors: [],
      }),
      getActiveAdapter: () => adapter,
      knownTestKeys: () => over.testKeys ?? [],
      tagDerivedProjectKeys: () => over.tagDerived ?? [],
      projectScope: () => over.scope ?? NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  function managerFor(
    subsystem: TraceabilitySubsystem,
    settings: Record<string, unknown> = {},
    logger = Logger.create()
  ): CommandManager {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
    } as unknown as vscode.WorkspaceConfiguration;
    const mgr = CommandManager.create(
      makeContext({ config: ExtensionConfig.create(workspaceConfig, false), logger })
    );
    mgr.setTraceabilitySubsystem(subsystem);
    return mgr;
  }

  const runSyncOn = (mgr: CommandManager): Promise<void> =>
    traceabilityCommands(mgr).syncTraceability();

  // The board's two ways into the sync: the Sync button and the quiet per-project load.
  const boardLoads = (mgr: CommandManager): { runSync: () => Promise<void>; autoSync: (key: string) => Promise<void> } =>
    traceabilityBoardDeps(mgr);

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("schedules one quiet direct sync for bounded reindex diagnostics and contains refresh failure", async () => {
    const logger = Logger.create();
    const commands = traceabilityCommands(managerFor(syncSubsystem({ catalogueProjects: ["CALC"] }), {}, logger));
    const sync = vi.spyOn(commands, "syncTraceability").mockImplementation(() => {
      throw new Error("refresh offline");
    });
    const logged = vi.spyOn(logger, "warn");
    const recover = commands as unknown as {
      scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void;
    };

    recover.scheduleProjectSync("CALC", ["ordinary warning", "Project may need re-indexing", "reindexed"]);
    await flush();

    expect(sync).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith({ announce: false, explicitKey: "CALC", forceProject: true });
    expect(logged).toHaveBeenCalledWith(
      "Follow-up traceability sync failed",
      expect.objectContaining({ project: "CALC", error: "refresh offline" })
    );
  });

  it("does not schedule recovery for an ordinary provider warning", async () => {
    const commands = traceabilityCommands(managerFor(syncSubsystem()));
    const sync = vi.spyOn(commands, "syncTraceability").mockResolvedValue();
    (commands as unknown as { scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void })
      .scheduleProjectSync("CALC", ["summary was trimmed"]);

    await flush();

    expect(sync).not.toHaveBeenCalled();
  });

  it("starts a successful create's project sync only after the authoring mutation owner has retired", async () => {
    const commands = traceabilityCommands(managerFor(syncSubsystem({ catalogueProjects: ["CALC"] })));
    const internals = commands as unknown as {
      operations: { mutationActive: boolean };
      scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void;
      getAuthoringCommands(): { bulkCreateTests(): Promise<void> };
    };
    vi.spyOn(internals, "getAuthoringCommands").mockReturnValue({
      bulkCreateTests: async () => {
        internals.scheduleProjectSync("CALC");
      },
    });
    const activeWhenSyncStarts: boolean[] = [];
    const sync = vi.spyOn(commands, "syncTraceability").mockImplementation(() => {
      activeWhenSyncStarts.push(internals.operations.mutationActive);
      return Promise.resolve();
    });

    await commands.bulkCreateTests();
    await flush();

    expect(activeWhenSyncStarts).toEqual([false]);
    expect(sync).toHaveBeenCalledWith({ announce: false, explicitKey: "CALC", forceProject: true });
  });

  it("syncs with the workspace + configured project scope and surfaces snapshot errors as a toast", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    await runSyncOn(managerFor(syncSubsystem({ sync, snapshotErrors: ["boom"], testKeys: ["CALC-1"] })));

    expect(sync).toHaveBeenCalledWith({ testKeys: ["CALC-1"], projectKeys: [] }, expect.anything(), expect.anything());
    expect(errorToast).toHaveBeenCalled();
  });

  it("scopes the sync to the tags and the already-synced catalogue, never the provider directory", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const subsystem = syncSubsystem({
      sync,
      testKeys: ["CALC-1"],
      tagDerived: ["CALC"],
      catalogueProjects: ["MATH"],
      directory: ["OPS"],
    });

    await runSyncOn(managerFor(subsystem));

    expect(sync).toHaveBeenCalledWith(
      { testKeys: ["CALC-1"], projectKeys: ["CALC", "MATH"] },
      expect.anything(),
      expect.anything()
    );
  });

  it("fetches the chosen projects and nothing else once the setting names the scope", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const subsystem = syncSubsystem({
      sync,
      testKeys: ["CALC-1"],
      tagDerived: ["CALC"],
      catalogueProjects: ["MATH"],
      directory: ["OPS"],
    });

    await runSyncOn(managerFor(subsystem, { "xray.syncProjectKeys": ["shop"] }));

    expect(sync).toHaveBeenCalledWith(
      { testKeys: ["CALC-1"], projectKeys: ["SHOP"] },
      expect.anything(),
      expect.anything()
    );
  });

  it("carries the default project key into the sync scope, so a create target is also a sync target", async () => {
    const sync = vi.fn(() => Promise.resolve());

    await runSyncOn(managerFor(syncSubsystem({ sync }), { "xray.defaultProjectKey": " pay " }));

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["PAY"] }, expect.anything(), expect.anything());
  });

  // One rule for every control: the standing scope plus the board's working project, named for that run.
  // The palette's Sync Traceability is not an exception, so a project the board is working in is never
  // reachable from the board and missing from the palette.
  it("unions the board's working project into the palette sync, alongside the standing scope", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    // The board really is working in PAY, so a scope without it cannot be a selection that never landed.
    expect(scope.get(["PAY", "OPS"])).toBe("PAY");

    await runSyncOn(managerFor(syncSubsystem({ sync, directory: ["PAY", "OPS"], scope, catalogueProjects: ["MATH"] })));

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["MATH", "PAY"] }, expect.anything(), expect.anything());
  });

  // A pinned list is the standing scope, and the working project rides alongside it for that run without
  // rewriting it. Both halves matter: dropping either strands one of the two controls.
  it("adds the working project to a pinned sync list for that run", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    const mgr = managerFor(
      syncSubsystem({ sync, directory: ["PAY", "OPS"], scope }),
      { "xray.syncProjectKeys": ["SHOP"] }
    );

    await boardLoads(mgr).runSync();

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["PAY", "SHOP"] }, expect.anything(), expect.anything());
  });

  it("names the working project once when a standing rung already holds it", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("MATH");
    const mgr = managerFor(syncSubsystem({ sync, scope, catalogueProjects: ["MATH"] }));

    await boardLoads(mgr).runSync();

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["MATH"] }, expect.anything(), expect.anything());
  });

  // A directory-only project sits on no rung, so once its quiet load fails the board can only get it
  // through Sync naming it. Without that the selection is stranded and the board never fills.
  it("names the board's working project on Sync, even after its quiet load failed", async () => {
    let failNext = true;
    const sync = vi.fn(() => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("the site is unreachable"));
      }
      return Promise.resolve();
    });
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    const mgr = managerFor(syncSubsystem({ sync, directory: ["PAY", "OPS"], scope }));

    await boardLoads(mgr).autoSync("PAY");
    await boardLoads(mgr).runSync();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith({ testKeys: [], projectKeys: ["PAY"] }, expect.anything(), expect.anything());
  });

  it("coalesces concurrent invocations into a single in-flight run", async () => {
    let resolveSync!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
    const mgr = managerFor(syncSubsystem({ sync }));

    const first = runSyncOn(mgr);
    const second = runSyncOn(mgr);
    resolveSync();
    await Promise.all([first, second]);

    // The second invoke joined the in-flight run rather than starting a second sync.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  // A project picked mid-run cannot be in the running scope, which was resolved before the pick, so it
  // is not allowed to join: it earns exactly one follow-up whose scope covers it.
  it("reruns once for a project picked while a sync is in flight, with the picked key in scope", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((_scope: SyncScope) => new Promise<void>((resolve) => resolvers.push(resolve)));
    const mgr = managerFor(syncSubsystem({ sync }));
    const { autoSync } = boardLoads(mgr);

    const first = runSyncOn(mgr);
    void autoSync("PAY");
    void autoSync("PAY");
    expect(sync).toHaveBeenCalledTimes(1);

    resolvers[0]!();
    await first;
    await flush();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[0]![0]).toEqual({ testKeys: [], projectKeys: [] });
    expect(sync.mock.calls[1]![0]).toEqual({ testKeys: [], projectKeys: ["PAY"] });

    // One slot, so the two picks produced one follow-up and that follow-up queues nothing further.
    resolvers[1]!();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    // Only the run the user asked for spoke; the load it replayed stayed quiet.
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("Synced 0 remote tests.");
  });

  it("preserves every forced project behind an active sync despite later ordinary loads", async () => {
    const scopes: SyncScope[] = [];
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((scope: SyncScope) => {
      scopes.push(scope);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    });
    const mgr = managerFor(syncSubsystem({ sync }));
    const commands = traceabilityCommands(mgr);
    const recover = commands as unknown as {
      scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void;
    };

    const initial = runSyncOn(mgr);
    recover.scheduleProjectSync("CALC", ["CALC needs reindexing"]);
    recover.scheduleProjectSync("PAY", ["PAY needs reindexing"]);
    void boardLoads(mgr).autoSync("CALC");
    void boardLoads(mgr).autoSync("PAY");
    await flush();
    expect(sync).toHaveBeenCalledOnce();

    resolvers[0]!();
    await initial;
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    resolvers[1]!();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(3));
    resolvers[2]!();
    await flush();

    expect(scopes).toEqual([
      { testKeys: [], projectKeys: [] },
      { testKeys: [], projectKeys: ["CALC"] },
      { testKeys: [], projectKeys: ["PAY"] },
    ]);
  });

  // The gates belong to the moment the follow-up runs, not the moment it was queued: the run in flight
  // may well be the one that catalogues the picked project.
  it("re-checks the gates when it replays a queued pick, so nothing is fetched twice", async () => {
    const catalogueProjects: string[] = [];
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((_scope: SyncScope) => new Promise<void>((resolve) => resolvers.push(resolve)));
    const mgr = managerFor(syncSubsystem({ sync, catalogueProjects }));

    const first = runSyncOn(mgr);
    void boardLoads(mgr).autoSync("PAY");
    catalogueProjects.push("PAY");
    resolvers[0]!();
    await first;
    await flush();

    expect(sync).toHaveBeenCalledOnce();
  });

  it("loads a project the catalogue has never held, quietly", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync, tagDerived: ["CALC"] }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["CALC", "PAY"] }, expect.anything(), expect.anything());
    expect(info).not.toHaveBeenCalled();
  });

  // A pinned list is the durable scope, not a cage: the project the board just opened is fetched for
  // this run, and nothing else joins it. Without that rung the load can never catalogue its project,
  // so the board would ask for it again on every repaint.
  it("loads a board's project under a pinned list without widening the pinned scope", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const mgr = managerFor(syncSubsystem({ sync, tagDerived: ["CALC"] }), {
      "xray.syncProjectKeys": ["SHOP"],
    });

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).toHaveBeenCalledWith(
      { testKeys: [], projectKeys: ["PAY", "SHOP"] },
      expect.anything(),
      expect.anything()
    );
  });

  it("loads nothing for a project an earlier sync already catalogued", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const mgr = managerFor(syncSubsystem({ sync, catalogueProjects: ["PAY"] }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).not.toHaveBeenCalled();
  });

  // A quiet load that fails is a log line, not a notification: nobody asked for it, and a stale
  // connection verdict would raise the same red toast on every board open.
  it("logs a quiet load's failure rather than raising a notification", async () => {
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn");
    const mgr = managerFor(syncSubsystem({ snapshotErrors: ["boom"] }), {}, logger);

    await boardLoads(mgr).autoSync("PAY");

    expect(errorToast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("A board load's sync failed", {
      error: "Sync completed with errors: see the output channel for details.",
    });
  });

  it("loads nothing while the tracker is not known to be reachable", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync, connected: false }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("wires the board's Sync button to the serialized sync, so two clicks share one run", async () => {
    let resolveSync!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
    const mgr = managerFor(syncSubsystem({ sync }));
    const { runSync } = boardLoads(mgr);

    const first = runSync();
    const second = runSync();
    resolveSync();
    await Promise.all([first, second]);

    // Rewiring the button to the unserialized command path would start a second, overlapping sync.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("wires the board's Select projects button to the same project picker the palette opens", async () => {
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const mgr = managerFor(syncSubsystem({ tagDerived: ["CALC"] }));

    traceabilityBoardDeps(mgr).selectSyncProjects();
    await flush();

    expect(quickPick).toHaveBeenCalledWith(
      [expect.objectContaining({ label: "CALC" })],
      expect.objectContaining({ title: "Select Projects to Sync", canPickMany: true })
    );
  });

  it("reports a finished sync as an information toast, zero tests included", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await runSyncOn(managerFor(syncSubsystem()));

    expect(info).toHaveBeenCalledWith("Synced 0 remote tests.");
  });

  it("reports a cancelled sync as information rather than an error", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    // A token that is already cancelled aborts the run's signal the moment the task subscribes.
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_opts, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        { isCancellationRequested: true, onCancellationRequested: (cb: () => void) => { cb(); return { dispose: () => {} }; } }
      )
    );

    await runSyncOn(managerFor(syncSubsystem()));

    expect(info).toHaveBeenCalledWith("Sync cancelled.");
    expect(errorToast).not.toHaveBeenCalled();
  });

  // The strip's whole lifecycle: the pages it counts, the handover to the repaint, and the clear that
  // keeps a failed run from stranding it.
  async function openBoardFor(mgr: CommandManager): Promise<StubBoardPanel> {
    traceabilityCommands(mgr).openBoard();
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });
    return panel;
  }

  const strips = (panel: StubBoardPanel): Array<string | undefined> =>
    boardPosts(panel).filter((m) => m.type === "syncProgress").map((m) => m["text"] as string | undefined);

  const reportingSync = (): ((scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress) => Promise<void>) =>
    (_scope, _signal, onProgress) => {
      onProgress?.({ projectKey: "PAY", fetched: 100, total: 350 });
      return Promise.resolve();
    };

  it("counts a sync's pages onto the board's strip, then hands over to the repaint", async () => {
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"] }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel)).toEqual(["Syncing PAY: 100 of 350 tests", "Rendering…"]);
  });

  it("clears the strip when the sync reports errors, so a failed run cannot strand it", async () => {
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"], snapshotErrors: ["boom"] }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel).at(-1)).toBe("");
  });

  it("posts only a clear when a sync reported no pages at all", async () => {
    const mgr = managerFor(syncSubsystem());
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel)).toEqual([""]);
  });

  // A run that fetched pages and then discarded them (a credential change mid-sync) commits nothing and
  // fires no change event, so there is no repaint to hand over to.
  it("clears the strip when a run counted pages but committed nothing", async () => {
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"], commits: false }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel).at(-1)).toBe("");
  });

  it("still counts a quiet load onto the strip, since that is all it says", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync: reportingSync() }));
    const panel = await openBoardFor(mgr);

    await boardLoads(mgr).autoSync("PAY");

    expect(strips(panel)).toEqual(["Syncing PAY: 100 of 350 tests", "Rendering…"]);
    expect(info).not.toHaveBeenCalled();
  });

  it("passes the resolved sync scope into the board model, so the empty available group says the right thing", () => {
    const built = (settings: Record<string, unknown>, tagDerived: string[] = []): BoardViewModel =>
      traceabilityBoardDeps(
        managerFor(syncSubsystem({ tagDerived, completeProjects: [] }), settings)
      ).buildModel();

    // Either half catches an inverted scope bit at the call site, since it flips both branches at once.
    expect(built({ "xray.syncProjectKeys": ["CALC"] })).toMatchObject({
      availableEmptyText: "No synced tests yet.",
    });
    // The setting is only one rung: a tag-derived project is scope enough for useful unsynced copy.
    expect(built({}, ["CALC"])).toMatchObject({ availableEmptyText: "No synced tests yet." });
    expect(built({})).toMatchObject({
      availableEmptyText: "Pick a project in the header to load its tests.",
    });
  });
});

describe("traceability sync contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.sync";

  it("declares the sync command under the Specwright category with a sync icon", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(sync)");
  });

  it("gates the palette entry and the view-title button on the connected context key", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe("playwrightBddRunner.traceability.connected");

    const button = pkg.contributes.menus["view/title"]!.find((e) => e.command === CMD);
    expect(button?.when).toBe(
      "view == playwrightBddRunner.traceability && playwrightBddRunner.traceability.connected"
    );
  });
});

describe("traceability board drag-to-link drop handler", () => {
  afterEach(() => vi.restoreAllMocks());

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };

  function dropSnapshot(): TraceabilitySnapshot {
    return {
      links: [],
      untraced: [{ scenario: A, reqKeys: [] }],
      orphans: [{ testKey: "5", meta: { key: "5" } }],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
  }

  function harness(snapshot: TraceabilitySnapshot) {
    const adapter = new InMemoryTraceabilityAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    const subsystem = {
      getActiveAdapter: () => adapter,
      getSnapshot: () => snapshot,
    } as unknown as TraceabilitySubsystem;
    mgr.setTraceabilitySubsystem(subsystem);
    return { mgr, applied };
  }

  const drop = (mgr: CommandManager, dropId: string, key: string): Promise<void> =>
    linkCommands(mgr).applyBoardDrop(dropId, key);

  it("writes the tag via a single WorkspaceEdit inserting the grammar-built tag", async () => {
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId(A), "5");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "insert", text: "@TC-5\n" });
  });

  it("routes through the shared applyTagInsert rather than duplicating the insert", async () => {
    const { mgr, applied } = harness(dropSnapshot());
    const insert = vi.spyOn(
      linkCommands(mgr) as unknown as { applyTagInsert: (...a: unknown[]) => Promise<unknown> },
      "applyTagInsert"
    );
    await drop(mgr, scenarioDropId(A), "5");
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]![0]).toMatchObject({ filePath: "/ws/a.feature", line: 3 });
    expect(insert.mock.calls[0]![1]).toBe("5");
    expect(applied).toHaveLength(1);
  });

  it("rejects a stale drop with a toast and no edit when the scenario is gone from the snapshot", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId({ ...A, line: 999 }), "5");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects a drop naming a key the snapshot no longer knows", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId(A), "NOPE-1");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("surfaces a failed write as an error toast without crashing", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    vi.spyOn(vscode.workspace, "applyEdit").mockRejectedValue(new Error("disk full"));
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    mgr.setTraceabilitySubsystem({
      getActiveAdapter: () => adapter,
      getSnapshot: () => dropSnapshot(),
    } as unknown as TraceabilitySubsystem);

    await expect(drop(mgr, scenarioDropId(A), "5")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });

  it("surfaces a refused write, which resolves rather than throwing, as an error toast", async () => {
    const { mgr } = harness(dropSnapshot());
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    await drop(mgr, scenarioDropId(A), "5");

    expect(error.mock.calls[0]?.[0]).toBe("Could not link 5: the feature file edit was not applied");
  });
});

describe("traceability board unlink handler", () => {
  afterEach(() => vi.restoreAllMocks());

  const SOURCE = "Feature: F\n\n@TC-1 @TC-2\nScenario: A\n  Given x\n";
  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 4, name: "A", kind: "scenario" };

  function unlinkSnapshot(): TraceabilitySnapshot {
    return {
      links: [
        { testKey: "1", scenario: A, reqKeys: [] },
        { testKey: "2", scenario: A, reqKeys: [] },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
  }

  function harness(snapshot: TraceabilitySnapshot) {
    const adapter = new InMemoryTraceabilityAdapter();
    const lines = SOURCE.split("\n");
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      eol: vscode.EndOfLine.LF,
      getText: () => SOURCE,
      lineAt: (n: number) => ({ text: lines[n] ?? "", rangeIncludingLineBreak: new vscode.Range(n, 0, n + 1, 0) }),
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    mgr.setTraceabilitySubsystem({
      getActiveAdapter: () => adapter,
      getSnapshot: () => snapshot,
    } as unknown as TraceabilitySubsystem);
    return { mgr, applied };
  }

  const unlink = (mgr: CommandManager, dropId: string, key: string): Promise<void> =>
    linkCommands(mgr).applyBoardUnlink(dropId, key);

  it("routes a valid pair through applyTagRemove with the exact ref and key", async () => {
    const { mgr } = harness(unlinkSnapshot());
    const remove = vi.spyOn(
      linkCommands(mgr) as unknown as { applyTagRemove: (...a: unknown[]) => Promise<unknown> },
      "applyTagRemove"
    );
    await unlink(mgr, scenarioDropId(A), "1");
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0]![0]).toMatchObject({ filePath: "/ws/a.feature", line: 4 });
    expect(remove.mock.calls[0]![1]).toBe("1");
  });

  it("removes only the named key from a two-link scenario, leaving the other tag", async () => {
    const { mgr, applied } = harness(unlinkSnapshot());
    await unlink(mgr, scenarioDropId(A), "1");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "replace", text: "@TC-2" });
  });

  it("rejects a stale pair with a toast and no edit when no live link matches", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(unlinkSnapshot());
    await unlink(mgr, scenarioDropId({ ...A, line: 999 }), "1");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("traceability bulkCreateTests wiring", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };

  function subsystemWithAuthoring(): TraceabilitySubsystem {
    return {
      traceabilityPanelActive: true,
      getSnapshot: () => ({ links: [], untraced: [{ scenario: A, reqKeys: [] }], orphans: [], stale: false, completeProjects: ["CALC"], errors: [] }),
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", projectOf: (key: string) => key.split("-")[0] },
        testAuthoring: { createTest: () => Promise.resolve({ key: "CALC-1", warnings: [] }) },
      }),
      tagDerivedProjectKeys: () => [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  // The command reads its selection off the open board, so drive one check through the panel.
  async function selectOnBoard(mgr: CommandManager): Promise<void> {
    BoardPanel.open(traceabilityBoardDeps(mgr));
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });
    await receiveBoard(panel, "board", { type: "select", target: "scenario", id: scenarioDropId(A), on: true });
  }

  it("reads an unconfigured site as not connected instead of letting the credential lookup reject", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(subsystemWithAuthoring());
    // The real store throws on a site that normalizes empty, which is exactly the default config here.
    mgr.setCredentialStore(
      new XrayCredentialStore(
        {
          get: () => Promise.resolve(undefined),
          store: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        } as unknown as vscode.SecretStorage,
        trustedWorkspace()
      )
    );
    await selectOnBoard(mgr);

    const run = (
      traceabilityCommands(mgr) as unknown as {
        getAuthoringCommands: () => { bulkCreateTests: () => Promise<void> };
      }
    ).getAuthoringCommands();

    await expect(run.bulkCreateTests()).resolves.toBeUndefined();
    expect(String(info.mock.calls.at(-1)?.[0])).toContain("Connect to your test tracker");
  });
});

// The board is rebuilt from settings, so a settings edit only reaches an open one through a rebuild.

