export type LogicalTestStatus = "passed" | "failed" | "skipped";

/** Resolve Playwright's actual and expected statuses into the user-visible scenario status. */
export function resolveTestStatus(
  actual: string | undefined,
  expected: string | undefined = "passed"
): LogicalTestStatus {
  const current = actual?.toLowerCase();
  if (current === "skipped") {return "skipped";}
  return current === (expected ?? "passed").toLowerCase() ? "passed" : "failed";
}
