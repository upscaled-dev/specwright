import { describe, expect, it, vi } from "vitest";
import { DetailBudget } from "../../core/execution-limits";
import { combineRunProgressObservers, formatRunProgress, type RunProgressObserver } from "../../core/run-progress";

describe("combineRunProgressObservers", () => {
  it("omits a combined observer when no presentation is attached", () => {
    expect(combineRunProgressObservers(undefined, undefined)).toBeUndefined();
  });

  it("shows zero completed when the runner first announces its total", () => {
    expect(formatRunProgress({ phase: "running", total: 7 })).toBe("Running 0/7");
  });

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

  it("fans lifecycle progress out when one optional consumer fails", () => {
    const second = vi.fn();
    const combined = combineRunProgressObservers(
      { onProgress: () => {throw new Error("closed");} }, { onProgress: second }
    );
    combined?.onProgress?.({ phase: "finishing" });
    expect(second).toHaveBeenCalledWith({ phase: "finishing" });
  });
});
