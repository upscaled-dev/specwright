import { describe, it, expect } from "vitest";
import { contentSecurityPolicy, createNonce, escapeHtml } from "../../utils/webview";

describe("escapeHtml", () => {
  it("escapes all five markup-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes the ampersand first so an emitted entity is not double-escaped", () => {
    expect(escapeHtml("<a>")).toBe("&lt;a&gt;");
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("CALC-1043 Divide by zero")).toBe("CALC-1043 Divide by zero");
  });

  it("is safe inside a double-quoted attribute", () => {
    expect(escapeHtml('acme".onclick="alert(1)')).toBe("acme&quot;.onclick=&quot;alert(1)");
  });
});

describe("createNonce", () => {
  it("returns 32 hex characters (16 random bytes)", () => {
    expect(createNonce()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a fresh value each call", () => {
    expect(createNonce()).not.toBe(createNonce());
  });
});

describe("contentSecurityPolicy", () => {
  it("locks default-src to none, allows inline styles, and gates scripts on the nonce", () => {
    expect(contentSecurityPolicy("abc123")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc123';"
    );
  });

  it("admits one webview source only when a document ships local styles and fonts", () => {
    expect(contentSecurityPolicy("abc123", "vscode-webview://view")).toBe(
      "default-src 'none'; style-src 'unsafe-inline' vscode-webview://view; font-src vscode-webview://view; script-src 'nonce-abc123';"
    );
  });
});
