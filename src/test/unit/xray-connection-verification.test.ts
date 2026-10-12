import { describe, it, expect, vi, afterEach } from "vitest";
import {
  XrayConnectionOutcome,
} from "../../xray/xray-connection-test";
import { XraySetupPanel } from "../../xray/xray-setup-panel";
import { WorkspaceTrust } from "../../core/workspace-trust";
import type { XrayCredentials } from "../../xray/xray-credential-store";
import {
  WEBVIEW_PROTOCOL_VERSION,
} from "../../webview/setup-protocol";

import * as xray from "./helpers/xray-setup-driver";
import type { StubPanel, PostedSetup } from "./helpers/xray-setup-driver";

const { flush, connected, stubWorkspaceConfig, MASK, makeCommands, win, FIRST_DOCUMENT, sessionOf, postedBodies, lastNonBusy, openPanel, saveMessage } = xray;

let activeDocument = FIRST_DOCUMENT;

afterEach(() => {
  xray.resetSetupDriver();
  activeDocument = FIRST_DOCUMENT;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Xray setup panel connection verification", () => {
  it("settles opening verification when the delegate throws before returning a promise", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    const show = XraySetupPanel.show.bind(XraySetupPanel);
    vi.spyOn(XraySetupPanel, "show").mockImplementation((delegate, root) => show({
      ...delegate,
      verifyConnection: () => {throw new Error("verification unavailable");},
    }, root));
    const panel = await openPanel(commands);
    await vi.waitFor(() => expect(lastNonBusy(panel)).toEqual({
      type: "error", message: "Could not verify connection: verification unavailable",
    }));
    expect(connStates(panel).at(-1)).toEqual({ type: "conn-state", state: "disconnected", label: "Not connected" });
    await XraySetupPanel.close();
    expect(panel.__disposed).toBe(true);
  });

  it("drains a committed save after the user closes the panel without starting a replacement probe", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    const panel = await openPanel(commands);
    let finishSave!: () => void;
    const admittedSave = new Promise<void>(resolve => {finishSave = resolve;});
    const saveSetup = commands.saveSetup.bind(commands);
    const save = vi.spyOn(commands, "saveSetup").mockImplementation(async input => {
      await admittedSave;
      return saveSetup(input);
    });
    const probe = vi.spyOn(commands, "probeConnection");
    const saving = panel.__receive(saveMessage({ clientId: "new-id", clientSecret: "new-secret" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    let closed = false;
    const closing = XraySetupPanel.close().then(() => {closed = true;});
    expect(panel.__disposed).toBe(true);
    expect(closed).toBe(false);
    const count = panel.webview.__posted.length;
    finishSave();
    await Promise.all([saving, closing]);
    expect(closed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(panel.webview.__posted).toHaveLength(count);
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "new-id", clientSecret: "new-secret" });
  });

  it("ignores a ready replay carrying a host revision and keeps the hydrated form usable", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    const panel = await openPanel(commands);
    const count = panel.webview.__posted.length;
    const revision = (panel.webview.__posted.at(-1) as PostedSetup).revision;
    await panel.__receive({
      version: WEBVIEW_PROTOCOL_VERSION, session: sessionOf(panel), document: FIRST_DOCUMENT,
      revision, surface: "setup", body: { type: "ready" },
    });
    expect(panel.webview.__posted).toHaveLength(count);
    await panel.__receive(saveMessage({ clientId: "new-id", clientSecret: "new-secret", test: false }));
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "new-id", clientSecret: "new-secret" });
    expect(connStates(panel).at(-1)?.state).toBe("connected");
  });

  it("asks for a new secret when the issued same-site mask no longer has stored credentials", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "old-id", "old-secret");
    const panel = await openPanel(commands);
    await vi.waitFor(() => expect(connStates(panel).at(-1)?.state).toBe("connected"));
    vi.spyOn(store, "getCredentials").mockResolvedValue(undefined);
    const save = vi.spyOn(commands, "saveSetup");
    await panel.__receive(saveMessage({ clientId: "new-id", clientSecret: MASK }));
    expect(lastNonBusy(panel)).toEqual({ type: "validation", errors: { clientSecret: "Enter your Xray client secret" } });
    expect(save).not.toHaveBeenCalled();
  });

  it("reveals a panel still detecting credentials and discards that detection after the user closes it", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    let finishPresence!: (present: boolean) => void;
    const presence = vi.spyOn(store, "hasCredentials").mockReturnValue(new Promise(resolve => {finishPresence = resolve;}));
    const probe = vi.spyOn(commands, "probeConnection");
    const opening = commands.connect();
    await vi.waitFor(() => expect(presence).toHaveBeenCalled());
    const panel = win.__webviewPanels[0]!;
    await commands.connect();
    expect(panel.__revealCount).toBe(1);
    (panel as unknown as { dispose(): void }).dispose();
    finishPresence(true);
    await opening;
    await XraySetupPanel.close();
    expect(panel.__disposed).toBe(true);
    expect(panel.webview.html).toBe("");
    expect(panel.webview.__posted).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("requires a new secret when a masked secret is submitted for a different host", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "old-id", "old-secret");
    const panel = await openPanel(commands);
    await vi.waitFor(() => expect(connStates(panel).at(-1)?.state).toBe("connected"));
    const save = vi.spyOn(commands, "saveSetup");
    await panel.__receive(saveMessage({ site: "new.atlassian.net", clientId: "new-id", clientSecret: MASK }));
    expect(lastNonBusy(panel)).toEqual({ type: "validation", errors: { clientSecret: "Enter the credentials for the new site" } });
    expect(save).not.toHaveBeenCalled();
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "old-id", clientSecret: "old-secret" });
    expect(await store.getCredentials("new.atlassian.net")).toBeUndefined();
  });

  it("preserves a committed save and skips its replacement probe when trust is lost at checking", async () => {
    stubWorkspaceConfig();
    let available = true;
    const { commands, store } = makeCommands("acme.atlassian.net", "global", new WorkspaceTrust(() => available));
    const panel = await openPanel(commands);
    const probe = vi.spyOn(commands, "probeConnection");
    const post = panel.webview.postMessage.bind(panel.webview);
    vi.spyOn(panel.webview, "postMessage").mockImplementation(message => {
      const body = (message as PostedSetup).body;
      if (body.type === "conn-state" && body.state === "checking") {available = false;}
      return post(message);
    });
    await panel.__receive(saveMessage({ clientId: "new-id", clientSecret: "new-secret" }));
    expect(probe).not.toHaveBeenCalled();
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "new-id", clientSecret: "new-secret" });
    expect(postedBodies(panel)).toContainEqual({ type: "saved", site: "acme.atlassian.net", region: "global", jira: false });
  });
  it("reports credentials removed between presence detection and verification", async () => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    vi.spyOn(store, "hasCredentials").mockResolvedValue(true);
    vi.spyOn(store, "getCredentials").mockResolvedValue(undefined);
    const probe = vi.spyOn(commands, "probeConnection");
    const panel = await openPanel(commands);
    await vi.waitFor(() => expect(lastNonBusy(panel)).toEqual({
      type: "error", message: "Could not verify connection: stored credentials could not be read.",
    }));
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a stored credential %s after the panel closes", async (outcome) => {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands("acme.atlassian.net");
    vi.spyOn(store, "hasCredentials").mockResolvedValue(true);
    let resolve!: (value: XrayCredentials) => void;
    let reject!: (error: Error) => void;
    const read = vi.spyOn(store, "getCredentials").mockReturnValue(new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    }));
    const probe = vi.spyOn(commands, "probeConnection");
    const panel = await openPanel(commands);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const closing = XraySetupPanel.close();
    const count = panel.webview.__posted.length;
    if (outcome === "resolve") {resolve({ clientId: "id", clientSecret: "secret" });}
    else {reject(new Error("retired credential read"));}
    await closing;
    expect(panel.__disposed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(panel.webview.__posted).toHaveLength(count);
  });

  it("does not commit a masked credential save when trust is lost during its read", async () => {
    stubWorkspaceConfig();
    let available = true;
    const { commands, store } = makeCommands("acme.atlassian.net", "global", new WorkspaceTrust(() => available));
    await store.setCredentials("acme.atlassian.net", "stored-id", "stored-secret");
    vi.spyOn(commands, "probeConnection").mockResolvedValue(connected("acme.atlassian.net"));
    const panel = await openPanel(commands);
    await vi.waitFor(() => expect(connStates(panel).at(-1)?.state).toBe("connected"));
    let resolve!: (value: XrayCredentials) => void;
    const read = vi.spyOn(store, "getCredentials").mockReturnValueOnce(new Promise((done) => {resolve = done;}));
    const save = vi.spyOn(commands, "saveSetup");
    const saving = panel.__receive(saveMessage({ clientId: MASK, clientSecret: MASK }));
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    available = false;
    resolve({ clientId: "stored-id", clientSecret: "stored-secret" });
    await saving;
    expect(save).not.toHaveBeenCalled();
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "stored-id", clientSecret: "stored-secret" });
  });

  it("rejects a Jira token without an email before saving or probing", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const panel = await openPanel(commands);
    const save = vi.spyOn(commands, "saveSetup");
    const probe = vi.spyOn(commands, "probeConnection");
    await panel.__receive(saveMessage({ jiraToken: "token", jiraEmail: " " }));
    expect(lastNonBusy(panel)).toEqual({ type: "validation", errors: {
      jiraEmail: "Enter both a Jira email and API token, or leave both blank",
    } });
    expect(save).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
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
