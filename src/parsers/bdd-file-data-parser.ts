import * as fs from "node:fs";
import * as path from "node:path";

const START_MARKER = "// bdd-data-start";
const END_MARKER = "// bdd-data-end";

interface BddStep {
  pwStepLine: number;
  gherkinStepLine: number;
}

interface BddTestEntry {
  pwTestLine: number;
  pickleLine: number;
  steps?: BddStep[];
}

export interface BddFileData {
  /** gherkinStepLine (1-based) → deduped sorted pwStepLine[] (1-based) */
  stepLines: Map<number, number[]>;
  /** pickleLine (Scenario: line, 1-based) → pwTestLine (1-based) */
  testLines: Map<number, number>;
  /** pwTestLine (generated test line, 1-based) → pickleLine (Scenario: line, 1-based) */
  pickleLines: Map<number, number>;
}

export interface BddSourceData {
  featurePath: string;
  lineNumbers: Map<number, number>;
}

/**
 * Extracts the `bddFileData` array playwright-bdd embeds in each generated spec between
 * `// bdd-data-start` and `// bdd-data-end` markers. Returns undefined (never throws) when
 * the markers are missing or the payload isn't valid JSON.
 */
export function parseBddFileData(specText: string): BddFileData | undefined {
  const start = specText.indexOf(START_MARKER);
  const end = specText.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  // The block reads `const bddFileData = [ // bdd-data-start\n {...},\n {...},\n]; // bdd-data-end`
  // so the slice between markers is the entries plus a trailing `];`; strip both, plus the
  // trailing comma JSON.parse rejects, and re-wrap in brackets.
  let body = specText.slice(start + START_MARKER.length, end).trim();
  if (!body.endsWith("];")) {
    return undefined;
  }
  body = body.slice(0, -2).trim();
  if (body.endsWith(",")) {
    body = body.slice(0, -1);
  }

  let entries: BddTestEntry[];
  try {
    entries = JSON.parse(`[${body}]`) as BddTestEntry[];
  } catch {
    return undefined;
  }

  // Background steps repeat the same pwStepLine across scenario entries; a Set dedupes them.
  // Scenario Outline rows genuinely produce multiple distinct pwStepLines; those all survive.
  const stepLineSets = new Map<number, Set<number>>();
  const testLines = new Map<number, number>();
  const pickleLines = new Map<number, number>();
  for (const entry of entries) {
    testLines.set(entry.pickleLine, entry.pwTestLine);
    pickleLines.set(entry.pwTestLine, entry.pickleLine);
    for (const step of entry.steps ?? []) {
      let set = stepLineSets.get(step.gherkinStepLine);
      if (!set) {
        set = new Set<number>();
        stepLineSets.set(step.gherkinStepLine, set);
      }
      set.add(step.pwStepLine);
    }
  }

  const stepLines = new Map<number, number[]>();
  for (const [gherkinLine, pwLines] of stepLineSets) {
    stepLines.set(gherkinLine, [...pwLines].sort((a, b) => a - b));
  }
  return { stepLines, testLines, pickleLines };
}

/** Parse the source feature and the complete generated-test line map once for reuse. */
export function parseBddSourceData(
  specText: string,
  projectDir: string
): BddSourceData | undefined {
  const generatedFrom = /^\s*\/\/\s*Generated from:\s*(.+?\.feature)\s*$/m.exec(specText)?.[1];
  if (!generatedFrom) {
    return undefined;
  }

  const lineNumbers = parseBddFileData(specText)?.pickleLines ?? looseSourceLineMap(specText);
  const featurePath = path.resolve(projectDir, generatedFrom);
  return { featurePath, lineNumbers };
}

/** Older generated specs carry the same entries without the end marker used by the strict parser. */
function looseSourceLineMap(specText: string): Map<number, number> {
  const lineNumbers = new Map<number, number>();
  const pairs = /"pwTestLine"\s*:\s*(\d+)\s*,\s*"pickleLine"\s*:\s*(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pairs.exec(specText)) !== null) {
    lineNumbers.set(Number(match[1]), Number(match[2]));
  }
  return lineNumbers;
}

interface SpecCandidate {
  specPath: string;
  mtimeMs: number;
}

/**
 * Pick the generated spec for a base path, considering both suffixes bddgen has used:
 * `<feature>.spec.js` up to playwright-bdd v8, `<feature>.spec.ts` from v9. When both exist
 * (a stale .js left over from before a v9 upgrade), the newer mtime wins. Undefined when
 * neither file exists.
 */
function existingSpecFor(base: string): SpecCandidate | undefined {
  let newest: SpecCandidate | undefined;
  for (const specPath of [`${base}.spec.js`, `${base}.spec.ts`]) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(specPath).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { specPath, mtimeMs };
    }
  }
  return newest;
}

function directSubdirsOf(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// Assumes playwright-bdd resolves outputDir relative to the config file's directory (we
// approximate that with workingDirectory). Probing the generated files lets callers use the
// actual layout rather than assume it. Two bddgen conventions bend the naive
// `<genDir>/<feature-relative-path>.spec.js`
// shape:
//   - A named BDD project (`defineBddProject(..., 'browser')`) nests its output one level
//     deeper: `.features-gen/browser/...`. We therefore probe the gen dir's direct
//     subdirectories as alternative roots.
//   - `featuresRoot` (default: the config directory) strips leading path segments from the
//     mirrored layout (`featuresRoot: './features'` puts `features/ui/x.feature` at
//     `.features-gen/ui/x.feature.spec.js`). We therefore retry with leading segments
//     stripped, most-specific (longest) suffix first.
// The extension can't read the user's Playwright config, so probing beats a setting the user
// would have to keep in sync. Every root matching at the first specificity is returned because
// each one is an applicable BDD project and omitting one silently skips its test execution.
export function resolveGeneratedSpecPaths(
  workingDir: string,
  featuresGenDir: string,
  featureFsPath: string
): string[] {
  const relative = path.relative(workingDir, featureFsPath);
  // `..` prefix alone would false-positive on a child directory literally named `..foo`;
  // an absolute result covers the Windows cross-drive case.
  const escapesWorkingDir =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesWorkingDir) {
    return [];
  }
  const genRoot = path.resolve(workingDir, featuresGenDir);
  const roots = [genRoot, ...directSubdirsOf(genRoot).sort()];
  const segments = relative.split(path.sep);
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (let i = 0; i < segments.length; i++) {
      const match = existingSpecFor(path.join(root, segments.slice(i).join(path.sep)));
      if (!match) {continue;}
      const identity = process.platform === "win32"
        ? match.specPath.toLowerCase()
        : match.specPath;
      if (!seen.has(identity)) {
        seen.add(identity);
        matches.push(match.specPath);
      }
      break;
    }
  }
  return matches;
}
