/**
 * Wrap a value in shell-safe double quotes. Escapes characters that have meaning inside
 * double quotes: backslash, dollar sign, backtick, and the double quote itself.
 */
export function shellQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}
