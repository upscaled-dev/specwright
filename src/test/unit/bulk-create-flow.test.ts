import { describe, it, expect, vi } from "vitest";
import { BulkCreateDeps, BulkCreateScenario, runBulkCreate } from "../../traceability/bulk-create-flow";
import { AuthoredTest, NewTestSpec } from "../../traceability/contracts";
import { TagWrite } from "../../traceability/tag-edit";

function scenario(name: string, line: number): BulkCreateScenario {
  return {
    ref: { filePath: "/ws/a.feature", line, name, kind: "scenario" },
    gherkin: `Scenario: ${name}\n  Given x`,
  };
}

const A = scenario("Log in", 3);
const B = scenario("Checkout", 8);
const C = scenario("Refund", 14);

interface Rig {
  deps: BulkCreateDeps;
  specs: NewTestSpec[];
  tagged: Array<{ name: string; key: string }>;
  merged: string[];
  reported: string[];
}

// One create per call, answering the queued outcome for that index: an AuthoredTest to return or an
// Error to throw. The tag write answers "inserted" unless `writes` names another outcome for the key.
function rig(
  outcomes: Array<AuthoredTest | Error>,
  writes: Record<string, TagWrite<"inserted">> = {}
): Rig {
  const specs: NewTestSpec[] = [];
  const tagged: Array<{ name: string; key: string }> = [];
  const merged: string[] = [];
  const reported: string[] = [];
  const deps: BulkCreateDeps = {
    locationHolds: () => Promise.resolve(true),
    createTest: (spec) => {
      const outcome = outcomes[specs.length];
      specs.push(spec);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome as AuthoredTest);
    },
    insertTag: (item, key) => {
      tagged.push({ name: item.ref.name, key });
      return Promise.resolve(writes[key] ?? "inserted");
    },
    merge: (key) => merged.push(key),
    report: (item) => reported.push(item.ref.name),
  };
  return { deps, specs, tagged, merged, reported };
}

const created = (key: string): AuthoredTest => ({ key, warnings: [] });

