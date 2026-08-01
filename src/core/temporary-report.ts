import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 50,
} as const;

/** Owns every file produced for one Playwright JSON report lifetime. */
export class TemporaryReport {
  public readonly jsonPath: string;
  public readonly livePath: string;
  private disposed = false;

  private constructor(
    private readonly directory: string,
    private readonly onCleanupError: (error: Error) => void,
    private readonly removeDirectory: (directory: string) => void
  ) {
    this.jsonPath = path.join(directory, "report.json");
    this.livePath = path.join(directory, "live.jsonl");
  }

  public static create(
    onCleanupError: (error: Error) => void,
    removeDirectory: (directory: string) => void = (directory) => fs.rmSync(directory, CLEANUP_OPTIONS)
  ): TemporaryReport {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-playwright-report-"));
    return new TemporaryReport(directory, onCleanupError, removeDirectory);
  }

  /** Remove the report directory once, with a bounded retry for transient Windows file locks. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.removeDirectory(this.directory);
    } catch (error) {
      const resolved = error instanceof Error ? error : new Error(String(error));
      try { this.onCleanupError(resolved); } catch { /* cleanup must not replace the run result */ }
    }
  }
}
