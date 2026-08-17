import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayConnectionCommands } from "../../xray/xray-connection-commands";
import {
  probeXrayConnection,
  XrayConnectionOutcome,
} from "../../xray/xray-connection-test";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { XraySetupPanel } from "../../xray/xray-setup-panel";
import { validateXraySetupInput } from "../../xray/xray-setup-validation";
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { TraceabilityAdapterRegistry } from "../../traceability/adapter-registry";
import { RunResultStore } from "../../traceability/run-result-store";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { WorkspaceTrust } from "../../core/workspace-trust";
import {
  WEBVIEW_PROTOCOL_VERSION,
  type SetupEnvelope,
  type SetupHostMessage,
} from "../../webview/setup-protocol";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function connected(site: string): XrayConnectionOutcome {
  return { ok: true, stage: "ok", site, message: `Connected to ${site}` };
}

function configWith(values: Record<string, unknown>): ExtensionConfig {
  const workspaceConfig = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key in values ? (values[key] as T) : defaultValue,
    update: (): Promise<void> => Promise.resolve(),
    inspect: (key: string): { key: string } => ({ key }),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(workspaceConfig, false);
}

function mapCredentialStore(): { store: XrayCredentialStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = {
    get: (key: string): Promise<string | undefined> => Promise.resolve(map.get(key)),
    store: (key: string, value: string): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<void> => {
      map.delete(key);
      return Promise.resolve();
    },
  } as unknown as vscode.SecretStorage;
  return { store: new XrayCredentialStore(storage, trustedWorkspace()), map };
}

function silentLogger(): Logger {
  const channel = {
    name: "test",
    append: () => { /* no-op */ },
    appendLine: () => { /* no-op */ },
    replace: () => { /* no-op */ },
    clear: () => { /* no-op */ },
    show: () => { /* no-op */ },
    hide: () => { /* no-op */ },
    dispose: () => { /* no-op */ },
  } as unknown as vscode.OutputChannel;
  return Logger.create(channel, LogLevel.ERROR);
}

interface WsConfigStub {
  wsConfig: vscode.WorkspaceConfiguration;
  updates: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }>;
}

function stubWorkspaceConfig(
  inspected: Record<string, unknown> = {},
  values: Record<string, unknown> = {}
): WsConfigStub {
  const updates: WsConfigStub["updates"] = [];
  const wsConfig = {
    get: (key: string, dflt?: unknown): unknown => (key in values ? values[key] : dflt),
    inspect: (): Record<string, unknown> => inspected,
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      updates.push({ key, value, target });
      return Promise.resolve();
    },
  } as unknown as vscode.WorkspaceConfiguration;
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
  return { wsConfig, updates };
}

interface SettingShape {
  globalValue?: unknown;
  workspaceValue?: unknown;
}

function statefulWorkspaceConfig(
  initial: Record<string, SettingShape>
): WsConfigStub {
  const state = new Map(
    Object.entries(initial).map(([key, value]) => [key, { ...value }])
  );
  const updates: WsConfigStub["updates"] = [];
  const wsConfig = {
    get: (key: string, dflt?: unknown): unknown => {
      const value = state.get(key);
      return value?.workspaceValue ?? value?.globalValue ?? dflt;
    },
    inspect: (key: string): Record<string, unknown> => ({ key, ...state.get(key) }),
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      updates.push({ key, value, target });
      const shape = state.get(key) ?? {};
      const field = target === vscode.ConfigurationTarget.Workspace
        ? "workspaceValue"
        : "globalValue";
      if (value === undefined) {
        delete shape[field];
      } else {
        shape[field] = value;
      }
      state.set(key, shape);
      return Promise.resolve();
    },
  } as unknown as vscode.WorkspaceConfiguration;
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
  return { wsConfig, updates };
}

const MASK = "••••••••";
const FIRST_DOCUMENT = "1".repeat(32);
const SECOND_DOCUMENT = "2".repeat(32);

function makeCommands(
  site: string,
  region = "global",
  workspaceTrust = trustedWorkspace()
): {
  commands: XrayConnectionCommands;
  store: XrayCredentialStore;
  map: Map<string, string>;
} {
  const { store, map } = mapCredentialStore();
  return {
    commands: new XrayConnectionCommands(
      configWith({ "xray.siteUrl": site, "xray.apiRegion": region }),
      store,
      silentLogger(),
      () => [],
      (deps) => Promise.resolve(connected(deps.site)),
      workspaceTrust,
      vscode.Uri.file("/extension/dist")
    ),
    store,
    map,
  };
}

interface StubPanel {
  viewType: string;
  title: string;
  webview: {
    html: string;
    options: { enableScripts: boolean; localResourceRoots: vscode.Uri[] };
    __posted: unknown[];
    postMessage: (message: unknown) => Promise<boolean>;
  };
  __revealCount: number;
  __disposed: boolean;
  __receive: (message: unknown) => Promise<void>;
}

type PostedSetup = SetupEnvelope<SetupHostMessage>;

const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
};

let activePanel: StubPanel | undefined;
let activeDocument = FIRST_DOCUMENT;

function sessionOf(panel: StubPanel): string {
  return /<body data-session="([^"]+)"/.exec(panel.webview.html)?.[1] ?? "";
}

function postedBodies(panel: StubPanel): SetupHostMessage[] {
  return (panel.webview.__posted as PostedSetup[]).map((message) => message.body);
}

function lastNonBusy(panel: StubPanel): SetupHostMessage | undefined {
  return postedBodies(panel).filter((message) => message.type !== "busy").at(-1);
}

async function openPanel(commands: XrayConnectionCommands): Promise<StubPanel> {
  await commands.connect();
  const panel = win.__webviewPanels[0]!;
  activePanel = panel;
  await panel.__receive({
    version: WEBVIEW_PROTOCOL_VERSION,
    session: sessionOf(panel),
    document: activeDocument,
    revision: 0,
    surface: "setup",
    body: { type: "ready" },
  });
  await flush();
  return panel;
}

async function reloadPanel(panel: StubPanel, document: string): Promise<void> {
  const previousDocument = activeDocument;
  activeDocument = document;
  await panel.__receive({
    version: WEBVIEW_PROTOCOL_VERSION,
    session: sessionOf(panel),
    document,
    revision: 0,
    surface: "setup",
    body: { type: "ready", previousDocument },
  });
}

function saveMessage(
  overrides: Partial<{
    site: string;
    region: string;
    clientId: string;
    clientSecret: string;
    jiraEmail: string;
    jiraToken: string;
    test: boolean;
  }> = {}
): Record<string, unknown> {
  if (activePanel === undefined) {throw new Error("Open the setup panel before sending a save.");}
  const envelopes = activePanel.webview.__posted as PostedSetup[];
  return {
    version: WEBVIEW_PROTOCOL_VERSION,
    session: sessionOf(activePanel),
    document: activeDocument,
    revision: envelopes.at(-1)?.revision ?? 0,
    surface: "setup",
    body: {
      type: "save",
      site: "acme.atlassian.net",
      region: "global",
      clientId: "id",
      clientSecret: "fixture-client-secret",
      jiraEmail: "",
      jiraToken: "",
      test: false,
      ...overrides,
    },
  };
}

