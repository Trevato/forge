/**
 * The one-time pass over what the Later gate holds (#8700): the candidates
 * (`core/gate_triage.ts`) read for a repository, and applied on one approval.
 * Applying closes what the person ticked and merges what they ticked as a
 * duplicate (the duplicate's words are appended to the survivor, never
 * replacing them, and its note points at the survivor); what they left
 * unticked stays behind the gate, as does a proposed keep. A closed issue keeps a "Gate review:" note and the
 * `issue.gate_reviewed` event only this path writes, which is how it is found
 * again and revived (`liftHold`). The approval carries a digest of the
 * candidates the person read; if the gate holds other issues now, the apply
 * refuses. A person approves — an agent may read the proposal and never
 * apply it.
 */

import { createHash } from "node:crypto";
import type { App } from "../app.ts";
import { alreadyDone } from "../core/done_on_main.ts";
import { heldIssues, REVIEW_NOTE } from "../core/gate_hold.ts";
import { startsTicked, triage, type Anchor, type Theme, type Triaged } from "../core/gate_triage.ts";
import { getIssue, getIssuesByIds } from "../core/issues.ts";
import { pillarsOf, servedBy } from "../core/pillars.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { addComment, editIssue, setIssueState } from "./issues.ts";

export interface GateReview {
  readonly themes: readonly Theme[];
  /** Every held issue with what is proposed for it: close, keep or merge. */
  readonly changes: readonly Triaged[];
  /** The numbers that start ticked: what the crew found done on main. */
  readonly ticked: readonly number[];
  /** Names the candidates shown; the apply must carry it back. */
  readonly digest: string;
  readonly held: number;
}

