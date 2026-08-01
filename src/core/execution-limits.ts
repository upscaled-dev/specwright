export const EXECUTION_LIMITS = {
  outputTailBytesPerStream: 256 * 1024,
  reportBytesPerRun: 16 * 1024 * 1024,
  artifactBytesPerWorkspace: 8 * 1024 * 1024,
} as const;

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
    if (notice === undefined) {return retained;}
    // Trimming works on byte boundaries, so the retained head can start mid code
    // point; drop the replacement characters the decoder puts there.
    return `${notice}\n${retained.replace(/^�+/u, "")}`;
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
