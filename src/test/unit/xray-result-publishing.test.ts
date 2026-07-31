import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import {
  createXrayResultPublishing,
  IssueSearcher,
  IssueTypeResolver,
  ProjectSearcher,
  XrayResultPublishingDeps,
} from "../../xray/xray-result-publishing";
import { ImportResponse, ImportTransport, StepResolver } from "../../xray/execution-importers";
import { NotSupportedError, PreflightDecision, RunArtifact, RunArtifactResult, ShardInfo } from "../../traceability/contracts";
import { EVIDENCE_MAX_FILE_BYTES, EVIDENCE_MAX_TOTAL_BYTES, EvidenceFs } from "../../traceability/evidence-resolution";
import { ScenarioRef } from "../../traceability/scenario-ref";
import { Logger, LogLevel } from "../../utils/logger";
import type { OutputChannel } from "vscode";

let nextLine = 3;
function ref(name: string): ScenarioRef {
  return { filePath: "/ws/a.feature", line: nextLine++, name, kind: "scenario" };
}

function mapped(name: string, testKey: string, over: Partial<RunArtifactResult> = {}): RunArtifactResult {
  return { scenario: ref(name), outcome: "passed", durationMs: 10, attempts: 1, flaky: false, evidenceRefs: [], testKey, ...over };
}

function artifact(results: RunArtifactResult[], preflight: PreflightDecision[] = []): RunArtifact {
  return {
    id: "run-1",
    createdAt: Date.UTC(2026, 6, 22, 12, 0, 0),
    results,
    shards: [],
    selection: { kind: "all-mapped" },
    preflight,
    state: "complete",
  };
}

const OK_BODY = { key: "XNP-100", id: "1001", self: "https://x/1001" };

function spyTransport(response: ImportResponse = { status: 200, ok: true, body: OK_BODY }): {
  transport: ImportTransport;
  postJson: ReturnType<typeof vi.fn>;
  postMultipart: ReturnType<typeof vi.fn>;
} {
  const postJson = vi.fn(() => Promise.resolve(response));
  const postMultipart = vi.fn(() => Promise.resolve(response));
  return { transport: { postJson, postMultipart }, postJson, postMultipart };
}

const RESOLVE_ALL: StepResolver = (r) => (r.name === "gone" ? undefined : { featureName: "Feature", steps: ["Given a step"] });

function makeDeps(over: Partial<XrayResultPublishingDeps>): XrayResultPublishingDeps {
  return {
    transport: spyTransport().transport,
    site: () => "acme.atlassian.net",
    jiraCredentials: () => Promise.resolve(undefined),
    resolveSteps: RESOLVE_ALL,
    workspaceRootFor: () => undefined,
    attachTo: () => "evidence",
    executionIssueType: () => "Test Execution",
    logger: Logger.create(undefined, LogLevel.ERROR),
    ...over,
  };
}

