import { randomBytes } from "node:crypto";

// Escapes every character that can break out of an HTML text node OR a double/single-quoted
// attribute, so one function is safe for both interpolation contexts the panels use.
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

// The panels' shared Content-Security-Policy: no default fetches, inline styles allowed (VS Code
// theming rides them), scripts only from the per-render nonce.
export function contentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
}
