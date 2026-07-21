export interface ExtractedKeys {
  testKeys: string[];
  reqKeys: string[];
}

export interface KeyExtractionGrammar {
  testPrefix: string;
  reqPrefix: string;
  keyShape: RegExp;
  canonicalizeKey(key: string): string;
}

// A `g`/`y` flag makes `RegExp.test` stateful via `lastIndex`, so repeated one-shot matches on the
// same instance would flip between hit and miss. Recreate the pattern without those flags before use.
export function stateless(keyShape: RegExp): RegExp {
  if (!keyShape.global && !keyShape.sticky) {return keyShape;}
  const flags = keyShape.flags.replaceAll("g", "").replaceAll("y", "");
  return new RegExp(keyShape.source, flags);
}

// The prefix is matched case-insensitively; the key is canonicalized by the adapter's grammar so
// `@TEST_CALC-1` and `@test_calc-1` collapse to one identity. What counts as a valid key body is the
// grammar's business — both the shape and the canonical form are supplied, not assumed here.
function keyForPrefix(
  tag: string,
  prefix: string,
  keyShape: RegExp,
  canonicalizeKey: (key: string) => string
): string | undefined {
  const body = tag.startsWith("@") ? tag.slice(1) : tag;
  if (body.length <= prefix.length) {return undefined;}
  if (body.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {return undefined;}
  const key = body.slice(prefix.length);
  return keyShape.test(key) ? canonicalizeKey(key) : undefined;
}

function pushUnique(keys: string[], key: string): void {
  if (!keys.includes(key)) {keys.push(key);}
}

export function extractKeys(
  tags: readonly string[],
  grammar: KeyExtractionGrammar
): ExtractedKeys {
  const keyShape = stateless(grammar.keyShape);
  const testKeys: string[] = [];
  const reqKeys: string[] = [];
  for (const tag of tags) {
    const testKey = keyForPrefix(tag, grammar.testPrefix, keyShape, grammar.canonicalizeKey);
    if (testKey) {
      pushUnique(testKeys, testKey);
      continue;
    }
    const reqKey = keyForPrefix(tag, grammar.reqPrefix, keyShape, grammar.canonicalizeKey);
    if (reqKey) {
      pushUnique(reqKeys, reqKey);
    }
  }
  return { testKeys, reqKeys };
}
