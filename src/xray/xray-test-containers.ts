import type {
  AddTestsToContainerResult,
  TestContainerKind,
  TestContainerTarget,
} from "../traceability/contracts";
import type { RemoteOperationName } from "./remote-operation";
import { jqlString } from "./xray-search";

export interface XrayContainerShape {
  readonly query: "getTestSets" | "getTestPlans";
  readonly mutation: "addTestsToTestSet" | "addTestsToTestPlan";
  readonly operation: Extract<RemoteOperationName, "xray.test-set.add-tests" | "xray.test-plan.add-tests">;
}

export function xrayContainerShape(kind: TestContainerKind): XrayContainerShape {
  return kind === "test-set"
    ? { query: "getTestSets", mutation: "addTestsToTestSet", operation: "xray.test-set.add-tests" }
    : { query: "getTestPlans", mutation: "addTestsToTestPlan", operation: "xray.test-plan.add-tests" };
}

export function resolveTestContainerQuery(kind: TestContainerKind, key: string): string {
  const { query } = xrayContainerShape(kind);
  return `{ ${query}(jql: ${JSON.stringify(`key = ${jqlString(key)}`)}, limit: 1) { results { issueId jira(fields: ["key"]) } } }`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export type TestContainerTargetParse =
  | { readonly kind: "found"; readonly target: TestContainerTarget }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only a structurally valid lookup can say "missing". A malformed provider response stays distinct
// from an empty or valid non-matching result so callers never turn protocol damage into a type verdict.
export function parseTestContainerTarget(
  body: unknown,
  kind: TestContainerKind,
  expectedKey: string
): TestContainerTargetParse {
  const { query } = xrayContainerShape(kind);
  if (!record(body) || !record(body["data"])) {return { kind: "malformed" };}
  const lookup = body["data"][query];
  if (!record(lookup) || !Array.isArray(lookup["results"])) {return { kind: "malformed" };}
  let found: TestContainerTarget | undefined;
  const results = lookup["results"];
  for (const result of results) {
    if (result === null) {continue;}
    if (!record(result) || !record(result["jira"])) {return { kind: "malformed" };}
    const key = readString(result["jira"]["key"])?.toUpperCase();
    if (key === undefined) {return { kind: "malformed" };}
    if (key !== expectedKey) {continue;}
    const issueId = readString(result["issueId"]);
    if (issueId === undefined) {return { kind: "malformed" };}
    found = { kind, key, issueId };
  }
  return found === undefined ? { kind: "missing" } : { kind: "found", target: found };
}

export function addTestsToContainerMutation(
  kind: TestContainerKind,
  issueId: string,
  testIssueIds: readonly string[]
): string {
  const { mutation } = xrayContainerShape(kind);
  const members = testIssueIds.map((id) => JSON.stringify(id)).join(", ");
  return `mutation { ${mutation}(issueId: ${JSON.stringify(issueId)}, testIssueIds: [${members}]) { addedTests warning } }`;
}

export function parseAddTestsToContainer(
  body: unknown,
  kind: TestContainerKind
): AddTestsToContainerResult {
  const { mutation } = xrayContainerShape(kind);
  const data = body !== null && typeof body === "object"
    ? (body as { data?: Record<string, Record<string, unknown> | null> | null }).data
    : undefined;
  const result = data?.[mutation];
  const addedTests = Array.isArray(result?.["addedTests"])
    && result["addedTests"].every((value) => typeof value === "string")
    ? result["addedTests"] as string[]
    : undefined;
  const warning = readString(result?.["warning"]);
  return {
    ...(addedTests !== undefined ? { addedTests } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}
