import { describe, it, expect } from "vitest";
import {
  buildFileHeader,
  formatStub,
  inferParameters,
} from "../../generators/step-stub-generator";

describe("inferParameters", () => {
  it("infers {string} for double-quoted text", () => {
    const r = inferParameters('I click "submit"');
    expect(r.pattern).toBe("I click {string}");
    expect(r.params).toEqual([
      { name: "str", type: "string", cucumberType: "{string}" },
    ]);
  });

  it("infers {string} for single-quoted text", () => {
    const r = inferParameters("I see 'hello'");
    expect(r.pattern).toBe("I see {string}");
    expect(r.params[0]!.cucumberType).toBe("{string}");
  });

  it("infers {int} for a plain integer", () => {
    const r = inferParameters("I have 5 users");
    expect(r.pattern).toBe("I have {int} users");
    expect(r.params).toEqual([
      { name: "count", type: "number", cucumberType: "{int}" },
    ]);
  });

  it("infers {float} for a decimal number", () => {
    const r = inferParameters("the value is 3.14");
    expect(r.pattern).toBe("the value is {float}");
    expect(r.params).toEqual([
      { name: "value", type: "number", cucumberType: "{float}" },
    ]);
  });

  it("infers {string} for an outline placeholder with a safe name", () => {
    const r = inferParameters("I type <input>");
    expect(r.pattern).toBe("I type {string}");
    expect(r.params).toEqual([
      { name: "input", type: "string", cucumberType: "{string}" },
    ]);
  });

  it("camelCases hyphenated outline placeholder names", () => {
    const r = inferParameters("I greet <full-name>");
    expect(r.pattern).toBe("I greet {string}");
    expect(r.params).toEqual([
      { name: "fullName", type: "string", cucumberType: "{string}" },
    ]);
  });

  it("camelCases space-separated outline placeholder names", () => {
    const r = inferParameters("I type <some value>");
    expect(r.pattern).toBe("I type {string}");
    expect(r.params).toEqual([
      { name: "someValue", type: "string", cucumberType: "{string}" },
    ]);
  });

  it("renames duplicate outline placeholders to base1/base2 instead of str1/str2", () => {
    const r = inferParameters("I copy <input> to <input>");
    expect(r.params.map((p) => p.name)).toEqual(["input1", "input2"]);
  });

  it("falls back to str when an outline placeholder has no alphanumeric characters", () => {
    const r = inferParameters("I type <-->");
    expect(r.params[0]!.name).toBe("str");
  });

  it("preserves order across mixed types in a single step", () => {
    const r = inferParameters('I have 5 "widgets"');
    expect(r.pattern).toBe("I have {int} {string}");
    expect(r.params.map((p) => p.cucumberType)).toEqual(["{int}", "{string}"]);
    expect(r.params.map((p) => p.type)).toEqual(["number", "string"]);
  });

  it("orders int/float/string by their position in the source text", () => {
    const r = inferParameters('value 3.14 with 7 and "x"');
    expect(r.pattern).toBe("value {float} with {int} and {string}");
    expect(r.params.map((p) => p.cucumberType)).toEqual(["{float}", "{int}", "{string}"]);
  });

  it("renames colliding string params by suffixing the same base", () => {
    const r = inferParameters('I have "a" and "b"');
    expect(r.pattern).toBe("I have {string} and {string}");
    expect(r.params.map((p) => p.name)).toEqual(["str1", "str2"]);
  });

  it("renames colliding int params by suffixing the same base", () => {
    const r = inferParameters("I have 3 widgets and 5 gadgets");
    expect(r.params.map((p) => p.name)).toEqual(["count1", "count2"]);
  });

  it("escapes literal braces in the step text", () => {
    const r = inferParameters("I press {ctrl}");
    expect(r.pattern).toBe("I press \\{ctrl\\}");
    expect(r.params).toHaveLength(0);
  });

  it("does not double-count a quoted integer as int", () => {
    const r = inferParameters('I see "5 things"');
    expect(r.pattern).toBe("I see {string}");
    expect(r.params).toHaveLength(1);
    expect(r.params[0]!.cucumberType).toBe("{string}");
  });

  it("does not infer {int} for the leading digits of a rejected float", () => {
    const r = inferParameters("version 1.2x");
    expect(r.pattern).toBe("version 1.2x");
    expect(r.params).toHaveLength(0);
  });

  it("only matches a positive int when a hyphen is preceded by a word character", () => {
    const r = inferParameters("abc-3");
    expect(r.pattern).toBe("abc-{int}");
    expect(r.params).toEqual([
      { name: "count", type: "number", cucumberType: "{int}" },
    ]);
  });

  it("matches a negative int after a non-word colon", () => {
    const r = inferParameters("I have width:-3");
    expect(r.pattern).toBe("I have width:{int}");
    expect(r.params).toEqual([
      { name: "count", type: "number", cucumberType: "{int}" },
    ]);
  });

  it("matches a negative int at the start of the step text", () => {
    const r = inferParameters("-3 widgets");
    expect(r.pattern).toBe("{int} widgets");
  });

  it("matches a negative int when whitespace precedes the hyphen", () => {
    const r = inferParameters("abc -3");
    expect(r.pattern).toBe("abc {int}");
  });

  it("preserves a trailing period after a {float}", () => {
    const r = inferParameters("pi is 3.14.");
    expect(r.pattern).toBe("pi is {float}.");
    expect(r.params).toEqual([
      { name: "value", type: "number", cucumberType: "{float}" },
    ]);
  });
});

describe("formatStub", () => {
  it("emits a stub line that ends with ;", () => {
    const stub = formatStub("Given", "I am ready");
    expect(stub.endsWith("});")).toBe(true);
  });

  it("matches the visual style of sample.steps.ts for a no-arg step", () => {
    const stub = formatStub("Given", "I am ready");
    expect(stub).toBe('Given("I am ready", async ({}) => {\n  // TODO: implement\n});');
  });

  it("emits typed parameters in declaration order for mixed types", () => {
    const stub = formatStub("When", 'I add 5 "widgets"');
    expect(stub).toBe(
      'When("I add {int} {string}", async ({}, count: number, str: string) => {\n  // TODO: implement\n});'
    );
  });

  it("uses collision-resolved names for multiple same-type params", () => {
    const stub = formatStub("Then", 'I see "a" and "b"');
    expect(stub).toBe(
      'Then("I see {string} and {string}", async ({}, str1: string, str2: string) => {\n  // TODO: implement\n});'
    );
  });

  it("rejects And as a keyword", () => {
    expect(() => formatStub("And" as "Given", "x")).toThrow();
  });

  it("rejects But as a keyword", () => {
    expect(() => formatStub("But" as "Then", "x")).toThrow();
  });

  it("escapes literal braces so the emitted source keeps the cucumber escape", () => {
    const stub = formatStub("Given", "I press {ctrl}");
    // The generated file must contain the two characters `\{`, which in a
    // double-quoted JS source string requires `\\{`.
    expect(stub).toContain(String.raw`"I press \\{ctrl\\}"`);
  });

  it("escapes a bare double quote in the step text", () => {
    const stub = formatStub("When", 'I press the " key');
    expect(stub).toContain(String.raw`"I press the \" key"`);
  });
});

describe("buildFileHeader", () => {
  it("starts with the createBdd import and a trailing blank line", () => {
    const header = buildFileHeader();
    expect(header).toBe(
      [
        'import { createBdd } from "playwright-bdd";',
        "",
        "const { Given, When, Then } = createBdd();",
        "",
        "",
      ].join("\n")
    );
  });
});