describe("createXrayResultPublishing: publish routing (pin: create vs append mapping)", () => {
  it("create-new POSTs Cucumber multipart and never posts JSON: the import is the only remote call", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));

    const outcome = await publishing.publish(artifact([mapped("a", "CALC-1")]), {
      mode: "create-new",
      project: "CALC",
      summary: "Run",
    });

    expect(t.postMultipart).toHaveBeenCalledTimes(1);
    expect(t.postJson).not.toHaveBeenCalled();
    expect(t.postMultipart.mock.calls[0]![0]).toBe("/import/execution/cucumber/multipart");
    expect(outcome.ref).toEqual({ kind: "execution", key: "XNP-100" });
    expect(outcome.imported).toBe(1);
  });

  it("append POSTs Xray JSON with the top-level testExecutionKey and never posts multipart", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));

    const outcome = await publishing.publish(artifact([mapped("a", "CALC-1")]), {
      mode: "append",
      executionKey: "XNP-77",
    });

    expect(t.postJson).toHaveBeenCalledTimes(1);
    expect(t.postMultipart).not.toHaveBeenCalled();
    expect(t.postJson.mock.calls[0]![0]).toBe("/import/execution");
    const body = t.postJson.mock.calls[0]![1] as { testExecutionKey: string; tests: unknown[] };
    expect(body.testExecutionKey).toBe("XNP-77");
    expect(body.tests).toHaveLength(1);
    // An info block would make Xray write the execution issue's date fields, which fails screen validation.
    expect(body).not.toHaveProperty("info");
    expect(outcome.ref.key).toBe("XNP-100");
  });

  it("append sends schema-complete outline iterations with nanosecond durations", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    const scenario: ScenarioRef = {
      filePath: "/ws/a.feature",
      line: 3,
      name: "Outline",
      kind: "outline",
      outlineName: "Outline",
    };

    await publishing.publish(
      artifact([
        mapped("Outline", "CALC-4", {
          scenario,
          outcome: "failed",
          durationMs: 4000,
          iterations: [
            { name: "Example #1", outcome: "passed", durationMs: 1500, attempts: 1 },
            { name: "Example #2", outcome: "failed", durationMs: 2500, attempts: 1 },
          ],
        }),
      ]),
      { mode: "append", executionKey: "XNP-77" }
    );

    expect(t.postJson.mock.calls[0]![1]).toEqual({
      testExecutionKey: "XNP-77",
      tests: [
        {
          testKey: "CALC-4",
          status: "FAILED",
          iterations: [
            {
              name: "Example #1",
              status: "PASSED",
              parameters: [{ name: "example", value: "Example #1" }],
              duration: "1500000000",
            },
            {
              name: "Example #2",
              status: "FAILED",
              parameters: [{ name: "example", value: "Example #2" }],
              duration: "2500000000",
            },
          ],
        },
      ],
    });
    expect(t.postMultipart).not.toHaveBeenCalled();
  });

  // Whether a real Xray response can carry neither field is an open wire question, so the guard is the
  // honest one: the results landed somewhere this session cannot name, and no key is invented for them.
  it("leaves the ref empty and logs when a create response carries neither key nor id", async () => {
    const lines: string[] = [];
    const channel = { appendLine: (line: string) => lines.push(line), show: () => {}, clear: () => {}, dispose: () => {} };
    const t = spyTransport({ status: 200, ok: true, body: { self: "https://x/1001" } });
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, logger: Logger.create(channel as unknown as OutputChannel, LogLevel.WARN) })
    );

    const outcome = await publishing.publish(artifact([mapped("a", "CALC-1")]), {
      mode: "create-new",
      project: "CALC",
      summary: "Run",
    });

    expect(outcome.ref.key).toBe("");
    expect(outcome.imported).toBe(1);
    expect(lines.some((line) => line.includes("The import response named no execution"))).toBe(true);
  });

  it("falls back to the sent execution key when the append response omits one", async () => {
    const t = spyTransport({ status: 200, ok: true, body: {} });
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    const outcome = await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "append", executionKey: "XNP-77" });
    expect(outcome.ref.key).toBe("XNP-77");
  });
});

describe("createXrayResultPublishing: reconcile filter (cross-seam)", () => {
  it("never sends an excluded result to the create importer", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    const excluded = mapped("b", "CALC-2");
    const run = artifact(
      [mapped("a", "CALC-1"), excluded],
      [{ scenario: excluded.scenario, testKey: "CALC-2", state: "invalid-key", outcome: "exclude" }]
    );

    const outcome = await publishing.publish(run, { mode: "create-new", project: "CALC", summary: "Run" });

    const parts = t.postMultipart.mock.calls[0]![1] as { results: string };
    expect(parts.results).toContain("@TEST_CALC-1");
    expect(parts.results).not.toContain("@TEST_CALC-2");
    expect(outcome.imported).toBe(1);
  });

  it("drops a changed-since-run scenario from the create payload and surfaces it as a warning", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    const run = artifact([mapped("a", "CALC-1"), mapped("gone", "CALC-9")]);

    const outcome = await publishing.publish(run, { mode: "create-new", project: "CALC", summary: "Run" });

    expect(outcome.imported).toBe(1);
    expect(outcome.warnings).toEqual(["1 scenario(s) changed since the run and were not published."]);
    const parts = t.postMultipart.mock.calls[0]![1] as { results: string };
    expect(parts.results).not.toContain("@TEST_CALC-9");
  });
});