describe("runBulkCreate", () => {
  it("creates one test per scenario in order, tagging and merging each before the next create", async () => {
    const { deps, specs, tagged, merged, reported } = rig([created("CALC-1"), created("CALC-2")]);

    const result = await runBulkCreate([A, B], "CALC", deps, new AbortController().signal);

    expect(specs).toEqual([
      { project: "CALC", summary: "Log in", gherkin: A.gherkin },
      { project: "CALC", summary: "Checkout", gherkin: B.gherkin },
    ]);
    expect(tagged).toEqual([
      { name: "Log in", key: "CALC-1" },
      { name: "Checkout", key: "CALC-2" },
    ]);
    expect(merged).toEqual(["CALC-1", "CALC-2"]);
    expect(reported).toEqual(["Log in", "Checkout"]);
    expect(result.created.map((entry) => [entry.scenario.ref.name, entry.key])).toEqual([
      ["Log in", "CALC-1"],
      ["Checkout", "CALC-2"],
    ]);
    expect(result.failed).toEqual([]);
  });

  it("serializes the writes: the next create never starts before the previous tag write settles", async () => {
    const order: string[] = [];
    let releaseTag!: () => void;
    const deps: BulkCreateDeps = {
      locationHolds: () => Promise.resolve(true),
      createTest: (spec) => {
        order.push(`create ${spec.summary}`);
        return Promise.resolve(created(spec.summary === "Log in" ? "CALC-1" : "CALC-2"));
      },
      insertTag: (item) => {
        order.push(`tag ${item.ref.name}`);
        return item.ref.name === "Log in"
          ? new Promise<TagWrite<"inserted">>((resolve) => {
              releaseTag = () => resolve("inserted");
            })
          : Promise.resolve("inserted");
      },
      merge: () => undefined,
      report: () => undefined,
    };

    const running = runBulkCreate([A, B], "CALC", deps, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["create Log in", "tag Log in"]);

    releaseTag();
    await running;

    expect(order).toEqual(["create Log in", "tag Log in", "create Checkout", "tag Checkout"]);
  });

  it("creates nothing for a scenario whose location no longer holds, and keeps going", async () => {
    const { deps, specs } = rig([created("CALC-1"), created("CALC-2")]);
    const moved: BulkCreateDeps = { ...deps, locationHolds: (item) => Promise.resolve(item !== B) };

    const result = await runBulkCreate([A, B, C], "CALC", moved, new AbortController().signal);

    expect(specs.map((spec) => spec.summary)).toEqual(["Log in", "Refund"]);
    expect(result.failed).toEqual([{ scenario: B, reason: "the feature file changed during the batch" }]);
    expect(result.created.map((entry) => entry.scenario)).toEqual([A, C]);
  });

  it("keeps going past a failed create, reporting its error as that scenario's reason", async () => {
    const { deps } = rig([created("CALC-1"), new Error("Xray rejected the payload"), created("CALC-3")]);

    const result = await runBulkCreate([A, B, C], "CALC", deps, new AbortController().signal);

    expect(result.created.map((entry) => entry.key)).toEqual(["CALC-1", "CALC-3"]);
    expect(result.failed).toEqual([{ scenario: B, reason: "Xray rejected the payload" }]);
  });

  it("fails a refused tag write with the created key named, and still merges it", async () => {
    const { deps, merged } = rig([created("CALC-1"), created("CALC-2")], { "CALC-2": "rejected" });

    const result = await runBulkCreate([A, B], "CALC", deps, new AbortController().signal);

    expect(result.created.map((entry) => entry.key)).toEqual(["CALC-1"]);
    expect(result.failed[0]!.scenario).toBe(B);
    expect(result.failed[0]!.reason).toContain("CALC-2 was created");
    expect(result.failed[0]!.reason).toContain("the feature file edit was not applied");
    expect(merged).toEqual(["CALC-1", "CALC-2"]);
  });

  it("fails a create that answered no readable key, naming the issue id and tagging nothing", async () => {
    const { deps, tagged, merged } = rig([{ issueId: "45678", warnings: [] }]);

    const result = await runBulkCreate([A], "CALC", deps, new AbortController().signal);

    expect(tagged).toEqual([]);
    expect(merged).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.failed[0]!.reason).toContain("45678");
  });

  it("stops before the next item once aborted, keeping everything already done", async () => {
    const controller = new AbortController();
    const { deps, specs } = rig([created("CALC-1"), created("CALC-2"), created("CALC-3")]);
    const aborting: BulkCreateDeps = { ...deps, merge: () => controller.abort() };

    const result = await runBulkCreate([A, B, C], "CALC", aborting, controller.signal);

    expect(specs).toHaveLength(1);
    expect(result.created.map((entry) => entry.key)).toEqual(["CALC-1"]);
    expect(result.failed).toEqual([]);
  });

  it("creates nothing at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, specs, reported } = rig([created("CALC-1")]);

    const result = await runBulkCreate([A, B], "CALC", deps, controller.signal);

    expect(specs).toEqual([]);
    expect(reported).toEqual([]);
    expect(result).toEqual({ created: [], failed: [] });
  });

  it("survives a throwing progress callback, failing only that item", async () => {
    const { deps, specs } = rig([created("CALC-1"), created("CALC-2")]);
    const noisy: BulkCreateDeps = {
      ...deps,
      report: (item) => {
        if (item === A) {
          throw new Error("progress died");
        }
      },
    };

    const result = await runBulkCreate([A, B], "CALC", noisy, new AbortController().signal);

    expect(specs.map((spec) => spec.summary)).toEqual(["Checkout"]);
    expect(result.failed).toEqual([{ scenario: A, reason: "progress died" }]);
    expect(result.created.map((entry) => entry.key)).toEqual(["CALC-1"]);
  });

  it("passes the signal into every create, so a capability can abort its own request in flight", async () => {
    const controller = new AbortController();
    const createTest = vi.fn((_spec: NewTestSpec, _signal?: AbortSignal) => Promise.resolve(created("CALC-1")));
    const deps: BulkCreateDeps = {
      locationHolds: () => Promise.resolve(true),
      createTest,
      insertTag: () => Promise.resolve("inserted"),
      merge: () => undefined,
      report: () => undefined,
    };

    await runBulkCreate([A], "CALC", deps, controller.signal);

    expect(createTest.mock.calls[0]![1]).toBe(controller.signal);
  });
});
