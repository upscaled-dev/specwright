const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

export function findTableBlocks(
  lines: string[],
  skipLines: Set<number>
): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (!skipLines.has(i) && isTableLine(raw)) {
      if (blockStart === -1) {blockStart = i;}
      continue;
    }
    if (blockStart !== -1) {
      blocks.push({ start: blockStart, end: i - 1 });
      blockStart = -1;
    }
  }
  if (blockStart !== -1) {
    blocks.push({ start: blockStart, end: lines.length - 1 });
  }
  return blocks;
}

export function formatTableBlock(rows: string[]): string[] | undefined {
  if (rows.length === 0) {return undefined;}

  const indent = leadingIndent(rows[0] ?? "");
  const parsed = rows.map((row) => parseRow(row));
  const columnCount = Math.max(...parsed.map((cells) => cells.length));

  const widths = new Array<number>(columnCount).fill(0);
  for (const cells of parsed) {
    for (let c = 0; c < columnCount; c++) {
      const cell = cells[c] ?? "";
      if (cell.length > (widths[c] ?? 0)) {widths[c] = cell.length;}
    }
  }

  const formatted = parsed.map((cells) => {
    const parts: string[] = [];
    for (let c = 0; c < columnCount; c++) {
      const cell = cells[c] ?? "";
      const width = widths[c] ?? 0;
      parts.push(NUMERIC_RE.test(cell) ? cell.padStart(width) : cell.padEnd(width));
    }
    return `${indent}| ${parts.join(" | ")} |`;
  });

  let changed = false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] !== formatted[i]) {
      changed = true;
      break;
    }
  }
  return changed ? formatted : undefined;
}

function isTableLine(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

function leadingIndent(raw: string): string {
  const m = /^[\t ]*/.exec(raw);
  return m ? m[0] : "";
}

function parseRow(row: string): string[] {
  const trimmed = row.trim();
  const inner = trimmed.slice(1, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      buf += String.raw`\|`;
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}