describe("createXrayResultPublishing: publish guards (fail fast before any import)", () => {
  it("rejects an empty create summary and posts nothing", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "CALC", summary: "" })
    ).rejects.toThrow("Enter a summary for the new execution before publishing.");
    expect(t.postMultipart).not.toHaveBeenCalled();
    expect(t.postJson).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only create summary and posts nothing", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "CALC", summary: "   " })
    ).rejects.toThrow("Enter a summary for the new execution before publishing.");
    expect(t.postMultipart).not.toHaveBeenCalled();
  });

  it("rejects a create publish when every scenario was dropped, surfacing the guard through the failure path", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    await expect(
      publishing.publish(artifact([mapped("gone", "CALC-9")]), { mode: "create-new", project: "CALC", summary: "Run" })
    ).rejects.toThrow("match the current feature files");
    expect(t.postMultipart).not.toHaveBeenCalled();
  });
});

// ---- Evidence resolution + attachTo routing ----

const shard = (workingDir: string): ShardInfo => ({ workingDir, command: "run", exitCode: 0, success: true });

function evidenceArtifact(results: RunArtifactResult[], shards: ShardInfo[]): RunArtifact {
  return {
    id: "run-1",
    createdAt: Date.UTC(2026, 6, 22, 12, 0, 0),
    results,
    shards,
    selection: { kind: "all-mapped" },
    preflight: [],
    state: "complete",
  };
}

function fakeFs(files: Record<string, Buffer>): EvidenceFs {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => files[p] ?? Buffer.alloc(0),
  };
}

const APPEND = { mode: "append", executionKey: "XNP-1" } as const;

