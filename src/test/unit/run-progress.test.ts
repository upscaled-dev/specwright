import { describe, expect, it, vi } from "vitest";
import { combineRunProgressObservers, type RunProgressObserver } from "../../core/run-progress";

describe("combineRunProgressObservers", () => {
  it("omits an output handler when no observer consumes process output", () => {
    const combined = combineRunProgressObservers({ onBegin: () => undefined });

    expect(combined?.onOutput).toBeUndefined();
  });

  it("fans output out to consumers without letting one failure block another", () => {
    const first: RunProgressObserver = { onOutput: () => {throw new Error("closed");} };
    const second = vi.fn();
    const combined = combineRunProgressObservers(first, { onOutput: second });

    combined?.onOutput?.("stderr", "failure\n");

    expect(second).toHaveBeenCalledWith("stderr", "failure\n");
  });
});
