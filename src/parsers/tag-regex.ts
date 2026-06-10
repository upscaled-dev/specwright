// Gherkin allows any non-whitespace in a tag (playwright-bdd relies on @retries:2,
// @timeout:5000, @fixture:foo, @mode:serial). We exclude `,` and `@` so comma-joined
// tags still split, and require a word/hyphen final char so trailing punctuation
// like ')' is not captured.
export const TAG_TOKEN_PATTERN = String.raw`@[^\s@,]*[\w-]`;
