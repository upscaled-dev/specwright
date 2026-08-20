import { describe, expect, it, vi } from "vitest";
import {
  readProcessIdentity,
  readProcessTable,
  survivingMembers,
  treeMembers,
  type ProcessEntry,
} from "../../core/windows-process-tree";

const START = Date.parse("2026-08-18T14:23:59.123Z");

function entry(pid: number, parentPid: number, offsetMs: number | undefined): ProcessEntry {
  return { pid, parentPid, creationDate: offsetMs === undefined ? undefined : START + offsetMs };
}

const ROOT = { pid: 100, creationDate: START };

function pids(members: readonly { pid: number }[]): number[] {
  return members.map((member) => member.pid).sort((a, b) => a - b);
}

describe("treeMembers", () => {
  it("walks the tree from the recorded root through every generation", () => {
    const snapshot = [
      entry(4, 0, 0),
      entry(100, 4, 0),
      entry(200, 100, 10),
      entry(300, 200, 20),
      entry(400, 100, 30),
      entry(500, 999, 40),
    ];

    expect(pids(treeMembers(snapshot, [ROOT]))).toEqual([100, 200, 300, 400]);
  });

  it("keeps the root recorded even when the snapshot no longer lists it", () => {
    expect(treeMembers([entry(200, 100, 10)], [ROOT])).toEqual([ROOT]);
    expect(treeMembers([], [ROOT])).toEqual([ROOT]);
  });

  it("refuses the children of a reused root pid", () => {
    const snapshot = [entry(100, 4, 5_000), entry(200, 100, 6_000)];

    expect(treeMembers(snapshot, [ROOT])).toEqual([ROOT]);
  });

  it("refuses a reused pid mid-chain and everything hanging off it", () => {
    // 200 started before the root, so it is a different process that inherited the pid.
    const snapshot = [entry(100, 4, 0), entry(200, 100, -1), entry(300, 200, 20)];

    expect(pids(treeMembers(snapshot, [ROOT]))).toEqual([100]);
  });

  // Nothing links a grandchild to the run once the parent that connected them is gone, and a pid
  // alone would enroll whichever process inherits it, so the descent ends at the absent parent.
  it("enrolls no descendant whose parent row the snapshot no longer holds", () => {
    const snapshot = [entry(100, 4, 0), entry(300, 200, 20)];

    expect(pids(treeMembers(snapshot, [ROOT]))).toEqual([100]);
  });

  it("keeps a subtree under a member whose creation instant Windows does not report", () => {
    const snapshot = [entry(100, 4, 0), entry(200, 100, undefined), entry(300, 200, -50)];

    expect(treeMembers(snapshot, [ROOT])).toEqual([
      ROOT,
      { pid: 200, creationDate: undefined },
      { pid: 300, creationDate: START - 50 },
    ]);
  });

  it("extends membership from the members that survived a kill", () => {
    const snapshot = [entry(200, 100, 10), entry(600, 200, 90)];

    expect(pids(treeMembers(snapshot, [{ pid: 200, creationDate: START + 10 }])))
      .toEqual([200, 600]);
  });

  it("terminates on self-parenting and mutually parented rows", () => {
    const snapshot = [entry(100, 100, 0), entry(200, 300, 10), entry(300, 200, 20)];

    expect(pids(treeMembers(snapshot, [ROOT]))).toEqual([100]);
  });
});

describe("survivingMembers", () => {
  const members = [ROOT, { pid: 200, creationDate: START + 10 }];

  it("reports the recorded identities the table still lists", () => {
    const snapshot = [entry(100, 4, 0), entry(900, 1, 50)];

    expect(survivingMembers(snapshot, members)).toEqual([ROOT]);
  });

  it("reports nothing once every recorded identity is gone", () => {
    expect(survivingMembers([entry(900, 1, 50)], members)).toEqual([]);
  });

  it("does not mistake a reused pid for the recorded process", () => {
    expect(survivingMembers([entry(100, 4, 9_000), entry(200, 1, 9_000)], members)).toEqual([]);
  });

  it("matches a member with no recorded instant on its pid alone", () => {
    const pidOnly = [{ pid: 200, creationDate: undefined }];

    expect(survivingMembers([entry(200, 1, 9_000)], pidOnly)).toEqual(pidOnly);
  });

  it("matches on pid alone when the table reports no instant for the row", () => {
    expect(survivingMembers([entry(100, 4, undefined)], members)).toEqual([ROOT]);
  });
});

