import { errMsg } from "../utils/text";
import type { AutomationBindingClassification, TestCaseMetadata } from "./contracts";

// Comparison is text only, ignoring line endings and per-line indentation/trailing whitespace, so a
// scenario that differs from the remote test purely by CRLF, indentation, or trailing spaces is
// neither flagged as drift nor pushed.
export function normalizeGherkin(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n").map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

export function hasGherkinDrift(local: string, remote: string): boolean {
  return normalizeGherkin(local) !== normalizeGherkin(remote);
}

// What a push may do. `drift` and `unknown-remote` BLOCK: the remote moved since the snapshot was
// taken, or there is no baseline to compare it against, so a push would overwrite text nobody has
// seen. Both are resolved by a sync, never by writing.
export type PushDecision = "push" | "drift" | "unchanged" | "unknown-remote";

/**
 * Total over its three inputs: the stored baseline (the last synced Gherkin), the freshly read remote
 * Gherkin, and the local source slice. An absent baseline or an absent remote read is `unknown-remote`;
 * a baseline that no longer matches the remote is `drift`. The comparison is `normalizeGherkin`'s, the
 * same one the drift indicator uses, so the board's drift badge and this decision can never disagree.
 */
export function decidePush(
  storedGherkin: string | undefined,
  remoteGherkin: string | undefined,
  localGherkin: string
): PushDecision {
  if (storedGherkin === undefined || remoteGherkin === undefined) {
    return "unknown-remote";
  }
  if (hasGherkinDrift(storedGherkin, remoteGherkin)) {
    return "drift";
  }
  return hasGherkinDrift(localGherkin, remoteGherkin) ? "push" : "unchanged";
}

// What the push did, precisely enough for the command layer to say it without guessing: each blocked
// kind names its own cause, since only `no-baseline` and `drift` are fixed by a sync. `refreshError`
// rides the two post-write kinds because a write that landed is never reported as a failure.
export type PushGherkinOutcome =
  | { readonly kind: "pushed"; readonly key: string; readonly refreshError?: string | undefined }
  | { readonly kind: "unchanged"; readonly key: string }
  | { readonly kind: "drift"; readonly key: string }
  | { readonly kind: "no-baseline"; readonly key: string }
  | { readonly kind: "no-remote-test"; readonly key: string }
  | { readonly kind: "no-issue-id"; readonly key: string }
  | { readonly kind: "wrong-test-type"; readonly key: string; readonly testType?: string | undefined }
  | {
      readonly kind: "unverified";
      readonly key: string;
      readonly reason: string;
      readonly refreshError?: string | undefined;
    };

export interface PushGherkinDeps {
  // A FRESH single-key read of the remote test. The decision never rests on the synced snapshot alone,
  // so this runs before any write.
  readRemote(key: string): Promise<TestCaseMetadata | undefined>;
  // The write, addressed by issue id (never a key). Returns the Gherkin read back from the same
  // mutation response; absent when the response carried none.
  pushGherkin(issueId: string, gherkin: string): Promise<string | undefined>;
  // Re-reads this one key into the snapshot so the stored baseline matches what the remote now holds,
  // without a full sync.
  refresh(key: string): Promise<void>;
  // Provider-specific compatibility check for the FRESHLY read test (Xray: Gherkin-only), the same hook
  // preflight takes. Absent never blocks, and neither does an `unknown` verdict.
  classifyBinding?: ((meta: TestCaseMetadata) => AutomationBindingClassification) | undefined;
}

/**
 * One mapped scenario's push: read the remote fresh, decide, and write only on `push`. Every blocking
 * outcome returns before `pushGherkin` is ever called, so a drifted, absent, or non-Gherkin remote is
 * never overwritten. After a write the baseline is refreshed regardless of what came back, since the
 * remote now holds whatever it holds; a refresh that fails leaves the push successful and hands its
 * error up for reporting, and a read-back that does not match what was sent reports `unverified`.
 */
export async function runPushGherkin(
  target: TestCaseMetadata,
  localGherkin: string,
  deps: PushGherkinDeps
): Promise<PushGherkinOutcome> {
  const key = target.key;
  const remote = await deps.readRemote(key);
  if (remote === undefined) {
    return { kind: "no-remote-test", key };
  }
  if (deps.classifyBinding?.(remote) === "incompatible-test-type") {
    return { kind: "wrong-test-type", key, ...(remote.testType ? { testType: remote.testType.name } : {}) };
  }
  const decision = decidePush(target.gherkin, remote.gherkin, localGherkin);
  if (decision === "unchanged") {
    return { kind: "unchanged", key };
  }
  if (decision === "drift") {
    return { kind: "drift", key };
  }
  if (decision === "unknown-remote") {
    return { kind: "no-baseline", key };
  }
  if (remote.issueId === undefined) {
    return { kind: "no-issue-id", key };
  }
  const readBack = await deps.pushGherkin(remote.issueId, localGherkin);
  const refreshError = await refreshFailure(deps, key);
  const stale = refreshError !== undefined ? { refreshError } : {};
  if (readBack === undefined) {
    return { kind: "unverified", key, reason: "the push response carried no text to verify against", ...stale };
  }
  return hasGherkinDrift(localGherkin, readBack)
    ? { kind: "unverified", key, reason: "the text read back from the push differs from what was sent", ...stale }
    : { kind: "pushed", key, ...stale };
}

// The write already landed, so a failed baseline refresh can only downgrade the report, never undo it
// (the never-rollback shape the publish flow uses).
async function refreshFailure(deps: PushGherkinDeps, key: string): Promise<string | undefined> {
  try {
    await deps.refresh(key);
    return undefined;
  } catch (error) {
    return errMsg(error);
  }
}
