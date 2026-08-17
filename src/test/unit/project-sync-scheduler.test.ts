import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { BoardOperationState } from "../../traceability/board-operation-state";
import { ProjectSyncScheduler } from "../../commands/project-sync-scheduler";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {resolve = done;});
  return { promise, resolve };
}

describe("ProjectSyncScheduler", () => {
  it("preserves forced projects behind active sync and never lets ordinary duplicates downgrade them", async () => {
    const activity = new vscode.EventEmitter<void>();
    let active = true;
    const runs: Array<{ project: string; force: boolean }> = [];
    const scheduler = new ProjectSyncScheduler({
      onDidChangeActivity: activity.event,
      canStart: () => !active,
      run: (project, force) => {runs.push({ project, force }); return Promise.resolve();},
      onError: vi.fn(),
    });

    scheduler.enqueue("CALC", true);
    scheduler.enqueue("PAY", true);
    scheduler.enqueue("CALC", false);
    scheduler.enqueue("PAY", false);
    expect(runs).toEqual([]);

    active = false;
    activity.fire();
    await vi.waitFor(() => expect(runs).toHaveLength(2));

    expect(runs).toEqual([
      { project: "CALC", force: true },
      { project: "PAY", force: true },
    ]);
    scheduler.dispose();
  });

  it("continues deterministic draining after one project rejects", async () => {
    const activity = new vscode.EventEmitter<void>();
    const runs: string[] = [];
    const errors: string[] = [];
    const scheduler = new ProjectSyncScheduler({
      onDidChangeActivity: activity.event,
      canStart: () => true,
      run: (project) => {
        runs.push(project);
        return project === "CALC" ? Promise.reject(new Error("offline")) : Promise.resolve();
      },
      onError: (project) => errors.push(project),
    });

    scheduler.enqueue("CALC", true);
    scheduler.enqueue("PAY", true);
    await vi.waitFor(() => expect(runs).toHaveLength(2));

    expect(runs).toEqual(["CALC", "PAY"]);
    expect(errors).toEqual(["CALC"]);
    scheduler.dispose();
  });

  it("waits for the final overlapping mutation before starting deferred recovery", async () => {
    const operations = new BoardOperationState();
    const first = deferred();
    const second = deferred();
    const runs = vi.fn(() => Promise.resolve());
    const scheduler = new ProjectSyncScheduler({
      onDidChangeActivity: operations.onDidChange,
      canStart: () => !operations.mutationActive,
      run: runs,
      onError: vi.fn(),
    });
    const a = operations.mutation(() => first.promise);
    const b = operations.mutation(() => second.promise);
    scheduler.defer("CALC", true);
    await flush();

    first.resolve();
    await a;
    expect(runs).not.toHaveBeenCalled();

    second.resolve();
    await b;
    await vi.waitFor(() => expect(runs).toHaveBeenCalledOnce());
    expect(runs).toHaveBeenCalledWith("CALC", true);
    scheduler.dispose();
    operations.dispose();
  });

  it("coalesces a project and cancels deferred work safely on dispose", async () => {
    const activity = new vscode.EventEmitter<void>();
    const run = vi.fn(() => Promise.resolve());
    const scheduler = new ProjectSyncScheduler({
      onDidChangeActivity: activity.event,
      canStart: () => false,
      run,
      onError: vi.fn(),
    });
    scheduler.defer("CALC", false);
    scheduler.defer("CALC", true);
    scheduler.defer("CALC", false);
    scheduler.dispose();

    activity.fire();
    await flush();

    expect(run).not.toHaveBeenCalled();
  });

  it("promotes deferred work when the same project becomes immediately ready", async () => {
    const activity = new vscode.EventEmitter<void>();
    const run = vi.fn(() => Promise.resolve());
    const scheduler = new ProjectSyncScheduler({
      onDidChangeActivity: activity.event,
      canStart: () => true,
      run,
      onError: vi.fn(),
    });

    scheduler.defer("CALC", true);
    scheduler.enqueue("CALC", false);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    expect(run).toHaveBeenCalledWith("CALC", true);
    scheduler.dispose();
  });

  it.each(["sync", "mutation"] as const)(
    "waits for both current forced sync and mutation when %s settles first",
    async (settlesFirst) => {
      const operations = new BoardOperationState();
      const sync = deferred();
      const mutation = deferred();
      let call = 0;
      const run = vi.fn((_project: string, _force: boolean) => {
        call += 1;
        return call === 1 ? sync.promise : Promise.resolve();
      });
      const scheduler = new ProjectSyncScheduler({
        onDidChangeActivity: operations.onDidChange,
        canStart: () => !operations.mutationActive,
        run,
        onError: vi.fn(),
      });

      scheduler.enqueue("CALC", true);
      scheduler.enqueue("CALC", false);
      const activeMutation = operations.mutation(() => mutation.promise);
      scheduler.defer("CALC", true);
      scheduler.defer("CALC", true);
      await flush();
      expect(run).toHaveBeenCalledOnce();

      if (settlesFirst === "sync") {
        sync.resolve();
      } else {
        mutation.resolve();
        await activeMutation;
      }
      await flush();
      expect(run).toHaveBeenCalledOnce();

      if (settlesFirst === "sync") {
        mutation.resolve();
        await activeMutation;
      } else {
        sync.resolve();
      }
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      await flush();
      expect(run.mock.calls).toEqual([
        ["CALC", true],
        ["CALC", true],
      ]);

      scheduler.dispose();
      operations.dispose();
    }
  );
});
