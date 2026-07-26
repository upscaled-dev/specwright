import { describe, it, expect } from "vitest";
import { scrubJwtLike } from "../../utils/text";

describe("scrubJwtLike", () => {
  const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;

  it("masks a three-segment token embedded in a sentence", () => {
    const scrubbed = scrubJwtLike(`denied for token ${jwt} on resource`);
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).toContain("[jwt-like-token]");
    expect(scrubbed).toContain("denied for token");
  });

  it("keeps hostnames and short dotted values intact", () => {
    expect(scrubJwtLike("see acme.atlassian.net and v1.2.3")).toBe(
      "see acme.atlassian.net and v1.2.3"
    );
  });
});
