/**
 * Which tell a change answers. The crew names every branch for it —
 * `scout/13-after-new-app-land-on-a-page` answers tell #13 — so the number
 * is read back out of the head branch. A convention, not a contract: any
 * branch that does not follow it, or names a number this repository has no
 * tell for, answers no tell, and nothing here throws.
 */

import type { Database } from "bun:sqlite";
import type { Pull } from "../../core/pulls.ts";
import { html, type Html } from "../html.ts";
import { tellHref } from "./nouns.ts";

export interface AnsweredTell {
  readonly number: number;
  readonly closed: boolean;
}

/** `<crew>/<number>-<slug>` → the number; anything else → undefined. Only
 * the first digits after the first slash count, so digits in the slug never
 * matter, and a number with a leading zero or past safe range is no tell. */
export function tellNumberOf(branch: string): number | undefined {
  const m = /^[^/\s]+\/([1-9][0-9]{0,8})-[^\s]*$/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

/** The tell each pull answers, keyed by pull number, in one grouped read for
 * the whole page. A pull from another repository's branch, or whose number
 * matches no tell here (a pull is not a tell), is left out. */
export function tellsAnswered(
  db: Database,
  repoId: string,
  pulls: readonly Pull[],
): Map<number, AnsweredTell> {
  const wanted = new Map<number, number>();
  for (const pull of pulls) {
    if (pull.crossRepo || pull.originHeadRepo !== null) continue;
    const n = tellNumberOf(pull.headBranch);
    if (n !== undefined) wanted.set(pull.number, n);
  }
  const out = new Map<number, AnsweredTell>();
  if (wanted.size === 0) return out;
  const numbers = [...new Set(wanted.values())];
  const state = new Map<number, boolean>();
  const CHUNK = 400;
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const batch = numbers.slice(i, i + CHUNK);
    const rows = db
      .query<{ number: number; state: string }, (string | number)[]>(
        `SELECT number, state FROM issue
         WHERE repo_id = ?1 AND kind = 'issue'
           AND number IN (${batch.map((_, k) => `?${k + 2}`).join(",")})`,
      )
      .all(repoId, ...batch);
    for (const r of rows) state.set(r.number, r.state === "closed");
  }
  for (const [pullNumber, n] of wanted) {
    const closed = state.get(n);
    if (closed !== undefined) out.set(pullNumber, { number: n, closed });
  }
  return out;
}

/** The line a change carries for its tell: a link in the studio's own noun,
 * and — when that tell is closed — what a person can act on. Never a verdict:
 * the change's word is judged elsewhere and is not touched by this. */
export function tellLine(base: string, t: AnsweredTell): Html {
  const link = html`<a href="${tellHref(base, t.number)}">tell #${t.number}</a>`;
  return t.closed
    ? html`for ${link} — its tell is already done`
    : html`for ${link}`;
}
