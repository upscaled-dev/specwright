export interface EditEntry {
  op: string;
  range?: { start: { line: number }; end?: { line: number } };
  position?: { line: number };
  text: string;
}

// Replays the entries a stubbed WorkspaceEdit recorded so a test can assert the resulting file
// byte-exactly, EOLs included, rather than the shape of the edit.
export function applyWsEdit(text: string, entries: EditEntry[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const parts = text.split(eol);
  for (const e of entries) {
    if (e.op === "insert" && e.position) {
      const content = e.text.endsWith(eol) ? e.text.slice(0, -eol.length) : e.text;
      parts.splice(e.position.line, 0, content);
    } else if (e.op === "replace" && e.range) {
      parts[e.range.start.line] = e.text;
    } else if (e.op === "delete" && e.range?.end) {
      parts.splice(e.range.start.line, e.range.end.line - e.range.start.line);
    }
  }
  return parts.join(eol);
}
