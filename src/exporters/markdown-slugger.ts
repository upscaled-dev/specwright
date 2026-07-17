/**
 * GitHub-style heading anchors: lowercase, drop everything but word chars / spaces / hyphens,
 * spaces become hyphens, duplicate slugs get -1, -2… suffixes in document order. TOC links only
 * resolve if they are generated with the same scheme the Markdown renderer applies to headings,
 * so slug every emitted heading through one instance, in emission order.
 */
export class MarkdownSlugger {
  private readonly seen = new Map<string, number>();

  public slug(heading: string): string {
    const base = heading
      .toLowerCase()
      .replaceAll(/[^\w\s-]/g, "")
      .replaceAll(/\s/g, "-");
    const count = this.seen.get(base) ?? 0;
    this.seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  }
}
