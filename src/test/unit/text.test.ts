import { describe, it, expect } from "vitest";
import { errMsg, maskValues, scrubJwtLike, serverMessage, serverText } from "../../utils/text";

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

describe("errMsg", () => {
  it("returns the bare message when nothing caused the error", () => {
    expect(errMsg(new Error("plain"))).toBe("plain");
    expect(errMsg("not an error")).toBe("not an error");
  });

  it("names the cause's code, which is where undici puts the real transport fault", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    expect(errMsg(new Error("fetch failed", { cause }))).toBe(
      "fetch failed (cause: ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443)"
    );
  });

  it("follows a second level and stops there", () => {
    const root = new Error("self-signed certificate in certificate chain");
    const middle = new Error("unable to verify the first certificate", { cause: root });
    expect(errMsg(new Error("fetch failed", { cause: middle }))).toBe(
      "fetch failed (cause: unable to verify the first certificate (cause: self-signed certificate in certificate chain))"
    );
  });

  it("terminates on a cause cycle", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    (first as { cause?: unknown }).cause = second;
    expect(errMsg(first)).toBe("first (cause: second (cause: first))");
  });

  it("prints a code-only cause without a dangling separator", () => {
    const cause = Object.assign(new Error(""), { code: "ECONNREFUSED" });
    expect(errMsg(new Error("fetch failed", { cause }))).toBe("fetch failed (cause: ECONNREFUSED)");
  });

  it("descends into an AggregateError's first error, which is where undici puts the wording", () => {
    const cause = Object.assign(new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:443")], ""), {
      code: "ECONNREFUSED",
    });
    expect(errMsg(new Error("fetch failed", { cause }))).toBe(
      "fetch failed (cause: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:443)"
    );
  });

  it("reads a string cause and ignores an empty one", () => {
    expect(errMsg(new Error("failed", { cause: "proxy refused" }))).toBe("failed (cause: proxy refused)");
    expect(errMsg(new Error("failed", { cause: "  " }))).toBe("failed");
  });
});

describe("serverText and serverMessage", () => {
  it("trims, scrubs, and clips at 300 characters", () => {
    expect(serverText("  spaced  ")).toBe("spaced");
    expect(serverText("x".repeat(300))).toHaveLength(300);
    expect(serverText("x".repeat(400))).toBe(`${"x".repeat(299)}…`);
  });

  it("scrubs before it clips, so a token straddling the cap cannot survive in pieces", () => {
    const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    const clipped = serverText(`${"x".repeat(280)} ${jwt} tail`);
    expect(clipped).toHaveLength(300);
    expect(clipped).toContain("[jwt-like-token]");
    expect(clipped).not.toContain("aaaaaaaa");
  });

  it("refuses an HTML body so a gateway page never becomes a toast", () => {
    expect(serverMessage("  <html><body>502 Bad Gateway</body></html>")).toBeUndefined();
    expect(serverMessage("   ")).toBeUndefined();
    expect(serverMessage("Issue does not exist.")).toBe("Issue does not exist.");
  });
});

describe("maskValues", () => {
  it("masks every occurrence of a credential and leaves the rest of the text alone", () => {
    expect(maskValues('{"secret":"abc","echo":"abc"}', ["abc", ""])).toBe(
      '{"secret":"[redacted]","echo":"[redacted]"}'
    );
  });
});