afterEach(() => {
  activePanel = undefined;
  activeDocument = FIRST_DOCUMENT;
  win.__resetWebviewPanels();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("XrayConnectionCommands.saveConnection", () => {
  it("stores trimmed credentials and skips the settings write when the site is unchanged", async () => {
    const { updates } = stubWorkspaceConfig({}, { "xray.siteUrl": "acme.atlassian.net" });
    const { commands, map } = makeCommands("acme.atlassian.net");

    const normalized = await commands.saveConnection("acme.atlassian.net", "  id  ", "  secret  ");

    expect(normalized).toBe("acme.atlassian.net");
    expect(updates).toEqual([]);
    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("secret");
  });

  it("writes a changed site to Global when the setting is not workspace-pinned", async () => {
    const { updates } = stubWorkspaceConfig({}, { "xray.siteUrl": "old.atlassian.net" });
    const { commands } = makeCommands("old.atlassian.net");

    await commands.saveConnection("new.atlassian.net", "id", "secret");

    expect(updates).toEqual([
      { key: "xray.siteUrl", value: "new.atlassian.net", target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes a changed site back to the Workspace when pinned there", async () => {
    const { updates } = stubWorkspaceConfig(
      { workspaceValue: "old.atlassian.net" },
      { "xray.siteUrl": "old.atlassian.net" }
    );
    const { commands } = makeCommands("old.atlassian.net");

    await commands.saveConnection("new.atlassian.net", "id", "secret");

    expect(updates[0]?.target).toBe(vscode.ConfigurationTarget.Workspace);
  });

  it("leaves settings unchanged when credential storage fails", async () => {
    const { updates } = stubWorkspaceConfig(
      { workspaceValue: "old.atlassian.net" },
      { "xray.siteUrl": "old.atlassian.net" }
    );
    const { commands, store } = makeCommands("old.atlassian.net");
    vi.spyOn(store, "setCredentials").mockRejectedValue(new Error("trust revoked"));

    await expect(commands.saveConnection("new.atlassian.net", "id", "secret"))
      .rejects.toThrow("trust revoked");

    expect(updates).toEqual([]);
  });

  it("restores mixed setting scopes and raw values after a settings write rejects", async () => {
    const stub = statefulWorkspaceConfig({
      "xray.siteUrl": { workspaceValue: "old.atlassian.net" },
      "xray.apiRegion": {},
    });
    const update = stub.wsConfig.update.bind(stub.wsConfig);
    vi.spyOn(stub.wsConfig, "update").mockImplementation(async (
      key: string,
      value: unknown,
      target?: boolean | vscode.ConfigurationTarget | null
    ): Promise<void> => {
      await update(key, value, target);
      if (key === "xray.apiRegion" && value === "au") {
        throw new Error("settings unavailable");
      }
    });
    const { commands, store } = makeCommands("old.atlassian.net");
    await store.setCredentials("old.atlassian.net", "old-id", "old-secret");
    await store.setJiraCredentials("old.atlassian.net", "old@example.com", "old-token");
    await store.setCredentials("new.atlassian.net", "kept-id", "kept-secret");
    await store.setJiraCredentials("new.atlassian.net", "kept@example.com", "kept-token");
    await expect(commands.saveSetup({
      site: "new.atlassian.net",
      region: "au",
      clientId: "new-id",
      clientSecret: "new-secret",
      jira: { email: "new@example.com", token: "new-token" },
    })).rejects.toThrow("settings unavailable");

    expect(await store.getCredentials("old.atlassian.net")).toEqual({
      clientId: "old-id",
      clientSecret: "old-secret",
    });
    expect(await store.getJiraCredentials("old.atlassian.net")).toEqual({
      email: "old@example.com",
      token: "old-token",
    });
    expect(await store.getCredentials("new.atlassian.net")).toEqual({
      clientId: "kept-id",
      clientSecret: "kept-secret",
    });
    expect(await store.getJiraCredentials("new.atlassian.net")).toEqual({
      email: "kept@example.com",
      token: "kept-token",
    });
    expect(stub.wsConfig.get("xray.siteUrl")).toBe("old.atlassian.net");
    expect(stub.wsConfig.get("xray.apiRegion", "global")).toBe("global");
    expect(stub.wsConfig.inspect("xray.siteUrl")).toEqual({
      key: "xray.siteUrl",
      workspaceValue: "old.atlassian.net",
    });
    expect(stub.wsConfig.inspect("xray.apiRegion")).toEqual({
      key: "xray.apiRegion",
    });
    expect(stub.updates).toEqual([
      { key: "xray.siteUrl", value: "new.atlassian.net", target: vscode.ConfigurationTarget.Workspace },
      { key: "xray.apiRegion", value: "au", target: vscode.ConfigurationTarget.Global },
      { key: "xray.siteUrl", value: "old.atlassian.net", target: vscode.ConfigurationTarget.Workspace },
      { key: "xray.apiRegion", value: undefined, target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("clears the previous site's credentials when switching hosts", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "old.atlassian.net" });
    const { commands, store, map } = makeCommands("old.atlassian.net");
    await store.setCredentials("old.atlassian.net", "old-id", "old-secret");

    await commands.saveConnection("new.atlassian.net", "new-id", "new-secret");

    expect(await store.getCredentials("old.atlassian.net")).toBeUndefined();
    expect(await store.getCredentials("new.atlassian.net")).toEqual({
      clientId: "new-id",
      clientSecret: "new-secret",
    });
    expect([...map.keys()].every((key) => key.includes(":new.atlassian.net:"))).toBe(true);
  });

  it("keeps stored credentials when the raw site differs but the normalized host is the same", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "acme.atlassian.net" });
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "old-id", "old-secret");

    await commands.saveConnection("https://acme.atlassian.net/", "new-id", "new-secret");

    expect(await store.getCredentials("acme.atlassian.net")).toEqual({
      clientId: "new-id",
      clientSecret: "new-secret",
    });
    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("new-id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("new-secret");
  });

  it("rejects a degenerate site and touches neither settings nor the credential store", async () => {
    const { updates } = stubWorkspaceConfig();
    const { commands, map } = makeCommands("");

    await expect(commands.saveConnection("https://", "id", "secret")).rejects.toThrow(
      "not a valid site host"
    );

    expect(updates).toEqual([]);
    expect(map.size).toBe(0);
  });
});

describe("validateXraySetupInput", () => {
  it("rejects hosts that normalize to empty or are not a bare host", () => {
    expect(validateXraySetupInput("https://", "id", "secret")?.site).toBeTruthy();
    expect(validateXraySetupInput("   ", "id", "secret")?.site).toBeTruthy();
    expect(validateXraySetupInput("acme.atlassian.net/jira", "id", "secret")?.site).toBeTruthy();
    expect(validateXraySetupInput("acme.atlassian.net:8080", "id", "secret")?.site).toBeTruthy();
  });

  it("accepts bare hosts and full URLs", () => {
    expect(validateXraySetupInput("acme.atlassian.net", "id", "secret")).toBeUndefined();
    expect(validateXraySetupInput("https://acme.atlassian.net/", "id", "secret")).toBeUndefined();
  });

  it("requires a non-empty client id and secret", () => {
    expect(validateXraySetupInput("acme.atlassian.net", "  ", "secret")?.clientId).toBeTruthy();
    expect(validateXraySetupInput("acme.atlassian.net", "id", "  ")?.clientSecret).toBeTruthy();
  });
});

describe("XrayConnectionCommands.connect", () => {
  it("aborts and drains the initial auth probe without posting after trust disposal", async () => {
    const trust = new WorkspaceTrust(() => true);
    const map = new Map<string, string>();
    const storage = {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {map.set(key, value); return Promise.resolve();},
      delete: (key: string) => {map.delete(key); return Promise.resolve();},
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, trust);
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
      });
    }));
    const commands = new XrayConnectionCommands(
      configWith({ "xray.siteUrl": "acme.atlassian.net" }),
      store,
      silentLogger(),
      () => [],
      probeXrayConnection,
      trust,
      vscode.Uri.file("/extension/dist")
    );

    await commands.connect();
    const panel = win.__webviewPanels[0]!;
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    const postsBeforeDisposal = postedBodies(panel).length;

    await trust.dispose();
    await flush();

    expect(fetchSignal?.aborted).toBe(true);
    expect(postedBodies(panel)).toHaveLength(postsBeforeDisposal);
  });

  it("opens the setup webview panel instead of prompting with input boxes", async () => {
    const inputBox = vi.spyOn(vscode.window, "showInputBox");
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();

    expect(inputBox).not.toHaveBeenCalled();
    expect(win.__webviewPanels).toHaveLength(1);
    const panel = win.__webviewPanels[0]!;
    expect(panel.viewType).toBe("playwrightBddRunner.xraySetup");
    expect(panel.title).toBe("Set up Xray");
    expect(panel.webview.html).toContain("Set up Xray");
  });

  it("prefills and HTML-escapes the current site host", async () => {
    const { commands } = makeCommands('acme".net');

    await commands.connect();

    expect(win.__webviewPanels[0]!.webview.html).toContain('value="acme&quot;.net"');
  });

  it("bounds the initial HTML site value to the same safe host projection", async () => {
    const tail = "UNBOUNDED-SITE-TAIL";
    const { commands } = makeCommands(`${"x".repeat(600)}${tail}`);
    const panel = await openPanel(commands);
    const form = postedBodies(panel).find((message) => message.type === "form-state");

    expect(form).toMatchObject({ type: "form-state", site: expect.any(String) });
    expect(form?.type === "form-state" ? form.site.length : 0).toBeLessThanOrEqual(300);
    expect(panel.webview.html).not.toContain(tail);
    expect(JSON.stringify(panel.webview.__posted)).not.toContain(tail);
  });

  it("offers every supported region and selects the configured one", async () => {
    const { commands } = makeCommands("acme.atlassian.net", "eu");

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('<option value="global">Global</option>');
    expect(html).toContain('<option value="us">US</option>');
    expect(html).toContain('<option value="eu" selected>EU</option>');
    expect(html).toContain('<option value="au">AU</option>');
  });

  it("shows the hint visible, masks both credential fields, and renders the checking dot when credentials exist", async () => {
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('<p class="hint" id="cred-hint">Credentials are stored for this site');
    expect(html).toContain(`<input id="clientId" type="text" placeholder="client id" value="${MASK}"`);
    expect(html).toContain(`<input id="clientSecret" type="password" placeholder="client secret" value="${MASK}"`);
    expect(html).toContain('<span id="conn-dot" class="conn-dot checking" aria-hidden="true">');
    expect(html).toContain('<span id="conn-label">Checking connection…</span>');
    expect(html).not.toContain("stored, enter to replace");
    await flush();
  });

  it("hides the hint, leaves credential fields empty, and marks not-connected when no credentials exist", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('<p class="hint" id="cred-hint" hidden>Credentials are stored for this site');
    expect(html).toContain('<input id="clientId" type="text" placeholder="client id" value=""');
    expect(html).toContain('<input id="clientSecret" type="password" placeholder="client secret" value=""');
    expect(html).toContain('<span id="conn-dot" class="conn-dot" aria-hidden="true">');
    expect(html).toContain('<span id="conn-label">Not connected</span>');
  });

  it("loads only the external setup bundle from the dist asset root", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();

    const panel = win.__webviewPanels[0]!;
    expect(panel.webview.options.localResourceRoots.map((uri) => uri.toString())).toEqual([
      vscode.Uri.file("/extension/dist").toString(),
    ]);
    expect(panel.webview.html).toContain('src="file:///extension/dist/xray-setup.js"');
    expect(panel.webview.html).toMatch(/<script nonce="[a-f0-9]+" src=/);
    expect(panel.webview.html).not.toContain("acquireVsCodeApi()");
    expect(panel.webview.html).not.toContain("unsafe-eval");
  });

  it("reveals the existing panel instead of creating a second one", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();
    await commands.connect();

    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.__revealCount).toBe(1);
  });

  it("single-flights concurrent opens onto one panel and lifecycle owner", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await Promise.all([commands.connect(), commands.connect()]);

    expect(win.__webviewPanels).toHaveLength(1);
    const panel = win.__webviewPanels[0]!;
    await XraySetupPanel.close();
    expect(panel.__disposed).toBe(true);
  });

  it.each([
    ["Xray", "hasCredentials", "throw"],
    ["Xray", "hasCredentials", "reject"],
    ["Jira", "hasJiraCredentials", "throw"],
    ["Jira", "hasJiraCredentials", "reject"],
  ] as const)("contains a %s credential-presence %s and leaves setup usable", async (_label, method, failure) => {
    const { commands, store } = makeCommands("acme.atlassian.net");
    const secret = `${method}-credential-like-fault`;
    const presence = vi.spyOn(store, method);
    if (failure === "throw") {
      presence.mockImplementation(() => {throw new Error(secret);});
    } else {
      presence.mockRejectedValue(new Error(secret));
    }

    const panel = await openPanel(commands);

    expect(win.__webviewPanels).toHaveLength(1);
    expect(panel.__disposed).toBe(false);
    expect(panel.webview.html).toContain("Set up Xray");
    expect(JSON.stringify({ html: panel.webview.html, posted: panel.webview.__posted })).not.toContain(secret);
    expect(lastNonBusy(panel)).toEqual({
      type: "error",
      message: "Could not read stored credential status. Enter credentials to continue.",
    });
  });
});

