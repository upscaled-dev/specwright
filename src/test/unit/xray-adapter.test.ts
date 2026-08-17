import { afterEach, describe, it, expect, vi } from "vitest";
import type * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import {
  classifyXrayBinding,
  JIRA_KEY_SHAPE,
  normalizeSiteUrl,
  projectFromKey,
  XrayAdapter,
} from "../../xray/xray-adapter";
import { createXrayAdapterFactory } from "../../xray/xray-adapter-factory";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import type {
  XrayConnectionOutcome,
  XrayConnectionTestDeps,
  XrayProbeOptions,
} from "../../xray/xray-connection-test";
import { NotSupportedError, TraceabilityAdapter } from "../../traceability/contracts";
import { XrayPublishSupport } from "../../xray/xray-adapter-factory";
import { Logger } from "../../utils/logger";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { xrayBaseUrl } from "../../xray/xray-region";

const NOOP_PUBLISH_SUPPORT: XrayPublishSupport = {
  resolveSteps: () => undefined,
  workspaceRootFor: () => undefined,
};

afterEach(() => vi.unstubAllGlobals());

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

  // An import response that named no execution leaves an empty ref, and /browse/ with nothing after it
  // is a dead link.
  it("returns undefined for a ref with no key rather than a link to /browse/", () => {
    const adapter = new XrayAdapter(configWith({ "xray.siteUrl": "acme.atlassian.net" }));
    expect(adapter.browseUrl({ key: "" })).toBeUndefined();
  });
});

describe("XrayAdapter connection capability", () => {
  it("exposes a thin connection view over the credential store when one is supplied", async () => {
    const store = new XrayCredentialStore(mapSecretStorage(), trustedWorkspace());
    const adapter = new XrayAdapter(configWith({ "xray.siteUrl": "acme.atlassian.net" }), {
      credentialStore: store,
    });

    expect(adapter.connection?.label).toBe("acme.atlassian.net");
    expect(await adapter.connection?.isConnected()).toBe(false);

    await store.setCredentials("acme.atlassian.net", "id-1", "secret-1");
    expect(await adapter.connection?.isConnected()).toBe(true);
  });

  it("reports disconnected when the site is unset even with stored credentials", async () => {
    const store = new XrayCredentialStore(mapSecretStorage(), trustedWorkspace());
    await store.setCredentials("acme.atlassian.net", "id-1", "secret-1");
    const adapter = new XrayAdapter(configWith({}), { credentialStore: store });
    expect(await adapter.connection?.isConnected()).toBe(false);
  });
});

function mutableConfig(values: Record<string, unknown>): ExtensionConfig {
  const workspaceConfig = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key in values ? (values[key] as T) : defaultValue,
    update: (): Promise<void> => Promise.resolve(),
    inspect: (key: string): { key: string } => ({ key }),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(workspaceConfig, false);
}

function fakeMemento(): vscode.Memento {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => map.get(key) as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...map.keys()],
  } as unknown as vscode.Memento;
}

interface ProbeCall {
  deps: XrayConnectionTestDeps;
  options: XrayProbeOptions | undefined;
}

function recordingProbe(outcome: XrayConnectionOutcome): {
  probe: (deps: XrayConnectionTestDeps, options?: XrayProbeOptions) => Promise<XrayConnectionOutcome>;
  calls: ProbeCall[];
} {
  const calls: ProbeCall[] = [];
  return {
    calls,
    probe: (deps, options) => {
      calls.push({ deps, options });
      return Promise.resolve(outcome);
    },
  };
}

