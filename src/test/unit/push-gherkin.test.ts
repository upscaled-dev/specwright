import { describe, it, expect } from "vitest";
import type { AutomationBindingClassification, TestCaseMetadata } from "../../traceability/contracts";
import {
  decidePush,
  hasGherkinDrift,
  PushDecision,
  PushGherkinDeps,
  runPushGherkin,
} from "../../traceability/push-gherkin";

const A = "Scenario: A\n  Given x";
const B = "Scenario: B\n  Given y";

describe("hasGherkinDrift", () => {
  it("ignores line endings and trailing whitespace", () => {
    expect(hasGherkinDrift("Scenario: A\r\n  Given x  \n", "Scenario: A\n  Given x")).toBe(false);
  });

  it("detects a meaningful text difference", () => {
    expect(hasGherkinDrift("Scenario: A\n  Given x", "Scenario: A\n  Given y")).toBe(true);
  });

  it("ignores per-line indentation differences", () => {
    expect(hasGherkinDrift("Scenario: A\n  Given x", "Scenario: A\n        Given x")).toBe(false);
  });
});

// Every combination of a present/absent baseline, a present/absent remote read, and a local text that
// matches one or the other. `undefined` is absence; a string, even "", is a value.
const MATRIX: Array<[string | undefined, string | undefined, string, PushDecision]> = [
  [undefined, undefined, A, "unknown-remote"],
  [undefined, undefined, B, "unknown-remote"],
  [undefined, A, A, "unknown-remote"],
  [undefined, A, B, "unknown-remote"],
  [undefined, B, A, "unknown-remote"],
  [undefined, B, B, "unknown-remote"],
  [A, undefined, A, "unknown-remote"],
  [A, undefined, B, "unknown-remote"],
  [B, undefined, A, "unknown-remote"],
  [B, undefined, B, "unknown-remote"],
  [A, A, A, "unchanged"],
  [A, A, B, "push"],
  [A, B, A, "drift"],
  [A, B, B, "drift"],
  [B, A, A, "drift"],
  [B, A, B, "drift"],
  [B, B, A, "push"],
  [B, B, B, "unchanged"],
];

describe("decidePush", () => {
  it.each(MATRIX)("stored %s + remote %s + local %s → %s", (stored, remote, local, expected) => {
    expect(decidePush(stored, remote, local)).toBe(expected);
  });

  it("treats an empty string as a value, not as an absent baseline or read", () => {
    expect(decidePush("", "", "")).toBe("unchanged");
    expect(decidePush("", "", A)).toBe("push");
    expect(decidePush("", A, A)).toBe("drift");
    expect(decidePush(A, "", A)).toBe("drift");
  });

  // PINNED: whitespace is not text. A local edit that only adds trailing spaces, a CRLF, an indent, or a
  // trailing blank line is `unchanged` and writes nothing, on the same rule the board's drift badge uses,
  // so the two can never contradict each other.
  it("never pushes a difference that is only whitespace", () => {
    expect(decidePush(A, A, "Scenario: A\n  Given x   ")).toBe("unchanged");
    expect(decidePush(A, A, "Scenario: A\r\n  Given x\r\n")).toBe("unchanged");
    expect(decidePush(A, A, "Scenario: A\n        Given x")).toBe("unchanged");
    expect(decidePush(A, A, `${A}\n\n`)).toBe("unchanged");
  });

  it("never reports drift for a baseline that differs from the remote only by whitespace", () => {
    expect(decidePush(`${A}  \n`, A, A)).toBe("unchanged");
    expect(decidePush(`${A}  \n`, A, B)).toBe("push");
  });
});

interface Rig {
  deps: PushGherkinDeps;
  calls: string[];
  pushed: Array<{ issueId: string; gherkin: string }>;
}

interface RigOptions {
  remote?: TestCaseMetadata | undefined;
  readBack?: string | undefined;
  refreshError?: Error | undefined;
  classifyBinding?: (() => AutomationBindingClassification) | undefined;
}

function rig(options: RigOptions = {}): Rig {
  const calls: string[] = [];
  const pushed: Array<{ issueId: string; gherkin: string }> = [];
  const remote = "remote" in options ? options.remote : { key: "CALC-1", issueId: "45678", gherkin: A };
  return {
    calls,
    pushed,
    deps: {
      readRemote: (key) => {
        calls.push(`read ${key}`);
        return Promise.resolve(remote);
      },
      pushGherkin: (issueId, gherkin) => {
        calls.push(`push ${issueId}`);
        pushed.push({ issueId, gherkin });
        return Promise.resolve("readBack" in options ? options.readBack : gherkin);
      },
      refresh: (key) => {
        calls.push(`refresh ${key}`);
        return options.refreshError ? Promise.reject(options.refreshError) : Promise.resolve();
      },
      ...(options.classifyBinding ? { classifyBinding: options.classifyBinding } : {}),
    },
  };
}

