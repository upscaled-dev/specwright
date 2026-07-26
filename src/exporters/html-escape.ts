/**
 * Markdown renderers swallow raw `<...>` in prose as HTML tags, so outline placeholders like
 * `<user>` vanish from the output. Entity-escape prose and HTML contexts (`<summary>` labels,
 * table cells, headings, TOC link texts). Code spans and fences must NOT be escaped; raw text
 * is safe there and entities would render literally.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