describe("createXrayResultPublishing: evidence resolution + attachTo", () => {
  const shotAbs = path.join("/ws", "test-results/shot.png");
  const fs = fakeFs({ [shotAbs]: Buffer.from("PNG") });
  const JIRA = { email: "a@b.c", token: "t" };
  const withShot = (): RunArtifactResult => mapped("a", "CALC-1", { evidenceRefs: ["test-results/shot.png"] });
  // Jira creds present; the issue stream needs a real upload destination.
  const deps = (attachTo: XrayResultPublishingDeps["attachTo"], t: ImportTransport): XrayResultPublishingDeps =>
    makeDeps({
      transport: t,
      evidenceFs: fs,
      workspaceRootFor: () => "/ws",
      attachTo,
      jiraCredentials: () => Promise.resolve(JIRA),
    });

  it("evidence mode embeds the file in the payload and routes nothing to the issue", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(deps(() => "evidence", t.transport));
    const outcome = await publishing.publish(evidenceArtifact([withShot()], [shard("/ws")]), APPEND);
    const body = t.postJson.mock.calls[0]![1] as { tests: Array<{ evidence?: unknown }> };
    expect(body.tests[0]!.evidence).toEqual([{ data: Buffer.from("PNG").toString("base64"), filename: "shot.png", contentType: "image/png" }]);
    expect(outcome.issueEvidenceFiles).toEqual([]);
  });

  it("issue mode keeps evidence out of the payload and routes the file to the issue", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(deps(() => "issue", t.transport));
    const outcome = await publishing.publish(evidenceArtifact([withShot()], [shard("/ws")]), APPEND);
    const body = t.postJson.mock.calls[0]![1] as { tests: Array<{ evidence?: unknown }> };
    expect(body.tests[0]!.evidence).toBeUndefined();
    expect(outcome.issueEvidenceFiles).toEqual([shotAbs]);
  });

  it("both mode embeds AND routes to the issue", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(deps(() => "both", t.transport));
    const outcome = await publishing.publish(evidenceArtifact([withShot()], [shard("/ws")]), APPEND);
    const body = t.postJson.mock.calls[0]![1] as { tests: Array<{ evidence?: unknown[] }> };
    expect(body.tests[0]!.evidence).toHaveLength(1);
    expect(outcome.issueEvidenceFiles).toEqual([shotAbs]);
  });

  it("resolves an evidence ref against the shard's owning root in a multi-root batch (first existing wins)", async () => {
    const rootBShot = path.join("/roots/b", "test-results/shot.png");
    const multiFs = fakeFs({ [rootBShot]: Buffer.from("PNG") });
    const t = spyTransport();
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        evidenceFs: multiFs,
        workspaceRootFor: (dir) => (dir.startsWith("/roots/a") ? "/roots/a" : "/roots/b"),
        attachTo: () => "issue",
        jiraCredentials: () => Promise.resolve(JIRA),
      })
    );
    const outcome = await publishing.publish(
      evidenceArtifact([mapped("a", "CALC-1", { evidenceRefs: ["test-results/shot.png"] })], [shard("/roots/a/pkg"), shard("/roots/b/pkg")]),
      APPEND
    );
    expect(outcome.issueEvidenceFiles).toEqual([rootBShot]);
  });

  it("skips a missing evidence file with a surfaced warning and no crash", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        evidenceFs: fakeFs({}),
        workspaceRootFor: () => "/ws",
        attachTo: () => "both",
        jiraCredentials: () => Promise.resolve(JIRA),
      })
    );
    const outcome = await publishing.publish(
      evidenceArtifact([mapped("a", "CALC-1", { evidenceRefs: ["test-results/gone.png"] })], [shard("/ws")]),
      APPEND
    );
    expect(outcome.issueEvidenceFiles).toEqual([]);
    expect(outcome.warnings).toContain("Skipped 1 evidence file not found.");
  });

  it("issue mode WITHOUT Jira creds embeds in the payload instead and routes nothing (with a note)", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        evidenceFs: fs,
        workspaceRootFor: () => "/ws",
        attachTo: () => "issue",
        jiraCredentials: () => Promise.resolve(undefined),
      })
    );
    const outcome = await publishing.publish(evidenceArtifact([withShot()], [shard("/ws")]), APPEND);
    const body = t.postJson.mock.calls[0]![1] as { tests: Array<{ evidence?: unknown[] }> };
    expect(body.tests[0]!.evidence).toHaveLength(1);
    expect(outcome.issueEvidenceFiles).toEqual([]);
    expect(outcome.warnings).toContain("Jira credentials missing: evidence embedded in the payload instead.");
  });

  it("both mode WITHOUT Jira creds embeds once and leaves no un-clearable pending upload", async () => {
    const t = spyTransport();
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        evidenceFs: fs,
        workspaceRootFor: () => "/ws",
        attachTo: () => "both",
        jiraCredentials: () => Promise.resolve(undefined),
      })
    );
    const outcome = await publishing.publish(evidenceArtifact([withShot()], [shard("/ws")]), APPEND);
    const body = t.postJson.mock.calls[0]![1] as { tests: Array<{ evidence?: unknown[] }> };
    expect(body.tests[0]!.evidence).toHaveLength(1);
    expect(outcome.issueEvidenceFiles).toEqual([]);
  });

  it("shares the total evidence budget across results, so the second skips after the first exhausts it", async () => {
    const fullRefs = Array.from(
      { length: EVIDENCE_MAX_TOTAL_BYTES / EVIDENCE_MAX_FILE_BYTES },
      (_, index) => `test-results/full-${index}.png`
    );
    const secondRef = "test-results/second.png";
    const fullFile = Buffer.alloc(EVIDENCE_MAX_FILE_BYTES);
    const budgetFs = fakeFs(
      Object.fromEntries([
        ...fullRefs.map((ref) => [path.join("/ws", ref), fullFile] as const),
        [path.join("/ws", secondRef), Buffer.from("overflow")] as const,
      ])
    );
    const t = spyTransport();
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        evidenceFs: budgetFs,
        workspaceRootFor: () => "/ws",
        attachTo: () => "evidence",
      })
    );

    const outcome = await publishing.publish(
      evidenceArtifact(
        [
          mapped("first", "CALC-1", { evidenceRefs: fullRefs }),
          mapped("second", "CALC-2", { evidenceRefs: [secondRef] }),
        ],
        [shard("/ws")]
      ),
      APPEND
    );

    const body = t.postJson.mock.calls[0]![1] as { tests: Array<{ evidence?: unknown[] }> };
    expect(body.tests[0]!.evidence).toHaveLength(fullRefs.length);
    expect(body.tests[1]!.evidence).toBeUndefined();
    expect(outcome.warnings).toContain("Skipped 1 file over the 25 MB evidence total.");
  });
});

