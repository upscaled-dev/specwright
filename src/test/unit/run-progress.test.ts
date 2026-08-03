import { describe, expect, it, vi } from "vitest";
import { DetailBudget } from "../../core/execution-limits";
import { combineRunProgressObservers, type RunProgressObserver } from "../../core/run-progress";

describe("combineRunProgressObservers", () => {
  it("withholds the detail budget so no invocation is handed a run's whole share", () => {
    const combined = combineRunProgressObservers({ detailBudget: new DetailBudget() });

    expect(combined?.detailBudget).toBeUndefined();
  });

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
