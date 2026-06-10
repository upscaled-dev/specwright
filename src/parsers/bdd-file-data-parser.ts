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
  // so the slice between markers is the entries plus a trailing `];` — strip both, plus the
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

  // Background steps repeat the same pwStepLine across scenario entries — a Set dedupes them.
  // Scenario Outline rows genuinely produce multiple distinct pwStepLines — those all survive.
  const stepLineSets = new Map<number, Set<number>>();
  const testLines = new Map<number, number>();
  for (const entry of entries) {
    testLines.set(entry.pickleLine, entry.pwTestLine);
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
  return { stepLines, testLines };
}

// Assumes playwright-bdd resolves outputDir relative to the config file's directory (we
// approximate that with workingDirectory) and that the hardcoded `.spec.js` suffix matches
// bddgen's current output naming.
export function resolveGeneratedSpecPath(
  workingDir: string,
  featuresGenDir: string,
  featureFsPath: string
): string | undefined {
  const relative = path.relative(workingDir, featureFsPath);
  // `..` prefix alone would false-positive on a child directory literally named `..foo`;
  // an absolute result covers the Windows cross-drive case.
  const escapesWorkingDir =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesWorkingDir) {
    return undefined;
  }
  return path.resolve(workingDir, featuresGenDir, `${relative}.spec.js`);
}
