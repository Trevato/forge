/**
 * A row is one line (#73). Free text an agent wrote — a run's summary, the
 * note a word carries from it — goes through here before it sits in a row's
 * meta: whitespace and newlines collapsed to single spaces, bounded
 * generously, escaped by `html`, and the whole of it in the title
 * attribute. Never rendered as markdown: a backtick stays a backtick. The
 * clamp itself is CSS (`.row-note` in `style/components.ts`), so a screen
 * reader and hover keep the text and the who and when beside it keep their
 * place. The transcript, one click from the row, has the whole summary.
 */
import { html, type Html } from "../html.ts";

/** The most characters of a note a row carries; past it the page would only grow. */
export const NOTE_MAX = 2000;

/** One readable line: newlines and runs of space become a single space. */
export function flatten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTE_MAX ? `${flat.slice(0, NOTE_MAX - 1)}…` : flat;
}

/** The note as a clamped, escaped span; the whole text is its title. */
export function noteLine(text: string): Html {
  const flat = flatten(text);
  return html`<span class="row-note" title="${flat}">${flat}</span>`;
}
