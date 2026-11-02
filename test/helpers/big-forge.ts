/**
 * A forge the size of production, written straight into the tables (#8848): one autonomous
 * repository with a crew, thousands of issues and pulls, a few hundred of them open with a
 * "changes requested" verdict, and the runs, comments, reviews and events that grow beside them.
 * No git: the passes that read the database are what is measured.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";

export interface BigForgeSize {
  readonly issues: number;
  readonly pulls: number;
  /** Of `pulls`, how many are open with changes requested. */
  readonly requested: number;
  readonly runs: number;
  readonly comments: number;
  readonly events: number;
  /** Line comments by the reviewer in the last five days, each a few findings of its own wording. */
  readonly reviewComments: number;
}

/** Roughly the forge's own database in November 2026. */
export const PRODUCTION: BigForgeSize = {
  issues: 9000,
  pulls: 9000,
  requested: 300,
  runs: 60000,
  comments: 120000,
  events: 400000,
  reviewComments: 6000,
};

export function bigForge(size: BigForgeSize = PRODUCTION): { app: App; dir: string; repoId: string } {
  const dir = mkdtempSync(join(tmpdir(), "forge-big-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const db = app.db;
  const at = (i: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString();
  db.transaction(() => {
    db.run("INSERT INTO user (id, username, email, password_hash, is_admin) VALUES ('own', 'owner', 'o@x.test', '', 1)");
    for (const a of ["builder", "reviewer"])
      db.run("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES (?1, ?1, ?1 || '@x.test', '', 1)", [a]);
    db.run(
      "INSERT INTO repo (id, owner_id, name, visibility, autonomy, autonomy_by) VALUES ('r', 'own', 'forge', 'public', 'on', 'own')",
    );
    db.run("INSERT INTO repo_crew (repo_id, user_id, role) VALUES ('r', 'builder', 'builder'), ('r', 'reviewer', 'reviewer')");
    const total = size.issues + size.pulls;
    for (let n = 1; n <= total; n++) {
      const pull = n > size.issues;
      const k = pull ? n - size.issues : 0;
      // The newest `requested` pulls are open; every other pull and issue is closed.
      const open = pull && k > size.pulls - size.requested;
      db.run(
        "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, assignee_id, state, created_at) VALUES (?1, 'r', ?2, ?3, 't', 'b', ?4, ?5, ?6, ?7)",
        [`i${n}`, n, pull ? "pull" : "issue", pull ? "builder" : "own", pull ? "builder" : null, open ? "open" : "closed", at(n)],
      );
      if (pull) {
        db.run(
          "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', ?3)",
          [`i${n}`, `b${n}`, open ? null : at(n + 5)],
        );
        db.run(
          "INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, 'reviewer', ?3, 'h', ?4)",
          [`v${n}`, `i${n}`, open ? "changes_requested" : "approved", at(n + 1)],
        );
      }
    }
    db.run("UPDATE repo SET issue_seq = ?1 WHERE id = 'r'", [total]);
    for (let n = 1; n <= size.runs; n++) {
      const issue = 1 + (n % total);
      db.run(
        "INSERT INTO run (id, repo_id, issue_id, kind, state, reason, summary, created_at, started_at, finished_at, actor_id) VALUES (?1, 'r', ?2, ?3, 'ok', ?4, 'done', ?5, ?5, ?5, 'builder')",
        [`u${n}`, `i${issue}`, n % 3 === 0 ? "check" : "agent", n % 5 === 0 ? "review" : "assigned", at(n)],
      );
    }
    for (let n = 1; n <= size.comments; n++)
      db.run("INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, 'own', 'c', ?3)", [
        `c${n}`,
        `i${1 + (n % total)}`,
        at(n),
      ]);
    // Distinct wording, as a week of different pulls has: almost no two findings are one ask.
    const word = (k: number) => `term${k.toString(36).replace(/[0-9]/g, (d) => "qrstuvwxyz"[+d]!)}`;
    let seed = 12345;
    const rnd = (m: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % m;
    const week = Date.now() - 5 * 86_400_000;
    for (let n = 1; n <= size.reviewComments; n++) {
      const body = Array.from({ length: 4 }, () => `- ${Array.from({ length: 12 }, () => word(rnd(5000))).join(" ")}`).join("\n");
      db.run("INSERT INTO comment (id, issue_id, author_id, kind, body, created_at) VALUES (?1, ?2, 'reviewer', 'review', ?3, ?4)", [
        `rc${n}`,
        `i${size.issues + 1 + (n % size.pulls)}`,
        body,
        new Date(week + n * 20_000).toISOString(),
      ]);
    }
    for (let n = 1; n <= size.events; n++)
      db.run("INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at) VALUES (?1, ?2, 'r', 'own', ?3, ?4)", [
        `e${n}`,
        n % 2 === 0 ? "pull.pushed" : "issue.commented",
        JSON.stringify({ number: 1 + (n % total) }),
        at(n),
      ]);
  })();
  return { app, dir, repoId: "r" };
}
