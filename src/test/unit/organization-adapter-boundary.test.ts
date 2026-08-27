import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { OrganizationCapability, OrganizationSnapshot, TraceabilityAdapter } from "../../traceability/contracts";
import { validatedAdapter } from "../../traceability/validated-adapter";

function rawAdapter(organization: OrganizationCapability): TraceabilityAdapter {
  return {
    id: "test", label: "Test",
    keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^T-\d+$/u, canonicalizeKey: (key) => key },
    browseUrl: () => undefined,
    organization,
  };
}

const emptySnapshot = { repositories: [], testSetProjects: [], stale: false, omittedTestSetProjectCount: 0, omittedRepositoryProjectCount: 0 } as const;

describe("organization adapter boundary", () => {
  it("rejects inconsistent membership and complete refresh claims", async () => {
    const changed = new vscode.EventEmitter<void>();
    const refresh = vi.fn()
      .mockResolvedValueOnce({ status: "complete" })
      .mockResolvedValueOnce({
        status: "complete",
        testSet: {
          key: "T-1", issueId: "1", members: [{ key: "T-2" }, { key: "T-2" }], remoteMemberCount: 2,
          membershipComplete: true, truncated: false, errors: [],
        },
      });
    const adapter = validatedAdapter(rawAdapter({
      onDidChange: changed.event, snapshot: () => emptySnapshot,
      sync: () => Promise.resolve(), refreshTestSet: refresh,
    }), () => Promise.resolve(), () => undefined);

    await expect(adapter.organization!.refreshTestSet("T-1")).rejects.toMatchObject({ code: "malformed-response" });
    await expect(adapter.organization!.refreshTestSet("T-1")).rejects.toMatchObject({ code: "malformed-response" });
  });

  it("rejects impossible complete and truncated project snapshots", () => {
    const changed = new vscode.EventEmitter<void>();
    const adapter = validatedAdapter(rawAdapter({
      onDidChange: changed.event,
      snapshot: () => ({
        repositories: [{ projectKey: "T", tests: [], complete: true, truncated: true, errors: [] }],
        testSetProjects: [], stale: false, omittedTestSetProjectCount: 0, omittedRepositoryProjectCount: 0,
      }),
      sync: () => Promise.resolve(), refreshTestSet: () => Promise.resolve({ status: "failed" }),
    }), () => Promise.resolve(), () => undefined);

    expect(() => adapter.organization!.snapshot()).toThrow(expect.objectContaining({ code: "malformed-response" }));
  });

  it.each([
    ["project keys", {
      ...emptySnapshot,
      repositories: [
        { projectKey: "T", tests: [], complete: true, truncated: false, errors: [] },
        { projectKey: "T", tests: [], complete: true, truncated: false, errors: [] },
      ],
    }],
    ["repository test keys", {
      ...emptySnapshot,
      repositories: [
        { projectKey: "T", tests: [{ key: "T-1" }], complete: true, truncated: false, errors: [] },
        { projectKey: "U", tests: [{ key: "T-1" }], complete: true, truncated: false, errors: [] },
      ],
    }],
    ["Test Set keys", {
      ...emptySnapshot,
      testSetProjects: [
        { projectKey: "T", complete: true, truncated: false, errors: [], testSets: [
          { key: "T-1", issueId: "1", members: [], remoteMemberCount: 0, membershipComplete: true, truncated: false, errors: [] },
        ] },
        { projectKey: "U", complete: true, truncated: false, errors: [], testSets: [
          { key: "T-1", issueId: "2", members: [], remoteMemberCount: 0, membershipComplete: true, truncated: false, errors: [] },
        ] },
      ],
    }],
  ])("rejects duplicate organization %s", (_label, snapshot) => {
    const adapter = validatedAdapter(rawAdapter({
      onDidChange: new vscode.EventEmitter<void>().event, snapshot: () => snapshot,
      sync: () => Promise.resolve(), refreshTestSet: () => Promise.resolve({ status: "failed" }),
    }), () => Promise.resolve(), () => undefined);

    expect(() => adapter.organization!.snapshot()).toThrow(expect.objectContaining({ code: "malformed-response" }));
  });

  it("accepts last-known members when the current remote total has shrunk", () => {
    const members = Array.from({ length: 120 }, (_, index) => ({ key: `T-${index + 1}` }));
    const snapshot = {
      ...emptySnapshot,
      testSetProjects: [{
        projectKey: "T", complete: false, truncated: true, errors: ["partial"],
        testSets: [{
          key: "T-301", issueId: "301", members, remoteMemberCount: 100,
          membershipComplete: false, truncated: true, membersLastKnown: true,
          errors: ["Showing last-known member details; exact membership requires refresh."],
        }],
      }],
    };
    const adapter = validatedAdapter(rawAdapter({
      onDidChange: new vscode.EventEmitter<void>().event, snapshot: () => snapshot,
      sync: () => Promise.resolve(), refreshTestSet: () => Promise.resolve({ status: "failed" }),
    }), () => Promise.resolve(), () => undefined);

    expect(adapter.organization!.snapshot()).toEqual(snapshot);
  });

  it("contains a changed event whose current snapshot has duplicate identities", () => {
    const changed = new vscode.EventEmitter<void>();
    let snapshot: OrganizationSnapshot = emptySnapshot;
    const reporter = vi.fn();
    const listener = vi.fn();
    const adapter = validatedAdapter(rawAdapter({
      onDidChange: changed.event, snapshot: () => snapshot,
      sync: () => Promise.resolve(), refreshTestSet: () => Promise.resolve({ status: "failed" }),
    }), () => Promise.resolve(), reporter);
    adapter.organization!.onDidChange(listener);
    snapshot = {
      ...emptySnapshot,
      repositories: [{ projectKey: "T", tests: [{ key: "T-1" }, { key: "T-1" }], complete: true, truncated: false, errors: [] }],
    };

    changed.fire();

    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ code: "malformed-response" }));
    expect(listener).not.toHaveBeenCalled();
  });

  it("contains malformed provider events and ignores them after disposal", async () => {
    const changed = new vscode.EventEmitter<void>();
    const reporter = vi.fn();
    const listener = vi.fn();
    const adapter = validatedAdapter(rawAdapter({
      onDidChange: changed.event, snapshot: () => emptySnapshot,
      sync: () => Promise.resolve(), refreshTestSet: () => Promise.resolve({ status: "failed" }),
    }), () => Promise.resolve(), reporter);
    adapter.organization!.onDidChange(listener);

    changed.fire("invalid" as never);

    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ code: "malformed-response" }));
    expect(listener).not.toHaveBeenCalled();
    await adapter.dispose?.();
    changed.fire();
    expect(listener).not.toHaveBeenCalled();
  });
});
