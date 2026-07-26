import type { AuthoredTest, NewContainerSpec } from "./contracts";

export interface ContainerCreateDeps {
  // The remote issue id the snapshot recorded for a test key, or undefined when no sync ever read one.
  issueIdFor(key: string): string | undefined;
  create(spec: NewContainerSpec): Promise<AuthoredTest>;
}

// Either nothing was sent, naming every key that has no issue id, or the container was created and its
// response is carried back whole (a `created.key` of undefined is the honest created-but-unreadable
// case, never a failure).
export type ContainerCreateOutcome =
  | { readonly kind: "unresolved"; readonly keys: readonly string[] }
  | { readonly kind: "created"; readonly created: AuthoredTest };

/**
 * Create one container from the tests picked on the board. A key with no issue id fails the WHOLE batch
 * before any remote call: one mutation creates the container with its members, so there is no honest
 * partial here. A container missing the tests that could not be resolved is worse than none, and the
 * caller can name the keys a sync would fix.
 *
 * `keys` is expected non-empty; the command layer's precheck is what guarantees it. An empty list would
 * post a legal `testIssueIds: []` and create an empty container, which no verb here asks for.
 */
export async function runContainerCreate(
  keys: readonly string[],
  project: string,
  summary: string,
  deps: ContainerCreateDeps
): Promise<ContainerCreateOutcome> {
  const testIssueIds: string[] = [];
  const unresolved: string[] = [];
  for (const key of keys) {
    const issueId = deps.issueIdFor(key);
    if (issueId === undefined) {
      unresolved.push(key);
    } else {
      testIssueIds.push(issueId);
    }
  }
  if (unresolved.length > 0) {
    return { kind: "unresolved", keys: unresolved };
  }
  return { kind: "created", created: await deps.create({ project, summary, testIssueIds }) };
}