describe("Xray setup panel save flow", () => {
  it.each(["false", "reject", "throw"] as const)(
    "requires a successful busy acknowledgement before saving after postMessage %s",
    async (failure) => {
      stubWorkspaceConfig();
      const { commands } = makeCommands("acme.atlassian.net");
      vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
      const panel = await openPanel(commands);
      const save = vi.spyOn(commands, "saveSetup");
      const postMessage = panel.webview.postMessage.bind(panel.webview);
      vi.spyOn(panel.webview, "postMessage")
        .mockImplementationOnce(() => {
          if (failure === "false") {return Promise.resolve(false);}
          if (failure === "reject") {return Promise.reject(new Error("webview unavailable"));}
          throw new Error("webview unavailable");
        })
        .mockImplementation(postMessage);

      await panel.__receive(saveMessage());
      expect(save).not.toHaveBeenCalled();

      const beforeRecovery = panel.webview.__posted.length;
      await panel.__receive(saveMessage());
      expect(save).not.toHaveBeenCalled();
      expect(panel.webview.__posted.length).toBeGreaterThan(beforeRecovery);

      await panel.__receive(saveMessage());
      expect(save).toHaveBeenCalledOnce();
    }
  );

  it("stops before storage when availability drops after parsing and recovers on reveal", async () => {
    stubWorkspaceConfig();
    let available = true;
    const trust = new WorkspaceTrust(() => available);
    const { commands } = makeCommands("acme.atlassian.net", "global", trust);
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    const save = vi.spyOn(commands, "saveSetup");

    const saving = panel.__receive(saveMessage());
    available = false;
    await saving;
    expect(save).not.toHaveBeenCalled();

    available = true;
    await commands.connect();
    expect(save).not.toHaveBeenCalled();
    await panel.__receive(saveMessage());
    expect(save).toHaveBeenCalledOnce();
  });

  it("rehydrates from the last acknowledged revision after a retained post fails", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    const save = vi.spyOn(commands, "saveSetup");
    const postMessage = panel.webview.postMessage.bind(panel.webview);
    let failTerminalBusy = true;
    vi.spyOn(panel.webview, "postMessage").mockImplementation((message) => {
      const body = (message as PostedSetup).body;
      if (failTerminalBusy && body.type === "busy" && !body.busy) {
        failTerminalBusy = false;
        return Promise.resolve(false);
      }
      return postMessage(message);
    });

    await panel.__receive(saveMessage());
    expect(save).toHaveBeenCalledOnce();
    const acknowledgedRevision = (panel.webview.__posted as PostedSetup[]).at(-1)!.revision;
    const recovery = saveMessage();
    const beforeRecovery = panel.webview.__posted.length;

    await panel.__receive({ ...recovery, revision: acknowledgedRevision });

    expect(save).toHaveBeenCalledOnce();
    expect(postedBodies(panel).slice(beforeRecovery).map((message) => message.type)).toEqual([
      "form-state",
      "conn-state",
      "test-result",
      "busy",
    ]);
    await panel.__receive(saveMessage());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("rejects raw, malformed, foreign, stale, and oversized save messages before storage", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    const save = vi.spyOn(commands, "saveSetup");
    const valid = saveMessage();
    const envelope = valid as {
      session: string;
      revision: number;
      surface: string;
      body: Record<string, unknown>;
    };

    await panel.__receive(envelope.body);
    await panel.__receive({ ...envelope, session: "foreign" });
    await panel.__receive({ ...envelope, document: "f".repeat(32) });
    await panel.__receive({ ...envelope, revision: envelope.revision - 1 });
    await panel.__receive({ ...envelope, surface: "board" });
    await panel.__receive({ ...envelope, body: { ...envelope.body, extra: true } });
    await panel.__receive({
      ...envelope,
      body: { ...envelope.body, clientSecret: "x".repeat(8_193) },
    });

    expect(save).not.toHaveBeenCalled();
    await panel.__receive(valid);
    expect(save).toHaveBeenCalledOnce();
  });

  it("persists the selected region and uses it for the immediate probe", async () => {
    const { updates } = stubWorkspaceConfig(
      { workspaceValue: "global" },
      { "xray.siteUrl": "acme.atlassian.net", "xray.apiRegion": "global" }
    );
    const { commands } = makeCommands("acme.atlassian.net");
    const probe = vi.spyOn(commands, "probeConnection")
      .mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ region: "au" }));

    expect(updates).toContainEqual({
      key: "xray.apiRegion",
      value: "au",
      target: vscode.ConfigurationTarget.Workspace,
    });
    expect(probe).toHaveBeenCalledWith(
      "acme.atlassian.net",
      { authOnly: true },
      expect.anything(),
      "au"
    );
  });

  it("posts validation errors and stores nothing for an invalid site", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("");
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ site: "https://" }));

    expect(map.size).toBe(0);
    const posted = postedBodies(panel).filter((message) => message.type === "validation") as Array<{
      type: string;
      errors?: { site?: string };
    }>;
    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe("validation");
    expect(posted[0]?.errors?.site).toBeTruthy();
  });

  it("does not replay discarded-field validation into a reloaded document", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("");
    const panel = await openPanel(commands);
    await panel.__receive(saveMessage({ site: "https://" }));
    expect(postedBodies(panel).some((message) => message.type === "validation")).toBe(true);
    panel.webview.__posted.length = 0;

    await reloadPanel(panel, SECOND_DOCUMENT);

    expect(postedBodies(panel).map((message) => message.type)).toEqual([
      "form-state",
      "conn-state",
      "busy",
    ]);
  });

  it("stores trimmed credentials and posts a saved message on a valid save", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ clientId: "  id  ", clientSecret: "  secret  " }));

    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("secret");
    expect(postedBodies(panel)).toContainEqual({
      type: "saved", site: "acme.atlassian.net", region: "global", jira: false,
    });
  });

  it("triggers an auth-only verify after a plain save and flips the dot to its outcome", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const probe = vi
      .spyOn(commands, "probeConnection")
      .mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage());

    expect(probe).toHaveBeenCalledWith(
      "acme.atlassian.net",
      { authOnly: true },
      expect.anything(),
      "global"
    );
    expect(postedBodies(panel)).toContainEqual({
      type: "conn-state",
      state: "connected",
      label: "Connected to acme.atlassian.net",
    });
  });

  it("posts the probe outcome as a test-result and a connected dot after a save-and-test", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: true,
      stage: "ok",
      site: "acme.atlassian.net",
      message: "Connected to acme.atlassian.net; authentication OK",
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    expect(postedBodies(panel)).toContainEqual({
      type: "conn-state",
      state: "connected",
      label: "Connected to acme.atlassian.net",
    });
    expect(lastNonBusy(panel)).toEqual({
      type: "test-result",
      ok: true,
      message: "Connected to acme.atlassian.net; authentication OK",
    });
  });

  it("shows a disconnected dot plus the message when Save & Test fails at the auth stage", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: false,
      stage: "auth",
      site: "acme.atlassian.net",
      message: "Authentication failed: check your client ID and secret.",
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    expect(postedBodies(panel)).toContainEqual({
      type: "conn-state",
      state: "disconnected",
      label: "Not connected",
    });
    expect(lastNonBusy(panel)).toEqual({
      type: "test-result",
      ok: false,
      message: "Authentication failed: check your client ID and secret.",
    });
  });

  it("drops the dot and names the failed half when Save & Test fails at the GraphQL stage", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: false,
      stage: "graphql",
      site: "acme.atlassian.net",
      message: "Xray GraphQL probe failed (HTTP 403): no permission.",
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    expect(postedBodies(panel)).toContainEqual({
      type: "conn-state",
      state: "disconnected",
      label: "Authenticated, but Xray data calls failed",
    });
    expect(lastNonBusy(panel)).toEqual({
      type: "test-result",
      ok: false,
      message: "Xray GraphQL probe failed (HTTP 403): no permission.",
    });
  });

  it("posts an error message when the save itself throws", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "saveSetup").mockRejectedValue(new Error("secret storage unavailable"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage());

    expect(lastNonBusy(panel)).toEqual({
      type: "error",
      message: "Could not save: secret storage unavailable",
    });
  });

  it("posts a terminal error when masked Xray credentials cannot be read", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();
    vi.spyOn(store, "getCredentials").mockRejectedValueOnce(new Error("secret read unavailable"));

    await panel.__receive(saveMessage({ clientId: MASK, clientSecret: MASK }));

    expect(lastNonBusy(panel)).toEqual({
      type: "error",
      message: "Could not save: stored credentials could not be read.",
    });
  });

  it("posts a terminal error when masked Jira credentials cannot be read", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "token");
    const panel = await openPanel(commands);
    vi.spyOn(store, "getJiraCredentials").mockRejectedValueOnce(new Error("Jira secret read unavailable"));

    await panel.__receive(saveMessage({ jiraEmail: MASK, jiraToken: MASK }));

    expect(lastNonBusy(panel)).toEqual({
      type: "error",
      message: "Could not save: stored credentials could not be read.",
    });
  });

  it("does not turn an optional walkthrough notification failure into a save failure", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(vscode.commands, "executeCommand").mockRejectedValue(new Error("notification unavailable"));
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage());

    expect(postedBodies(panel)).toContainEqual({
      type: "saved", site: "acme.atlassian.net", region: "global", jira: false,
    });
    expect((postedBodies(panel) as Array<{ type: string }>).some(
      (message) => message.type === "error"
    )).toBe(false);
  });

  it("reports a failed test launch after a successful save instead of swallowing it", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockRejectedValue(new Error("probe crashed"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    const posted = postedBodies(panel).filter((message) => message.type !== "busy") as Array<{ type: string }>;
    expect(posted.some((message) => message.type === "saved")).toBe(true);
    expect(posted.at(-1)).toEqual({
      type: "error",
      message: "Saved, but the connection test failed to run: probe crashed",
    });
  });

  it("recovers when the verify delegate throws synchronously instead of stranding the form at Checking…", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockImplementation(() => {
      throw new Error("probe exploded");
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    const posted = postedBodies(panel).filter((message) => message.type !== "busy") as Array<{ type: string; state?: string; label?: string; message?: string }>;
    expect(posted.some((message) => message.type === "saved")).toBe(true);
    // A terminal (non-checking) conn-state re-enables the buttons; the error carries the reason.
    expect(posted).toContainEqual({ type: "conn-state", state: "disconnected", label: "Not connected" });
    expect(posted.at(-1)).toEqual({
      type: "error",
      message: "Saved, but the connection test failed to run: probe exploded",
    });
  });

  it("keeps both stored credentials on a masked save (site casing change) and re-tests", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: true,
      stage: "ok",
      site: "acme.atlassian.net",
      message: "Connected to acme.atlassian.net; authentication OK",
    });
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(
      saveMessage({ site: "https://acme.atlassian.net/", clientId: MASK, clientSecret: MASK, test: true })
    );

    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("stored-id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("stored-secret");
    expect(lastNonBusy(panel)).toEqual({
      type: "test-result",
      ok: true,
      message: "Connected to acme.atlassian.net; authentication OK",
    });
  });

  it("rotates only the client secret while a masked client id keeps the stored value", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(saveMessage({ clientId: MASK, clientSecret: "rotated-secret" }));

    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("stored-id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("rotated-secret");
  });

  it("rejects a masked field when the normalized host changed and never carries old credentials over", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(
      saveMessage({ site: "other.atlassian.net", clientId: MASK, clientSecret: MASK })
    );

    const posted = postedBodies(panel).filter((message) => message.type !== "busy") as Array<{
      type: string;
      errors?: { clientId?: string; clientSecret?: string };
    }>;
    expect(posted.at(-1)?.type).toBe("validation");
    expect(posted.at(-1)?.errors?.clientId).toBe("Enter the credentials for the new site");
    expect(posted.at(-1)?.errors?.clientSecret).toBe("Enter the credentials for the new site");
    expect(map.get("specwright.xray:other.atlassian.net:clientId")).toBeUndefined();
    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("stored-id");
  });

  it("rejects the mask as a literal credential when nothing is stored", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ clientId: MASK, clientSecret: "real-secret" }));

    const posted = postedBodies(panel).filter((message) => message.type !== "busy") as Array<{ type: string; errors?: { clientId?: string } }>;
    expect(posted.at(-1)?.type).toBe("validation");
    expect(posted.at(-1)?.errors?.clientId).toBeTruthy();
    expect(map.size).toBe(0);
  });

  it("never leaks the secret into the generated HTML or the saved message", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    const secret = "top-secret-token-value";

    await panel.__receive(saveMessage({ clientId: "unique-client-id", clientSecret: secret }));

    expect(panel.webview.html).not.toContain(secret);
    expect(JSON.stringify(postedBodies(panel))).not.toContain(secret);
  });

  it("scrubs a submitted credential from bounded save errors", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const secret = "unique-secret-that-must-not-return";
    vi.spyOn(commands, "saveSetup").mockRejectedValue(new Error(`provider echoed ${secret}`));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ clientId: "unique-client-id", clientSecret: secret }));

    expect(JSON.stringify(postedBodies(panel))).not.toContain(secret);
    expect(lastNonBusy(panel)).toEqual({
      type: "error",
      message: "Could not save: provider echoed [redacted]",
    });
  });

  it.each(["throw", "reject"] as const)(
    "redacts every submitted and resolved credential from a %s verification fault",
    async (failure) => {
      stubWorkspaceConfig();
      const { commands } = makeCommands("acme.atlassian.net");
      const secrets = [
        "verification-client-id-value",
        "verification-client-secret-value",
        "verification-jira@example.com",
        "verification-jira-token-value",
      ] as const;
      const fault = new Error(`probe echoed ${secrets.join(" / ")}`);
      const probe = vi.spyOn(commands, "probeConnection");
      if (failure === "throw") {
        probe.mockImplementation(() => {throw fault;});
      } else {
        probe.mockRejectedValue(fault);
      }
      const panel = await openPanel(commands);

      await panel.__receive(saveMessage({
        clientId: secrets[0],
        clientSecret: secrets[1],
        jiraEmail: secrets[2],
        jiraToken: secrets[3],
        test: true,
      }));

      const outbound = JSON.stringify(panel.webview.__posted);
      for (const secret of secrets) {expect(outbound).not.toContain(secret);}
      expect(lastNonBusy(panel)).toMatchObject({ type: "error" });
    }
  );

  it("redacts credentials from saved, connection, result, project, and Jira projections", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const secrets = [
      "projection-client-id-value",
      "projection-client-secret-value",
      "projection-jira@example.com",
      "projection-jira-token-value",
    ] as const;
    vi.spyOn(commands, "saveSetup").mockResolvedValue(secrets[1]!);
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: true,
      stage: "ok",
      site: secrets[0]!,
      message: `outcome ${secrets.join(" / ")}`,
      projects: [{ project: secrets[1]!, totalTests: 1 }],
      jiraProjects: [{ key: secrets[2]!, name: secrets[3]! }],
      jiraError: `jira ${secrets[0]}`,
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({
      clientId: secrets[0],
      clientSecret: secrets[1],
      jiraEmail: secrets[2],
      jiraToken: secrets[3],
      test: true,
    }));

    const outbound = JSON.stringify(panel.webview.__posted);
    for (const secret of secrets) {expect(outbound).not.toContain(secret);}
    expect(postedBodies(panel)).toContainEqual(expect.objectContaining({ type: "project-view" }));
  });

  it("redacts stored values resolved from every masked save field", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    const secrets = [
      "resolved-client-id-value",
      "resolved-client-secret-value",
      "resolved-jira@example.com",
      "resolved-jira-token-value",
    ] as const;
    await store.setCredentials("acme.atlassian.net", secrets[0], secrets[1]);
    await store.setJiraCredentials("acme.atlassian.net", secrets[2], secrets[3]);
    vi.spyOn(commands, "probeConnection")
      .mockResolvedValueOnce(connected("acme.atlassian.net"))
      .mockResolvedValueOnce({
        ok: true,
        stage: "ok",
        site: secrets[0],
        message: `resolved ${secrets.join(" / ")}`,
        projects: [{ project: secrets[1], totalTests: 1 }],
        jiraProjects: [{ key: secrets[2], name: secrets[3] }],
        jiraError: secrets[0],
      });
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(saveMessage({
      clientId: MASK,
      clientSecret: MASK,
      jiraEmail: MASK,
      jiraToken: MASK,
      test: true,
    }));

    const outbound = JSON.stringify(panel.webview.__posted);
    for (const secret of secrets) {expect(outbound).not.toContain(secret);}
  });
});