const STORED: TestCaseMetadata = { key: "CALC-1", issueId: "45678", gherkin: A };

describe("runPushGherkin", () => {
  it("reads the remote fresh before writing, then refreshes the one key it wrote", async () => {
    const h = rig();

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.calls).toEqual(["read CALC-1", "push 45678", "refresh CALC-1"]);
    expect(h.pushed).toEqual([{ issueId: "45678", gherkin: B }]);
    expect(outcome).toEqual({ kind: "pushed", key: "CALC-1" });
  });

  it("addresses the write by the issue id the FRESH read returned, never the stale one", async () => {
    const h = rig({ remote: { key: "CALC-1", issueId: "99999", gherkin: A } });

    await runPushGherkin(STORED, B, h.deps);

    expect(h.pushed[0]?.issueId).toBe("99999");
  });

  it("writes nothing when the remote moved since the last sync", async () => {
    const h = rig({ remote: { key: "CALC-1", issueId: "45678", gherkin: "Scenario: A\n  Given someone else edited this" } });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.calls).toEqual(["read CALC-1"]);
    expect(h.pushed).toEqual([]);
    expect(outcome).toMatchObject({ kind: "drift", key: "CALC-1" });
  });

  it("writes nothing when there is no synced baseline to compare against", async () => {
    const h = rig();

    const outcome = await runPushGherkin({ key: "CALC-1" }, B, h.deps);

    expect(h.calls).toEqual(["read CALC-1"]);
    expect(h.pushed).toEqual([]);
    expect(outcome).toEqual({ kind: "no-baseline", key: "CALC-1" });
  });

  it("writes nothing when the fresh read finds no remote test for the key", async () => {
    const h = rig({ remote: undefined });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.pushed).toEqual([]);
    expect(outcome).toEqual({ kind: "no-remote-test", key: "CALC-1" });
  });

  it("writes nothing when the remote carries no issue id to address the write to", async () => {
    const h = rig({ remote: { key: "CALC-1", gherkin: A } });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.pushed).toEqual([]);
    expect(outcome).toEqual({ kind: "no-issue-id", key: "CALC-1" });
  });

  it("writes nothing when the local text already matches the remote", async () => {
    const h = rig();

    const outcome = await runPushGherkin(STORED, `${A}  `, h.deps);

    expect(h.calls).toEqual(["read CALC-1"]);
    expect(outcome).toEqual({ kind: "unchanged", key: "CALC-1" });
  });

  it("reports a read-back that differs from what was sent, still refreshing the baseline", async () => {
    const h = rig({ readBack: "Scenario: A\n  Given the server rewrote this" });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.calls).toEqual(["read CALC-1", "push 45678", "refresh CALC-1"]);
    expect(outcome).toMatchObject({ kind: "unverified", key: "CALC-1" });
  });

  it("reports a response that carried no text to verify against", async () => {
    const h = rig({ readBack: undefined });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.calls).toEqual(["read CALC-1", "push 45678", "refresh CALC-1"]);
    expect(outcome).toMatchObject({ kind: "unverified", reason: expect.stringContaining("no text") });
  });

  it("refuses a remote the provider classifies as the wrong test type, before any write", async () => {
    const h = rig({
      remote: { key: "CALC-1", issueId: "45678", gherkin: A, testType: { name: "Manual", kind: "Steps" } },
      classifyBinding: () => "incompatible-test-type",
    });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.calls).toEqual(["read CALC-1"]);
    expect(h.pushed).toEqual([]);
    expect(outcome).toEqual({ kind: "wrong-test-type", key: "CALC-1", testType: "Manual" });
  });

  it("lets an unknown classification through, since a partial snapshot must never block a push", async () => {
    const h = rig({ classifyBinding: () => "unknown" });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(outcome).toEqual({ kind: "pushed", key: "CALC-1" });
  });

  // The write already landed: reporting it as a failure would send the user to re-push text the remote
  // has, so the refresh fault only downgrades the report.
  it("keeps a landed push successful when the baseline refresh fails, carrying its error up", async () => {
    const h = rig({ refreshError: new Error("offline") });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(h.calls).toEqual(["read CALC-1", "push 45678", "refresh CALC-1"]);
    expect(outcome).toEqual({ kind: "pushed", key: "CALC-1", refreshError: "offline" });
  });

  it("keeps an unverified push unverified when the baseline refresh also fails", async () => {
    const h = rig({ readBack: "Scenario: A\n  Given the server rewrote this", refreshError: new Error("offline") });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(outcome).toMatchObject({ kind: "unverified", refreshError: "offline" });
  });

  it("accepts a read-back that differs from what was sent only by whitespace", async () => {
    const h = rig({ readBack: `${B}\n` });

    const outcome = await runPushGherkin(STORED, B, h.deps);

    expect(outcome).toEqual({ kind: "pushed", key: "CALC-1" });
  });
});