describe("createXrayResultPublishing: create-mode issue type resolution", () => {
  const JIRA = { email: "a@b.c", token: "t" };
  const infoOf = (postMultipart: ReturnType<typeof spyTransport>["postMultipart"]): { fields: { issuetype: { name: string } } } =>
    JSON.parse((postMultipart.mock.calls[0]![1] as { info: string }).info) as { fields: { issuetype: { name: string } } };

  it("threads a resolved issue type name into the create payload's issuetype.name", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() => Promise.resolve({ kind: "resolved", name: "Xray Test Execution" }));
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "CALC", summary: "Run" });

    expect(resolveIssueType).toHaveBeenCalledTimes(1);
    expect(resolveIssueType.mock.calls[0]![0]).toMatchObject({ projectKey: "CALC", site: "acme.atlassian.net" });
    expect(infoOf(t.postMultipart).fields.issuetype.name).toBe("Xray Test Execution");
  });

  it("rejects with the project's actual types when the execution type is unavailable, before any import", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({ kind: "unavailable", availableNames: ["Bug", "Story", "Task"], subtaskNames: [], subtaskMatch: undefined, teamManaged: false })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "SCRATCH", summary: "Run" })
    ).rejects.toThrow(
      'Project SCRATCH has no "Test Execution" issue type. Its issue types are: Bug, Story, Task. Enable Xray for this project in Jira, or publish to a project that has the Xray issue types.'
    );
    expect(t.postMultipart).not.toHaveBeenCalled();
    expect(t.postJson).not.toHaveBeenCalled();
  });

  it("rejects with the team-managed remedy when the unavailable project is team-managed", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({ kind: "unavailable", availableNames: ["Bug", "Story", "Task"], subtaskNames: [], subtaskMatch: undefined, teamManaged: true })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "SCRATCH", summary: "Run" })
    ).rejects.toThrow(
      'Project SCRATCH has no "Test Execution" issue type. Its issue types are: Bug, Story, Task. This is a team-managed project: create a "Test Execution" work type in its project settings, map it under Xray Settings > Work Types Mapping, then retry.'
    );
    expect(t.postMultipart).not.toHaveBeenCalled();
    expect(t.postJson).not.toHaveBeenCalled();
  });

  it("rejects with the empty-project variant when the account sees no issue types", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({ kind: "unavailable", availableNames: [], subtaskNames: [], subtaskMatch: undefined, teamManaged: false })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "SCRATCH", summary: "Run" })
    ).rejects.toThrow(
      'Project SCRATCH has no "Test Execution" issue type, and no issue types are available to your account in this project. Enable Xray for this project in Jira, or publish to a project that has the Xray issue types.'
    );
    expect(t.postMultipart).not.toHaveBeenCalled();
  });

  it("names the subtask-level execution type instead of claiming the project lacks it", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({
        kind: "unavailable",
        availableNames: ["Bug", "Story", "Task"],
        subtaskNames: ["Test Execution"],
        subtaskMatch: "Test Execution",
        teamManaged: true,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has a "Test Execution" work type, but it is a subtask type, and a standalone execution cannot be created as a subtask. Recreate "Test Execution" as a standard-level work type in its project settings, map it under Xray Settings > Work Types Mapping, then retry.'
    );
    expect(t.postMultipart).not.toHaveBeenCalled();
  });

  it("offers the Xray remedy for a subtask-level execution type in a company-managed project", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({
        kind: "unavailable",
        availableNames: ["Bug"],
        subtaskNames: ["TEST EXECUTION"],
        subtaskMatch: "TEST EXECUTION",
        teamManaged: false,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has a "Test Execution" work type, but it is a subtask type, and a standalone execution cannot be created as a subtask. Enable Xray for this project in Jira, or publish to a project that has the Xray issue types.'
    );
    expect(t.postMultipart).not.toHaveBeenCalled();
  });

  it("lists the excluded subtask types when none of them is the execution type", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({
        kind: "unavailable",
        availableNames: ["Bug", "Story"],
        subtaskNames: ["Sub-task", "Test Step"],
        subtaskMatch: undefined,
        teamManaged: true,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has no "Test Execution" issue type. Its issue types are: Bug, Story. Subtask types (cannot host a standalone execution): Sub-task, Test Step. This is a team-managed project: create a "Test Execution" work type in its project settings, map it under Xray Settings > Work Types Mapping, then retry.'
    );
    expect(t.postMultipart).not.toHaveBeenCalled();
  });

  it("keeps the subtask lead when the account sees no standard-level types at all", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({
        kind: "unavailable",
        availableNames: [],
        subtaskNames: ["Sub-task", "Test Execution"],
        subtaskMatch: "Test Execution",
        teamManaged: true,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has a "Test Execution" work type, but it is a subtask type, and a standalone execution cannot be created as a subtask. Recreate "Test Execution" as a standard-level work type in its project settings, map it under Xray Settings > Work Types Mapping, then retry.'
    );
  });

  it("says the account's only types are subtask types instead of claiming it sees none", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({
        kind: "unavailable",
        availableNames: [],
        subtaskNames: ["Sub-task", "Test Step"],
        subtaskMatch: undefined,
        teamManaged: false,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has no "Test Execution" issue type. The only issue types available to your account in this project are subtask types (cannot host a standalone execution): Sub-task, Test Step. Enable Xray for this project in Jira, or publish to a project that has the Xray issue types.'
    );
  });

  it("lists the excluded subtask types on the company-managed branch too", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({
        kind: "unavailable",
        availableNames: ["Bug", "Story"],
        subtaskNames: ["Sub-task"],
        subtaskMatch: undefined,
        teamManaged: false,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has no "Test Execution" issue type. Its issue types are: Bug, Story. Subtask types (cannot host a standalone execution): Sub-task. Enable Xray for this project in Jira, or publish to a project that has the Xray issue types.'
    );
  });

  it("publishes with the default issue type name when resolution is unknown", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() => Promise.resolve({ kind: "unknown" }));
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "CALC", summary: "Run" });

    expect(resolveIssueType).toHaveBeenCalledTimes(1);
    expect(infoOf(t.postMultipart).fields.issuetype.name).toBe("Test Execution");
  });

  it("never calls the resolver without Jira creds and publishes with the configured name", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() => Promise.resolve({ kind: "unknown" }));
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        jiraCredentials: () => Promise.resolve(undefined),
        resolveIssueType,
        executionIssueType: () => "Xray Execution",
      })
    );

    await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "CALC", summary: "Run" });

    expect(resolveIssueType).not.toHaveBeenCalled();
    expect(infoOf(t.postMultipart).fields.issuetype.name).toBe("Xray Execution");
  });

  it("quotes the configured work type name in the unavailable message and passes it to the resolver", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({ kind: "unavailable", availableNames: ["Bug", "Story"], subtaskNames: [], subtaskMatch: undefined, teamManaged: false })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        jiraCredentials: () => Promise.resolve(JIRA),
        resolveIssueType,
        executionIssueType: () => "Sub-Test Execution",
      })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has no "Sub-Test Execution" issue type. Its issue types are: Bug, Story. Enable Xray for this project in Jira, or publish to a project that has the Xray issue types.'
    );
    expect(resolveIssueType.mock.calls[0]![0]).toMatchObject({ executionIssueType: "Sub-Test Execution" });
  });

  it("quotes the configured work type name in the subtask-level branch", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() =>
      Promise.resolve({
        kind: "unavailable",
        availableNames: ["Bug"],
        subtaskNames: ["Sub-Test Execution"],
        subtaskMatch: "Sub-Test Execution",
        teamManaged: true,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        jiraCredentials: () => Promise.resolve(JIRA),
        resolveIssueType,
        executionIssueType: () => "Sub-Test Execution",
      })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" })
    ).rejects.toThrow(
      'Project APEX has a "Sub-Test Execution" work type, but it is a subtask type, and a standalone execution cannot be created as a subtask. Recreate "Sub-Test Execution" as a standard-level work type in its project settings, map it under Xray Settings > Work Types Mapping, then retry.'
    );
  });

  it("publishes with the configured work type name when resolution is unknown", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() => Promise.resolve({ kind: "unknown" }));
    const publishing = createXrayResultPublishing(
      makeDeps({
        transport: t.transport,
        jiraCredentials: () => Promise.resolve(JIRA),
        resolveIssueType,
        executionIssueType: () => "Sub-Test Execution",
      })
    );

    await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "APEX", summary: "Run" });

    expect(infoOf(t.postMultipart).fields.issuetype.name).toBe("Sub-Test Execution");
  });

  it("never calls the resolver on the append path", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() => Promise.resolve({ kind: "unknown" }));
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "append", executionKey: "XNP-7" });

    expect(resolveIssueType).not.toHaveBeenCalled();
  });
});

