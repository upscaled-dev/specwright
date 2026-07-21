import { JIRA_KEY_SHAPE } from "./xray-adapter";

// Escape a user string for an Xray JQL double-quoted literal: backslash first (so an escaped quote's
// backslash isn't itself re-escaped), then the double-quote. These are the only two metacharacters a
// JQL string literal recognizes. §5 leniency: a nonsense clause never errors — Xray returns 0 rows —
// so the CALLER must word an empty result honestly ("no matches"), never "invalid query".
export function escapeJql(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// True when the input already looks like a Jira issue key (a trailing `-<number>`), so a direct key
// lookup is the right search rather than a summary contains-match.
export function isKeyShaped(text: string): boolean {
  return JIRA_KEY_SHAPE.test(text.trim());
}

/**
 * Build the search JQL for a free-text/key query. A key-shaped input resolves to a direct
 * `key in (...)` lookup; anything else becomes a summary contains-match scoped to the configured
 * projects. Returns `undefined` when there is nothing searchable (blank text, or non-key text with no
 * project to scope the summary search) — the caller then returns an honest empty result without a
 * transport hit.
 */
export function buildSearchJql(projectKeys: readonly string[], text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (isKeyShaped(trimmed)) {
    return `key in (${trimmed.toUpperCase()})`;
  }
  const projects = projectKeys.map((key) => key.trim()).filter((key) => key !== "");
  if (projects.length === 0) {
    return undefined;
  }
  const projectClause = projects.length === 1 ? `project = ${projects[0]}` : `project in (${projects.join(", ")})`;
  return `${projectClause} AND summary ~ "${escapeJql(trimmed)}*"`;
}

// Resolve a Test Plan to its member tests. The schema doc has no root `getTestPlan` query (verified
// against xray-graphql-schema.md), so this rides the documented `getTests(jql, limit, start)` engine
// with Xray's `testPlanTests` JQL function — a flat query that honors the limit ≤ 100 / paginate
// budget for free.
export function buildTestPlanJql(planKey: string): string {
  return `issue in testPlanTests("${escapeJql(planKey)}")`;
}