describe("createXrayAdapterFactory verify", () => {
  it("runs an auth-only probe with a live site read and maps ok → ok", async () => {
    const store = new XrayCredentialStore(mapSecretStorage(), trustedWorkspace());
    const values: Record<string, unknown> = { "xray.siteUrl": "old.atlassian.net" };
    const config = mutableConfig(values);
    const { probe, calls } = recordingProbe({
      ok: true,
      stage: "ok",
      site: "new.atlassian.net",
      message: "Connected to new.atlassian.net",
    });
    const adapter = createXrayAdapterFactory(
      store,
      probe,
      fakeMemento(),
      NOOP_PUBLISH_SUPPORT,
      trustedWorkspace()
    ).create({ config, logger: Logger.create() });

    // The site is read at verify time, not captured at create time.
    values["xray.siteUrl"] = "new.atlassian.net";
    const result = await adapter.connection!.verify!();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ authOnly: true });
    expect(calls[0]!.deps.site).toBe("new.atlassian.net");
    expect(calls[0]!.deps.knownTestKeys()).toEqual([]);
    expect(result).toEqual({ status: "ok", message: "Connected to new.atlassian.net" });
  });

  it("maps a network-stage outcome to unreachable", async () => {
    const store = new XrayCredentialStore(mapSecretStorage(), trustedWorkspace());
    const config = mutableConfig({ "xray.siteUrl": "acme.atlassian.net" });
    const { probe } = recordingProbe({
      ok: false,
      stage: "network",
      site: "acme.atlassian.net",
      message: "Could not reach Xray: check your network connection.",
    });
    const adapter = createXrayAdapterFactory(
      store,
      probe,
      fakeMemento(),
      NOOP_PUBLISH_SUPPORT,
      trustedWorkspace()
    ).create({ config, logger: Logger.create() });

    expect(await adapter.connection!.verify!()).toEqual({
      status: "unreachable",
      message: "Could not reach Xray: check your network connection.",
    });
  });

  it("maps an auth-stage outcome to auth-failed", async () => {
    const store = new XrayCredentialStore(mapSecretStorage(), trustedWorkspace());
    const config = mutableConfig({ "xray.siteUrl": "acme.atlassian.net" });
    const { probe } = recordingProbe({
      ok: false,
      stage: "auth",
      site: "acme.atlassian.net",
      message: "Authentication failed: check your client ID and secret.",
    });
    const adapter = createXrayAdapterFactory(
      store,
      probe,
      fakeMemento(),
      NOOP_PUBLISH_SUPPORT,
      trustedWorkspace()
    ).create({ config, logger: Logger.create() });

    expect(await adapter.connection!.verify!()).toEqual({
      status: "auth-failed",
      message: "Authentication failed: check your client ID and secret.",
    });
  });

  it("captures the selected region for each replacement adapter endpoint", async () => {
    const store = new XrayCredentialStore(mapSecretStorage(), trustedWorkspace());
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    const values: Record<string, unknown> = {
      "xray.siteUrl": "acme.atlassian.net",
      "xray.apiRegion": "global",
    };
    const config = mutableConfig(values);
    const { probe, calls } = recordingProbe({
      ok: true,
      stage: "ok",
      site: "acme.atlassian.net",
      message: "Connected",
    });
    const factory = createXrayAdapterFactory(
      store,
      probe,
      fakeMemento(),
      NOOP_PUBLISH_SUPPORT,
      trustedWorkspace()
    );

    const globalAdapter = factory.create({ config, logger: Logger.create() });
    await globalAdapter.connection!.verify!();
    await globalAdapter.dispose?.();
    values["xray.apiRegion"] = "au";
    const auAdapter = factory.create({ config, logger: Logger.create() });
    await auAdapter.connection!.verify!();
    const urls: string[] = [];
    const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      const body = url.endsWith("/authenticate")
        ? JSON.stringify(jwt)
        : JSON.stringify({ data: { getTests: { total: 0, results: [] } } });
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: () => Promise.resolve(body),
      } as unknown as Response);
    });
    await auAdapter.remoteSearch!.search("CALC-1");

    expect(calls.map(({ deps }) => xrayBaseUrl(deps.region))).toEqual([
      "https://xray.cloud.getxray.app/api/v2",
      "https://au.xray.cloud.getxray.app/api/v2",
    ]);
    expect(urls).toEqual([
      "https://au.xray.cloud.getxray.app/api/v2/authenticate",
      "https://au.xray.cloud.getxray.app/api/v2/graphql",
    ]);
    await auAdapter.dispose?.();
  });
});

describe("classifyXrayBinding", () => {
  it("treats a Gherkin target as compatible", () => {
    expect(classifyXrayBinding({ key: "CALC-1", testType: { name: "Cucumber", kind: "Gherkin" } })).toBe("compatible");
  });

  it("treats a non-Gherkin target as an incompatible test type", () => {
    expect(classifyXrayBinding({ key: "CALC-1", testType: { name: "Manual", kind: "Manual" } })).toBe("incompatible-test-type");
  });

  it("returns unknown (never blocking) when metadata or its testType is absent", () => {
    expect(classifyXrayBinding(undefined)).toBe("unknown");
    expect(classifyXrayBinding({ key: "CALC-1" })).toBe("unknown");
  });
});

describe("XrayAdapter.automationBinding", () => {
  it("exposes classify offline and rejects bind with a typed NotSupportedError (a P3 write path)", async () => {
    const adapter = new XrayAdapter(configWith({}));
    expect(adapter.automationBinding.classify({ key: "CALC-1", testType: { name: "Cucumber", kind: "Gherkin" } })).toBe("compatible");
    await expect(adapter.automationBinding.bind({ kind: "testCase", key: "CALC-1" })).rejects.toThrow(/P3/);
    await expect(adapter.automationBinding.bind({ kind: "testCase", key: "CALC-1" })).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe("XrayAdapter.testAuthoring", () => {
  it("is absent on a browse-only adapter, so the link picker offers no create entry", () => {
    expect(new XrayAdapter(configWith({})).testAuthoring).toBeUndefined();
  });

  it("delegates to the injected authoring capability when the live adapter carries one", async () => {
    const created = { key: "CALC-9", warnings: [] };
    const authoring = { createTest: vi.fn(() => Promise.resolve(created)) };
    const adapter = new XrayAdapter(configWith({}), { testAuthoring: authoring });

    await expect(
      adapter.testAuthoring?.createTest({ project: "CALC", summary: "S", gherkin: "Scenario: S" })
    ).resolves.toBe(created);
    expect(authoring.createTest).toHaveBeenCalledOnce();
  });
});

describe("XrayAdapter disposal", () => {
  it("awaits metadata lifecycle disposal", async () => {
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => {finish = resolve;});
    const metadata = {
      onDidChange: () => ({ dispose: () => {} }),
      snapshot: () => ({
        tests: new Map(), fetchedScopes: [], catalogueProjects: [], completeProjects: [],
        verifiedAbsentKeys: [], syncedAt: undefined, stale: false, errors: [],
      }),
      sync: () => Promise.resolve(),
      dispose: vi.fn(() => deferred),
    };
    const adapter = new XrayAdapter(configWith({}), { metadata });
    let settled = false;

    const disposal = adapter.dispose().then(() => {settled = true;});
    await Promise.resolve();
    expect(metadata.dispose).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    finish();
    await disposal;
    expect(settled).toBe(true);
  });
});
