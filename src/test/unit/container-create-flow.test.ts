import { describe, it, expect, vi } from "vitest";
import { runContainerCreate } from "../../traceability/container-create-flow";
import type { AuthoredTest, NewContainerSpec } from "../../traceability/contracts";

const IDS: Record<string, string> = { "CALC-1": "1001", "CALC-2": "1002", "CALC-3": "1003" };

interface Rig {
  create: ReturnType<typeof vi.fn>;
  issueIdFor: (key: string) => string | undefined;
}

function rig(created: AuthoredTest = { key: "CALC-90", issueId: "9000", warnings: [] }, ids = IDS): Rig {
  return {
    create: vi.fn((_spec: NewContainerSpec) => Promise.resolve(created)),
    issueIdFor: (key: string) => ids[key],
  };
}

describe("runContainerCreate", () => {
  it("sends one create with the members' issue ids, in the order the board picked them", async () => {
    const deps = rig();

    const outcome = await runContainerCreate(["CALC-3", "CALC-1"], "CALC", "Regression", deps);

    expect(deps.create).toHaveBeenCalledOnce();
    expect(deps.create.mock.calls[0]?.[0]).toEqual({
      project: "CALC",
      summary: "Regression",
      testIssueIds: ["1003", "1001"],
    });
    expect(outcome).toEqual({ kind: "created", created: { key: "CALC-90", issueId: "9000", warnings: [] } });
  });

  it("fails the whole batch before any remote call when a key has no issue id, naming every one", async () => {
    const deps = rig(undefined, { "CALC-2": "1002" });

    const outcome = await runContainerCreate(["CALC-1", "CALC-2", "CALC-3"], "CALC", "Regression", deps);

    expect(outcome).toEqual({ kind: "unresolved", keys: ["CALC-1", "CALC-3"] });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("carries a container created without a readable key back as created, never as a failure", async () => {
    const deps = rig({ issueId: "9000", warnings: [] });

    const outcome = await runContainerCreate(["CALC-1"], "CALC", "Regression", deps);

    expect(outcome).toEqual({ kind: "created", created: { issueId: "9000", warnings: [] } });
  });

  it("carries the create's warnings through untouched", async () => {
    const deps = rig({ key: "CALC-90", warnings: ["CALC-2 was already in another plan"] });

    const outcome = await runContainerCreate(["CALC-1", "CALC-2"], "CALC", "Regression", deps);

    expect(outcome).toEqual({
      kind: "created",
      created: { key: "CALC-90", warnings: ["CALC-2 was already in another plan"] },
    });
  });

  it("surfaces a rejected create to the caller rather than swallowing it", async () => {
    const deps = rig();
    deps.create.mockRejectedValueOnce(new Error("offline"));

    await expect(runContainerCreate(["CALC-1"], "CALC", "Regression", deps)).rejects.toThrow("offline");
  });
});
