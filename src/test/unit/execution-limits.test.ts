import { describe, expect, it } from "vitest";
import { BoundedOutputTail } from "../../core/execution-limits";

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

  it("drops the partial code point a byte-boundary cut leaves at the head", () => {
    const tail = new BoundedOutputTail(2);
    tail.append("éz");

    expect(tail.format("stdout")).toBe(
      "[Specwright truncated stdout: retained 2 bytes, discarded 1 bytes.]\nz"
    );
  });
});
