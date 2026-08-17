import type { AuthoredTest, NewContainerSpec } from "./contracts";
import type { TraceabilitySnapshot } from "./traceability-model";

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

export type ContainerMembers =
  | { readonly kind: "unresolved"; readonly keys: readonly string[] }
  | { readonly kind: "resolved"; readonly issueIds: readonly string[] };

// One resolver for every container membership write. It preserves selection order and names every
// unresolved test, so no caller can silently send a partial membership list.
export function resolveContainerMembers(
  keys: readonly string[],
  issueIdFor: (key: string) => string | undefined
): ContainerMembers {
  const issueIds: string[] = [];
  const unresolved: string[] = [];
  for (const key of keys) {
    const issueId = issueIdFor(key);
    if (issueId === undefined) {
      unresolved.push(key);
    } else {
      issueIds.push(issueId);
    }
  }
  return unresolved.length > 0
    ? { kind: "unresolved", keys: unresolved }
    : { kind: "resolved", issueIds };
}

// Read the synced issue id from either source of a board test card: a mapped link or an orphan.
export function containerMemberIssueId(
  snapshot: TraceabilitySnapshot | undefined,
  key: string
): string | undefined {
  const link = snapshot?.links.find((item) => item.testKey === key);
  return link?.meta?.issueId ?? snapshot?.orphans.find((item) => item.testKey === key)?.meta.issueId;
}

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
  const members = resolveContainerMembers(keys, deps.issueIdFor);
  if (members.kind === "unresolved") {
    return members;
  }
  return {
    kind: "created",
    created: await deps.create({ project, summary, testIssueIds: members.issueIds }),
  };
}
