/**
 * The merge queue's last gates (#7508), for the flow panel: the newest ten
 * across the repositories the reader may see, one row each with when, the
 * pulls, the verdict, and on red the first failing test and its first error
 * line. Reads `recentGates` once per repository; a sealed pull is never
 * named by title, only as `a sealed pull`.
 */

import type { Database } from "bun:sqlite";
import { recentGates, type KeptResult } from "../../checks/gate_result.ts";
import { span } from "../../flow/pipeline.ts";
import { html, type Html } from "../html.ts";
import { badge, row } from "../ui.ts";

/** The most gates the card lists. */
export const GATES_LISTED = 10;

interface Listed {
  readonly repo: string;
  readonly gate: KeptResult;
  readonly sealed: ReadonlySet<number>;
}

/** Repositories with a kept gate that the reader may see: all for the owner, public ones otherwise. */
function repos(db: Database, owner: boolean): { id: string; name: string }[] {
  return db
    .query<{ id: string; name: string }, []>(
      `SELECT r.id, u.username || '/' || r.name AS name FROM repo r JOIN user u ON u.id = r.owner_id
       WHERE r.id IN (SELECT repo_id FROM gate_result)${owner ? "" : " AND r.visibility = 'public'"}
       ORDER BY name`,
    )
    .all();
}

function sealedPulls(db: Database, repoId: string, numbers: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const n of numbers) {
    const row = db.query<{ s: number }, [string, number]>("SELECT sealed AS s FROM issue WHERE repo_id = ?1 AND number = ?2").get(repoId, n);
    if (row?.s) out.add(n);
  }
  return out;
}

const verdictWord = (g: KeptResult): string => (g.state === "cut_off" ? "cut off" : g.state);

/** What the verdict adds: a red gate's first failing test and error line, a cut-off gate's reason; nothing when a pull in it is sealed. */
function detail(l: Listed): string | null {
  if (l.sealed.size > 0) return null;
  const { gate } = l;
  if (gate.state === "red") {
    const first = gate.failing[0];
    if (first === undefined) return gate.reason;
    return first.errors[0] === undefined ? first.name : `${first.name} — ${first.errors[0]}`;
  }
  return gate.state === "cut_off" ? gate.reason : null;
}

function gateRow(l: Listed, now: number): Html {
  const { gate, repo } = l;
  const more = detail(l);
  const tone = gate.state === "green" ? "success" : gate.state === "red" ? "danger" : "default";
  return row({
    data: { gate: gate.state },
    title: html`${gate.pulls.map((n) =>
        l.sealed.has(n) ? html`<span class="muted">a sealed pull</span> ` : html`<a href="/${repo}/pulls/${String(n)}">#${String(n)}</a> `,
      )}${badge(verdictWord(gate), { tone })}`,
    meta: html`${span(Math.max(0, now - Date.parse(gate.finishedAt)))} ago · ${repo}${more === null ? null : html` · <span data-detail title="${more}">${more}</span>`}`,
  });
}

/** The "Last gates" section: a heading and rows, no card. */
export function gatesSection(db: Database, owner: boolean, now: number): Html {
  const all: Listed[] = [];
  for (const r of repos(db, owner)) {
    for (const gate of recentGates(db, r.id, GATES_LISTED)) {
      all.push({ repo: r.name, gate, sealed: sealedPulls(db, r.id, gate.pulls) });
    }
  }
  all.sort((a, b) => (a.gate.finishedAt < b.gate.finishedAt ? 1 : a.gate.finishedAt > b.gate.finishedAt ? -1 : 0));
  const top = all.slice(0, GATES_LISTED);
  return html`<section class="settings-block" id="gates"><h2>Last gates</h2>${
    top.length === 0
      ? html`<p class="muted">No gate has run yet.</p>`
      : html`<ul class="list">${top.map((l) => gateRow(l, now))}</ul>`
  }</section>`;
}
