import { describe, expect, it } from "vitest";
import { BoundedOutputTail, DetailBudget } from "../../core/execution-limits";

describe("DetailBudget", () => {
  it("holds the cap steady while the same share is charged and released repeatedly", () => {
    const budget = new DetailBudget(100);

    for (let round = 0; round < 50; round += 1) {
      expect(budget.take(60)).toBe("charged");
      budget.release(60);
    }

    // Leaking a share would refuse the first of these; handing back more than was charged would
    // admit the second.
    expect(budget.take(100)).toBe("charged");
    expect(budget.take(1)).toBe("refused");
  });

  it("admits a structure another owner already paid for without charging it twice", () => {
    const budget = new DetailBudget(100);
    const steps = [{ title: "step" }];

    expect(budget.take(60, steps)).toBe("charged");
    // The second retainer of the same allocation pays nothing and leaves the room intact.
    expect(budget.take(60, steps)).toBe("shared");
    expect(budget.take(40)).toBe("charged");
  });

  it("retires a share key with its refund so a replacement pays for itself again", () => {
    const budget = new DetailBudget(100);
    const steps = [{ title: "step" }];

    expect(budget.take(60, steps)).toBe("charged");
    budget.release(60, steps);

    // Without retiring the key, this would be admitted as "shared" against a refunded charge.
    expect(budget.take(60, steps)).toBe("charged");
  });

  it("floors a drifted release at zero instead of minting budget", () => {
    const budget = new DetailBudget(100);
    budget.release(60);

    expect(budget.take(100)).toBe("charged");
    expect(budget.take(1)).toBe("refused");
  });

  it("charges nothing for a refused request and keeps the remaining room usable", () => {
    const budget = new DetailBudget(100);
    expect(budget.take(60)).toBe("charged");

    expect(budget.take(60)).toBe("refused");

    expect(budget.take(40)).toBe("charged");
  });
});

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
