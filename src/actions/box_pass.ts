/**
 * The reviewer's pass over the boxes of the issues a pull closes (#8682).
 * Builders do not tick boxes, so finished work piled up unticked; the
 * reviewer that approves a pull reads its head against each box and says
 * which it meets (`ticks`) and which it leaves with why (`left`). The forge
 * ticks the first, notes the second on the issue, and closes an issue whose
 * pull already landed once its last box is ticked.
 *
 * Only a crew reviewer's approval is a pass; a box number counts the
 * unticked boxes of the issue as `unticked` lists them, from 1, and a number
 * that names no box is ignored.
 */

import type { App } from "../app.ts";
import { PASS_LEAD, tickBoxes, unticked } from "../core/done_on_main.ts";
import { addComment, getIssue, setIssueState as setIssueStateCore, updateIssueText } from "../core/issues.ts";
import { noteShipped } from "../crew/note_closed.ts";
import { isStructural, pillarsOf } from "../core/pillars.ts";
import { closesFromBody, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";

/** Boxes of one issue the pass ticks. */
export interface BoxTick {
  readonly issue: number;
  readonly box: number;
  /** The box as the reviewer read it: a tick whose box reads otherwise now is ignored. */
  readonly text: string;
}

/** A box of one issue the pass leaves, and why. */
export interface BoxLeft extends BoxTick {
  readonly why: string;
}

export interface BoxPass {
  readonly ticks?: readonly BoxTick[] | undefined;
  readonly left?: readonly BoxLeft[] | undefined;
}

/** The most boxes and the longest reason one review carries. */
export const MAX_PASS = 50;
const MAX_WHY = 300;
const MAX_TEXT = 300;

/** Whether the box now at `n` is the one the reviewer read, by its first MAX_TEXT characters. */
const same = (now: string | undefined, read: string): boolean =>
  now !== undefined && now.slice(0, MAX_TEXT) === read.trim().slice(0, MAX_TEXT);

/** A list from a request body as a pass, or undefined when it is not one. */
export function passOf(ticks: unknown, left: unknown): BoxPass | undefined {
  const asList = (v: unknown): unknown[] | undefined =>
    v === undefined ? [] : Array.isArray(v) && v.length <= MAX_PASS ? v : undefined;
  const t = asList(ticks);
  const l = asList(left);
  if (t === undefined || l === undefined) return undefined;
  const whole = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined;
  const out: { ticks: BoxTick[]; left: BoxLeft[] } = { ticks: [], left: [] };
  for (const item of t) {
    const r = item as { issue?: unknown; box?: unknown; text?: unknown } | null;
    const issue = whole(r?.issue);
    const box = whole(r?.box);
    if (issue === undefined || box === undefined || typeof r?.text !== "string") return undefined;
    out.ticks.push({ issue, box, text: r.text.trim().slice(0, MAX_TEXT) });
  }
  for (const item of l) {
    const r = item as { issue?: unknown; box?: unknown; text?: unknown; why?: unknown } | null;
    const issue = whole(r?.issue);
    const box = whole(r?.box);
    if (issue === undefined || box === undefined || typeof r?.text !== "string" || typeof r?.why !== "string")
      return undefined;
    out.left.push({ issue, box, text: r.text.trim().slice(0, MAX_TEXT), why: r.why.trim().slice(0, MAX_WHY) });
  }
  return out;
}

/** Hold the pass a crew reviewer read at `headOid`, for the landing; a later approval replaces it. */
export function holdPass(app: App, pull: Pull, reviewer: User, headOid: string, pass: BoxPass): void {
  app.db
    .query(
      `INSERT INTO pull_pass (pull_id, reviewer_id, head_oid, pass) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(pull_id) DO UPDATE SET reviewer_id = ?2, head_oid = ?3, pass = ?4`,
    )
    .run(pull.id, reviewer.id, headOid, JSON.stringify(pass));
}

/**
 * The pass held for `pull`, applied at its landing when its head is still
 * the one the reviewer read; dropped either way, so it is never applied twice.
 */
export function landHeldPass(app: App, repo: Repo, pull: Pull): void {
  const row = app.db
    .query<{ reviewer_id: string; head_oid: string; pass: string }, [string]>(
      "SELECT reviewer_id, head_oid, pass FROM pull_pass WHERE pull_id = ?1",
    )
    .get(pull.id);
  if (row === null) return;
  app.db.query("DELETE FROM pull_pass WHERE pull_id = ?1").run(pull.id);
  if (row.head_oid !== pull.headOid) return;
  const reviewer = getUserById(app.db, row.reviewer_id);
  if (reviewer !== undefined) applyBoxPass(app, repo, pull, reviewer, JSON.parse(row.pass) as BoxPass);
}

/** Apply an approving reviewer's pass to the issues `pull` closes. */
export function applyBoxPass(app: App, repo: Repo, pull: Pull, reviewer: User, pass: BoxPass): void {
  const plan = pillarsOf(app.db, repo);
  const named = new Set([...(pass.ticks ?? []), ...(pass.left ?? [])].map((r) => r.issue));
  for (const n of closesFromBody(pull.body)) {
    if (!named.has(n)) continue;
    const issue = getIssue(app.db, repo.id, n);
    if (issue === undefined || issue.kind !== "issue" || issue.state !== "open") continue;
    if (isStructural(plan, issue.id)) continue;
    const before = unticked(issue.body);
    const { body, ticked } = tickBoxes(
      issue.body,
      (pass.ticks ?? []).filter((t) => t.issue === n && same(before[t.box - 1], t.text)).map((t) => t.box),
    );
    if (ticked.length > 0 && updateIssueText(app.db, issue.id, { body }).ok)
      app.bus.append({
        kind: "issue.edited",
        repoId: repo.id,
        actorId: reviewer.id,
        payload: { number: n, changed: ["body"] },
      });
    const left = (pass.left ?? [])
      .filter((l) => l.issue === n && same(before[l.box - 1], l.text))
      .flatMap((l) => (before[l.box - 1] === undefined ? [] : [`${before[l.box - 1]} — ${l.why || "no reason given"}`]));
    const words = [
      ticked.length > 0 ? `ticked ${ticked.join("; ")}` : "",
      left.length > 0 ? `left open: ${left.join("; ")}` : "",
    ].filter((w) => w !== "");
    if (words.length > 0) {
      const text = `${PASS_LEAD}${pull.number} at its head: ${words.join(". ")}.`;
      const noted = addComment(app.db, { issueId: issue.id, authorId: reviewer.id, body: text });
      if (noted.ok)
        app.bus.append({
          kind: "issue.commented",
          repoId: repo.id,
          actorId: reviewer.id,
          payload: { number: n, body: text, commentId: noted.value.id },
        });
    }
    // A pull that landed before its boxes were read closes the issue now, as the landing would have.
    if (pull.mergedAt !== null && unticked(body).length === 0 && setIssueStateCore(app.db, issue.id, "closed")) {
      app.bus.append({
        kind: "issue.closed",
        repoId: repo.id,
        actorId: reviewer.id,
        payload: { number: n, by: "merge", pull: pull.number },
      });
      noteShipped(app, reviewer.id, repo, issue, pull);
    }
  }
}
