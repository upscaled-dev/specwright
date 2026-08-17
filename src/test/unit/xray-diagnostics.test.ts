import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { describeJwt, describeShape, errorShapeVerdict, graphqlErrorSummaries } from "../../xray/xray-diagnostics";

describe("xray diagnostics module graph", () => {
  const srcDir = path.resolve(__dirname, "../../xray");
  const read = (file: string): string => fs.readFileSync(path.join(srcDir, file), "utf-8");

  it("breaks the connection-test <-> jira-project-search import cycle", () => {
    const jira = read("jira-project-search.ts");
    // jira-project-search sourced describeShape from connection-test before; now it (and
    // connection-test and the client) all source it here, leaving only one-way edges.
    expect(jira).toContain('from "./xray-diagnostics"');
    expect(jira).not.toContain("xray-connection-test");

    const diagnostics = read("xray-diagnostics.ts");
    expect(diagnostics).not.toContain("xray-connection-test");
    expect(diagnostics).not.toContain("jira-project-search");
  });
});

describe("describeShape", () => {
  it("emits types and lengths, never values", () => {
    const input = { name: "secret-value", count: 3, ok: true, none: null };
    expect(describeShape(input)).toEqual({
      name: "string(12)",
      count: "number",
      ok: "boolean",
      none: "null",
    });
  });

  it("summarizes arrays by first-element skeleton plus count", () => {
    expect(describeShape([{ a: "x" }, { a: "yy" }, { a: "zzz" }])).toEqual([
      { a: "string(1)" },
      "… 3 items total",
    ]);
    expect(describeShape([42])).toEqual(["number"]);
    expect(describeShape([])).toEqual(["(empty)"]);
  });

  it("stops recursing past the depth cap", () => {
    const deep = { l0: { l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } } } };
    const result = describeShape(deep);
    const dig = (value: unknown, keys: string[]): unknown =>
      keys.reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], value);
    expect(dig(result, ["l0", "l1", "l2", "l3", "l4", "l5"])).toBe("…");
  });

  it("never reproduces a long secret-like string in its output", () => {
    const secret = "client-secret-0123456789-abcdefghij";
    const out = JSON.stringify(describeShape({ request: { client_secret: secret } }));
    expect(out).not.toContain(secret);
    expect(out).toContain(`string(${secret.length})`);
  });
});

describe("graphqlErrorSummaries", () => {
  it("returns empty for non-objects and bodies without errors", () => {
    expect(graphqlErrorSummaries("plain text")).toEqual([]);
    expect(graphqlErrorSummaries(null)).toEqual([]);
    expect(graphqlErrorSummaries({ data: { ok: true } })).toEqual([]);
    expect(graphqlErrorSummaries({ errors: [] })).toEqual([]);
  });

  it("formats message and extensions.code, with a fallback for missing messages", () => {
    const summaries = graphqlErrorSummaries({
      errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }, {}],
    });
    expect(summaries[0]).toBe("errors[0] [FORBIDDEN]: denied");
    expect(summaries[1]).toBe("errors[1]: (no message)");
  });

  it("clips long messages and scrubs jwt-like tokens inside them", () => {
    const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    const summaries = graphqlErrorSummaries({
      errors: [{ message: `bad token ${jwt} ${"x".repeat(400)}` }],
    });
    expect(summaries[0]).not.toContain(jwt);
    expect(summaries[0]).toContain("[jwt-like-token]");
    expect((summaries[0] ?? "").length).toBeLessThanOrEqual("errors[0]: ".length + 160);
  });
});

describe("errorShapeVerdict", () => {
  it("reserves empty success for a 200 response without GraphQL errors", () => {
    expect(errorShapeVerdict({ status: 200, errors: ["invalid field"] })).toBe("expected-error-envelope");
    expect(errorShapeVerdict({ status: 200, errors: [] })).toBe("unexpected-empty-success");
    expect(errorShapeVerdict({ status: 400, errors: [] })).toBe("unexpected-response");
  });
});

describe("describeJwt", () => {
  it("reports length and segment count without emitting the token", () => {
    const jwt = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    const line = describeJwt(jwt);
    expect(line).not.toContain(jwt);
    expect(line).toContain(`length ${jwt.length}`);
    expect(line).toContain("three-segment shape: true");
  });

  it("flags a token without three segments", () => {
    expect(describeJwt("no-dots")).toContain("three-segment shape: false");
  });
});
