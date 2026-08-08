import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { parseXrayRegion, xrayBaseUrl } from "../../xray/xray-region";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { probeXrayConnection } from "../../xray/xray-connection-test";
import { trustedWorkspace } from "./helpers/test-workspace-trust";

describe("parseXrayRegion", () => {
  it("passes through the four known regions", () => {
    expect(parseXrayRegion("global")).toBe("global");
    expect(parseXrayRegion("us")).toBe("us");
    expect(parseXrayRegion("eu")).toBe("eu");
    expect(parseXrayRegion("au")).toBe("au");
  });

  it("falls back to global for anything unknown", () => {
    expect(parseXrayRegion("")).toBe("global");
    expect(parseXrayRegion("US")).toBe("global");
    expect(parseXrayRegion("mars")).toBe("global");
  });
});

describe("xrayBaseUrl", () => {
  it("uses the bare host for global and a region-prefixed host otherwise", () => {
    expect(xrayBaseUrl("global")).toBe("https://xray.cloud.getxray.app/api/v2");
    expect(xrayBaseUrl("us")).toBe("https://us.xray.cloud.getxray.app/api/v2");
    expect(xrayBaseUrl("eu")).toBe("https://eu.xray.cloud.getxray.app/api/v2");
    expect(xrayBaseUrl("au")).toBe("https://au.xray.cloud.getxray.app/api/v2");
  });
});

function mapCredentialStore(): XrayCredentialStore {
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
  return new XrayCredentialStore(storage, trustedWorkspace());
}

describe("probeXrayConnection region integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends auth-only handshakes to the region host threaded through its deps", async () => {
    const credentialStore = mapCredentialStore();
    await credentialStore.setCredentials("acme.atlassian.net", "id", "secret");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Headers(),
          text: (): Promise<string> => Promise.resolve(JSON.stringify("a".repeat(40) + ".b.c")),
        } as unknown as Response);
      })
    );

    await probeXrayConnection(
      {
        site: "acme.atlassian.net",
        region: "eu",
        credentialStore,
        logger: Logger.create(undefined, LogLevel.ERROR),
        knownTestKeys: () => [],
      },
      { authOnly: true }
    );

    expect(urls).toEqual(["https://eu.xray.cloud.getxray.app/api/v2/authenticate"]);
  });
});
