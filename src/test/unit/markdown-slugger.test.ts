import { describe, it, expect } from "vitest";
import { MarkdownSlugger } from "../../exporters/markdown-slugger";

describe("MarkdownSlugger", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(new MarkdownSlugger().slug("Step Definitions")).toBe("step-definitions");
  });

  it("keeps word chars, digits, underscores, and hyphens", () => {
    expect(new MarkdownSlugger().slug("A-b_c 9")).toBe("a-b_c-9");
  });

  it("strips angle brackets, slashes, and parens", () => {
    expect(new MarkdownSlugger().slug("Auth (<user>/<role>)")).toBe("auth-userrole");
  });

  it("strips dots so file paths collapse into one token", () => {
    expect(new MarkdownSlugger().slug("features/broken.feature")).toBe("featuresbrokenfeature");
  });

  it("suffixes duplicates with -1, -2 in call order", () => {
    const s = new MarkdownSlugger();
    expect(s.slug("Checkout")).toBe("checkout");
    expect(s.slug("Checkout")).toBe("checkout-1");
    expect(s.slug("Checkout")).toBe("checkout-2");
  });

  it("tracks distinct headings independently", () => {
    const s = new MarkdownSlugger();
    expect(s.slug("Given")).toBe("given");
    expect(s.slug("When")).toBe("when");
    expect(s.slug("Given")).toBe("given-1");
  });
});
