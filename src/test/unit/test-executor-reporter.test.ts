import { describe, expect, it } from "vitest";
import { withJsonReporter } from "../../core/test-executor";

describe("withJsonReporter", () => {
  it("adds json to the configured reporter list without replacing it", () => {
    expect(withJsonReporter("npx playwright test --reporter=list"))
      .toBe("npx playwright test --reporter=list,json");
    expect(withJsonReporter("npx playwright test --reporter=line,html"))
      .toBe("npx playwright test --reporter=line,html,json");
  });

  it("adds a reporter flag only when the command has none", () => {
    expect(withJsonReporter("npx playwright test"))
      .toBe("npx playwright test --reporter=json");
    expect(withJsonReporter("npx playwright test --reporter=list,json"))
      .toBe("npx playwright test --reporter=list,json");
  });
});
