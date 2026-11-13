/**
 * /flow's "waiting" section (#11455): three quiet places work sits unseen, each
 * with its one action. Approved pulls waiting on the merge queue (`approvedWait`),
 * crew pulls with no push for a week (`staleFold`, which only proposes the note;
 * a person closes) and crew-fork branches that head no pull (`alarmUnproposed`).
 * A section with nothing to say draws nothing. Reads are plain rows into the
 * pure modules; no branch name reaches a shell.
 */

import type { Database } from "bun:sqlite";
import { alarmUnproposed, type UnproposedAlarm } from "../../flow/alarm_unproposed.ts";
import { readWaitingRows, type Waiting } from "../../flow/waiting_rows.ts";
export type { Waiting } from "../../flow/waiting_rows.ts";
import { html, type Html } from "../html.ts";
import { row } from "../ui.ts";
import { span } from "../../flow/pipeline.ts";


export async function readWaiting(db: Database, reposRoot: string, now: Date): Promise<Waiting> {
  return { ...readWaitingRows(db, now), unproposed: await unproposedCached(db, reposRoot, now) };
}

/** How long the branch scan is reused: it reads git for every crew fork, /flow must answer in milliseconds. */
export const UNPROPOSED_TTL_MS = 60_000;
let scanned: { root: string; at: number; value: UnproposedAlarm } | undefined;

/** The unproposed-work scan, at most once a minute per process (a branch is hours old before it counts). */
async function unproposedCached(db: Database, reposRoot: string, now: Date): Promise<UnproposedAlarm> {
  const hit = scanned;
  if (hit !== undefined && hit.root === reposRoot && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < UNPROPOSED_TTL_MS) return hit.value;
  const value = await alarmUnproposed(db, reposRoot, now);
  scanned = { root: reposRoot, at: now.getTime(), value };
  return value;
}

/** Drops the held scan (tests). */
export function forgetUnproposed(): void {
  scanned = undefined;
}

const plural = (n: number, one: string): string => `${String(n)} ${n === 1 ? one : `${one}s`}`;

/** One list of the section: its name, one sentence of what it is, and its rows, each a sentence that wraps. */
const waitingList = (id: string, name: string, says: string, rows: readonly Html[]): Html =>
  html`<section class="bd-block">
    <header class="bd-head"><h2>${name}</h2><p class="bd-sub">${says}</p></header>
    <ul class="list" id="${id}">${[...rows]}</ul>
  </section>`;

/** The section; empty html when all three are quiet. */
export function waitingSection(w: Waiting): Html {
  const parts: Html[] = [];
  if (w.approved.length > 0) {
    parts.push(waitingList("flow-approved", "Approved, waiting on the merge queue", "Reviewed and approved; the queue has not landed them yet.", w.approved.map((a) => row({
        title: html`<span class="valve-name"><a href="/${a.repo}/pulls/${String(a.oldest)}">${a.repo}</a>
          <span class="muted small">${plural(a.waiting, "approved pull")} waiting; the oldest, #${String(a.oldest)}, for ${span(a.oldestHours * 3_600_000)}</span></span>`,
      }))));
  }
  if (w.stale.length > 0) {
    parts.push(waitingList("flow-stale", "Stale crew pulls", "Open with no push for days; a person closes one, and its work can fold back into its issue.", w.stale.map((s) => row({
        title: html`<span class="valve-name"><a href="/${s.repo}/pulls/${String(s.number)}">${s.repo} #${String(s.number)}</a>
          <span class="muted small">${plural(s.days, "day")} without a push; a person closes it</span></span>`,
        meta: s.note === null
          ? html`<span class="valve-body muted small">No issue to fold back into.</span>`
          : html`<span class="valve-body small"><a href="/${s.repo}/issues/${String(s.issueNumber)}">Fold back into #${String(s.issueNumber)}</a>: <code>${s.note}</code></span>`,
      }))));
  }
  if (w.unproposed.fires) {
    parts.push(waitingList("flow-unproposed", "Work a crew fork never proposed", "Branches with commits and no pull: work that was done and never offered.", w.unproposed.branches.map((b) => row({
        title: html`<span class="valve-name"><a class="mono" href="/${b.repo}/tree/${encodeURIComponent(b.branch)}">${b.repo}: ${b.branch}</a>
          <span class="muted small">${span(b.ageMs)} old, no pull</span></span>`,
      }))));
  }
  return parts.length === 0 ? html`` : html`<div class="bd-live" id="flow-waiting">${parts}</div>`;
}
