import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { WorkspaceTrust } from "../../core/workspace-trust";

import * as xray from "./helpers/xray-setup-driver";
import type { PostedSetup } from "./helpers/xray-setup-driver";

const { flush, connected, stubWorkspaceConfig, MASK, SECOND_DOCUMENT, makeCommands, postedBodies, lastNonBusy, openPanel, reloadPanel, saveMessage } = xray;

afterEach(() => {
  xray.resetSetupDriver();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
