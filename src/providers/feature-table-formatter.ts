import * as vscode from "vscode";
import { findTableBlocks, formatTableBlock } from "./feature-table-formatter-helpers";

export class FeatureTableFormatter implements vscode.DocumentFormattingEditProvider {
  public provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const text = document.getText();
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const docStringSkip = computeDocStringSkip(text);
    const blocks = findTableBlocks(lines, docStringSkip);

    const edits: vscode.TextEdit[] = [];
    for (const block of blocks) {
      const original = lines.slice(block.start, block.end + 1);
      const formatted = formatTableBlock(original);
      if (!formatted) {continue;}
      const range = new vscode.Range(block.start, 0, block.end, (lines[block.end] ?? "").length);
      edits.push(vscode.TextEdit.replace(range, formatted.join(newline)));
    }
    return edits;
  }
}

// computeSkipRanges in feature-skip-ranges.ts adds table rows to its skip set, which
// would mask every table we want to format. We only need doc-string suppression here.
function computeDocStringSkip(text: string): Set<number> {
  const skip = new Set<number>();
  const lines = text.split(/\r?\n/);
  let docStringDelimiter: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (docStringDelimiter) {
      skip.add(i);
      // A docstring closes only with the delimiter type that opened it.
      if (trimmed.startsWith(docStringDelimiter)) {docStringDelimiter = null;}
      continue;
    }
    if (trimmed.startsWith(`"""`) || trimmed.startsWith("```")) {
      skip.add(i);
      docStringDelimiter = trimmed.startsWith(`"""`) ? `"""` : "```";
    }
  }
  return skip;
}
