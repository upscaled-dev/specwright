import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { XrayConnectionCommands } from "../../xray/xray-connection-commands";
import {
  probeXrayConnection,
} from "../../xray/xray-connection-test";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { XraySetupPanel } from "../../xray/xray-setup-panel";
import { WorkspaceTrust } from "../../core/workspace-trust";

import * as xray from "./helpers/xray-setup-driver";

const { flush, connected, configWith, silentLogger, stubWorkspaceConfig, statefulWorkspaceConfig, MASK, makeCommands, win, postedBodies, lastNonBusy, openPanel } = xray;

afterEach(() => {
  xray.resetSetupDriver();
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