describe("Xray setup panel connection verification", () => {
  function connStates(panel: StubPanel): Array<{ type: string; state: string; label: string }> {
    return (postedBodies(panel) as Array<{ type: string; state?: string; label?: string }>)
      .filter((m): m is { type: string; state: string; label: string } => m.type === "conn-state");
  }

  it("serializes one hydration snapshot for concurrent and repeated ready messages", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: false,
      stage: "auth",
      site: "acme.atlassian.net",
      message: "Authentication rejected",
    });

    await commands.connect();
    const panel = win.__webviewPanels[0]!;
    await flush();
    expect(panel.webview.__posted).toEqual([]);

    const ready = {
      version: WEBVIEW_PROTOCOL_VERSION,
      session: sessionOf(panel),
      document: activeDocument,
      revision: 0,
      surface: "setup",
      body: { type: "ready" },
    };
    await Promise.all([panel.__receive(ready), panel.__receive(ready)]);

    const envelopes = panel.webview.__posted as PostedSetup[];
    expect(envelopes.map((message) => message.body.type)).toEqual([
      "form-state",
      "conn-state",
      "test-result",
      "busy",
    ]);
    expect(envelopes.map((message) => message.revision)).toEqual([1, 2, 3, 4]);
    expect(envelopes.every((message) => message.document === activeDocument)).toBe(true);

    await panel.__receive(ready);
    expect(panel.webview.__posted).toHaveLength(4);
  });

  it("verifies on open with stored credentials and flips the dot to connected", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    const probe = vi
      .spyOn(commands, "probeConnection")
      .mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    expect(probe).toHaveBeenCalledWith(
      "acme.atlassian.net",
      { authOnly: true },
      expect.anything(),
      "global"
    );
    expect(connStates(panel).at(-1)).toEqual({
      type: "conn-state",
      state: "connected",
      label: "Connected to acme.atlassian.net",
    });
  });

  it("makes no network call on open when no credentials are stored", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const probe = vi.spyOn(commands, "probeConnection");
    const panel = await openPanel(commands);
    await flush();

    expect(probe).not.toHaveBeenCalled();
    expect(connStates(panel).at(-1)).toEqual({
      type: "conn-state",
      state: "disconnected",
      label: "Not connected",
    });
  });

  it("shows disconnected and the indicative message when the open verify hits a 401", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: false,
      stage: "auth",
      site: "acme.atlassian.net",
      message: "Authentication failed: check your client ID and secret.",
    });
    const panel = await openPanel(commands);
    await flush();

    expect(connStates(panel).at(-1)).toEqual({
      type: "conn-state",
      state: "disconnected",
      label: "Not connected",
    });
    expect(postedBodies(panel)).toContainEqual({
      type: "test-result",
      ok: false,
      message: "Authentication failed: check your client ID and [redacted].",
    });
  });

  it.each(["throw", "reject"] as const)(
    "redacts stored Xray credentials from an opening probe %s",
    async (failure) => {
      stubWorkspaceConfig();
      const { commands, store } = makeCommands("acme.atlassian.net");
      const secrets = ["stored-opening-client-id", "stored-opening-client-secret"];
      await store.setCredentials("acme.atlassian.net", secrets[0]!, secrets[1]!);
      const fault = new Error(`opening probe echoed ${secrets.join(" / ")}`);
      const probe = vi.spyOn(commands, "probeConnection");
      if (failure === "throw") {
        probe.mockImplementation(() => {throw fault;});
      } else {
        probe.mockRejectedValue(fault);
      }

      const panel = await openPanel(commands);
      await flush();

      const outbound = JSON.stringify(panel.webview.__posted);
      for (const secret of secrets) {expect(outbound).not.toContain(secret);}
      expect(lastNonBusy(panel)).toMatchObject({ type: "error" });
    }
  );

  it("redacts stored credentials from opening outcome fields without projecting full-probe data", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    const secrets = ["stored-outcome-client-id", "stored-outcome-client-secret"];
    await store.setCredentials("acme.atlassian.net", secrets[0]!, secrets[1]!);
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: true,
      stage: "ok",
      site: secrets[0]!,
      message: `connected with ${secrets[1]}`,
      projects: [{ project: secrets[0]!, totalTests: 1 }],
      jiraProjects: [{ key: secrets[0]!, name: secrets[1]! }],
      jiraError: secrets[1]!,
    });

    const panel = await openPanel(commands);
    await flush();

    const outbound = JSON.stringify(panel.webview.__posted);
    for (const secret of secrets) {expect(outbound).not.toContain(secret);}
    expect(postedBodies(panel).some((message) => message.type === "project-view")).toBe(false);
  });

  it("contains a stored-credential read failure without probing or echoing its fault", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    const faultSecret = "credential-read-fault-secret";
    vi.spyOn(store, "hasCredentials").mockResolvedValue(true);
    vi.spyOn(store, "getCredentials").mockRejectedValue(new Error(faultSecret));
    const probe = vi.spyOn(commands, "probeConnection");

    const panel = await openPanel(commands);
    await flush();

    expect(probe).not.toHaveBeenCalled();
    expect(JSON.stringify(panel.webview.__posted)).not.toContain(faultSecret);
    expect(lastNonBusy(panel)).toEqual({
      type: "error",
      message: "Could not verify connection: stored credentials could not be read.",
    });
  });

  it("aborts the open verify and rejects overlapping saves until replacement verification settles", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    let resolveOpen!: (outcome: XrayConnectionOutcome) => void;
    let openSignal: AbortSignal | undefined;
    const openProbe = new Promise<XrayConnectionOutcome>((resolve) => { resolveOpen = resolve; });
    vi.spyOn(commands, "probeConnection")
      .mockImplementationOnce((_site, _options, signal) => {
        openSignal = signal;
        return openProbe;
      })
      .mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    let finishSave!: (site: string) => void;
    const pausedSave = new Promise<string>((resolve) => { finishSave = resolve; });
    const save = vi.spyOn(commands, "saveSetup").mockReturnValue(pausedSave);
    const saving = panel.__receive(saveMessage({ clientId: MASK, clientSecret: MASK }));
    await flush();
    const overlapping = panel.__receive(saveMessage({ clientId: "other", clientSecret: "other" }));

    expect(openSignal?.aborted).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(postedBodies(panel).filter((message) => message.type === "busy").slice(-1)).toEqual([
      { type: "busy", busy: true, testing: false },
    ]);
    await overlapping;
    resolveOpen({ ok: false, stage: "auth", site: "acme.atlassian.net", message: "stale" });
    await flush();
    expect(connStates(panel).filter((message) => message.state !== "checking")).toEqual([]);

    finishSave("acme.atlassian.net");
    await saving;

    const terminal = connStates(panel).filter((m) => m.state !== "checking");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.state).toBe("connected");
    expect(postedBodies(panel).filter((message) => message.type === "busy").slice(-2)).toEqual([
      { type: "busy", busy: true, testing: false },
      { type: "busy", busy: false, testing: false },
    ]);
  });

  it("closes the retained panel, aborts its probe, and drains that probe", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    let resolveProbe!: (outcome: XrayConnectionOutcome) => void;
    let signal: AbortSignal | undefined;
    vi.spyOn(commands, "probeConnection").mockImplementation((_site, _options, nextSignal) => {
      signal = nextSignal;
      return new Promise<XrayConnectionOutcome>((resolve) => { resolveProbe = resolve; });
    });
    const panel = await openPanel(commands);
    await flush();

    let drained = false;
    const closing = XraySetupPanel.close().then(() => {drained = true;});
    await flush();

    expect(panel.__disposed).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(drained).toBe(false);

    resolveProbe(connected("acme.atlassian.net"));
    await closing;
    expect(drained).toBe(true);
  });
});

