export interface BddgenErrorLocation {
  filePath: string;
  line: number;
  column?: number | undefined;
  message: string;
}

// Strip any CSI sequence (SGR colors plus cursor/erase codes like ESC[2K, ESC[1G),
// otherwise the ^-anchored line patterns below fail to match. ESC is built via
// fromCodePoint so no raw control byte lives in this source file.
const ESC = String.fromCodePoint(27);
const ANSI_RE = new RegExp(String.raw`${ESC}\[[0-?]*[ -/]*[@-~]`, "g");
const FEATURE_BLOCK_RE = /Error parsing feature file:\s*(.+?\.feature)\s*[\r\n]+([\s\S]*?)(?=Error parsing feature file:|$)/g;
const BLOCK_TUPLE_RE = /\((\d+):(\d+)\):\s*(.+)/g;
const SINGLE_LINE_RE = /^(.+?\.feature):(\d+)(?::(\d+))?\s*[-:]\s*(.+)$/gm;
const MSBUILD_RE = /^(.+?\.feature)\((\d+),(\d+)\):\s*(?:error)?\s*(.+)$/gm;

export function parseBddgenErrors(output: string): BddgenErrorLocation[] {
  if (!output) {return [];}
  const cleaned = output.replaceAll(ANSI_RE, "");
  const results: BddgenErrorLocation[] = [];
  const seen = new Set<string>();

  const pushUnique = (loc: BddgenErrorLocation): void => {
    const key = `${loc.filePath}\0${loc.line}\0${loc.message}`;
    if (seen.has(key)) {return;}
    seen.add(key);
    results.push(loc);
  };

  let blockMatch: RegExpExecArray | null;
  FEATURE_BLOCK_RE.lastIndex = 0;
  while ((blockMatch = FEATURE_BLOCK_RE.exec(cleaned)) !== null) {
    const filePath = blockMatch[1]?.trim();
    const body = blockMatch[2] ?? "";
    if (!filePath) {continue;}
    let tupleMatch: RegExpExecArray | null;
    BLOCK_TUPLE_RE.lastIndex = 0;
    while ((tupleMatch = BLOCK_TUPLE_RE.exec(body)) !== null) {
      const lineStr = tupleMatch[1];
      const colStr = tupleMatch[2];
      const msg = tupleMatch[3]?.trim();
      if (!lineStr || !colStr || !msg) {continue;}
      const lineNum = Number.parseInt(lineStr, 10);
      const colNum = Number.parseInt(colStr, 10);
      if (!Number.isFinite(lineNum) || lineNum < 1) {continue;}
      pushUnique({
        filePath,
        line: lineNum - 1,
        column: Number.isFinite(colNum) && colNum >= 1 ? colNum - 1 : undefined,
        message: msg,
      });
    }
  }

  let singleMatch: RegExpExecArray | null;
  SINGLE_LINE_RE.lastIndex = 0;
  while ((singleMatch = SINGLE_LINE_RE.exec(cleaned)) !== null) {
    const filePath = singleMatch[1]?.trim();
    const lineStr = singleMatch[2];
    const colStr = singleMatch[3];
    const msg = singleMatch[4]?.trim();
    if (!filePath || !lineStr || !msg) {continue;}
    if (filePath.startsWith("Error parsing feature file")) {continue;}
    const lineNum = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(lineNum) || lineNum < 1) {continue;}
    const colNum = colStr ? Number.parseInt(colStr, 10) : Number.NaN;
    pushUnique({
      filePath,
      line: lineNum - 1,
      column: Number.isFinite(colNum) && colNum >= 1 ? colNum - 1 : undefined,
      message: msg,
    });
  }

  let msbuildMatch: RegExpExecArray | null;
  MSBUILD_RE.lastIndex = 0;
  while ((msbuildMatch = MSBUILD_RE.exec(cleaned)) !== null) {
    const filePath = msbuildMatch[1]?.trim();
    const lineStr = msbuildMatch[2];
    const colStr = msbuildMatch[3];
    const msg = msbuildMatch[4]?.trim();
    if (!filePath || !lineStr || !colStr || !msg) {continue;}
    const lineNum = Number.parseInt(lineStr, 10);
    const colNum = Number.parseInt(colStr, 10);
    if (!Number.isFinite(lineNum) || lineNum < 1) {continue;}
    pushUnique({
      filePath,
      line: lineNum - 1,
      column: Number.isFinite(colNum) && colNum >= 1 ? colNum - 1 : undefined,
      message: msg,
    });
  }

  return results;
}