describe("readProcessTable", () => {
  const row = (pid: number, parentPid: number, creationDate: unknown): unknown =>
    ({ ProcessId: pid, ParentProcessId: parentPid, CreationDate: creationDate });

  it("queries the live table through one PowerShell invocation", async () => {
    const read = vi.fn(() => Promise.resolve(JSON.stringify([row(100, 4, "2026-08-18T14:23:59.123Z")])));

    await expect(readProcessTable(read)).resolves.toEqual([entry(100, 4, 0)]);
    expect(read).toHaveBeenCalledWith(
      "Get-CimInstance Win32_Process | " +
      "Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress"
    );
  });

  it.each([
    ["ISO 8601", "2026-08-18T14:23:59.123+02:00"],
    ["ISO 8601 with sub-millisecond digits", "2026-08-18T12:23:59.1234567Z"],
    ["DMTF", "20260818142359.123456+120"],
    ["a .NET epoch literal", `/Date(${Date.parse("2026-08-18T12:23:59.123Z")})/`],
  ])("reads a creation instant written as %s", async (_shape, creationDate) => {
    const read = () => Promise.resolve(JSON.stringify([row(100, 4, creationDate)]));

    await expect(readProcessTable(read)).resolves.toEqual([
      { pid: 100, parentPid: 4, creationDate: Date.parse("2026-08-18T12:23:59.123Z") },
    ]);
  });

  it("reads a single-process answer that PowerShell did not wrap in an array", async () => {
    const read = () => Promise.resolve(JSON.stringify(row(100, 4, "2026-08-18T14:23:59.123Z")));

    await expect(readProcessTable(read)).resolves.toEqual([entry(100, 4, 0)]);
  });

  it("keeps a kernel row that Windows reports without a creation instant", async () => {
    const read = () => Promise.resolve(JSON.stringify([row(0, 0, null), row(100, 4, "2026-08-18T14:23:59.123Z")]));

    await expect(readProcessTable(read)).resolves.toEqual([entry(0, 0, undefined), entry(100, 4, 0)]);
  });

  it.each([
    ["the query failed", undefined],
    ["the answer is not JSON", "Get-CimInstance : Access denied"],
    ["a creation instant cannot be read", JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, CreationDate: "yesterday" }])],
    ["a creation instant is not a string", JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, CreationDate: 17870558 }])],
    ["a pid is not a whole number", JSON.stringify([{ ProcessId: "1", ParentProcessId: 0, CreationDate: null }])],
    ["a parent pid is missing", JSON.stringify([{ ProcessId: 1, CreationDate: null }])],
    ["a row is not an object", JSON.stringify([7])],
  ])("fails the probe when %s", async (_reason, output) => {
    await expect(readProcessTable(() => Promise.resolve(output))).resolves.toBeUndefined();
  });

  // PowerShell exits 0 with empty output when the CIM query fails, and a live table always lists
  // System and Idle, so no rows means the probe failed rather than the machine being empty.
  it("fails the probe when the answer has no rows", async () => {
    await expect(readProcessTable(() => Promise.resolve(""))).resolves.toBeUndefined();
    await expect(readProcessTable(() => Promise.resolve("null"))).resolves.toBeUndefined();
    await expect(readProcessTable(() => Promise.resolve("[]"))).resolves.toBeUndefined();
  });
});

describe("readProcessIdentity", () => {
  it("pins the requested pid to its creation instant", async () => {
    const read = vi.fn((_script: string) => Promise.resolve(JSON.stringify([
      { ProcessId: 4242, ParentProcessId: 100, CreationDate: "2026-08-18T14:23:59.123Z" },
    ])));

    await expect(readProcessIdentity(4242, read)).resolves.toEqual({ pid: 4242, creationDate: START });
    expect(read.mock.calls[0]?.[0]).toContain('Win32_Process -Filter "ProcessId=4242"');
  });

  it.each([
    ["the process already exited", ""],
    ["the answer names another process", JSON.stringify([{ ProcessId: 7, ParentProcessId: 1, CreationDate: null }])],
    ["Windows reports no creation instant", JSON.stringify([{ ProcessId: 4242, ParentProcessId: 1, CreationDate: null }])],
    ["the query failed", undefined],
  ])("has no identity when %s", async (_reason, output) => {
    await expect(readProcessIdentity(4242, () => Promise.resolve(output))).resolves.toBeUndefined();
  });
});
