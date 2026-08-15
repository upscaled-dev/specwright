import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseBddFileData,
  parseBddSourceData,
  resolveGeneratedSpecPaths,
} from "../parsers/bdd-file-data-parser";

export type ExactGeneratedTargets =
  | { readonly targets: string[] }
  | { readonly reason: string };

export function generatedSpecPaths(
  workingDir: string,
  featuresGenDir: string,
  featurePath: string
): string[] {
  return resolveGeneratedSpecPaths(workingDir, featuresGenDir, featurePath);
}

function samePath(first: string, second: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}

interface VerifiedGeneratedSpec {
  readonly path: string;
  readonly content: string;
}

function readVerifiedGeneratedSpecs(
  workingDir: string,
  featuresGenDir: string,
  featurePath: string,
  specPaths = generatedSpecPaths(workingDir, featuresGenDir, featurePath)
): { specs: VerifiedGeneratedSpec[] } | { reason: string } {
  const specs: VerifiedGeneratedSpec[] = [];
  const foreignSources: string[] = [];
  for (const specPath of specPaths) {
    let content: string;
    try {content = fs.readFileSync(specPath, "utf8");}
    catch {return { reason: `generated spec ${specPath} could not be read` };}
    const source = parseBddSourceData(content, workingDir)?.featurePath;
    if (source === undefined) {
      return {
        reason: `generated spec ${specPath} has no "Generated from" source identity; regenerate it before running`,
      };
    }
    if (!samePath(source, featurePath)) {
      foreignSources.push(`${specPath} belongs to ${source}`);
      continue;
    }
    specs.push({ path: specPath, content });
  }
  if (specs.length === 0 && foreignSources.length > 0) {
    return {
      reason: `no generated spec belongs to ${path.resolve(featurePath)}; ${foreignSources.join("; ")}. ` +
        "Check the bddgen features configuration and regenerate it",
    };
  }
  return { specs };
}

/** Verify each generated spec declares the requested source feature before it can be targeted. */
export function verifiedGeneratedSpecPaths(
  workingDir: string,
  featuresGenDir: string,
  featurePath: string,
  specPaths = generatedSpecPaths(workingDir, featuresGenDir, featurePath)
): { paths: string[] } | { reason: string } {
  const verified = readVerifiedGeneratedSpecs(
    workingDir,
    featuresGenDir,
    featurePath,
    specPaths
  );
  return "reason" in verified
    ? verified
    : { paths: verified.specs.map((spec) => spec.path) };
}

/**
 * Feature lines whose generated test bddgen skipped for undefined steps (skip-scenario mode),
 * unioned across every verified generated spec of the feature. Specs belonging to another
 * feature contribute nothing; an unreadable or unidentified spec fails the verification as a
 * unit (readVerifiedGeneratedSpecs's contract), which empties the whole union.
 */
export function missingStepSkipLines(
  workingDir: string,
  featuresGenDir: string,
  featureFsPath: string
): ReadonlySet<number> {
  const lines = new Set<number>();
  const verified = readVerifiedGeneratedSpecs(workingDir, featuresGenDir, featureFsPath);
  if ("reason" in verified) {return lines;}
  for (const { content } of verified.specs) {
    for (const line of parseBddFileData(content)?.missingStepPickleLines ?? []) {
      lines.add(line);
    }
  }
  return lines;
}

/** Resolve the exact generated test in every BDD project that owns the feature. */
export function exactGeneratedTargets(
  workingDir: string,
  featuresGenDir: string,
  featurePath: string,
  lineNumber: number | undefined,
  specPaths = generatedSpecPaths(workingDir, featuresGenDir, featurePath)
): ExactGeneratedTargets {
  if (lineNumber === undefined || lineNumber <= 0) {
    return { reason: "the test item has no line number" };
  }
  if (specPaths.length === 0) {
    return { reason: `no generated spec exists for the feature under ${workingDir}` };
  }
  const verified = readVerifiedGeneratedSpecs(
    workingDir,
    featuresGenDir,
    featurePath,
    specPaths
  );
  if ("reason" in verified) {return verified;}
  const targets: string[] = [];
  for (const { path: specPath, content } of verified.specs) {
    const pwTestLine = parseBddFileData(content)?.testLines.get(lineNumber);
    if (pwTestLine === undefined) {
      return {
        reason: `line ${lineNumber} has no bddFileData mapping in ${specPath} (stale spec or feature/spec drift)`,
      };
    }
    const relative = path.relative(workingDir, specPath);
    const specArg = relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
      ? specPath
      : relative;
    targets.push(`${specArg.split(path.sep).join("/")}:${pwTestLine}`);
  }
  return { targets };
}

export function needsGeneratedSpecs(
  workingDir: string,
  featuresGenDir: string,
  featurePath: string,
  lineNumber: number | undefined,
  outlineName: string | undefined,
  scenarioName: string | undefined,
  hasProvidedTargets: boolean
): boolean {
  if (hasProvidedTargets) {return false;}
  const relative = path.relative(workingDir, featurePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  if (
    lineNumber !== undefined &&
    lineNumber > 0 &&
    (scenarioName !== undefined || outlineName !== undefined)
  ) {
    const verified = verifiedGeneratedSpecPaths(
      workingDir,
      featuresGenDir,
      featurePath
    );
    if ("reason" in verified) {return false;}
    return "reason" in exactGeneratedTargets(
      workingDir,
      featuresGenDir,
      featurePath,
      lineNumber,
      verified.paths
    );
  }
  if (outlineName === undefined) {return false;}
  const verified = verifiedGeneratedSpecPaths(workingDir, featuresGenDir, featurePath);
  return "paths" in verified && verified.paths.length === 0;
}
