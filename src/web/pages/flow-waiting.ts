/**
 * /flow's "waiting" section (#11455): three quiet places work sits unseen, each
 * with its one action. Approved pulls waiting on the merge queue (`approvedWait`),
 * crew pulls with no push for a week (`staleFold`, which only proposes the note;
 * a person closes) and crew-fork branches that head no pull (`alarmUnproposed`).
 * A section with nothing to say draws nothing. Reads are plain rows into the
 * pure modules; no branch name reaches a shell.
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "../../core/pulls.ts";
import { alarmUnproposed, type UnproposedAlarm } from "../../flow/alarm_unproposed.ts";
import { approvedWait, type ApprovedRow, type ApprovedWait } from "../../flow/approved_wait.ts";
import { staleFold, type StaleFold } from "../../flow/stale_fold.ts";
import { html, type Html } from "../html.ts";
import { row } from "../ui.ts";
import { span } from "../../flow/pipeline.ts";

export interface Waiting {
  readonly approved: readonly ApprovedWait[];
  readonly stale: readonly (StaleFold & { readonly repo: string })[];
  readonly unproposed: UnproposedAlarm;
}

/** Open, unlanded pulls whose latest verdict is an approval, with when it came. */
export function approvedRows(db: Database): ApprovedRow[] {
  return db
    .query<{ repo: string; number: number; at: string }, []>(
      `SELECT ro.username || '/' || r.name AS repo, i.number AS number, a.at AS at
         FROM pull p
         JOIN issue i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id
         JOIN user ro ON ro.id = r.owner_id
         JOIN (SELECT issue_id, MAX(created_at) AS at FROM review WHERE state = 'approved' GROUP BY issue_id) a ON a.issue_id = i.id
        WHERE i.state = 'open' AND p.merged_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM review c WHERE c.issue_id = i.id AND c.state = 'changes_requested' AND c.created_at > a.at)`,
    )
    .all()
    .map((x) => ({ repo: x.repo, number: x.number, approvedAt: x.at }));
}

/** Open crew pulls with the time of their newest push (their opening when none), and whether they are approved. */
function crewPulls(db: Database): { repo: string; pull: Parameters<typeof staleFold>[0][number] }[] {
  return db
    .query<{ repo: string; number: number; branch: string; body: string; moved: string; approved: number }, []>(
      `SELECT ro.username || '/' || r.name AS repo, i.number AS number, p.head_branch AS branch, i.body AS body,
              COALESCE((SELECT MAX(e.created_at) FROM event e
                         WHERE e.repo_id = i.repo_id AND e.kind = 'pull.pushed'
                           AND json_extract(e.payload, '$.number') = i.number + 0), i.created_at) AS moved,
              EXISTS (SELECT 1 FROM review a WHERE a.issue_id = i.id AND a.state = 'approved'
                        AND NOT EXISTS (SELECT 1 FROM review c WHERE c.issue_id = i.id AND c.state = 'changes_requested' AND c.created_at > a.created_at)) AS approved
         FROM pull p
         JOIN issue i ON i.id = p.issue_id AND i.state = 'open' AND i.kind = 'pull'
         JOIN repo r ON r.id = i.repo_id
         JOIN user ro ON ro.id = r.owner_id
         JOIN user u ON u.id = i.author_id AND u.is_agent = 1
        WHERE p.merged_at IS NULL`,
    )
    .all()
    .map((x) => ({
      repo: x.repo,
      pull: { number: x.number, issueNumber: closesFromBody(x.body)[0] ?? null, branch: x.branch, lastPushAt: x.moved, approved: x.approved === 1 },
    }));
}

export async function readWaiting(db: Database, reposRoot: string, now: Date): Promise<Waiting> {
  const pulls = crewPulls(db);
  return {
    approved: approvedWait(approvedRows(db), now),
    stale: staleFold(pulls.map((p) => ({ ...p.pull, repo: p.repo })), now),
    unproposed: await unproposedCached(db, reposRoot, now),
  };
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
