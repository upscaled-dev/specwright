import { describe, it, expect } from "vitest";
import { buildKeysJql, buildSearchJql, buildTestPlanJql, escapeJql, isKeyShaped, jqlString } from "../../xray/xray-search";

describe("escapeJql", () => {
  it("escapes backslashes before double-quotes so an injected quote can't break out of the literal", () => {
    expect(escapeJql('a "b" c')).toBe('a \\"b\\" c');
    expect(escapeJql("a\\b")).toBe("a\\\\b");
    expect(escapeJql('back\\ and "quote"')).toBe('back\\\\ and \\"quote\\"');
  });

  it("escapes a backslash that already precedes a quote exactly once (reordering the passes breaks this)", () => {
    expect(escapeJql(String.raw`a\"b`)).toBe(String.raw`a\\\"b`);
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeJql("login flow")).toBe("login flow");
  });
});

describe("jqlString", () => {
  it("quotes the escaped value so a reserved word is never a bare token", () => {
    expect(jqlString("IS")).toBe('"IS"');
    expect(jqlString('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("buildKeysJql", () => {
  it("quotes every key in the list", () => {
    expect(buildKeysJql(["IS-1", "CALC-2"])).toBe('key in ("IS-1", "CALC-2")');
  });
});

describe("isKeyShaped", () => {
  it("is true for a Jira issue key and false for free text", () => {
    expect(isKeyShaped("CALC-1")).toBe(true);
    expect(isKeyShaped("AB-CD-123")).toBe(true);
    expect(isKeyShaped("login")).toBe(false);
    expect(isKeyShaped("CALC")).toBe(false);
  });
});

describe("buildSearchJql", () => {
  it("builds a project-scoped summary contains-match for free text", () => {
    expect(buildSearchJql(["CALC"], "login")).toBe('project = "CALC" AND summary ~ "login*"');
  });

  it("uses project in (...) when several projects are configured", () => {
    expect(buildSearchJql(["CALC", "MATH"], "login")).toBe('project in ("CALC", "MATH") AND summary ~ "login*"');
  });

  it("JQL-escapes the user text inside the summary literal", () => {
    expect(buildSearchJql(["CALC"], 'say "hi"')).toBe('project = "CALC" AND summary ~ "say \\"hi\\"*"');
  });

  it("quotes a project key that is a JQL reserved word (a bare IS is rejected by Jira)", () => {
    expect(buildSearchJql(["IS"], "login")).toBe('project = "IS" AND summary ~ "login*"');
    expect(buildSearchJql(["IS", "NOT"], "login")).toBe('project in ("IS", "NOT") AND summary ~ "login*"');
  });

  it("routes a key-shaped input to a direct key lookup, uppercased and quoted, ignoring projects", () => {
    expect(buildSearchJql(["CALC"], "calc-42")).toBe('key in ("CALC-42")');
    expect(buildSearchJql([], "MATH-7")).toBe('key in ("MATH-7")');
    expect(buildSearchJql([], "is-123")).toBe('key in ("IS-123")');
  });

  it("returns undefined when there is nothing searchable (blank, or free text with no project)", () => {
    expect(buildSearchJql(["CALC"], "   ")).toBeUndefined();
    expect(buildSearchJql([], "login")).toBeUndefined();
    expect(buildSearchJql(["  "], "login")).toBeUndefined();
  });
});

describe("buildTestPlanJql", () => {
  it("rides the testPlanTests JQL function (getTests engine, no root getTestPlan query in the schema)", () => {
    expect(buildTestPlanJql("CALC-100")).toBe('issue in testPlanTests("CALC-100")');
  });

  it("escapes the plan key inside the literal", () => {
    expect(buildTestPlanJql('bad"key')).toBe('issue in testPlanTests("bad\\"key")');
  });
});
