const PLACEHOLDER_RE = /\{[^}]*\}/g;

const META_OUTSIDE_PLACEHOLDERS_RE = /[\\|[\]?+*^$]/;

export function humanizeRegexSource(
  source: string,
  isRegex: boolean
): { label: string; humanized: boolean } {
  if (!isRegex) {
    return { label: source, humanized: true };
  }

  let out = source;
  if (out.startsWith("^")) {out = out.slice(1);}
  if (out.endsWith("$")) {out = out.slice(0, -1);}

  out = out.replaceAll(/\(\?<([A-Za-z_$][\w$]*)>[^)]*\)/g, "{$1}");
  out = out.replaceAll("(\\d+\\.\\d+)", "{float}");
  out = out.replaceAll("([\\d.]+)", "{float}");
  out = out.replaceAll("(\\d+)", "{int}");
  out = out.replaceAll(/"\(\[\^"]\*\)"/g, '"{string}"');
  out = out.replaceAll(/'\(\[\^']\*\)'/g, "'{string}'");
  out = out.replaceAll("(.+?)", "{}");
  out = out.replaceAll("(.*?)", "{}");
  out = out.replaceAll("(.+)", "{}");
  out = out.replaceAll("(.*)", "{}");
  out = out.replaceAll(/\\s\+/g, " ");

  const placeholderStripped = out.replaceAll(PLACEHOLDER_RE, "");
  if (META_OUTSIDE_PLACEHOLDERS_RE.test(placeholderStripped)) {
    return { label: source, humanized: false };
  }

  return { label: out, humanized: true };
}

export function patternToSnippet(label: string): string {
  let index = 0;
  let hasPlaceholder = false;
  let out = "";
  let cursor = 0;
  for (const match of label.matchAll(/\{([^}]*)\}/g)) {
    hasPlaceholder = true;
    index += 1;
    out += escapeSnippetText(label.slice(cursor, match.index));
    const inner = match[1] ?? "";
    const hint = inner.length > 0 ? inner : "arg";
    out += `\${${index}:${escapeSnippetText(hint)}}`;
    cursor = match.index + match[0].length;
  }
  if (!hasPlaceholder) {return label;}
  out += escapeSnippetText(label.slice(cursor));
  return `${out}$0`;
}

function escapeSnippetText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("$", String.raw`\$`)
    .replaceAll("}", String.raw`\}`);
}
