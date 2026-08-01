import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { EXECUTION_LIMITS } from "../core/execution-limits";

export class PlaywrightReportTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes = EXECUTION_LIMITS.reportBytesPerRun) {
    super(`Playwright JSON report exceeds the ${maxBytes}-byte limit (received ${actualBytes} bytes).`);
    this.name = "PlaywrightReportTooLargeError";
  }
}

export class PlaywrightInlineAttachmentTooLargeError extends Error {
  constructor(name: string | undefined, actualBytes: number) {
    const label = name?.trim() ? ` "${name}"` : "";
    super(
      `Playwright JSON report contains inline attachment${label} exceeding the ` +
      `${EXECUTION_LIMITS.inlineAttachmentBytes}-byte limit (received ${actualBytes} bytes).`
    );
    this.name = "PlaywrightInlineAttachmentTooLargeError";
  }
}

export function isPlaywrightReportLimitError(error: unknown): boolean {
  return (
    error instanceof PlaywrightReportTooLargeError ||
    error instanceof PlaywrightInlineAttachmentTooLargeError
  );
}

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
      if (typeof attachment.body === "string") {
        const bytes = Buffer.byteLength(attachment.body, "base64");
        if (bytes > EXECUTION_LIMITS.inlineAttachmentBytes) {
          throw new PlaywrightInlineAttachmentTooLargeError(attachment.name, bytes);
        }
      }
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

export function readPlaywrightReportSync(jsonPath: string): unknown {
  assertReportSize(fs.statSync(jsonPath).size);
  return parsePlaywrightReportText(fs.readFileSync(jsonPath, "utf8"));
}

/** Read without blocking and move large JSON parsing off the extension-host thread. */
export async function readPlaywrightReport(jsonPath: string): Promise<unknown> {
  const stat = await fs.promises.stat(jsonPath);
  assertReportSize(stat.size);
  const text = await fs.promises.readFile(jsonPath, "utf8");
  const actualBytes = Buffer.byteLength(text);
  assertReportSize(actualBytes);
  return actualBytes >= EXECUTION_LIMITS.asyncReportParseBytes
    ? parseJsonOffThread(text)
    : JSON.parse(text) as unknown;
}

function assertReportSize(actualBytes: number): void {
  if (actualBytes > EXECUTION_LIMITS.reportBytesPerRun) {
    throw new PlaywrightReportTooLargeError(actualBytes);
  }
}

interface WorkerResponse {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

const PARSE_WORKER = `
  const { parentPort } = require("node:worker_threads");
  parentPort.once("message", (text) => {
    try {
      parentPort.postMessage({ ok: true, value: JSON.parse(text) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error) });
    }
  });
`;

function parseJsonOffThread(text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PARSE_WORKER, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: EXECUTION_LIMITS.reportWorkerOldGenerationMb,
        maxYoungGenerationSizeMb: EXECUTION_LIMITS.reportWorkerYoungGenerationMb,
      },
    });
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {return;}
      settled = true;
      worker.removeAllListeners();
      worker.terminate().catch(() => undefined);
      action();
    };
    worker.once("message", (message: WorkerResponse) => {
      finish(() => {
        if (message.ok) {resolve(message.value);}
        else {reject(new SyntaxError(message.error ?? "Failed to parse Playwright JSON"));}
      });
    });
    worker.once("error", (error) => {
      finish(() => reject(error));
    });
    worker.once("exit", (code) => {
      finish(() => reject(new Error(
        `Playwright JSON parser worker exited before returning a result (code ${code}).`
      )));
    });
    worker.postMessage(text);
  });
}