describe("createXrayResultPublishing: searchTargets", () => {
  it("rejects with NotSupportedError when Jira credentials are absent", async () => {
    const publishing = createXrayResultPublishing(makeDeps({ jiraCredentials: () => Promise.resolve(undefined) }));
    await expect(publishing.searchTargets("execution", "CALC")).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("maps Jira issues to publish targets when credentials are present", async () => {
    const searchIssues = vi.fn<IssueSearcher>(() =>
      Promise.resolve({
        issues: [
          { key: "XNP-1", summary: "Nightly" },
          { key: "XNP-2", summary: "Smoke" },
        ],
        truncated: false,
      })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({
        jiraCredentials: () => Promise.resolve({ email: "a@b.c", token: "t" }),
        searchIssues,
      })
    );

    const targets = await publishing.searchTargets("execution", "XNP");

    expect(searchIssues).toHaveBeenCalledTimes(1);
    expect(searchIssues.mock.calls[0]![0]).toMatchObject({
      kind: "execution",
      query: "XNP",
      site: "acme.atlassian.net",
      executionIssueType: "Test Execution",
    });
    expect(targets).toEqual([
      { id: "XNP-1", label: "XNP-1 · Nightly", ref: { key: "XNP-1" } },
      { id: "XNP-2", label: "XNP-2 · Smoke", ref: { key: "XNP-2" } },
    ]);
  });
});

describe("createXrayResultPublishing: searchTargets (project kind)", () => {
  const JIRA = { email: "a@b.c", token: "t" };
  const PROJECTS = [
    { key: "CALC", name: "Calculator" },
    { key: "SHOP", name: "Storefront" },
  ];

  it("maps the site's projects to publish targets and never calls the issue search", async () => {
    const searchProjects = vi.fn<ProjectSearcher>(() => Promise.resolve({ projects: PROJECTS, truncated: false }));
    const searchIssues = vi.fn<IssueSearcher>(() => Promise.resolve({ issues: [], truncated: false }));
    const publishing = createXrayResultPublishing(
      makeDeps({ jiraCredentials: () => Promise.resolve(JIRA), searchProjects, searchIssues })
    );

    const targets = await publishing.searchTargets("project", "");

    expect(searchProjects.mock.calls[0]![0]).toMatchObject({ site: "acme.atlassian.net" });
    expect(searchIssues).not.toHaveBeenCalled();
    expect(targets).toEqual([
      { id: "CALC", label: "CALC · Calculator", ref: { key: "CALC" } },
      { id: "SHOP", label: "SHOP · Storefront", ref: { key: "SHOP" } },
    ]);
  });

  it("forwards the query and the abort signal so the match happens server-side", async () => {
    const searchProjects = vi.fn<ProjectSearcher>(() => Promise.resolve({ projects: PROJECTS, truncated: false }));
    const publishing = createXrayResultPublishing(
      makeDeps({ jiraCredentials: () => Promise.resolve(JIRA), searchProjects })
    );
    const controller = new AbortController();

    const targets = await publishing.searchTargets("project", "ca", controller.signal);

    expect(searchProjects.mock.calls[0]![0]).toMatchObject({ query: "ca", signal: controller.signal });
    // Whatever the endpoint returned is the answer: nothing is filtered a second time here.
    expect(targets.map((t) => t.ref.key)).toEqual(["CALC", "SHOP"]);
  });

  it("labels a project whose name fell back to its key with the key twice", async () => {
    const publishing = createXrayResultPublishing(
      makeDeps({
        jiraCredentials: () => Promise.resolve(JIRA),
        searchProjects: () => Promise.resolve({ projects: [{ key: "SOLO", name: "SOLO" }], truncated: false }),
      })
    );
    const targets = await publishing.searchTargets("project", "SOLO");
    expect(targets).toEqual([{ id: "SOLO", label: "SOLO · SOLO", ref: { key: "SOLO" } }]);
  });

  it("rejects with NotSupportedError when Jira credentials are absent, without listing projects", async () => {
    const searchProjects = vi.fn<ProjectSearcher>(() => Promise.resolve({ projects: PROJECTS, truncated: false }));
    const publishing = createXrayResultPublishing(
      makeDeps({ jiraCredentials: () => Promise.resolve(undefined), searchProjects })
    );
    await expect(publishing.searchTargets("project", "CALC")).rejects.toBeInstanceOf(NotSupportedError);
    expect(searchProjects).not.toHaveBeenCalled();
  });
});
