import { describe, expect, it } from "vitest";
import {
  BoundedOutputTail,
  EXECUTION_LIMITS,
  RUN_INPUT_BUDGET_BYTES,
} from "../../core/execution-limits";

describe("BoundedOutputTail", () => {
  it("returns complete output while it remains within the limit", () => {
    const tail = new BoundedOutputTail(8);
    tail.append("hello");
    tail.append("!");

    expect(tail.format("stdout")).toBe("hello!");
  });

  it("keeps the newest bytes and reports retained and discarded sizes", () => {
    const tail = new BoundedOutputTail(5);
    tail.append("abc");
    tail.append("defgh");

    expect(tail.format("stderr")).toBe(
      "[Specwright truncated stderr: retained 5 bytes, discarded 3 bytes.]\ndefgh"
    );
  });

  it("defines one run input budget from the report and two output tails", () => {
    expect(RUN_INPUT_BUDGET_BYTES).toBe(
      EXECUTION_LIMITS.reportBytesPerRun + 2 * EXECUTION_LIMITS.outputTailBytesPerStream
    );
  });
});
