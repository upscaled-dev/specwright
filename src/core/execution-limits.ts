export const EXECUTION_LIMITS = {
  outputTailBytesPerStream: 256 * 1024,
  reportBytesPerRun: 16 * 1024 * 1024,
  artifactBytesPerWorkspace: 8 * 1024 * 1024,
  // Bounds only the bulky half of a live result (steps, stack, attachments). The identity, status
  // and duration of every case stay retained so a cancelled run can still report what completed.
  liveDetailBytesPerRun: 4 * 1024 * 1024,
} as const;

/** One run's share of live detail, held across every invocation that run dispatches. */
/** `charged` paid for the bytes; `shared` admits a structure another owner already paid for. */
export type BudgetAdmission = "charged" | "shared" | "refused";

export class DetailBudget {
  private used = 0;
  // Structures another retainer of this run already paid for, e.g. a live-streamed result's steps
  // array that the run accumulator then retains by reference. One budget bounds real memory, and a
  // shared structure is one allocation, so it is charged exactly once. Weakly held: the keys die
  // with the run's results.
  private readonly paidShares = new WeakSet<object>();

  constructor(private readonly maxBytes: number = EXECUTION_LIMITS.liveDetailBytesPerRun) {}

  /** Admit `bytes`, keyed by `share` when the structure can be retained by more than one owner. */
  public take(bytes: number, share?: object): BudgetAdmission {
    if (share !== undefined && this.paidShares.has(share)) {return "shared";}
    if (this.used + bytes > this.maxBytes) {return "refused";}
    this.used += bytes;
    if (share !== undefined) {this.paidShares.add(share);}
    return "charged";
  }

  /**
   * Give back a charge. `paidShare` is the key the releasing owner charged under, when it was the
   * owner that paid for the shared structure: the key must die with the charge, or replacing and
   * re-retaining the same structure would be admitted again for free after its refund.
   */
  public release(bytes: number, paidShare?: object): void {
    // Floored: an owner can only give back what was actually charged, and a drifted release must
    // not mint budget for detail that was never admitted.
    this.used = Math.max(0, this.used - bytes);
    if (paidShare !== undefined) {this.paidShares.delete(paidShare);}
  }
}

/** The one sentence that reports a lost stream tail, wherever the loss is measured. */
export function truncationNotice(
  stream: "stdout" | "stderr",
  retainedBytes: number,
  discardedBytes: number
): string {
  return (
    `[Specwright truncated ${stream}: retained ${retainedBytes} bytes, ` +
    `discarded ${discardedBytes} bytes.]`
  );
}

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
    const notice = this.truncationNotice(stream);
    return notice === undefined ? this.retained() : `${notice}\n${this.retained()}`;
  }

  /** The kept bytes alone, with no truncation notice in front of them. */
  public retained(): string {
    const text = Buffer.concat(this.chunks, this.retainedBytes).toString("utf8");
    // Trimming works on byte boundaries, so a trimmed head can start mid code point; drop the
    // replacement characters the decoder puts there, but only when something was trimmed.
    return this.totalBytes === this.retainedBytes ? text : text.replace(/^�+/u, "");
  }

  public truncationNotice(stream: "stdout" | "stderr"): string | undefined {
    const discardedBytes = this.totalBytes - this.retainedBytes;
    return discardedBytes === 0
      ? undefined
      : truncationNotice(stream, this.retainedBytes, discardedBytes);
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
