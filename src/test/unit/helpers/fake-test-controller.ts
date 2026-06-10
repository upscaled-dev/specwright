/**
 * A functional in-memory fake of `vscode.TestController` (+ TestItem / TestItemCollection /
 * TestRun) for integration-style tests of PlaywrightBddTestProvider. Unlike the bare stub in
 * __mocks__/vscode.ts, this records run outcomes so a test can assert what got marked
 * passed/failed/skipped and what was written to the Test Results output.
 */
import { Range } from "../../__mocks__/vscode";

export interface RunOutcome {
  passed: string[];
  failed: Array<{ id: string; message: string }>;
  skipped: string[];
  started: string[];
  output: string[];
  ended: boolean;
}

export class FakeTestItemCollection {
  private readonly map = new Map<string, FakeTestItem>();

  get size(): number { return this.map.size; }
  add(item: FakeTestItem): void { this.map.set(item.id, item); }
  get(id: string): FakeTestItem | undefined { return this.map.get(id); }
  delete(id: string): void { this.map.delete(id); }
  replace(items: FakeTestItem[]): void {
    this.map.clear();
    for (const i of items) { this.map.set(i.id, i); }
  }
  forEach(cb: (item: FakeTestItem) => void): void {
    for (const item of this.map.values()) { cb(item); }
  }
}

export class FakeTestItem {
  public readonly children = new FakeTestItemCollection();
  public range: Range | undefined;
  public description: string | undefined;
  public canResolveChildren = false;
  constructor(
    public readonly id: string,
    public label: string,
    public readonly uri?: { fsPath: string } | undefined
  ) {}
}

export class FakeTestRun {
  public readonly outcome: RunOutcome = {
    passed: [], failed: [], skipped: [], started: [], output: [], ended: false,
  };
  constructor(public readonly request: unknown) {}

  started(item: FakeTestItem): void { this.outcome.started.push(item.id); }
  passed(item: FakeTestItem): void { this.outcome.passed.push(item.id); }
  failed(item: FakeTestItem, message: { message: string }): void {
    this.outcome.failed.push({ id: item.id, message: message?.message ?? String(message) });
  }
  skipped(item: FakeTestItem): void { this.outcome.skipped.push(item.id); }
  appendOutput(text: string): void { this.outcome.output.push(text); }
  end(): void { this.outcome.ended = true; }
}

export interface FakeRunProfile {
  label: string;
  kind: number;
  configureHandler?: () => void;
  runHandler: (request: unknown) => void | Promise<void>;
  dispose(): void;
}

export class FakeTestController {
  public readonly items = new FakeTestItemCollection();
  public resolveHandler: ((test: unknown) => void | Promise<void>) | undefined;
  public refreshHandler: (() => void | Promise<void>) | undefined;
  public readonly profiles: FakeRunProfile[] = [];
  public readonly runs: FakeTestRun[] = [];

  createTestItem(id: string, label: string, uri?: { fsPath: string }): FakeTestItem {
    return new FakeTestItem(id, label, uri);
  }

  createRunProfile(
    label: string,
    kind: number,
    runHandler: (request: unknown) => void | Promise<void>
  ): FakeRunProfile {
    const profile: FakeRunProfile = { label, kind, runHandler, dispose() { /* no-op */ } };
    this.profiles.push(profile);
    return profile;
  }

  createTestRun(request: unknown): FakeTestRun {
    const run = new FakeTestRun(request);
    this.runs.push(run);
    return run;
  }

  /** Find a run profile by its label (e.g. "Run", "Debug"). */
  profile(label: string): FakeRunProfile | undefined {
    return this.profiles.find((p) => p.label === label);
  }

  /** Depth-first lookup of a discovered item by id. */
  find(id: string): FakeTestItem | undefined {
    let found: FakeTestItem | undefined;
    const walk = (item: FakeTestItem): void => {
      if (found) {return;}
      if (item.id === id) { found = item; return; }
      item.children.forEach(walk);
    };
    this.items.forEach(walk);
    return found;
  }

  dispose(): void { /* no-op */ }
}
