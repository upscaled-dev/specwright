import * as vscode from "vscode";

interface QueuedProject {
  readonly force: boolean;
  readonly ready: boolean;
}

export interface ProjectSyncSchedulerDeps {
  readonly onDidChangeActivity: vscode.Event<void>;
  canStart(): boolean;
  run(project: string, force: boolean): Promise<void>;
  onError(project: string, error: unknown): void;
}

/** A lossless, deterministic queue for project reads that must follow active work. */
export class ProjectSyncScheduler implements vscode.Disposable {
  private readonly queued = new Map<string, QueuedProject>();
  private readonly activitySubscription: vscode.Disposable;
  private deferredTimer: ReturnType<typeof setTimeout> | undefined;
  private current: { project: string; force: boolean } | undefined;
  private drainTask: Promise<void> | undefined;
  private draining = false;
  private disposed = false;

  constructor(private readonly deps: ProjectSyncSchedulerDeps) {
    this.activitySubscription = deps.onDidChangeActivity(() => this.poke());
  }

  public enqueue(project: string, force: boolean): void {
    this.merge(project, force, true, false);
    this.poke();
  }

  public defer(project: string, force: boolean): void {
    this.merge(project, force, false, true);
    if (this.disposed || this.deferredTimer !== undefined) {return;}
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = undefined;
      for (const [key, value] of this.queued) {
        if (!value.ready) {this.queued.set(key, { ...value, ready: true });}
      }
      this.poke();
    }, 0);
  }

  public poke(): void {
    if (this.disposed || this.draining || this.drainTask !== undefined || !this.deps.canStart()) {return;}
    let next: [string, QueuedProject] | undefined;
    for (const entry of this.queued) {
      if (entry[1].ready) {next = entry; break;}
    }
    if (next === undefined) {return;}
    // Close synchronous activity-event reentrancy before run() can start its tracked sync.
    this.draining = true;
    this.drainTask = this.drain(next).finally(() => {
      this.drainTask = undefined;
      this.draining = false;
      this.poke();
    });
  }

  private merge(project: string, force: boolean, ready: boolean, followsCurrent: boolean): void {
    if (this.disposed) {return;}
    if (!followsCurrent && project === this.current?.project) {
      if (!force || this.current.force) {return;}
    }
    const existing = this.queued.get(project);
    this.queued.set(project, {
      force: force || existing?.force === true,
      ready: ready || existing?.ready === true,
    });
  }

  private async drain([project, request]: [string, QueuedProject]): Promise<void> {
    this.queued.delete(project);
    this.current = { project, force: request.force };
    try {
      await this.deps.run(project, request.force);
    } catch (error) {
      this.deps.onError(project, error);
    } finally {
      this.current = undefined;
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.deferredTimer !== undefined) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = undefined;
    }
    this.queued.clear();
    this.activitySubscription.dispose();
  }
}
