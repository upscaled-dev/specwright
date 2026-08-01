export const EXECUTION_LIMITS = {
  outputTailBytesPerStream: 256 * 1024,
  reportBytesPerRun: 16 * 1024 * 1024,
  asyncReportParseBytes: 256 * 1024,
  inlineAttachmentBytes: 1024 * 1024,
  artifactBytesPerWorkspace: 8 * 1024 * 1024,
  benchmarkDurationMs: 2_000,
  runHeapGrowthBytes: 96 * 1024 * 1024,
  reportWorkerOldGenerationMb: 64,
  reportWorkerYoungGenerationMb: 16,
} as const;

/**
 * A run can retain one report plus one bounded tail for each process stream. Parsed report
 * objects are transient and covered by the benchmark heap budget rather than this input budget.
 */
export const RUN_INPUT_BUDGET_BYTES =
  EXECUTION_LIMITS.reportBytesPerRun + 2 * EXECUTION_LIMITS.outputTailBytesPerStream;

/** Retain the newest bytes from a stream without letting chunk metadata grow without bound. */
export class BoundedOutputTail {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  public append(value: Buffer | string): void {
    const chunk = typeof value === "string" ? Buffer.from(value) : value;
    if (chunk.length === 0) {return;}

    this.totalBytes += chunk.length;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    this.trim();
    if (this.chunks.length > 64) {this.compact();}
  }

  public format(stream: "stdout" | "stderr"): string {
    const retained = Buffer.concat(this.chunks, this.retainedBytes).toString("utf8");
    const notice = this.truncationNotice(stream);
    return notice === undefined ? retained : `${notice}\n${retained}`;
  }

  public truncationNotice(stream: "stdout" | "stderr"): string | undefined {
    const discardedBytes = this.totalBytes - this.retainedBytes;
    if (discardedBytes === 0) {return undefined;}
    return (
      `[Specwright truncated ${stream}: retained ${this.retainedBytes} bytes, ` +
      `discarded ${discardedBytes} bytes.]`
    );
  }

  private trim(): void {
    let excess = this.retainedBytes - this.maxBytes;
    while (excess > 0) {
      const first = this.chunks[0];
      if (first === undefined) {break;}
      if (first.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
        excess -= first.length;
      } else {
        // Copy the retained tail so a small slice cannot keep one oversized source chunk alive.
        this.chunks[0] = Buffer.from(first.subarray(excess));
        this.retainedBytes -= excess;
        excess = 0;
      }
    }
  }

  private compact(): void {
    const retained = Buffer.concat(this.chunks, this.retainedBytes);
    this.chunks.length = 0;
    if (retained.length > 0) {this.chunks.push(retained);}
  }
}
