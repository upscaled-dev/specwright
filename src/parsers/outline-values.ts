/** Apply one Examples row using the same placeholder substitution Gherkin uses for pickles. */
export function substituteOutlineValues(
  text: string,
  headers: readonly string[],
  values: readonly string[]
): string {
  let substituted = text;
  for (const [index, value] of values.entries()) {
    const header = headers[index];
    if (header) {substituted = substituted.replaceAll(`<${header}>`, value);}
  }
  return substituted;
}