describe("Xray setup panel Jira access", () => {
  function jiraKey(field: "jiraEmail" | "jiraToken", site = "acme.atlassian.net"): string {
    return `specwright.xray:${site}:${field}`;
  }

  it("masks both Jira fields when Jira credentials are stored", async () => {
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain(`<input id="jiraEmail" type="email" placeholder="you@example.com" value="${MASK}"`);
    expect(html).toContain(`<input id="jiraToken" type="password" placeholder="Jira API token" value="${MASK}"`);
  });

  it("leaves both Jira fields empty when no Jira credentials are stored", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('<input id="jiraEmail" type="email" placeholder="you@example.com" value=""');
    expect(html).toContain('<input id="jiraToken" type="password" placeholder="Jira API token" value=""');
  });

  it.each(["throw", "reject"] as const)(
    "preserves stored Jira credentials when their presence probe %s",
    async (failure) => {
      stubWorkspaceConfig();
      const { commands, store } = makeCommands("acme.atlassian.net");
      await store.setJiraCredentials("acme.atlassian.net", "stored@example.com", "stored-token");
      const presence = vi.spyOn(store, "hasJiraCredentials");
      if (failure === "throw") {
        presence.mockImplementation(() => {throw new Error("presence unavailable");});
      } else {
        presence.mockRejectedValue(new Error("presence unavailable"));
      }
      vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));

      const panel = await openPanel(commands);
      expect(panel.webview.html).toContain(`id="jiraEmail" type="email" placeholder="you@example.com" value="${MASK}"`);
      await panel.__receive(saveMessage({
        clientId: "rotated-id",
        clientSecret: "rotated-secret",
        jiraEmail: MASK,
        jiraToken: MASK,
      }));

      expect(await store.getJiraCredentials("acme.atlassian.net")).toEqual({
        email: "stored@example.com",
        token: "stored-token",
      });
      expect(postedBodies(panel)).toContainEqual({
        type: "saved",
        site: "acme.atlassian.net",
        region: "global",
        jira: true,
      });
    }
  );

  it("fails closed when Jira presence is unknown and no stored pair can be re-read", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    vi.spyOn(store, "hasJiraCredentials").mockRejectedValue(new Error("presence unavailable"));
    const save = vi.spyOn(commands, "saveSetup");
    const panel = await openPanel(commands);

    expect(panel.webview.html).toContain(`id="jiraToken" type="password" placeholder="Jira API token" value="${MASK}"`);
    await panel.__receive(saveMessage({ jiraEmail: MASK, jiraToken: MASK }));

    expect(save).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
    expect(lastNonBusy(panel)).toMatchObject({
      type: "validation",
      errors: {
        jiraEmail: "Enter your Jira email",
        jiraToken: "Enter your Jira API token",
      },
    });
  });

  it("rejects a lone Jira email with a both-or-neither error and stores nothing", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ jiraEmail: "me@example.com", jiraToken: "" }));

    const posted = postedBodies(panel).filter((message) => message.type !== "busy") as Array<{ type: string; errors?: { jiraToken?: string } }>;
    expect(posted.at(-1)?.type).toBe("validation");
    expect(posted.at(-1)?.errors?.jiraToken).toBeTruthy();
    expect(map.size).toBe(0);
  });

  it("stores both trimmed Jira secrets and reports jira: true on save", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ jiraEmail: "  me@example.com  ", jiraToken: "  jira-token  " }));

    expect(map.get(jiraKey("jiraEmail"))).toBe("me@example.com");
    expect(map.get(jiraKey("jiraToken"))).toBe("jira-token");
    expect(postedBodies(panel)).toContainEqual({
      type: "saved", site: "acme.atlassian.net", region: "global", jira: true,
    });
  });

  it("clears stored Jira secrets when both Jira fields are saved blank", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(saveMessage({ jiraEmail: "", jiraToken: "" }));

    expect(map.get(jiraKey("jiraEmail"))).toBeUndefined();
    expect(map.get(jiraKey("jiraToken"))).toBeUndefined();
    expect(postedBodies(panel)).toContainEqual({
      type: "saved", site: "acme.atlassian.net", region: "global", jira: false,
    });
  });

  it("rotates only the Jira token while a masked Jira email keeps the stored value", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setJiraCredentials("acme.atlassian.net", "stored@example.com", "stored-token");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(saveMessage({ jiraEmail: MASK, jiraToken: "rotated-token" }));

    expect(map.get(jiraKey("jiraEmail"))).toBe("stored@example.com");
    expect(map.get(jiraKey("jiraToken"))).toBe("rotated-token");
  });

  it("rejects a masked Jira field when the host changed and never carries old Jira creds over", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setJiraCredentials("acme.atlassian.net", "stored@example.com", "stored-token");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(saveMessage({ site: "other.atlassian.net", jiraEmail: MASK, jiraToken: MASK }));

    const posted = postedBodies(panel).filter((message) => message.type !== "busy") as Array<{
      type: string;
      errors?: { jiraEmail?: string; jiraToken?: string };
    }>;
    expect(posted.at(-1)?.type).toBe("validation");
    expect(posted.at(-1)?.errors?.jiraEmail).toBe("Enter the Jira credentials for the new site");
    expect(map.get(jiraKey("jiraEmail", "other.atlassian.net"))).toBeUndefined();
    expect(map.get(jiraKey("jiraEmail"))).toBe("stored@example.com");
  });

  it("never leaks the Jira token into the HTML or the saved message", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    const token = "super-secret-jira-token";

    await panel.__receive(saveMessage({ jiraEmail: "me@example.com", jiraToken: token }));

    expect(panel.webview.html).not.toContain(token);
    expect(JSON.stringify(postedBodies(panel))).not.toContain(token);
  });

  it("posts a project-view carrying Jira and Xray data after a full probe", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: true,
      stage: "ok",
      site: "acme.atlassian.net",
      message: "Connected to acme.atlassian.net",
      projects: [
        { project: "CALC", totalTests: 5, existsOnSite: true },
        { project: "MATH", totalTests: 0, existsOnSite: false },
      ],
      jiraProjects: [{ key: "CALC", name: "Calculator" }],
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    const view = (postedBodies(panel) as Array<{ type: string }>).find((m) => m.type === "project-view");
    expect(view).toEqual({
      type: "project-view",
      hasJira: true,
      jiraProjects: [{ key: "CALC", name: "Calculator" }],
      jiraTruncated: false,
      probed: [
        { project: "CALC", totalTests: 5, existsOnSite: true },
        { project: "MATH", totalTests: 0, existsOnSite: false },
      ],
    });
  });

  it("marks the project-view truncated when the probe reports a capped Jira list", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: true,
      stage: "ok",
      site: "acme.atlassian.net",
      message: "Connected to acme.atlassian.net",
      projects: [{ project: "CALC", totalTests: 0 }],
      jiraProjects: [{ key: "OTHER", name: "Other" }],
      jiraTruncated: true,
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    const view = (postedBodies(panel) as Array<{ type: string; jiraTruncated?: boolean }>).find(
      (m) => m.type === "project-view"
    );
    expect(view?.jiraTruncated).toBe(true);
  });

  it("rehydrates the current saved form, connection, projects, status, and idle state after reload", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const secrets = [
      "reload-client-id",
      "reload-client-secret",
      "reload@example.com",
      "reload-jira-token",
    ] as const;
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: true,
      stage: "ok",
      site: "acme.atlassian.net",
      message: "Connection ready",
      projects: [{ project: "CALC", totalTests: 5, existsOnSite: true }],
      jiraProjects: [{ key: "CALC", name: "Calculator" }],
    });
    const panel = await openPanel(commands);
    await panel.__receive(saveMessage({
      clientId: secrets[0],
      clientSecret: secrets[1],
      jiraEmail: secrets[2],
      jiraToken: secrets[3],
      test: true,
    }));
    panel.webview.__posted.length = 0;

    await reloadPanel(panel, SECOND_DOCUMENT);

    expect(postedBodies(panel)).toEqual([
      {
        type: "form-state",
        site: "acme.atlassian.net",
        region: "global",
        credentials: true,
        jira: true,
      },
      { type: "conn-state", state: "connected", label: "Connected to acme.atlassian.net" },
      {
        type: "project-view",
        hasJira: true,
        jiraProjects: [{ key: "CALC", name: "Calculator" }],
        jiraTruncated: false,
        probed: [{ project: "CALC", totalTests: 5, existsOnSite: true }],
      },
      { type: "test-result", ok: true, message: "Connection ready" },
      { type: "busy", busy: false, testing: true },
    ]);
    const outbound = JSON.stringify(panel.webview.__posted);
    for (const secret of secrets) {expect(outbound).not.toContain(secret);}
  });

  it("rehydrates a changed host as checking and busy, then settles that same document", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("old.atlassian.net");
    let settle!: (outcome: XrayConnectionOutcome) => void;
    const probe = new Promise<XrayConnectionOutcome>((resolve) => {settle = resolve;});
    vi.spyOn(commands, "probeConnection").mockReturnValue(probe);
    const panel = await openPanel(commands);
    const saving = panel.__receive(saveMessage({
      site: "new.atlassian.net",
      region: "au",
      clientId: "changed-host-client-id",
      clientSecret: "changed-host-client-secret",
      jiraEmail: "changed@example.com",
      jiraToken: "changed-host-jira-token",
      test: true,
    }));
    await flush();
    panel.webview.__posted.length = 0;

    await reloadPanel(panel, SECOND_DOCUMENT);

    expect(postedBodies(panel)).toEqual([
      {
        type: "form-state",
        site: "new.atlassian.net",
        region: "au",
        credentials: true,
        jira: true,
      },
      { type: "conn-state", state: "checking", label: "Checking connection…" },
      { type: "busy", busy: true, testing: true },
    ]);

    settle({
      ok: true,
      stage: "ok",
      site: "new.atlassian.net",
      message: "Changed host connected",
      projects: [{ project: "NEW", totalTests: 2 }],
    });
    await saving;
    expect((panel.webview.__posted as PostedSetup[]).every((message) => message.document === SECOND_DOCUMENT))
      .toBe(true);
    expect(postedBodies(panel).at(-1)).toEqual({ type: "busy", busy: false, testing: true });
    expect(postedBodies(panel)).toContainEqual(expect.objectContaining({ type: "project-view" }));
  });

  it("posts no project-view for the auth-only open verify", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    const views = (postedBodies(panel) as Array<{ type: string }>).filter((m) => m.type === "project-view");
    expect(views).toHaveLength(0);
  });
});

