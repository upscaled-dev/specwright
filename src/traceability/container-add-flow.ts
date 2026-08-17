import type { AddTestsToContainerResult, KeyGrammar } from "./contracts";

export type ContainerTargetKey =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "valid"; readonly key: string };

function matchesKeyShape(key: string, shape: RegExp): boolean {
  shape.lastIndex = 0;
  const matches = shape.test(key);
  shape.lastIndex = 0;
  return matches;
}

// Canonicalize once, then enforce both provider key grammar and the board's scoped project before any
// remote read. The remote type-specific exact-key query supplies the remaining existence/type proof.
export function validateContainerTargetKey(
  input: string,
  project: string,
  grammar: KeyGrammar
): ContainerTargetKey {
  const key = grammar.canonicalizeKey(input.trim());
  if (key === "" || !matchesKeyShape(key, grammar.keyShape)) {
    return { kind: "invalid", message: "Enter an exact issue key, such as CALC-123." };
  }
  const targetProject = grammar.projectOf?.(key);
  if (targetProject === undefined || grammar.canonicalizeKey(targetProject) !== grammar.canonicalizeKey(project)) {
    return { kind: "invalid", message: `The target must be in project ${project}.` };
  }
  return { kind: "valid", key };
}

export interface ContainerAddReport {
  readonly message: string;
  readonly inspect: boolean;
}

export function describeContainerAdd(
  noun: string,
  key: string,
  selected: number,
  result: AddTestsToContainerResult
): ContainerAddReport {
  if (result.addedTests === undefined) {
    return {
      message: `Xray accepted the request for ${noun} ${key}, but did not return a readable added count. Inspect ${key} before retrying.`,
      inspect: true,
    };
  }
  const added = result.addedTests.length;
  if (added < selected) {
    return {
      message: `Xray reported ${added} of ${selected} selected tests added to ${noun} ${key}. The others may already be members or may not have been accepted; inspect ${key} before retrying.`,
      inspect: true,
    };
  }
  return {
    message: `Added ${added} of ${selected} selected tests to ${noun} ${key}.`,
    inspect: result.warning !== undefined,
  };
}
