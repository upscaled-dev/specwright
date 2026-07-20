import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayConnectionCommands } from "../../xray/xray-connection-commands";
import { XrayConnectionOutcome } from "../../xray/xray-connection-test";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { validateXraySetupInput } from "../../xray/xray-setup-panel";
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { TraceabilityAdapterRegistry } from "../../traceability/adapter-registry";
import { RunResultStore } from "../../traceability/run-result-store";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";

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
  return { store: new XrayCredentialStore(storage), map };
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

const MASK = "••••••••";

function makeCommands(site: string): {
  commands: XrayConnectionCommands;
  store: XrayCredentialStore;
  map: Map<string, string>;
} {
  const { store, map } = mapCredentialStore();
  return {
    commands: new XrayConnectionCommands(configWith({ "xray.siteUrl": site }), store, silentLogger(), () => []),
    store,
    map,
  };
}

interface StubPanel {
  viewType: string;
  title: string;
  webview: { html: string; __posted: unknown[] };
  __revealCount: number;
  __receive: (message: unknown) => Promise<void>;
}

const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
};

async function openPanel(commands: XrayConnectionCommands): Promise<StubPanel> {
  await commands.connect();
  return win.__webviewPanels[0]!;
}

function saveMessage(
  overrides: Partial<{
    site: string;
    clientId: string;
    clientSecret: string;
    jiraEmail: string;
    jiraToken: string;
    test: boolean;
  }> = {}
): Record<string, unknown> {
  return {
    type: "save",
    site: "acme.atlassian.net",
    clientId: "id",
    clientSecret: "secret",
    jiraEmail: "",
    jiraToken: "",
    test: false,
    ...overrides,
  };
}

afterEach(() => {
  win.__resetWebviewPanels();
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

  it("shows the hint visible, masks both credential fields, and renders the checking dot when credentials exist", async () => {
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('<p class="hint" id="cred-hint">Credentials are stored for this site');
    expect(html).toContain(`<input id="clientId" type="text" placeholder="client id" value="${MASK}"`);
    expect(html).toContain(`<input id="clientSecret" type="password" placeholder="client secret" value="${MASK}"`);
    expect(html).toContain('<span id="conn-dot" class="conn-dot checking">');
    expect(html).toContain('<span id="conn-label">Checking connection…</span>');
    expect(html).not.toContain("stored — enter to replace");
    await flush();
  });

  it("hides the hint, leaves credential fields empty, and marks not-connected when no credentials exist", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('<p class="hint" id="cred-hint" hidden>Credentials are stored for this site');
    expect(html).toContain('<input id="clientId" type="text" placeholder="client id" value=""');
    expect(html).toContain('<input id="clientSecret" type="password" placeholder="client secret" value=""');
    expect(html).toContain('<span id="conn-dot" class="conn-dot">');
    expect(html).toContain('<span id="conn-label">Not connected</span>');
  });

  it("reveals the existing panel instead of creating a second one", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();
    await commands.connect();

    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.__revealCount).toBe(1);
  });
});

describe("Xray setup panel save flow", () => {
  it("posts validation errors and stores nothing for an invalid site", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("");
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ site: "https://" }));

    expect(map.size).toBe(0);
    const posted = panel.webview.__posted as Array<{ type: string; errors?: { site?: string } }>;
    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe("validation");
    expect(posted[0]?.errors?.site).toBeTruthy();
  });

  it("stores trimmed credentials and posts a saved message on a valid save", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ clientId: "  id  ", clientSecret: "  secret  " }));

    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("secret");
    expect(panel.webview.__posted).toContainEqual({ type: "saved", site: "acme.atlassian.net", jira: false });
  });

  it("triggers an auth-only verify after a plain save and flips the dot to its outcome", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const probe = vi
      .spyOn(commands, "probeConnection")
      .mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage());

    expect(probe).toHaveBeenCalledWith("acme.atlassian.net", { authOnly: true });
    expect(panel.webview.__posted).toContainEqual({
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
      message: "Connected to acme.atlassian.net — authentication OK",
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    expect(panel.webview.__posted).toContainEqual({
      type: "conn-state",
      state: "connected",
      label: "Connected to acme.atlassian.net",
    });
    expect(panel.webview.__posted.at(-1)).toEqual({
      type: "test-result",
      ok: true,
      message: "Connected to acme.atlassian.net — authentication OK",
    });
  });

  it("shows a disconnected dot plus the message when Save & Test fails at the auth stage", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: false,
      stage: "auth",
      site: "acme.atlassian.net",
      message: "Authentication failed — check your client ID and secret.",
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    expect(panel.webview.__posted).toContainEqual({
      type: "conn-state",
      state: "disconnected",
      label: "Not connected",
    });
    expect(panel.webview.__posted.at(-1)).toEqual({
      type: "test-result",
      ok: false,
      message: "Authentication failed — check your client ID and secret.",
    });
  });

  it("keeps the dot connected when Save & Test fails only at the GraphQL stage", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: false,
      stage: "graphql",
      site: "acme.atlassian.net",
      message: "Xray GraphQL probe failed (non-OK status or GraphQL errors) — see output for details.",
    });
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    expect(panel.webview.__posted).toContainEqual({
      type: "conn-state",
      state: "connected",
      label: "Connected to acme.atlassian.net",
    });
    expect(panel.webview.__posted.at(-1)).toEqual({
      type: "test-result",
      ok: false,
      message: "Xray GraphQL probe failed (non-OK status or GraphQL errors) — see output for details.",
    });
  });

  it("posts an error message when the save itself throws", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "saveConnection").mockRejectedValue(new Error("secret storage unavailable"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage());

    expect(panel.webview.__posted.at(-1)).toEqual({
      type: "error",
      message: "Could not save: secret storage unavailable",
    });
  });

  it("reports a failed test launch after a successful save instead of swallowing it", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockRejectedValue(new Error("probe crashed"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ test: true }));

    const posted = panel.webview.__posted as Array<{ type: string }>;
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

    const posted = panel.webview.__posted as Array<{ type: string; state?: string; label?: string; message?: string }>;
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
      message: "Connected to acme.atlassian.net — authentication OK",
    });
    const panel = await openPanel(commands);
    await flush();

    await panel.__receive(
      saveMessage({ site: "https://acme.atlassian.net/", clientId: MASK, clientSecret: MASK, test: true })
    );

    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("stored-id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("stored-secret");
    expect(panel.webview.__posted.at(-1)).toEqual({
      type: "test-result",
      ok: true,
      message: "Connected to acme.atlassian.net — authentication OK",
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

    const posted = panel.webview.__posted as Array<{
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

    const posted = panel.webview.__posted as Array<{ type: string; errors?: { clientId?: string } }>;
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

    await panel.__receive(saveMessage({ clientSecret: secret }));

    expect(panel.webview.html).not.toContain(secret);
    expect(JSON.stringify(panel.webview.__posted)).not.toContain(secret);
  });
});