describe("TraceabilitySubsystem.knownTestKeys", () => {
  function makeSubsystem(): TraceabilitySubsystem {
    const logger = silentLogger();
    const config = configWith({});
    return new TraceabilitySubsystem(
      config,
      new TraceabilityAdapterRegistry(),
      FeatureParser.create(logger),
      TestDiscoveryManager.create(logger, config),
      PlaywrightJsonParser.create(logger),
      new RunResultStore(),
      logger,
      { get: () => undefined, update: () => Promise.resolve(), keys: () => [] } as unknown as vscode.Memento
    );
  }

  it("dedupes test keys across links, preserving first-seen order", () => {
    const subsystem = makeSubsystem();
    type ModelSeam = {
      model: { snapshot: { links: Array<{ testKey: string }> }; dispose: () => void } | undefined;
    };
    (subsystem as unknown as ModelSeam).model = {
      snapshot: {
        links: [
          { testKey: "CALC-1" },
          { testKey: "CALC-2" },
          { testKey: "CALC-1" },
          { testKey: "MATH-9" },
        ],
      },
      dispose: () => undefined,
    };

    expect(subsystem.knownTestKeys()).toEqual(["CALC-1", "CALC-2", "MATH-9"]);
    subsystem.dispose();
  });

  it("returns an empty array when no model exists (panel off or disposed)", () => {
    const subsystem = makeSubsystem();
    expect(subsystem.knownTestKeys()).toEqual([]);
    subsystem.dispose();
  });
});

