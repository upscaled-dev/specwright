import { afterEach, describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";

function makeChannel(): { lines: string[]; channel: vscode.OutputChannel } {
  const lines: string[] = [];
  const channel = {
    appendLine: (line: string): void => {
      lines.push(line);
    },
    show: (): void => {},
    clear: (): void => {},
    dispose: (): void => {},
  } as unknown as vscode.OutputChannel;
  return { lines, channel };
}

function makeLogChannel(): {
  calls: Array<{ level: string; message: string }>;
  channel: vscode.LogOutputChannel;
} {
  const calls: Array<{ level: string; message: string }> = [];
  const channel = {
    appendLine: (): void => { throw new Error("LogOutputChannel appendLine should not be used"); },
    debug: (message: string): void => { calls.push({ level: "debug", message }); },
    info: (message: string): void => { calls.push({ level: "info", message }); },
    warn: (message: string): void => { calls.push({ level: "warn", message }); },
    error: (message: string): void => { calls.push({ level: "error", message }); },
    show: (): void => {},
    clear: (): void => {},
    dispose: (): void => {},
  } as unknown as vscode.LogOutputChannel;
  return { calls, channel };
}

describe("Logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a host-managed log channel by default", () => {
    const create = vi.spyOn(vscode.window, "createOutputChannel");
    const logger = Logger.create();

    expect(create).toHaveBeenCalledWith("Specwright", { log: true });
    logger.dispose();
  });

  it("delegates levels to a host-managed LogOutputChannel", () => {
    const { calls, channel } = makeLogChannel();
    const logger = Logger.create(channel);

    logger.debug("details", { runId: "run-1" });
    logger.warn("warning");

    expect(calls).toEqual([
      { level: "debug", message: "details\n{\n  \"runId\": \"run-1\"\n}" },
      { level: "warn", message: "warning" },
    ]);
  });

  it("suppresses debug messages at the default INFO level", () => {
    const { lines, channel } = makeChannel();
    const logger = Logger.create(channel);

    logger.debug("hidden");
    logger.info("visible");

    expect(lines.some((l) => l.includes("hidden"))).toBe(false);
    expect(lines.some((l) => l.includes("visible"))).toBe(true);
  });

  it("emits debug messages after setLogLevel(DEBUG)", () => {
    const { lines, channel } = makeChannel();
    const logger = Logger.create(channel);

    logger.setLogLevel(LogLevel.DEBUG);
    logger.debug("now visible");

    expect(logger.getLogLevel()).toBe(LogLevel.DEBUG);
    expect(lines.some((l) => l.includes("now visible"))).toBe(true);
  });

  it("filters info/warn below the ERROR level", () => {
    const { lines, channel } = makeChannel();
    const logger = Logger.create(channel, LogLevel.ERROR);

    logger.info("nope");
    logger.warn("nope");
    logger.error("yes");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("yes");
  });

  it("logs circular data without throwing", () => {
    const { lines, channel } = makeChannel();
    const logger = Logger.create(channel);
    const data: Record<string, unknown> = { name: "loop" };
    data["self"] = data;

    expect(() => logger.info("circular", data)).not.toThrow();
    expect(lines.some((l) => l.includes("[Circular]"))).toBe(true);
  });

  it("serializes Error values with message and stack instead of {}", () => {
    const { lines, channel } = makeChannel();
    const logger = Logger.create(channel);

    logger.error("failed", { error: new Error("boom") });

    const payload = lines.join("\n");
    expect(payload).toContain('"message": "boom"');
    expect(payload).toContain('"stack"');
  });
});
