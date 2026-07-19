import { describe, it, expect } from "vitest";
import type * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { JIRA_KEY_SHAPE, normalizeSiteUrl, projectFromKey, XrayAdapter } from "../../xray/xray-adapter";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { TraceabilityAdapter } from "../../traceability/contracts";

function mapSecretStorage(): vscode.SecretStorage {
  const map = new Map<string, string>();
  return {
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

describe("normalizeSiteUrl", () => {
  it("passes a bare host through", () => {
    expect(normalizeSiteUrl("acme.atlassian.net")).toBe("acme.atlassian.net");
  });

  it("strips an http/https scheme", () => {
    expect(normalizeSiteUrl("https://acme.atlassian.net")).toBe("acme.atlassian.net");
    expect(normalizeSiteUrl("HTTP://acme.atlassian.net")).toBe("acme.atlassian.net");
  });

  it("strips trailing slashes and surrounding whitespace", () => {
    expect(normalizeSiteUrl("  acme.atlassian.net//  ")).toBe("acme.atlassian.net");
  });
});

describe("projectFromKey", () => {
  it("derives the project from the key prefix", () => {
    expect(projectFromKey("CALC-1043")).toBe("CALC");
    expect(projectFromKey("AB12-7")).toBe("AB12");
  });

  it("keeps every segment before the trailing number for multi-segment keys", () => {
    expect(projectFromKey("AB-CD-123")).toBe("AB-CD");
  });
});

describe("XrayAdapter", () => {
  it("exposes the xray id/label and the Jira key grammar fed from config", () => {
    const adapter: TraceabilityAdapter = new XrayAdapter(
      configWith({ "traceability.testTagPrefix": "XT_", "traceability.reqTagPrefix": "COV_" })
    );
    expect(adapter.id).toBe("xray");
    expect(adapter.label).toBe("Xray");
    expect(adapter.keyGrammar.keyShape).toBe(JIRA_KEY_SHAPE);
    expect(adapter.keyGrammar.testPrefix).toBe("XT_");
    expect(adapter.keyGrammar.projectOf?.("CALC-1043")).toBe("CALC");
    expect(adapter.metadata).toBeUndefined();
    expect(adapter.connection).toBeUndefined();
  });

  it("canonicalizes keys to uppercase through the grammar", () => {
    const adapter = new XrayAdapter(configWith({}));
    expect(adapter.keyGrammar.canonicalizeKey("calc-1")).toBe("CALC-1");
  });

  it("reads the prefixes live so a config change is reflected", () => {
    const adapter = new XrayAdapter(configWith({ "traceability.reqTagPrefix": "COVERS_" }));
    expect(adapter.keyGrammar.reqPrefix).toBe("COVERS_");
    expect(adapter.keyGrammar.testPrefix).toBe("TEST_");
  });

  it("falls back to the default prefix when the configured prefix is empty/whitespace", () => {
    const adapter = new XrayAdapter(configWith({ "traceability.testTagPrefix": "  ", "traceability.reqTagPrefix": "" }));
    expect(adapter.keyGrammar.testPrefix).toBe("TEST_");
    expect(adapter.keyGrammar.reqPrefix).toBe("REQ_");
  });

  it("builds a browse URL from a bare host", () => {
    const adapter = new XrayAdapter(configWith({ "xray.siteUrl": "acme.atlassian.net" }));
    expect(adapter.browseUrl({ key: "CALC-1" })).toBe("https://acme.atlassian.net/browse/CALC-1");
  });

  it("normalizes a pasted scheme and trailing slash in the browse URL", () => {
    const adapter = new XrayAdapter(configWith({ "xray.siteUrl": "https://acme.atlassian.net/" }));
    expect(adapter.browseUrl({ key: "CALC-1" })).toBe("https://acme.atlassian.net/browse/CALC-1");
  });

  it("returns undefined when siteUrl is unset", () => {
    const adapter = new XrayAdapter(configWith({}));
    expect(adapter.browseUrl({ key: "CALC-1" })).toBeUndefined();
  });
});

describe("XrayAdapter connection capability", () => {
  it("exposes a thin connection view over the credential store when one is supplied", async () => {
    const store = new XrayCredentialStore(mapSecretStorage());
    const adapter = new XrayAdapter(configWith({ "xray.siteUrl": "acme.atlassian.net" }), store);

    expect(adapter.connection?.label).toBe("acme.atlassian.net");
    expect(await adapter.connection?.isConnected()).toBe(false);

    await store.setCredentials("acme.atlassian.net", "id-1", "secret-1");
    expect(await adapter.connection?.isConnected()).toBe(true);
  });

  it("reports disconnected when the site is unset even with stored credentials", async () => {
    const store = new XrayCredentialStore(mapSecretStorage());
    await store.setCredentials("acme.atlassian.net", "id-1", "secret-1");
    const adapter = new XrayAdapter(configWith({}), store);
    expect(await adapter.connection?.isConnected()).toBe(false);
  });
});
