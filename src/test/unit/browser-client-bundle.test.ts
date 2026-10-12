import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browserClientCode, browserClientCoveragePlugin } from "./helpers/browser-client-bundle.mjs";

describe("browser bundle coverage", () => {
  let server: ViteDevServer;

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      plugins: [browserClientCoveragePlugin()],
      server: { middlewareMode: true, hmr: false, ws: false },
    });
  });

  afterAll(() => server.close());

  it.each(["coverage-board", "traceability-view", "xray-setup"] as const)(
    "remaps the exact evaluated %s JavaScript without changing V8 offsets",
    async (entry) => {
      const code = await browserClientCode(entry);
      const source = new URL(/^\/\/# sourceURL=(.+)$/mu.exec(code)![1]!);
      const transformed = await server.environments["ssr"]!.transformRequest(`${fileURLToPath(source)}${source.search}`);
      const map = transformed?.map;

      expect(transformed?.code).toBe(code);
      expect(map && "sourcesContent" in map && map.sourcesContent?.some((content) => content?.includes("acquireVsCodeApi"))).toBe(true);
    }
  );
});


it("refreshes evaluated bytes and coverage maps after a watched browser dependency changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "specwright-browser-watch-"));
  const directory = join(root, "src/webview");
  mkdirSync(directory, { recursive: true });
  const dependency = join(directory, "value.ts");
  writeFileSync(dependency, 'export const value = "first";');
  writeFileSync(join(directory, "xray-setup.ts"), 'import { value } from "./value"; globalThis.browserWatchValue = value;');
  const server = await createServer({ root, configFile: false, plugins: [browserClientCoveragePlugin(root)],
    server: { middlewareMode: true, hmr: false, ws: false, watch: { usePolling: true, interval: 10 } },
  });
  const request = `${join(directory, "xray-setup.ts")}?specwright-browser-bundle`;
  try {
    const first = await browserClientCode("xray-setup", root);
    expect((await server.environments["ssr"]!.transformRequest(request))?.code).toBe(first);
    await vi.waitFor(() => expect(Object.values(server.watcher.getWatched()).flat()).toContain("value.ts"));
    writeFileSync(dependency, 'export const value = "other";');
    const second = await browserClientCode("xray-setup", root);
    expect(second).not.toBe(first);
    expect(second).toContain('"other"');
    await vi.waitFor(async () => {
      const transformed = await server.environments["ssr"]!.transformRequest(request);
      expect(transformed?.code).toBe(second);
      expect(transformed?.map && "sourcesContent" in transformed.map && transformed.map.sourcesContent)
        .toContain('export const value = "other";');
    });
    writeFileSync(join(directory, "xray-setup.ts"), 'globalThis.browserWatchValue = "final";');
    rmSync(dependency);
    const final = await browserClientCode("xray-setup", root);
    expect(final).toContain('"final"');
    await vi.waitFor(async () => {
      const transformed = await server.environments["ssr"]!.transformRequest(request);
      expect(transformed?.code).toBe(final);
      expect(transformed?.map && "sourcesContent" in transformed.map && transformed.map.sourcesContent)
        .not.toContain('export const value = "other";');
    });
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
