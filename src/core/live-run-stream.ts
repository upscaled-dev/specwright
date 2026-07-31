import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseBddSourceData, type BddSourceData } from "../parsers/bdd-file-data-parser";
import type {
  LiveReporterRecord,
  LiveRunBeginRecord,
  LiveTestEndRecord,
  LiveTestStatus,
} from "./live-reporter-protocol";
import type { ScenarioResult, ScenarioStatus } from "../utils/playwright-json-parser";
import { resolveTestStatus } from "./test-result-status";

const READ_BUFFER_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 25;

export interface LiveRunStreamHandlers {
  onBegin(record: LiveRunBeginRecord): void;
  onTestEnd(result: ScenarioResult, record: LiveTestEndRecord): void;
  /** Malformed or unknown records are isolated to their own line and never stop the stream. */
  onMalformedLine?(line: string): void;
  /** File-system and consumer callback failures are reported without escaping the watcher. */
  onError?(error: Error): void;
}

/**
 * Tails the append-only JSONL file produced by the Specwright Playwright reporter.
 *
 * `watch` drains records already present, then polls the open file at low latency. `finish` stops
 * polling, performs one last drain (including a final record without a newline), and removes it.
 */
export class LiveRunStream {
  private readonly sourceBySpecPath = new Map<string, BddSourceData | undefined>();
  private readonly readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  private decoder = new StringDecoder("utf8");
  private pollTimer: NodeJS.Timeout | undefined;
  private fd: number | undefined;
  private offset = 0;
  private pending = "";
  private begin: LiveRunBeginRecord | undefined;
  private finished = false;

  private constructor(
    private readonly reportPath: string,
    private readonly handlers: LiveRunStreamHandlers
  ) {}

  public static watch(reportPath: string, handlers: LiveRunStreamHandlers): LiveRunStream {
    const stream = new LiveRunStream(reportPath, handlers);
    stream.start();
    return stream;
  }