/** A short name for the candidates and what is proposed for each, whatever their order. */
export function reviewDigest(changes: readonly Triaged[]): string {
  const sorted = changes
    .map((c) => `${c.number}:${c.verdict.kind}:${c.verdict.kind === "merge" ? c.verdict.into : ""}`)
    .sort()
    .join(",");
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

/** A bet is open work titled `Bet:` outside the gate (#8713). */
const BET = /^bet\b/i;

/**
 * The open work held issues can join, and which held issues already serve a
 * pillar: two reads, bodies included for the anchors only.
 */
function anchorsFor(app: App, repo: Repo, heldIds: ReadonlySet<string>) {
  const set = pillarsOf(app.db, repo);
  const serves = servedBy(app.db, set);
  const ids = [...serves.entries()]
    .filter(([id, name]) => name !== "Later" && !heldIds.has(id))
    .map(([id]) => id);
  const found = getIssuesByIds(app.db, ids);
  const anchors: Anchor[] = [];
  for (const [id, name] of serves) {
    const issue = found.get(id);
    if (issue === undefined || issue.state !== "open" || issue.kind !== "issue") continue;
    anchors.push({ number: issue.number, label: name, title: issue.title, body: issue.body });
  }
  for (const p of set.pillars) anchors.push({ number: p.umbrella.number, label: p.name, title: p.umbrella.title, body: p.umbrella.body });
  const bets = app.db
    .query<{ id: string }, [string]>(
      `SELECT id FROM issue WHERE repo_id = ?1 AND kind = 'issue' AND state = 'open' AND sealed = 0 AND title LIKE 'bet%' LIMIT 64`,
    )
    .all(repo.id)
    .filter((r) => !heldIds.has(r.id));
  for (const issue of getIssuesByIds(app.db, bets.map((r) => r.id)).values())
    if (BET.test(issue.title)) anchors.push({ number: issue.number, label: "Bet", title: issue.title, body: issue.body });
  return { anchors, serves };
}

/** How many open issues wait for each of these, in one read. */
function waitingOn(app: App, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = app.db
    .query<{ blocked_by_id: string; n: number }, string[]>(
      `SELECT d.blocked_by_id, COUNT(*) AS n FROM issue_dependency d
         JOIN issue ON issue.id = d.issue_id
        WHERE issue.state = 'open' AND d.blocked_by_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
        GROUP BY d.blocked_by_id`,
    )
    .all(...ids);
  for (const r of rows) out.set(r.blocked_by_id, r.n);
  return out;
}

/** What the gate holds, triaged by title and body: one pass, no model. */
export function reviewGate(app: App, repo: Repo): GateReview | undefined {
  const set = pillarsOf(app.db, repo);
  if (set.gate === undefined) return undefined;
  const held = heldIssues(app.db, repo, set);
  const ids = held.map((i) => i.id);
  const done = alreadyDone(app.db, ids);
  const waiting = waitingOn(app, ids);
  const { anchors, serves } = anchorsFor(app, repo, new Set(ids));
  const themes = triage(
    held.map((i) => ({ number: i.number, title: i.title, body: i.body, waiting: waiting.get(i.id) ?? 0 })),
    new Set(held.filter((i) => done.has(i.id)).map((i) => i.number)),
    anchors,
    new Map(held.flatMap((i) => (serves.get(i.id) !== undefined && serves.get(i.id) !== "Later" ? [[i.number, serves.get(i.id)!] as const] : []))),
  );
  const changes = themes.flatMap((t) => t.items);
  return {
    themes,
    changes,
    ticked: changes.filter(startsTicked).map((c) => c.number),
    digest: reviewDigest(changes),
    held: held.length,
  };
}

export type ApplyError = "not_found" | "forbidden" | "stale";

/**
 * Apply the approval the person gave: `approved` are the issue numbers they
 * ticked and `digest` names the candidates they read. If the gate holds other
 * issues now, or an approved one is not a candidate, the whole is refused, so
 * a person never approves what they did not read. Returns how many were closed or merged.
 */
export function applyGateReview(
  app: App,
  actor: User,
  repo: Repo,
  approved: readonly number[],
  digest: string | undefined,
): Result<number, ApplyError> {
  if (actor.kind === "agent" || !canWrite(app.db, repo, actor)) return err("forbidden");
  const review = reviewGate(app, repo);
  if (review === undefined) return err("not_found");
  if (digest !== review.digest) return err("stale");
  const proposed = new Map(review.changes.map((c) => [c.number, c.verdict]));
  if (!approved.every((n) => proposed.has(n))) return err("stale");
  let closed = 0;
  const chosen = new Set(approved);
  // Merges first, so a survivor takes its words before anything closes it.
  const order = [...new Set(approved)].sort((a, b) => Number(proposed.get(b)!.kind === "merge") - Number(proposed.get(a)!.kind === "merge"));
  for (const number of order) {
    const issue = getIssue(app.db, repo.id, number);
    const verdict = proposed.get(number)!;
    if (issue === undefined || issue.state !== "open" || verdict.kind === "keep") continue;
    if (verdict.kind === "merge") {
      const survivor = getIssue(app.db, repo.id, verdict.into);
      if (survivor === undefined || survivor.state !== "open") continue;
      // A survivor closed in this same apply would take the words with it: the duplicate waits.
      if (chosen.has(survivor.number) && proposed.get(survivor.number)!.kind !== "keep") continue;
      // Append, never replace; if the words do not fit, nothing is closed.
      const merged = `${survivor.body}\n\n---\nMerged from #${issue.number}: ${issue.title}\n\n${issue.body}`;
      if (!editIssue(app, actor, repo, survivor, { body: merged }).ok) continue;
      if (!setIssueState(app, actor, repo, issue, "closed", { reason: "dropped", system: true }).ok) continue;
      app.bus.append({
        kind: "issue.gate_reviewed",
        repoId: repo.id,
        actorId: actor.id,
        payload: { number: issue.number },
      });
      addComment(app, actor, repo, issue, `${REVIEW_NOTE}merged into #${survivor.number}: its words are appended there. Revive it from the held page to bring it back.`);
      closed++;
      continue;
    }
    if (!setIssueState(app, actor, repo, issue, "closed", { reason: verdict.reason, system: true }).ok) continue;
    // The marker follows the close, never the other way: a failed close leaves none.
    app.bus.append({
      kind: "issue.gate_reviewed",
      repoId: repo.id,
      actorId: actor.id,
      payload: { number: issue.number },
    });
    addComment(app, actor, repo, issue, `${REVIEW_NOTE}closed: ${verdict.why}. Revive it from the held page to bring it back.`);
    closed++;
  }
  return ok(closed);
}
