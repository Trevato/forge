/**
 * The estimate scorecard on /flow (#11955), over the repositories the viewer may read: per
 * estimator, then per size and kind, how late (or early) the median ran and how often the p90 held.
 */
import { estimatesVisibleTo } from "../../core/estimates.ts";
import type { User } from "../../core/users.ts";
import type { Database } from "bun:sqlite";
import { biasWords, scoreboard, type Score } from "../../flow/estimate_score.ts";
import { html, type Html } from "../html.ts";
import { row } from "../ui.ts";

const counts = (s: Score): string => `${String(s.resolved)} resolved · ${String(s.void)} void · ${String(s.open)} open`;

/** One row per score: "steward · small bug: median 2.4× late, p90 held 55% · 6 resolved …". */
export function estimatesSection(db: Database, viewer: User | undefined): Html {
  const scores = scoreboard(estimatesVisibleTo(db, viewer));
  if (scores.length === 0) return html``;
  return html`<section class="bd-block" aria-labelledby="estimates-h">
    <header class="bd-head"><h2 id="estimates-h">Estimates</h2><p class="bd-sub">How each estimator's guesses have held. The p90 should hold about 90% of the time.</p></header>
    <ul class="list" id="estimate-scores">${scores.map((s) =>
      row({
        title: html`${s.who}${s.group === "" ? "" : ` · ${s.group}`}`,
        meta: html`${biasWords(s) ?? "nothing resolved yet"} · ${counts(s)}`,
      }),
    )}</ul></section>`;
}
