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
// theming rides them), scripts only from the per-render nonce. A view that ships local style/font
// assets opts its own webview source in without widening any other panel.
export function contentSecurityPolicy(nonce: string, resourceSource?: string): string {
  const resources = resourceSource
    ? ` style-src 'unsafe-inline' ${resourceSource}; font-src ${resourceSource};`
    : " style-src 'unsafe-inline';";
  return `default-src 'none';${resources} script-src 'nonce-${nonce}';`;
}
