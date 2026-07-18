export interface TagPrefixes {
  testPrefix: string;
  reqPrefix: string;
}

export interface ExtractedKeys {
  testKeys: string[];
  reqKeys: string[];
}

export const DEFAULT_TEST_PREFIX = "TEST_";
export const DEFAULT_REQ_PREFIX = "REQ_";

// A Jira/Xray issue key: a project part (which may itself contain hyphens/underscores), then a
// trailing `-<number>`. The project is everything before that last `-<number>` — so KEY_SHAPE and
// projectFromKey agree on multi-segment keys like AB-CD-123.
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*-\d+$/;

/** `CALC-1043` → `CALC`, `AB-CD-123` → `AB-CD`: everything before the trailing `-<number>`. */
export function projectFromKey(key: string): string {
  const match = /^(.*)-\d+$/.exec(key);
  return match?.[1] ?? key;
}

// The prefix is matched case-insensitively; the key is normalized to uppercase so `@TEST_CALC-1`
// and `@test_calc-1` collapse to one canonical Jira key (CALC-1) for identity and display.
function keyForPrefix(tag: string, prefix: string): string | undefined {
  const body = tag.startsWith("@") ? tag.slice(1) : tag;
  if (body.length <= prefix.length) {return undefined;}
  if (body.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {return undefined;}
  const key = body.slice(prefix.length);
  return KEY_SHAPE.test(key) ? key.toUpperCase() : undefined;
}

function pushUnique(keys: string[], key: string): void {
  if (!keys.includes(key)) {keys.push(key);}
}

// An empty/whitespace prefix would match every tag; treat it as unset and fall back to the default.
function effectivePrefix(prefix: string, fallback: string): string {
  return prefix.trim() === "" ? fallback : prefix;
}

export function extractXrayKeys(
  tags: readonly string[],
  prefixes: TagPrefixes
): ExtractedKeys {
  const testPrefix = effectivePrefix(prefixes.testPrefix, DEFAULT_TEST_PREFIX);
  const reqPrefix = effectivePrefix(prefixes.reqPrefix, DEFAULT_REQ_PREFIX);
  const testKeys: string[] = [];
  const reqKeys: string[] = [];
  for (const tag of tags) {
    const testKey = keyForPrefix(tag, testPrefix);
    if (testKey) {
      pushUnique(testKeys, testKey);
      continue;
    }
    const reqKey = keyForPrefix(tag, reqPrefix);
    if (reqKey) {
      pushUnique(reqKeys, reqKey);
    }
  }
  return { testKeys, reqKeys };
}
