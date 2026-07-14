/**
 * Wrap a value in shell-safe double quotes for the shell that `spawn(..., { shell: true })`
 * (and the js-debug node-terminal) will run the command through.
 *
 * The two shells disagree about the backslash, which is why this must branch:
 *   - POSIX (sh/bash/zsh): inside double quotes, `\` escapes `\`, `$`, `` ` `` and `"` — so all
 *     four must be backslash-escaped.
 *   - Windows (cmd.exe): backslash is NOT an escape character. POSIX-style doubling leaks the
 *     extra backslashes through to the child verbatim, which corrupted every value containing
 *     one: `--grep "v2\.0"` became the regex `v2\\.0` (matches nothing) and the precise
 *     `dir\file.spec.js:12` target became `dir\\file.spec.js:12` — both silently degraded a
 *     single-row run into a whole-outline name-grep. On win32 we instead follow the
 *     CommandLineToArgvW rules the child's own argv parser applies (the qntm.org/cmd algorithm,
 *     as used by cross-spawn): backslashes are literal UNLESS they precede a double quote, so
 *     only runs before a `"` (including our closing one) are doubled.
 */
export function shellQuote(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? windowsQuote(value) : posixQuote(value);
}

function posixQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("$", String.raw`\$`)
    .replaceAll("`", "\\`")
    .replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

// `$` and `` ` `` are literal in cmd.exe and must NOT be escaped. Known gap: `%VAR%` of an
// existing environment variable still expands inside cmd double quotes — there is no in-quote
// escape for `%` on the command line, and test titles matching a set variable are rare enough
// that we accept it.
function windowsQuote(value: string): string {
  // Single linear pass instead of /(\\*)"/ replaces: buffer each run of backslashes and decide
  // its fate at the next non-backslash character.
  let escaped = "";
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // A run of backslashes directly before a double quote: double the run, then escape the
      // quote itself so the child's argv parser keeps it literal (and stays in quoted mode).
      escaped += "\\".repeat(backslashes * 2) + String.raw`\"`;
    } else {
      escaped += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  // A trailing run of backslashes sits before the closing quote we add: double it so that
  // quote isn't swallowed as an escaped literal.
  escaped += "\\".repeat(backslashes * 2);
  return `"${escaped}"`;
}
