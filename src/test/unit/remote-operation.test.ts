import { describe, expect, it, vi } from "vitest";
import { RemoteOutcomeUnknownError } from "../../core/workspace-trust";
import {
  operationIdentity,
  REMOTE_OPERATION_POLICY,
  RetryableRemoteError,
  retryAfterMilliseconds,
  runRemoteOperation,
} from "../../xray/remote-operation";
import { XrayAbortError } from "../../xray/xray-client";

const immediate = (): Promise<void> => Promise.resolve();

describe("remote operation policy", () => {
  it("classifies every audited Xray and Jira request without a default", () => {
    expect(REMOTE_OPERATION_POLICY).toMatchObject({
      "xray.authenticate": { budget: "authentication" },
      "xray.graphql.read": { class: "read", budget: "read" },
      "xray.test.create": { class: "non-idempotent-write", attempts: 1 },
      "xray.test-set.create": { class: "non-idempotent-write", attempts: 1 },
      "xray.test-plan.create": { class: "non-idempotent-write", attempts: 1 },
      "xray.execution.create": { class: "non-idempotent-write", attempts: 1 },
      "xray.gherkin.update": { class: "non-idempotent-write", attempts: 1 },
      "xray.execution.import-json": { class: "non-idempotent-write", attempts: 1 },
      "xray.execution.import-cucumber": { class: "non-idempotent-write", attempts: 1 },
      "jira.attachment.upload": { class: "non-idempotent-write", attempts: 1 },
      "jira.attachment-meta.read": { class: "read" },
      "jira.issue-types.read": { class: "read" },
      "jira.issues.read": { class: "read" },
      "jira.projects.read": { class: "read" },
      "jira.profile.read": { class: "read" },
    });
    expect(Object.values(REMOTE_OPERATION_POLICY).every((policy) => policy.attempts > 0)).toBe(true);
  });

  it("never replays a transient non-idempotent write", async () => {
    const run = vi.fn(() => Promise.reject(new RetryableRemoteError("timeout")));
    await expect(runRemoteOperation(run, {
      identity: operationIdentity("xray.execution.import-json", "publish-1"),
      sleep: immediate,
      random: () => 0,
      abortError: () => new XrayAbortError(),
    })).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After while retrying a read", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new RetryableRemoteError("busy", 5_000))
      .mockResolvedValue("ok");
    const sleep = vi.fn(immediate);
    await expect(runRemoteOperation(run, {
      identity: operationIdentity("jira.projects.read", "read-1"),
      sleep,
      random: () => 0,
      abortError: () => new XrayAbortError(),
    })).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(5_000, undefined);
  });

  it("starts no request when already cancelled and no request after cancellation in backoff", async () => {
    const before = new AbortController();
    before.abort();
    const never = vi.fn(() => Promise.resolve("no"));
    await expect(runRemoteOperation(never, {
      identity: operationIdentity("jira.issues.read"),
      signal: before.signal,
      sleep: immediate,
      random: () => 0,
      abortError: () => new XrayAbortError(),
    })).rejects.toBeInstanceOf(XrayAbortError);
    expect(never).not.toHaveBeenCalled();

    const during = new AbortController();
    const once = vi.fn(() => Promise.reject(new RetryableRemoteError("busy")));
    await expect(runRemoteOperation(once, {
      identity: operationIdentity("jira.issues.read"),
      signal: during.signal,
      sleep: () => {during.abort(); return Promise.reject(new XrayAbortError());},
      random: () => 0,
      abortError: () => new XrayAbortError(),
    })).rejects.toBeInstanceOf(XrayAbortError);
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("parses delta seconds and HTTP dates", () => {
    expect(retryAfterMilliseconds("3", 0)).toBe(3_000);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
  });
});
