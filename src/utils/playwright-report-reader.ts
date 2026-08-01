import * as fs from "node:fs";
import { EXECUTION_LIMITS } from "../core/execution-limits";

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
export async function readPlaywrightReport(jsonPath: string): Promise<unknown> {
  const stat = await fs.promises.stat(jsonPath);
  assertReportSize(stat.size);
  return parsePlaywrightReportText(await fs.promises.readFile(jsonPath, "utf8"));
}

function assertReportSize(actualBytes: number): void {
  if (actualBytes > EXECUTION_LIMITS.reportBytesPerRun) {
    throw new PlaywrightReportTooLargeError(actualBytes);
  }
}
