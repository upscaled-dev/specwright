import { describe, it, expect, vi, afterEach } from "vitest";
import {
  XrayConnectionOutcome,
} from "../../xray/xray-connection-test";

import * as xray from "./helpers/xray-setup-driver";
import type { PostedSetup } from "./helpers/xray-setup-driver";

const { flush, connected, stubWorkspaceConfig, MASK, SECOND_DOCUMENT, makeCommands, win, postedBodies, lastNonBusy, openPanel, reloadPanel, saveMessage } = xray;

afterEach(() => {
  xray.resetSetupDriver();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
