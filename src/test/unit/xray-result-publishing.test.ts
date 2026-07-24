import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import { createXrayResultPublishing, IssueSearcher, IssueTypeResolver, XrayResultPublishingDeps } from "../../xray/xray-result-publishing";
import { ImportResponse, ImportTransport, StepResolver } from "../../xray/execution-importers";
import { NotSupportedError, PreflightDecision, RunArtifact, RunArtifactResult, ShardInfo } from "../../traceability/contracts";
import { EvidenceFs } from "../../traceability/evidence-resolution";
import { ScenarioRef } from "../../traceability/scenario-ref";
import { Logger, LogLevel } from "../../utils/logger";

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
    logger: Logger.create(undefined, LogLevel.ERROR),
    ...over,
  };
}

describe("createXrayResultPublishing — publish routing (pin: create vs append mapping)", () => {
  it("create-new POSTs Cucumber multipart and never posts JSON — the import is the only remote call", async () => {
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
    expect(outcome.ref.key).toBe("XNP-100");
  });

  it("falls back to the sent execution key when the append response omits one", async () => {
    const t = spyTransport({ status: 200, ok: true, body: {} });
    const publishing = createXrayResultPublishing(makeDeps({ transport: t.transport }));
    const outcome = await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "append", executionKey: "XNP-77" });
    expect(outcome.ref.key).toBe("XNP-77");
  });
});

describe("createXrayResultPublishing — reconcile filter (cross-seam)", () => {
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

describe("createXrayResultPublishing — publish guards (fail fast before any import)", () => {
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

describe("createXrayResultPublishing — evidence resolution + attachTo", () => {
  const shotAbs = path.join("/ws", "test-results/shot.png");
  const fs = fakeFs({ [shotAbs]: Buffer.from("PNG") });
  const JIRA = { email: "a@b.c", token: "t" };
  const withShot = (): RunArtifactResult => mapped("a", "CALC-1", { evidenceRefs: ["test-results/shot.png"] });
  // Jira creds present — the issue stream needs a real upload destination.
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
    expect(outcome.warnings).toContain("Jira credentials missing — evidence embedded in the payload instead.");
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
});

describe("createXrayResultPublishing — create-mode issue type resolution", () => {
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
      Promise.resolve({ kind: "unavailable", availableNames: ["Bug", "Story", "Task"], teamManaged: false })
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
      Promise.resolve({ kind: "unavailable", availableNames: ["Bug", "Story", "Task"], teamManaged: true })
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
      Promise.resolve({ kind: "unavailable", availableNames: [], teamManaged: false })
    );
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(JIRA), resolveIssueType })
    );

    await expect(
      publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "SCRATCH", summary: "Run" })
    ).rejects.toThrow("no issue types are available to your account in this project");
    expect(t.postMultipart).not.toHaveBeenCalled();
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

  it("never calls the resolver without Jira creds and publishes with the default name", async () => {
    const t = spyTransport();
    const resolveIssueType = vi.fn<IssueTypeResolver>(() => Promise.resolve({ kind: "unknown" }));
    const publishing = createXrayResultPublishing(
      makeDeps({ transport: t.transport, jiraCredentials: () => Promise.resolve(undefined), resolveIssueType })
    );

    await publishing.publish(artifact([mapped("a", "CALC-1")]), { mode: "create-new", project: "CALC", summary: "Run" });

    expect(resolveIssueType).not.toHaveBeenCalled();
    expect(infoOf(t.postMultipart).fields.issuetype.name).toBe("Test Execution");
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

describe("createXrayResultPublishing — searchTargets", () => {
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
    expect(searchIssues.mock.calls[0]![0]).toMatchObject({ kind: "execution", query: "XNP", site: "acme.atlassian.net" });
    expect(targets).toEqual([
      { id: "XNP-1", label: "XNP-1 — Nightly", ref: { key: "XNP-1" } },
      { id: "XNP-2", label: "XNP-2 — Smoke", ref: { key: "XNP-2" } },
    ]);
  });
});
