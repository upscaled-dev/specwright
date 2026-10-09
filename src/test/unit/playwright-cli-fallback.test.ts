import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundedCommand, TERMINATION_GRACE_MS } from "../../core/bounded-command-runner";
import { readProcessIdentity, readProcessTable } from "../../core/windows-process-tree";
import { PLAYWRIGHT_STOP_ACCEPTED, PLAYWRIGHT_STOP_REQUEST,
  PLAYWRIGHT_STOP_GRACE_MS } from "../../core/playwright-cli-cancellation";
import { Logger } from "../../utils/logger";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(), readFileSync: vi.fn(),
}));
vi.mock("../../core/windows-process-tree", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../core/windows-process-tree")>(),
  readProcessIdentity: vi.fn(), readProcessTable: vi.fn(),
}));
vi.mock("../../core/playwright-cli-cancellation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../core/playwright-cli-cancellation")>(),
  playwrightCliInvocation: () => ({ executable: "node", args: ["bridge.js", "cli.js", "test"] }),
}));

class FakeChild extends EventEmitter {
  public readonly pid = 4242;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly connected = true;
  public readonly send = vi.fn((_message: string, callback: (error: Error | null) => void) => callback(null));
  public readonly kill = vi.fn(() => true);
}

describe("command runner cooperative fallback", () => {
  afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks();});

  it.each([
    [false, 0, ""],
    [true, 0, ""],
    [false, 5, `ERROR: Access is denied.\r\n${"x".repeat(1000)}`],
  ] as const)("forces bounded tree cleanup when the CLI stop hangs (acknowledged: %s, kill code: %i)", async (accepted, killCode, diagnostic) => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readFileSync).mockReturnValue('node "%~dp0\\..\\playwright\\cli.js"');
    vi.mocked(readProcessIdentity).mockResolvedValue({ pid: 4242, creationDate: 1_000 });
    vi.mocked(readProcessTable).mockResolvedValueOnce([{ pid: 4242, parentPid: 1, creationDate: 1_000 }]);
    if (diagnostic !== "") {vi.mocked(readProcessTable).mockRejectedValue(new Error("inventory unavailable"));}
    else {vi.mocked(readProcessTable).mockResolvedValue([{ pid: 900, parentPid: 1, creationDate: 1 }]);}
    const cli = new FakeChild();
    const killer = new FakeChild();
    vi.mocked(spawn).mockImplementation((executable) => (executable === "taskkill" ? killer : cli) as never);
    const logger = Logger.create();
    const messages: string[] = [];
    vi.spyOn(logger, "warn").mockImplementation((message) => {messages.push(message);});
    vi.spyOn(logger, "error").mockImplementation((message) => {messages.push(message);});
    const controller = new AbortController();
    let settled = false;
    const pending = runBoundedCommand({ command: "npx playwright test", workingDir: process.cwd(),
      logger, signal: controller.signal });
    void pending.then(() => {settled = true;});
    controller.abort();
    expect(cli.send).toHaveBeenCalledWith(PLAYWRIGHT_STOP_REQUEST, expect.any(Function));
    if (accepted) {cli.emit("message", PLAYWRIGHT_STOP_ACCEPTED);}
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_STOP_GRACE_MS - 1);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledWith("taskkill", ["/pid", "4242", "/T", "/F"], expect.anything());
    expect(settled).toBe(false);

    cli.emit("close", 130, null);
    cli.emit("error", new Error("late CLI channel error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    if (diagnostic !== "") {killer.stderr.write(diagnostic);}
    killer.emit("close", killCode, null);
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS);
    await pending;
    expect(settled).toBe(true);
    expect(killer.kill).not.toHaveBeenCalled();
    if (diagnostic !== "") {
      expect(messages.join("\n")).toContain("taskkill exit code 5. ERROR: Access is denied.");
      expect(messages.join("\n")).not.toContain("x".repeat(201));
    }
    logger.dispose();
  });
});
