/**
 * What the crew cost today across the apps a person can write, and how many
 * are paused at their ceiling — the owner's first question about their apps,
 * asked on `/apps` (#599: it was the old home's). One bounded read each
 * (`spentTodayForRepos`, `crewForRepos`), never a query per app; every app
 * passed is one the viewer can write, so the money stays the owner's own.
 */

import { crewForRepos } from "../../core/agents.ts";
import type { Repo } from "../../core/repos.ts";
import { isPausedAtCeiling, spentTodayForRepos } from "../../crew/autonomy.ts";
import type { Database } from "bun:sqlite";
import { html, type Html } from "../html.ts";

export function costLine(db: Database, writable: readonly Repo[]): Html | null {
  if (writable.length === 0) return null;
  const ids = writable.map((r) => r.id);
  const spentToday = spentTodayForRepos(db, ids);
  const crew = crewForRepos(db, ids);
  const spentUsd = writable.reduce((sum, r) => sum + (spentToday.get(r.id) ?? 0), 0);
  const paused = writable.filter((r) => isPausedAtCeiling(r, crew, spentToday)).length;
  const noun = `app${writable.length === 1 ? "" : "s"}`;
  const sentence = `$${spentUsd.toFixed(2)} spent today across ${writable.length} ${noun} you can write`;
  return html`<p class="small muted studio-cost">
    ${sentence} · ${paused} paused at <a href="/map">their ceiling</a>
  </p>`;
}