describe("XrayConnectionCommands.disconnect", () => {
  it("reports when nothing is stored and never shows the confirm dialog", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "acme.atlassian.net" });
    const { commands } = makeCommands("acme.atlassian.net");
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await commands.disconnect();

    expect(info).toHaveBeenCalledWith("No Xray credentials are stored for this site.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("clears credentials only after the modal confirm", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "acme.atlassian.net" });
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const warn = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue(undefined as never);

    await commands.disconnect();
    expect(map.size).toBe(2);

    warn.mockResolvedValue("Disconnect" as never);
    await commands.disconnect();
    expect(map.size).toBe(0);
  });

  it("acts on the freshly-configured host, not the stale ExtensionConfig snapshot", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "new.atlassian.net" });
    const { commands, store } = makeCommands("old.atlassian.net");
    await store.setCredentials("old.atlassian.net", "old-id", "old-secret");
    await store.setCredentials("new.atlassian.net", "new-id", "new-secret");
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const warn = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Disconnect" as never);

    await commands.disconnect();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("new.atlassian.net"),
      { modal: true },
      "Disconnect"
    );
    expect(await store.getCredentials("new.atlassian.net")).toBeUndefined();
    expect(await store.getCredentials("old.atlassian.net")).toEqual({
      clientId: "old-id",
      clientSecret: "old-secret",
    });
  });
});

