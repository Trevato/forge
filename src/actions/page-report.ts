/**
 * The words of a report made from a page (#810): the first line is the
 * title, the whole text is the body. One shape for the toolbar page and the
 * terminal's palette, so the issue they open reads the same from either door.
 */

const TITLE_MAX = 80;

/** The issue title for `text`: its first line, kept to {@link TITLE_MAX}. */
export function reportTitle(text: string): string {
  const first = text.trim().split("\n")[0]!.trim();
  return first.length <= TITLE_MAX ? first : `${first.slice(0, TITLE_MAX - 3).trimEnd()}…`;
}