  /** Final drain and best-effort cleanup. Safe to call more than once. */
  public finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    try {
      this.drain();
      this.pending += this.decoder.end();
      this.consumeLines(true);
    } catch (error) {
      this.reportError(error);
    } finally {
      if (this.fd !== undefined) {
        try { fs.closeSync(this.fd); } catch { /* best effort */ }
        this.fd = undefined;
      }
      try { fs.unlinkSync(this.reportPath); } catch { /* best effort */ }
    }
  }

  private start(): void {
    this.fd = fs.openSync(this.reportPath, "r");
    // Polling one open temp file is predictable across local, remote, and network file systems,
    // where fs.watch can coalesce or drop append notifications.
    this.pollTimer = setInterval(() => this.drainSafely(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    this.drainSafely();
  }

  private drainSafely(): void {
    try {
      this.drain();
    } catch (error) {
      this.reportError(error);
    }
  }

  private drain(): void {
    if (this.fd === undefined) {
      return;
    }
    const size = fs.fstatSync(this.fd).size;
    if (size < this.offset) {
      // The protocol is append-only, but reset cleanly if an external actor replaced the file.
      this.offset = 0;
      this.pending = "";
      this.decoder = new StringDecoder("utf8");
    }

    while (this.offset < size) {
      const length = Math.min(this.readBuffer.length, size - this.offset);
      const bytesRead = fs.readSync(this.fd, this.readBuffer, 0, length, this.offset);
      if (bytesRead === 0) {
        break;
      }
      this.offset += bytesRead;
      this.pending += this.decoder.write(this.readBuffer.subarray(0, bytesRead));
    }
    this.consumeLines(false);
  }

  private consumeLines(includeRemainder: boolean): void {
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      this.consumeLine(line);
      newline = this.pending.indexOf("\n");
    }

    if (includeRemainder && this.pending !== "") {
      const line = this.pending.replace(/\r$/, "");
      this.pending = "";
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (line.trim() === "") {
      return;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line) as unknown;
    } catch {
      this.handlers.onMalformedLine?.(line);
      return;
    }
    if (!isLiveReporterRecord(candidate)) {
      this.handlers.onMalformedLine?.(line);
      return;
    }

    if (candidate.kind === "run-begin") {
      this.begin = candidate;
      this.sourceBySpecPath.clear();
      this.callHandler(() => this.handlers.onBegin(candidate));
      return;
    }

    const result = this.toScenarioResult(candidate);
    this.callHandler(() => this.handlers.onTestEnd(result, candidate));
  }

  private toScenarioResult(record: LiveTestEndRecord): ScenarioResult {
    const specPath = this.resolveSpecPath(record.file);
    const source = this.resolveSource(specPath, record.line);
    const outlineName = enclosingOutlineName(record);
    const attempts = record.retry + 1;
    return {
      featurePath: source?.featurePath ?? specPath,
      ...(source?.lineNumber === undefined ? {} : { lineNumber: source.lineNumber }),
      scenarioName: record.title,
      status: toScenarioStatus(record),
      durationMs: record.durationMs,
      ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
      ...(record.errorStack === undefined ? {} : { errorStack: record.errorStack }),
      ...(outlineName === undefined ? {} : { outlineName }),
      ...(attempts > 1 ? { attempts } : {}),
      ...(record.status === "timedOut" ? { outcome: "timed-out" as const } : {}),
      ...(record.status === "interrupted" ? { outcome: "interrupted" as const } : {}),
    };
  }

  private resolveSpecPath(file: string): string {
    if (path.isAbsolute(file)) {
      return file;
    }
    return path.resolve(this.begin?.rootDir ?? process.cwd(), file);
  }

  private resolveSource(specPath: string, pwTestLine: number) {
    let source = this.sourceBySpecPath.get(specPath);
    if (!this.sourceBySpecPath.has(specPath)) {
      try {
        const specText = fs.readFileSync(specPath, "utf8");
        const projectDir = this.begin?.configFile
          ? path.dirname(this.begin.configFile)
          : this.begin?.rootDir ?? process.cwd();
        source = parseBddSourceData(specText, projectDir);
      } catch {
        source = undefined;
      }
      this.sourceBySpecPath.set(specPath, source);
    }
    if (!source) {return undefined;}
    const lineNumber = source.lineNumbers.get(pwTestLine);
    return { featurePath: source.featurePath, ...(lineNumber === undefined ? {} : { lineNumber }) };
  }

  private callHandler(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const resolved = error instanceof Error ? error : new Error(String(error));
    try { this.handlers.onError?.(resolved); } catch { /* never escape the watcher */ }
  }
}

function toScenarioStatus(record: LiveTestEndRecord): ScenarioStatus {
  return resolveTestStatus(record.status, record.expectedStatus);
}

function enclosingOutlineName(record: LiveTestEndRecord): string | undefined {
  const enclosing = record.titlePath.at(-2);
  return enclosing && (/^Example #\d+/.test(record.title) || /<[^>]+>/.test(enclosing))
    ? enclosing
    : undefined;
}

function isLiveReporterRecord(value: unknown): value is LiveReporterRecord {
  if (!isObject(value) || (value["kind"] !== "run-begin" && value["kind"] !== "test-end")) {
    return false;
  }
  if (value["kind"] === "run-begin") {
    return (
      typeof value["rootDir"] === "string" &&
      optionalString(value["configFile"]) &&
      isNonNegativeNumber(value["total"])
    );
  }
  return (
    typeof value["file"] === "string" &&
    isPositiveNumber(value["line"]) &&
    typeof value["title"] === "string" &&
    isStringArray(value["titlePath"]) &&
    isLiveTestStatus(value["status"]) &&
    isNonNegativeNumber(value["durationMs"]) &&
    optionalString(value["errorMessage"]) &&
    optionalString(value["errorStack"]) &&
    isNonNegativeNumber(value["retry"]) &&
    isNonNegativeNumber(value["retries"]) &&
    isLiveTestStatus(value["expectedStatus"]) &&
    typeof value["projectName"] === "string" &&
    isNonNegativeNumber(value["completed"]) &&
    isNonNegativeNumber(value["total"])
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return isNonNegativeNumber(value) && value > 0;
}

function isLiveTestStatus(value: unknown): value is LiveTestStatus {
  return (
    value === "passed" ||
    value === "failed" ||
    value === "timedOut" ||
    value === "skipped" ||
    value === "interrupted"
  );
}