describe("XrayConnectionCommands.manageConnection", () => {
  async function pickedItems(site: string, seed: boolean): Promise<string[]> {
    stubWorkspaceConfig({}, { "xray.siteUrl": site });
    const { commands, store } = makeCommands(site);
    if (seed) {
      await store.setCredentials(site, "id", "secret");
    }
    let captured: vscode.QuickPickItem[] = [];
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) => {
      captured = items as vscode.QuickPickItem[];
      return Promise.resolve(undefined);
    });
    await commands.manageConnection();
    return captured.map((item) => item.label);
  }

  it("offers the connected action set when credentials exist", async () => {
    const labels = await pickedItems("acme.atlassian.net", true);
    expect(labels).toEqual([
      "$(key) Update Credentials…",
      "$(plug) Test Connection",
      "$(sign-out) Disconnect",
      "$(settings-gear) Open Settings",
    ]);
  });

  it("offers only connect/settings when no credentials exist", async () => {
    const labels = await pickedItems("acme.atlassian.net", false);
    expect(labels).toEqual(["$(plug) Connect to Xray…", "$(settings-gear) Open Settings"]);
  });

  it("reads the freshly-configured host, not the stale ExtensionConfig snapshot", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "new.atlassian.net" });
    const { commands, store } = makeCommands("old.atlassian.net");
    await store.setCredentials("new.atlassian.net", "id", "secret");
    let labels: string[] = [];
    let placeHolder = "";
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items, options) => {
      labels = (items as vscode.QuickPickItem[]).map((item) => item.label);
      placeHolder = (options as vscode.QuickPickOptions | undefined)?.placeHolder ?? "";
      return Promise.resolve(undefined);
    });

    await commands.manageConnection();

    expect(placeHolder).toBe("Connected to new.atlassian.net");
    expect(labels).toContain("$(sign-out) Disconnect");
  });
});
