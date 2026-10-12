import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";
import { playwrightCliInvocation, stopPlaywrightCli, PLAYWRIGHT_STOP_ACCEPTED, PLAYWRIGHT_STOP_REQUEST,
  PLAYWRIGHT_STOP_GRACE_MS } from "../../core/playwright-cli-cancellation";
import { provePlaywrightCancellation } from "../helpers/playwright-cancellation";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

describe("Playwright cooperative CLI cancellation", () => {
  beforeAll(async () => {
    const root = path.resolve(__dirname, "../../..");
    await build({ entryPoints: [path.join(root, "src/core/playwright-cli-bootstrap.ts")],
      outfile: path.join(root, "dist/playwright-cli-bootstrap.js"), bundle: true,
      platform: "node", format: "cjs" });
  });
  it("tears down the populated resource test, exits its worker and admits the next named run",
    () => provePlaywrightCancellation(), 90_000);
  it.runIf(process.env["SPECWRIGHT_BROWSER_CANCELLATION_ACCEPTANCE"] === "1")(
    "tears down the populated browser test, exits its worker and admits the next named run",
    () => provePlaywrightCancellation({ withBrowser: true }), 90_000);
});

class FakeCli extends EventEmitter {
  public connected = true;
  public send = vi.fn((_message: string, callback: (error: Error | null) => void) => callback(null));
}

describe("cooperative stop evidence", () => {
  afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks();});

  it.each([0, 130])("requires a requested acknowledgement and complete CLI close with code %i", async (code) => {
    const cli = new FakeCli();
    cli.emit("message", PLAYWRIGHT_STOP_ACCEPTED);
    const stopped = stopPlaywrightCli(cli as unknown as ChildProcess);
    expect(cli.send).toHaveBeenCalledWith(PLAYWRIGHT_STOP_REQUEST, expect.any(Function));
    cli.emit("message", PLAYWRIGHT_STOP_ACCEPTED);
    cli.emit("close", code, null);
    await expect(stopped).resolves.toBe(true);
    expect(cli.listenerCount("message")).toBe(0);
  });

  it.each([
    ["unsolicited acknowledgement", false, 0, null],
    ["failed CLI exit", true, 1, null],
    ["forced exit", true, null, "SIGTERM"],
  ] as const)("requires fallback after %s", async (_reason, accepted, code, signal) => {
    const cli = new FakeCli();
    cli.emit("message", PLAYWRIGHT_STOP_ACCEPTED);
    const stopped = stopPlaywrightCli(cli as unknown as ChildProcess);
    if (accepted) {cli.emit("message", PLAYWRIGHT_STOP_ACCEPTED);}
    cli.emit("close", code, signal);
    await expect(stopped).resolves.toBe(false);
  });

  it.each([false, true])("bounds a stop that never closes (acknowledged: %s)", async (accepted) => {
    vi.useFakeTimers();
    const cli = new FakeCli();
    const stopped = stopPlaywrightCli(cli as unknown as ChildProcess);
    if (accepted) {cli.emit("message", PLAYWRIGHT_STOP_ACCEPTED);}
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_STOP_GRACE_MS);
    await expect(stopped).resolves.toBe(false);
    expect(cli.eventNames()).toEqual([]);
  });

  it.each(["disconnect", "error"])("falls back when the control channel reports %s", async (event) => {
    const cli = new FakeCli();
    const stopped = stopPlaywrightCli(cli as unknown as ChildProcess);
    cli.emit(event, new Error("channel failed"));
    await expect(stopped).resolves.toBe(false);
  });
});


describe("CLI bridge availability", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("declines an invocation when the workspace has no Playwright CLI", () => {
    expect(playwrightCliInvocation(undefined, ["test"])).toBeUndefined();
  });
  it("declines an invocation when neither packaged nor development bridge exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(playwrightCliInvocation("/workspace/node_modules/playwright/cli.js", ["test"])).toBeUndefined();
  });
});

describe("CLI control channel races", () => {
  it("does not send to a disconnected child", async () => {
    const cli = new FakeCli();
    cli.connected = false;
    await expect(stopPlaywrightCli(cli as unknown as ChildProcess)).resolves.toBe(false);
    expect(cli.send).not.toHaveBeenCalled();
    expect(cli.eventNames()).toEqual([]);
  });
  it("ignores unrelated messages and falls back when sending fails", async () => {
    const cli = new FakeCli();
    cli.send.mockImplementation((_message, callback) => {
      cli.emit("message", { kind: "worker-ready" });
      callback(new Error("channel closed"));
    });
    await expect(stopPlaywrightCli(cli as unknown as ChildProcess)).resolves.toBe(false);
    expect(cli.eventNames()).toEqual([]);
  });
  it("keeps a completed clean stop when a delayed send callback reports failure", async () => {
    const cli = new FakeCli();
    let completeSend!: (error: Error | null) => void;
    cli.send.mockImplementation((_message, callback) => { completeSend = callback; });
    const stopped = stopPlaywrightCli(cli as unknown as ChildProcess);
    cli.emit("message", PLAYWRIGHT_STOP_ACCEPTED);
    cli.emit("close", 0, null);
    completeSend(new Error("late channel failure"));
    await expect(stopped).resolves.toBe(true);
    expect(cli.eventNames()).toEqual([]);
  });
});
