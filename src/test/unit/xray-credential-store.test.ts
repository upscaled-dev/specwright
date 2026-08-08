import { describe, it, expect, vi } from "vitest";
import type * as vscode from "vscode";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { WorkspaceTrust, WorkspaceTrustRequiredError } from "../../core/workspace-trust";

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
  it("stops credential reads when trust is revoked between SecretStorage awaits", async () => {
    let trusted = true;
    const get = vi.fn((_key: string) => {
      trusted = false;
      return Promise.resolve("id");
    });
    const storage = { get } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, new WorkspaceTrust(() => trusted));

    await expect(store.getCredentials("acme.atlassian.net"))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
    expect(get).toHaveBeenCalledOnce();
  });

  it("returns no Xray secret when trust is revoked during the final read", async () => {
    let trusted = true;
    let reads = 0;
    const storage = {
      get: () => {
        reads += 1;
        if (reads === 2) {trusted = false;}
        return Promise.resolve(reads === 1 ? "id" : "secret");
      },
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, new WorkspaceTrust(() => trusted));

    await expect(store.getCredentials("acme.atlassian.net"))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
  });

  it("returns no Jira secret when trust is revoked during the final read", async () => {
    let trusted = true;
    let reads = 0;
    const storage = {
      get: () => {
        reads += 1;
        if (reads === 2) {trusted = false;}
        return Promise.resolve(reads === 1 ? "me@example.com" : "token");
      },
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, new WorkspaceTrust(() => trusted));

    await expect(store.getJiraCredentials("acme.atlassian.net"))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
  });

  it("rolls back a partial credential write when trust is revoked between stores", async () => {
    let trusted = true;
    const storeSecret = vi.fn((_key: string, _value: string) => {
      trusted = false;
      return Promise.resolve();
    });
    const deleteSecret = vi.fn(() => Promise.resolve());
    const storage = {
      get: () => Promise.resolve(undefined),
      store: storeSecret,
      delete: deleteSecret,
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, new WorkspaceTrust(() => trusted));

    await expect(store.setCredentials("acme.atlassian.net", "id", "secret"))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
    expect(storeSecret).toHaveBeenCalledOnce();
    expect(deleteSecret).toHaveBeenCalledWith("specwright.xray:acme.atlassian.net:clientId");
  });

  it("restores the previous Xray pair when trust is revoked during an update", async () => {
    const idKey = "specwright.xray:acme.atlassian.net:clientId";
    const secretKey = "specwright.xray:acme.atlassian.net:clientSecret";
    const map = new Map<string, string>([[idKey, "old-id"], [secretKey, "old-secret"]]);
    let trusted = true;
    const storage = {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {
        map.set(key, value);
        if (key === secretKey && value === "new-secret") {trusted = false;}
        return Promise.resolve();
      },
      delete: (key: string) => {map.delete(key); return Promise.resolve();},
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, new WorkspaceTrust(() => trusted));

    await expect(store.setCredentials("acme.atlassian.net", "new-id", "new-secret"))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);

    expect(map.get(idKey)).toBe("old-id");
    expect(map.get(secretKey)).toBe("old-secret");
  });

  it("removes both new Xray values when trust is revoked during the final store", async () => {
    const map = new Map<string, string>();
    let trusted = true;
    const storage = {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {
        map.set(key, value);
        if (key.endsWith(":clientSecret")) {trusted = false;}
        return Promise.resolve();
      },
      delete: (key: string) => {map.delete(key); return Promise.resolve();},
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, new WorkspaceTrust(() => trusted));

    await expect(store.setCredentials("acme.atlassian.net", "id", "secret"))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
    expect(map.size).toBe(0);
  });

  it("restores the previous Jira pair when the second store mutates then rejects", async () => {
    const emailKey = "specwright.xray:acme.atlassian.net:jiraEmail";
    const tokenKey = "specwright.xray:acme.atlassian.net:jiraToken";
    const map = new Map<string, string>([[emailKey, "old@example.com"], [tokenKey, "old-token"]]);
    const storage = {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {
        map.set(key, value);
        return key === tokenKey && value === "new-token"
          ? Promise.reject(new Error("store failed"))
          : Promise.resolve();
      },
      delete: (key: string) => {map.delete(key); return Promise.resolve();},
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, trustedWorkspace());

    await expect(store.setJiraCredentials(
      "acme.atlassian.net",
      "new@example.com",
      "new-token"
    )).rejects.toThrow("store failed");

    expect(map.get(emailKey)).toBe("old@example.com");
    expect(map.get(tokenKey)).toBe("old-token");
  });

  it("removes both new Jira values when trust is revoked during the final store", async () => {
    const map = new Map<string, string>();
    let trusted = true;
    const storage = {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {
        map.set(key, value);
        if (key.endsWith(":jiraToken")) {trusted = false;}
        return Promise.resolve();
      },
      delete: (key: string) => {map.delete(key); return Promise.resolve();},
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, new WorkspaceTrust(() => trusted));

    await expect(store.setJiraCredentials("acme.atlassian.net", "me@example.com", "token"))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
    expect(map.size).toBe(0);
  });

  it("reports when Xray update recovery cannot fully restore the previous pair", async () => {
    const idKey = "specwright.xray:acme.atlassian.net:clientId";
    const secretKey = "specwright.xray:acme.atlassian.net:clientSecret";
    const map = new Map<string, string>([[idKey, "old-id"], [secretKey, "old-secret"]]);
    const storage = {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {
        map.set(key, value);
        if (key === secretKey && value === "new-secret") {
          return Promise.reject(new Error("update failed"));
        }
        if (key === idKey && value === "old-id") {
          return Promise.reject(new Error("restore failed"));
        }
        return Promise.resolve();
      },
      delete: (key: string) => {map.delete(key); return Promise.resolve();},
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, trustedWorkspace());

    await expect(store.setCredentials("acme.atlassian.net", "new-id", "new-secret"))
      .rejects.toThrow("Credentials may be incomplete");
  });

  it("reports when Jira update recovery cannot fully restore the previous pair", async () => {
    const emailKey = "specwright.xray:acme.atlassian.net:jiraEmail";
    const tokenKey = "specwright.xray:acme.atlassian.net:jiraToken";
    const map = new Map<string, string>([[emailKey, "old@example.com"], [tokenKey, "old-token"]]);
    const storage = {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => {
        map.set(key, value);
        if (key === tokenKey && value === "new-token") {
          return Promise.reject(new Error("update failed"));
        }
        if (key === emailKey && value === "old@example.com") {
          return Promise.reject(new Error("restore failed"));
        }
        return Promise.resolve();
      },
      delete: (key: string) => {map.delete(key); return Promise.resolve();},
    } as unknown as vscode.SecretStorage;
    const store = new XrayCredentialStore(storage, trustedWorkspace());

    await expect(store.setJiraCredentials("acme.atlassian.net", "new@example.com", "new-token"))
      .rejects.toThrow("Credentials may be incomplete");
  });

  it("keys secrets by the normalized site host", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    await store.setCredentials("https://acme.atlassian.net/", "id-1", "secret-1");
    expect([...map.keys()].sort()).toEqual([
      "specwright.xray:acme.atlassian.net:clientId",
      "specwright.xray:acme.atlassian.net:clientSecret",
    ]);
  });

  it("resolves the same entry regardless of scheme/trailing slash", async () => {
    const { storage } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    await store.setCredentials("https://acme.atlassian.net/", "id", "secret");
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("returns undefined unless both halves are present", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
    map.set("specwright.xray:acme.atlassian.net:clientId", "id-only");
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
    map.set("specwright.xray:acme.atlassian.net:clientSecret", "secret");
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id-only", clientSecret: "secret" });
  });

  it("returns undefined for a stale secret-only entry", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    map.set("specwright.xray:acme.atlassian.net:clientSecret", "secret-only");
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
    expect(await store.hasCredentials("acme.atlassian.net")).toBe(false);
  });

  it("round-trips set, has, and clear", async () => {
    const { storage } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    expect(await store.hasCredentials("acme.atlassian.net")).toBe(true);
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
    await store.clearCredentials("acme.atlassian.net");
    expect(await store.hasCredentials("acme.atlassian.net")).toBe(false);
    expect(await store.getCredentials("acme.atlassian.net")).toBeUndefined();
  });

  it("clear removes both halves from the backing storage", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    expect(map.size).toBe(2);
    await store.clearCredentials("acme.atlassian.net");
    expect(map.size).toBe(0);
  });

  it("resolves case variants of the same host to one credential slot", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    await store.setCredentials("Acme.Atlassian.net", "id", "secret");
    expect([...map.keys()].every((key) => key.includes(":acme.atlassian.net:"))).toBe(true);
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("refuses a site that normalizes to an empty host", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    await expect(store.setCredentials("https://", "id", "secret")).rejects.toThrow(
      "empty host"
    );
    expect(map.size).toBe(0);
    await expect(store.getCredentials("https://")).rejects.toThrow("empty host");
  });

  it("fires onDidChange once per own write and once per own clear", async () => {
    const { storage } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
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
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    fireChange("specwright.xray:acme.atlassian.net:clientId");
    expect(fires).toBe(1);
    store.dispose();
  });

  it("ignores SecretStorage changes for keys outside its namespace", () => {
    const { storage, fireChange } = bridgedSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    fireChange("some.other.extension:token");
    expect(fires).toBe(0);
    store.dispose();
  });

  it("keys Jira secrets under jiraEmail/jiraToken and round-trips both-or-neither", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());

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
    const store = new XrayCredentialStore(storage, trustedWorkspace());
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
    const store = new XrayCredentialStore(storage, trustedWorkspace());
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    await store.setJiraCredentials("acme.atlassian.net", "me@example.com", "jira-token");
    expect(map.size).toBe(4);

    await store.clearJiraCredentials("acme.atlassian.net");

    expect(await store.getJiraCredentials("acme.atlassian.net")).toBeUndefined();
    expect(await store.getCredentials("acme.atlassian.net")).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("clearCredentials tears down both the Xray and the Jira pair for the host", async () => {
    const { storage, map } = mapSecretStorage();
    const store = new XrayCredentialStore(storage, trustedWorkspace());
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
    const store = new XrayCredentialStore(storage, trustedWorkspace());
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
    const store = new XrayCredentialStore(storage, trustedWorkspace());
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
    const store = new XrayCredentialStore(storage, trustedWorkspace());
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
