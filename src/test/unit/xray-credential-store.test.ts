import { describe, it, expect } from "vitest";
import type * as vscode from "vscode";
import { XrayCredentialStore } from "../../xray/xray-credential-store";

function mapSecretStorage(): { storage: vscode.SecretStorage; map: Map<string, string> } {
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
  return { storage, map };
}

// A SecretStorage stub whose onDidChange can be fired by hand, so tests can drive the cross-window
// bridge and prove it neither double-fires for own writes nor reacts to foreign keys.
function bridgedSecretStorage(): {
  storage: vscode.SecretStorage;
  map: Map<string, string>;
  fireChange: (key: string) => void;
} {
  const map = new Map<string, string>();
  const listeners: Array<(event: { key: string }) => void> = [];
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
    onDidChange: (listener: (event: { key: string }) => void): { dispose: () => void } => {
      listeners.push(listener);
      return { dispose: () => { /* no-op */ } };
    },
  } as unknown as vscode.SecretStorage;
  return { storage, map, fireChange: (key) => { for (const l of listeners) { l({ key }); } } };
}

describe("XrayCredentialStore", () => {
  it("keys secrets by the normalized site host", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await store.setCredentials("https://acme.atlassian.net/", "id-1", "secret-1");
    expect([...map.keys()].sort()).toEqual([
      "specwright.xray:acme.atlassian.net:clientId",
      "specwright.xray:acme.atlassian.net:clientSecret",
    ]);
  });

  it("resolves the same entry regardless of scheme/trailing slash", async () => {
    const { storage } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await store.setCredentials("https://acme.atlassian.net/", "id", "secret");
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("returns undefined unless both halves are present", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
    map.set("specwright.xray:acme.atlassian.net:clientId", "id-only");
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
    map.set("specwright.xray:acme.atlassian.net:clientSecret", "secret");
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id-only", clientSecret: "secret" });
  });

  it("returns undefined for a stale secret-only entry", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    map.set("specwright.xray:acme.atlassian.net:clientSecret", "secret-only");
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
    expect(await store.hasCredentials("acme.atlassian.net")).toBe(false);
  });

  it("round-trips set, has, and clear", async () => {
    const { storage } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    expect(await store.hasCredentials("acme.atlassian.net")).toBe(true);
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
    await store.clearCredentials("acme.atlassian.net");
    expect(await store.hasCredentials("acme.atlassian.net")).toBe(false);
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
  });

  it("clear removes both halves from the backing storage", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    expect(map.size).toBe(2);
    await store.clearCredentials("acme.atlassian.net");
    expect(map.size).toBe(0);
  });

  it("resolves case variants of the same host to one credential slot", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await store.setCredentials("Acme.Atlassian.net", "id", "secret");
    expect([...map.keys()].every((key) => key.includes(":acme.atlassian.net:"))).toBe(true);
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("refuses a site that normalizes to an empty host", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await expect(store.setCredentials("https://", "id", "secret")).rejects.toThrow(
      "empty host"
    );
    expect(map.size).toBe(0);
    await expect(store.getCredentials("https://")).rejects.toThrow("empty host");
  });

  it("fires onDidChange once per own write and once per own clear", async () => {
    const { storage } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    expect(fires).toBe(1);
    await store.clearCredentials("acme.atlassian.net");
    expect(fires).toBe(2);
    store.dispose();
  });

  it("bridges a cross-window change for a namespace key into onDidChange", () => {
    const { storage, fireChange } = bridgedSecretStorage();
    const store = new XrayCredentialStore(storage);
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    fireChange("specwright.xray:acme.atlassian.net:clientId");
    expect(fires).toBe(1);
    store.dispose();
  });

  it("ignores SecretStorage changes for keys outside its namespace", () => {
    const { storage, fireChange } = bridgedSecretStorage();
    const store = new XrayCredentialStore(storage);
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    fireChange("some.other.extension:token");
    expect(fires).toBe(0);
    store.dispose();
  });

  it("keys Jira secrets under jiraEmail/jiraToken and round-trips both-or-neither", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);

    expect(await store.getJiraCredentials("acme.atlassian.net")).toBeUndefined();
    expect(await store.hasJiraCredentials("acme.atlassian.net")).toBe(false);

    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");
    expect([...map.keys()].sort()).toEqual([
      "specwright.xray:acme.atlassian.net:jiraEmail",
      "specwright.xray:acme.atlassian.net:jiraToken",
    ]);
    expect(await store.getJiraCredentials("acme.atlassian.net")).toEqual({
      email: "me@example.com",
      token: "jira-token",
    });
    expect(await store.hasJiraCredentials("acme.atlassian.net")).toBe(true);
  });

  it("returns undefined when only one Jira half is present", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    map.set("specwright.xray:acme.atlassian.net:jiraEmail", "me@example.com");
    expect(await store.getJiraCredentials("acme.atlassian.net")).toBeUndefined();
    map.set("specwright.xray:acme.atlassian.net:jiraToken", "jira-token");
    expect(await store.getJiraCredentials("acme.atlassian.net")).toEqual({
      email: "me@example.com",
      token: "jira-token",
    });
  });

  it("clearJiraCredentials removes both Jira halves and leaves the Xray pair intact", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");
    expect(map.size).toBe(4);

    await store.clearJiraCredentials("acme.atlassian.net");

    expect(await store.getJiraCredentials("acme.atlassian.net")).toBeUndefined();
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("clearCredentials tears down both the Xray and the Jira pair for the host", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");
    expect(map.size).toBe(4);

    await store.clearCredentials("acme.atlassian.net");

    expect(map.size).toBe(0);
    expect(await store.hasCredentials("acme.atlassian.net")).toBe(false);
    expect(await store.hasJiraCredentials("acme.atlassian.net")).toBe(false);
  });

  it("fires onDidChange once per Jira write and once per Jira clear", async () => {
    const { storage } = mapSecretStorage();
    const store = new XrayCredentialStore(storage);
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");
    expect(fires).toBe(1);
    await store.clearJiraCredentials("acme.atlassian.net");
    expect(fires).toBe(2);
    store.dispose();
  });

  it("does not double-fire when the bridge re-delivers a Jira key the store itself just wrote", async () => {
    const { storage, fireChange } = bridgedSecretStorage();
    const store = new XrayCredentialStore(storage);
    let fires = 0;
    store.onDidChange(() => { fires += 1; });

    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");
    expect(fires).toBe(1);
    fireChange("specwright.xray:acme.atlassian.net:jiraEmail");
    fireChange("specwright.xray:acme.atlassian.net:jiraToken");
    expect(fires).toBe(1);
    store.dispose();
  });

  it("does not double-fire when the bridge re-delivers a key the store itself just wrote", async () => {
    const { storage, fireChange } = bridgedSecretStorage();
    const store = new XrayCredentialStore(storage);
    let fires = 0;
    store.onDidChange(() => { fires += 1; });

    await store.setCredentials("acme.atlassian.net", "id", "secret");
    expect(fires).toBe(1);
    // The SecretStorage-level events for the two keys we just wrote must be swallowed.
    fireChange("specwright.xray:acme.atlassian.net:clientId");
    fireChange("specwright.xray:acme.atlassian.net:clientSecret");
    expect(fires).toBe(1);
    // The suppression is one-shot: a later change to the same key is a genuine cross-window edit.
    fireChange("specwright.xray:acme.atlassian.net:clientId");
    expect(fires).toBe(2);
    store.dispose();
  });
});
