/**
 * Rule breakers (#7560): when a pull's own check is red on a rule test, the
 * pull gets one comment with the rule, the file and line, and the fix, from
 * `table.ts`. A comment whose text a pull already carries is not repeated, so
 * pushing again with the same breach says nothing new. A red that breaks no
 * rule in the table gets no comment: never a vague "tests failed".
 */

import type { Database } from "bun:sqlite";
import { addComment } from "../core/issues.ts";
import { watcherId } from "./bot.ts";
import { breachOf, type Breach } from "./table.ts";

/** How far back a failed check is read. */
export const LOOKBACK_MS = 24 * 3_600_000;

const MARK = "_Posted by the rule watcher, not written by a person._";

export function breakerComment(breaches: readonly Breach[]): string {
  const lines = breaches.map(
    (b) => `- **${b.rule}** at \`${b.file}${b.line === undefined ? "" : `:${b.line}`}\`\n  Fix: ${b.fix}.`,
  );
  return `${MARK}\n\nThis pull's check is red on ${breaches.length === 1 ? "a repo rule" : "repo rules"}:\n\n${lines.join("\n")}`;
}

interface Failed {
  readonly pull: string;
  readonly repo: string;
  readonly names: readonly string[];
}

/** The read the breaker rests on (`?1` = the earliest a failed check may be): each open pull's latest check, when failed. */
export const FAILED_CHECKS_SQL = `SELECT c.issue_id, c.repo_id, c.check_detail, c.id
         FROM run c
         JOIN issue i ON i.id = c.issue_id AND i.kind = 'pull' AND i.state = 'open'
        WHERE c.kind = 'check' AND c.state = 'failed' AND c.created_at >= ?1 AND c.check_detail <> ''
          AND c.id = (SELECT l.id FROM run l WHERE l.issue_id = c.issue_id AND l.kind = 'check' ORDER BY l.created_at DESC, l.id DESC LIMIT 1)
        ORDER BY c.id`;

function failedChecks(db: Database, since: string): Failed[] {
  const rows = db.query<{ issue_id: string; repo_id: string; check_detail: string; id: string }, [string]>(FAILED_CHECKS_SQL).all(since);
  const out: Failed[] = [];
  for (const r of rows) {
    try {
      const names = (JSON.parse(r.check_detail) as { names?: unknown }).names;
      if (Array.isArray(names)) out.push({ pull: r.issue_id, repo: r.repo_id, names: names.filter((n): n is string => typeof n === "string") });
    } catch {
      // A detail this build cannot read says nothing.
    }
  }
  return out;
}

/** Comment on each open pull whose failed check broke a rule; returns the pull ids commented, once per distinct text. */
export function commentBreakers(db: Database, now: Date): string[] {
  const posted: string[] = [];
  const bot = watcherId(db);
  for (const f of failedChecks(db, new Date(now.getTime() - LOOKBACK_MS).toISOString())) {
    const found = f.names.flatMap((n) => breachOf(n) ?? []);
    if (found.length === 0) continue;
    const body = breakerComment(found);
    const same = db
      .query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND body = ?2")
      .get(f.pull, body)!.n;
    if (same > 0) continue;
    if (addComment(db, { issueId: f.pull, authorId: bot, body }).ok) posted.push(f.pull);
  }
  return posted;
}
