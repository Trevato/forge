/**
 * One repository for the milestones page to be pinned on: 20 milestones, each
 * an open umbrella waiting on 49 children, over 1,000 issues, 900 of them
 * closed, and a week of merged pulls. Ids and numbers are fixed; times are
 * hours before `now`, and the page reads the real clock, so a caller seeds
 * with the real `now` and normalises the times it renders.
 */
import type { Database } from "bun:sqlite";

export const MILESTONES = 20;
export const CHILDREN = 49;
export const CLOSED_PER_MILESTONE = 45;
/** Every third closed child landed by a merged pull this week. */
export const MERGE_EVERY = 3;

const pad = (n: number): string => String(n).padStart(4, "0");

export function seedMilestones(
  db: Database,
  repoId: string,
  authorId: string,
  now: Date,
): void {
  const ago = (hours: number): string =>
    new Date(now.getTime() - hours * 3_600_000).toISOString();
  const issue = db.prepare(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at, closed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`,
  );
  const edge = db.prepare(
    `INSERT INTO issue_dependency (issue_id, blocked_by_id, created_at) VALUES (?1, ?2, ?3)`,
  );
  const pull = db.prepare(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
     VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
  );
  const oid = "0".repeat(40);
  let number = 0;
  let merges = 0;
  const tx = db.transaction(() => {
    const children: { id: string; number: number }[] = [];
    for (let m = 0; m < MILESTONES; m++) {
      const umbrella = { id: `ms-${pad(m)}`, number: ++number };
      issue.run(umbrella.id, repoId, umbrella.number, "issue", `Milestone ${pad(m)}`, "", authorId, "open", ago(500), null);
      for (let c = 0; c < CHILDREN; c++) {
        const child = { id: `ch-${pad(m)}-${pad(c)}`, number: ++number };
        const closed = c < CLOSED_PER_MILESTONE;
        issue.run(
          child.id, repoId, child.number, "issue", `Step ${pad(m)}.${pad(c)}`, "", authorId,
          closed ? "closed" : "open", ago(400), closed ? ago(24 + ((m * 7 + c) % 100)) : null,
        );
        edge.run(umbrella.id, child.id, ago(400));
        children.push(child);
        if (closed && c % MERGE_EVERY === 0) {
          // Within the 7-day window, spread over the week.
          const at = ago(1 + ((m * 13 + c * 5) % 160));
          const p = { id: `pl-${pad(merges)}`, number: 0 };
          merges++;
          p.number = ++number;
          issue.run(p.id, repoId, p.number, "pull", `Land step ${pad(m)}.${pad(c)}`, `Closes #${child.number}`, authorId, "closed", at, at);
          pull.run(p.id, `feature/step-${pad(m)}-${pad(c)}`, oid, at);
        }
      }
    }
    db.run(`UPDATE repo SET issue_seq = ?1 WHERE id = ?2`, [number, repoId]);
  });
  tx();
}
