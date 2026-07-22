import type * as vscode from "vscode";
import { AdapterContractHarness, runAdapterContractTests } from "./helpers/adapter-contract-suite";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayAdapter } from "../../xray/xray-adapter";
import { XrayClient, XrayFetchOutcome, XrayTestRecord } from "../../xray/xray-client";
import { XrayMetadataCapability } from "../../xray/xray-metadata";
import { XrayMetadataCache } from "../../xray/xray-metadata-cache";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { TestCaseMetadata } from "../../traceability/contracts";

const SITE = "acme.atlassian.net";

// A mocked transport standing in for XrayClient: `seed`/`seedError` decide what the next sync's
// fetch returns, so the contract suite drives complete/partial/error catalogues without a network.
class ControllableClient {
  private tests: XrayTestRecord[] = [];
  private complete = true;
  private errors: string[] = [];

  public seed(tests: readonly TestCaseMetadata[], completeness: "complete" | "partial"): void {
    this.tests = tests.map((test) => ({ ...test }));
    this.complete = completeness === "complete";
    this.errors = [];
  }

  public seedError(message: string): void {
    this.tests = [];
    this.complete = false;
    this.errors = [message];
  }

  private outcome(): XrayFetchOutcome {
    return { tests: [...this.tests], pages: [], complete: this.complete, errors: [...this.errors] };
  }

  public fetchProjectCatalogue(): Promise<XrayFetchOutcome> {
    return Promise.resolve(this.outcome());
  }

  public fetchTestsByKeys(): Promise<XrayFetchOutcome> {
    return Promise.resolve(this.outcome());
  }

  public invalidateAuth(): void {
    /* no-op: this fake never holds a JWT */
  }
}

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

function fakeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, dflt?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : dflt),
    update: (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

function harnessConfig(): ExtensionConfig {
  return {
    get xraySiteUrl(): string { return SITE; },
    get xrayCacheTtlMinutes(): number { return 15; },
    get traceabilityTestTagPrefix(): string { return "TEST_"; },
    get traceabilityReqTagPrefix(): string { return "REQ_"; },
  } as unknown as ExtensionConfig;
}

function xrayHarness(): AdapterContractHarness {
  const client = new ControllableClient();
  const credentialStore = new XrayCredentialStore(mapSecretStorage());
  const config = harnessConfig();
  const cache = new XrayMetadataCache(fakeMemento(), {
    endpoint: "xray.cloud.getxray.app",
    account: () => Promise.resolve("account"),
    workspaceId: "ws",
  });
  const metadata = new XrayMetadataCapability({
    client: client as unknown as XrayClient,
    cache,
    config,
    logger: Logger.create(undefined, LogLevel.ERROR),
    account: () => Promise.resolve("account"),
    onCredentialsChange: credentialStore.onDidChange,
  });
  const adapter = new XrayAdapter(config, credentialStore, () => Promise.resolve({ status: "ok", message: "ok" }), metadata);

  return {
    adapter,
    connect: () => credentialStore.setCredentials(SITE, "id", "secret"),
    disconnect: () => credentialStore.clearCredentials(SITE),
    seedCatalogue: (tests, completeness) => client.seed(tests, completeness),
    seedSyncError: (message) => client.seedError(message),
    // A project scope makes a full-catalogue fetch authoritative enough to derive orphans.
    syncScope: { projectKeys: ["CALC"] },
    grammarSample: { tags: ["@TEST_calc-1", "@TEST_CALC-2", "@REQ_calc-9"], testKeys: ["CALC-1", "CALC-2"], reqKeys: ["CALC-9"] },
    mappedKey: "CALC-1",
    orphanKey: "CALC-9",
    makeArtifact: () => ({
      id: "run",
      createdAt: 1,
      results: [{
        testKey: "CALC-1",
        outcome: "passed",
        scenario: { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" },
        durationMs: 5,
        attempts: 1,
        flaky: false,
        evidenceRefs: [],
      }],
      shards: [],
      selection: { kind: "all-mapped" },
      preflight: [],
      state: "complete",
    }),
    publishRequest: { mode: "append", executionKey: "EXEC-1" },
  };
}

runAdapterContractTests(xrayHarness);
