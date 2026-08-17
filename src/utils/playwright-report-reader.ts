import * as fs from "node:fs";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { EXECUTION_LIMITS } from "../core/execution-limits";

const REPORT_PARSE_WORKER = `
  const { parentPort } = require("node:worker_threads");
  parentPort.once("message", (bytes) => {
    try {
      const text = new TextDecoder().decode(bytes);
      parentPort.postMessage({ value: JSON.parse(text) });
    } catch (error) {
      parentPort.postMessage({ error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      } });
    }
  });
`;

interface WorkerMessage {
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

type ReportWorkerFactory = (source: string, options: WorkerOptions) => Worker;

export class PlaywrightReportTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes = EXECUTION_LIMITS.reportBytesPerRun) {
    super(`Playwright JSON report exceeds the ${maxBytes}-byte limit (received ${actualBytes} bytes).`);
    this.name = "PlaywrightReportTooLargeError";
  }
}

export function isPlaywrightReportLimitError(error: unknown): boolean {
  return error instanceof PlaywrightReportTooLargeError;
}

// Inline attachment bodies ride inside the report, so the whole-report byte
// limit already bounds them; only path attachments are collected here.
export function collectPlaywrightAttachmentPaths(
  attempts: readonly {
    readonly attachments?: readonly {
      readonly name?: string;
      readonly path?: string;
      readonly body?: string;
    }[];
  }[]
): string[] {
  const paths: string[] = [];
  for (const attempt of attempts) {
    for (const attachment of attempt.attachments ?? []) {
      if (typeof attachment.path === "string" && attachment.path !== "" && !paths.includes(attachment.path)) {
        paths.push(attachment.path);
      }
    }
  }
  return paths;
}

export function parsePlaywrightReportText(text: string): unknown {
  assertReportSize(Buffer.byteLength(text));
  return JSON.parse(text) as unknown;
}

/** Read without blocking the extension host; the size limit is checked before the file is read. */
export async function readPlaywrightReport(
  jsonPath: string,
  signal?: AbortSignal,
  createWorker: ReportWorkerFactory = spawnReportWorker
): Promise<unknown> {
  throwIfAborted(signal);
  const stat = await fs.promises.stat(jsonPath);
  assertReportSize(stat.size);
  const report = await fs.promises.readFile(jsonPath, signal ? { signal } : undefined);
  assertReportSize(report.byteLength);
  throwIfAborted(signal);
  const bytes = report.buffer.slice(report.byteOffset, report.byteOffset + report.byteLength);
  return parsePlaywrightReportInWorker(bytes, signal, createWorker);
}

function spawnReportWorker(source: string, options: WorkerOptions): Worker {
  return new Worker(source, options);
}

function reportWorkerOptions(): WorkerOptions {
  return {
    eval: true,
    execArgv: [],
    env: {},
    resourceLimits: {
      maxOldGenerationSizeMb: EXECUTION_LIMITS.reportParserWorkerHeapMb,
    },
  };
}

function parsePlaywrightReportInWorker(
  bytes: ArrayBuffer,
  signal: AbortSignal | undefined,
  createWorker: ReportWorkerFactory
): Promise<unknown> {
  throwIfAborted(signal);
  const worker = createWorker(REPORT_PARSE_WORKER, reportWorkerOptions());

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (outcome: { readonly value: unknown } | { readonly error: unknown }): void => {
      if (settled) {return;}
      settled = true;
      cleanup();
      worker.terminate().then(() => {
        if ("error" in outcome) {reject(outcome.error);}
        else {resolve(outcome.value);}
      }, reject);
    };
    const onMessage = (message: WorkerMessage): void => {
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        settle({ error });
        return;
      }
      if (!("value" in message)) {
        settle({ error: new Error("Playwright report parser returned no result.") });
        return;
      }
      settle({ value: message.value });
    };
    const onError = (error: Error): void => settle({ error });
    const onExit = (code: number): void => settle({
      error: new Error(
        code === 0
          ? "Playwright report parser exited before returning a result."
          : `Playwright report parser exited with code ${code}.`
      ),
    });
    const onAbort = (): void => settle({ error: abortError(signal) });

    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage(bytes, [bytes]);
    } catch (error) {
      settle({ error });
    }
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {throw abortError(signal);}
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {return signal.reason;}
  const error = new Error("Playwright report parsing was cancelled.");
  error.name = "AbortError";
  return error;
}

function assertReportSize(actualBytes: number): void {
  if (actualBytes > EXECUTION_LIMITS.reportBytesPerRun) {
    throw new PlaywrightReportTooLargeError(actualBytes);
  }
}
