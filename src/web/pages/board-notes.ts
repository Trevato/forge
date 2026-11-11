/**
 * The board's notes: everything that is not a panel, folded into one quiet
 * line under the title — "4 notes · 1 needs you" — that opens in place.
 * Closed is the default; a list the reader has opened stays open across live
 * swaps (`liveRegionsJs`). Nothing is stored.
 * A note is a short line with a link, never a paragraph; two notes with the
 * same cause are one. Only what a person can act on is a note: the crew's
 * own housekeeping (an issue parked twice) is the planner's, on the map.
 */

import { html, type Html } from "../html.ts";
import { disclosure, dot } from "../ui.ts";

/** One line on the board. */
export interface Note {
  /** The cause; a second note with the same key is dropped. */
  key: string;
  /** True when it waits for the reader, false when it is only worth knowing. */
  need: boolean;
  /** The line itself: one link or one span, `data-need` on a need. */
  line: Html;
}

/** Notes with each cause once, in the order given. */
export function distinct(notes: readonly Note[]): Note[] {
  const seen = new Set<string>();
  return notes.filter((n) => !seen.has(n.key) && !!seen.add(n.key));
}

/** "4 notes · 1 needs you": the closed line's words. */
export function summaryWords(notes: readonly Note[]): string {
  const needs = notes.filter((n) => n.need).length;
  const all = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
  return needs === 0 ? all : `${all} · ${needs} ${needs === 1 ? "needs" : "need"} you`;
}

/** The closed line: the count of notes, and the need count wearing the attention dot. */
function summaryLine(notes: readonly Note[]): Html {
  const needs = notes.filter((n) => n.need).length;
  if (needs === 0) return html`${summaryWords(notes)}`;
  const all = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
  return html`${all} · <span class="notes-need" data-need>${dot("attn")} ${needs} ${needs === 1 ? "needs" : "need"} you</span>`;
}

/**
 * The live region for the notes. `fine` is the admin's quiet "All fine"
 * when nothing is noted, followed by `aside` when there is one; anyone
 * else gets an empty region, ready for the first note to swap in.
 */
export function notesRegion(
  notes: readonly Note[],
  o: { fine: boolean; live: string; ok: boolean | null; aside?: Html },
): Html {
  const attrs = html`id="notes" data-live="${o.live}"${
    o.ok === null ? "" : html` data-ok="${o.ok ? "yes" : "no"}"`
  }`;
  const wrap = (inner: Html | null) =>
    html`<div ${attrs} role="status">${inner}</div>`;
  if (notes.length === 0)
    return wrap(
      o.fine
        ? html`<span class="small muted">${dot("success")} All fine${o.aside === undefined ? "" : html` · ${o.aside}`}</span>`
        : null,
    );
  return wrap(
    disclosure(
      summaryLine(notes),
      html`<ul class="small muted">
        ${notes.map((n) => html`<li>${n.line}</li>`)}
      </ul>`,
      { small: true, id: "notes-list" },
    ),
  );
}