describe("Xray setup panel connection verification", () => {
  function connStates(panel: StubPanel): Array<{ type: string; state: string; label: string }> {
    return (panel.webview.__posted as Array<{ type: string; state?: string; label?: string }>)
      .filter((m): m is { type: string; state: string; label: string } => m.type === "conn-state");
  }

  it("verifies on open with stored credentials and flips the dot to connected", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    const probe = vi
      .spyOn(commands, "probeConnection")
      .mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    expect(probe).toHaveBeenCalledWith("acme.atlassian.net", { authOnly: true });
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
    expect(connStates(panel)).toHaveLength(0);
  });

  it("shows disconnected and the indicative message when the open verify hits a 401", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue({
      ok: false,
      stage: "auth",
      site: "acme.atlassian.net",
      message: "Authentication failed — check your client ID and secret.",
    });
    const panel = await openPanel(commands);
    await flush();

    expect(connStates(panel).at(-1)).toEqual({
      type: "conn-state",
      state: "disconnected",
      label: "Not connected",
    });
    expect(panel.webview.__posted).toContainEqual({
      type: "test-result",
      ok: false,
      message: "Authentication failed — check your client ID and secret.",
    });
  });

  it("ignores a stale verify result once a newer verify has started", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    let resolveFirst!: (outcome: XrayConnectionOutcome) => void;
    let resolveSecond!: (outcome: XrayConnectionOutcome) => void;
    const first = new Promise<XrayConnectionOutcome>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<XrayConnectionOutcome>((resolve) => { resolveSecond = resolve; });
    vi.spyOn(commands, "probeConnection").mockReturnValueOnce(first).mockReturnValueOnce(second);
    const panel = await openPanel(commands);

    const firstSave = panel.__receive(saveMessage());
    await flush();
    const secondSave = panel.__receive(saveMessage());
    await flush();

    resolveSecond({ ok: false, stage: "auth", site: "acme.atlassian.net", message: "Not connected" });
    await secondSave;
    // The stale first verify resolves last; its result must not post a conn-state.
    resolveFirst(connected("acme.atlassian.net"));
    await firstSave;

    const terminal = connStates(panel).filter((m) => m.state !== "checking");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.state).toBe("disconnected");
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
    expect(html).toContain(`<input id="jiraEmail" type="text" placeholder="you@example.com" value="${MASK}"`);
    expect(html).toContain(`<input id="jiraToken" type="password" placeholder="Jira API token" value="${MASK}"`);
  });

  it("leaves both Jira fields empty when no Jira credentials are stored", async () => {
    const { commands } = makeCommands("acme.atlassian.net");

    await commands.connect();

    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('<input id="jiraEmail" type="text" placeholder="you@example.com" value=""');
    expect(html).toContain('<input id="jiraToken" type="password" placeholder="Jira API token" value=""');
  });

  it("rejects a lone Jira email with a both-or-neither error and stores nothing", async () => {
    stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);

    await panel.__receive(saveMessage({ jiraEmail: "me@example.com", jiraToken: "" }));

    const posted = panel.webview.__posted as Array<{ type: string; errors?: { jiraToken?: string } }>;
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
    expect(panel.webview.__posted).toContainEqual({ type: "saved", site: "acme.atlassian.net", jira: true });
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
    expect(panel.webview.__posted).toContainEqual({ type: "saved", site: "acme.atlassian.net", jira: false });
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

    const posted = panel.webview.__posted as Array<{
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
    expect(JSON.stringify(panel.webview.__posted)).not.toContain(token);
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

    const view = (panel.webview.__posted as Array<{ type: string }>).find((m) => m.type === "project-view");
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

    const view = (panel.webview.__posted as Array<{ type: string; jiraTruncated?: boolean }>).find(
      (m) => m.type === "project-view"
    );
    expect(view?.jiraTruncated).toBe(true);
  });

  it("posts no project-view for the auth-only open verify", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await flush();

    const views = (panel.webview.__posted as Array<{ type: string }>).filter((m) => m.type === "project-view");
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
      logger
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
