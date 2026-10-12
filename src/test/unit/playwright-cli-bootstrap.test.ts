import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAYWRIGHT_STOP_ACCEPTED, PLAYWRIGHT_STOP_REQUEST } from "../../core/playwright-cli-cancellation";

const originalArgv = process.argv;
const connectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected");
const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  for (const [key, descriptor] of [["connected", connectedDescriptor], ["send", sendDescriptor]] as const) {
    if (descriptor) { Object.defineProperty(process, key, descriptor); }
    else { Reflect.deleteProperty(process, key); }
  }
  vi.resetModules();
});

describe("Playwright CLI bootstrap control channel", () => {
  it("refuses to launch without an installed CLI path", async () => {
    process.argv = [process.execPath, "bootstrap.js"];
    await expect(import("../../core/playwright-cli-bootstrap")).rejects.toThrow(
      "The installed Playwright CLI path is required."
    );
  });

  it.each([
    { name: "foreign message", message: "unrelated", listeners: 1, connected: true, throws: false, interrupted: false, acknowledged: false },
    { name: "CLI without a teardown handler", message: PLAYWRIGHT_STOP_REQUEST, listeners: 0, connected: true, throws: false, interrupted: false, acknowledged: false },
    { name: "cooperative teardown", message: PLAYWRIGHT_STOP_REQUEST, listeners: 1, connected: true, throws: false, interrupted: true, acknowledged: true },
    { name: "disconnected IPC", message: PLAYWRIGHT_STOP_REQUEST, listeners: 1, connected: false, throws: false, interrupted: true, acknowledged: false },
    { name: "lost acknowledgement", message: PLAYWRIGHT_STOP_REQUEST, listeners: 1, connected: true, throws: true, interrupted: true, acknowledged: true },
  ])("handles $name without disrupting CLI teardown", async (testCase) => {
    process.argv = [process.execPath, "bootstrap.js", "node:path", "test", "--workers=1"];
    let messageListener: ((message: unknown) => void) | undefined;
    const originalOn = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "message") { messageListener = listener as (message: unknown) => void; return process; }
      return originalOn(event, listener);
    });
    const originalCount = process.listenerCount.bind(process);
    vi.spyOn(process, "listenerCount").mockImplementation((event) => event === "SIGINT" ? testCase.listeners : originalCount(event));
    const events = process as EventEmitter;
    const originalEmit = events.emit.bind(events);
    const interrupt = vi.fn();
    vi.spyOn(events, "emit").mockImplementation((event, ...args) => {
      if (event === "SIGINT") { interrupt(); return true; }
      return originalEmit(event, ...args);
    });
    const send = vi.fn((_message: unknown, callback: () => void) => {
      if (testCase.throws) { throw new Error("IPC closed"); }
      callback();
    });
    Object.defineProperty(process, "connected", { configurable: true, value: testCase.connected });
    Object.defineProperty(process, "send", { configurable: true, value: send });

    await import("../../core/playwright-cli-bootstrap");
    expect(process.argv).toEqual([process.execPath, "node:path", "test", "--workers=1"]);
    expect(messageListener).toBeTypeOf("function");
    expect(() => messageListener!(testCase.message)).not.toThrow();
    expect(interrupt).toHaveBeenCalledTimes(testCase.interrupted ? 1 : 0);
    if (testCase.acknowledged) { expect(send).toHaveBeenCalledWith(PLAYWRIGHT_STOP_ACCEPTED, expect.any(Function)); }
    else { expect(send).not.toHaveBeenCalled(); }
  });
});
