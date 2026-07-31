import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { runCapturedWithProgress } from "../../commands/captured-run-progress";

describe("runCapturedWithProgress", () => {
  it("publishes live counts, aborts on cancellation, and completes the open session", async () => {
    const reports: unknown[] = [];
    const complete = vi.fn();
    const end = vi.fn();
    const onTestEnd = vi.fn();
    const window = {
      ...vscode.window,
      withProgress: async (
        options: { cancellable?: boolean },
        task: (
          progress: { report(value: unknown): void },
          token: {
            isCancellationRequested: boolean;
            onCancellationRequested(listener: () => void): { dispose(): void };
          }
        ) => Promise<unknown>
      ) => {
        expect(options.cancellable).toBe(true);
        return task(
          { report: (value) => reports.push(value) },
          {
            isCancellationRequested: false,
            onCancellationRequested: (listener) => {
              queueMicrotask(listener);
              return { dispose: () => undefined };
            },
          }
        );
      },
    } as unknown as typeof vscode.window;

    const result = await runCapturedWithProgress(
      "Running feature",
      { progress: { onTestEnd }, complete, end },
      async (signal, progress) => {
        progress.onBegin?.(500);
        progress.onTestEnd?.({
          featurePath: "/repo/sample.feature",
          scenarioName: "first",
          status: "passed",
        }, 127, 500);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { success: false, output: "", error: "Cancelled", duration: 1 };
      },
      window
    );

    expect(result.error).toBe("Cancelled");
    expect(reports).toEqual([
      { message: "0 / 500 completed" },
      { message: "127 / 500 completed" },
    ]);
    expect(onTestEnd).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(result);
    expect(end).not.toHaveBeenCalled();
  });

  it("keeps notification progress alive when the TestRun observer throws", async () => {
    const reports: unknown[] = [];
    const window = {
      ...vscode.window,
      withProgress: async (
        _options: unknown,
        task: (
          progress: { report(value: unknown): void },
          token: {
            isCancellationRequested: boolean;
            onCancellationRequested(listener: () => void): { dispose(): void };
          }
        ) => Promise<unknown>
      ) => task(
        { report: (value) => reports.push(value) },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => undefined }),
        }
      ),
    } as unknown as typeof vscode.window;

    await runCapturedWithProgress(
      "Running feature",
      {
        progress: { onBegin: () => {throw new Error("TestRun closed");} },
        complete: () => undefined,
        end: () => undefined,
      },
      async (_signal, progress) => {
        progress.onBegin?.(2);
        return { success: true, output: "", duration: 1 };
      },
      window
    );

    expect(reports).toEqual([{ message: "0 / 2 completed" }]);
  });
});
