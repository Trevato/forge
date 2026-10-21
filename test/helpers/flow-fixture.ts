/**
 * A forge sized like production's for the flow readers (#3693): one app
 * repository with a month of runs (checks, crew, reviews, deploys) and two
 * weeks of merged pulls, the open asks the crew is on and the edges
 * between them, and a month of page views, written straight into the tables so a suite can build it
 * in seconds. Deterministic: the same call writes the same rows.
 */
import type { App } from "../../src/app.ts";
import { createRepo } from "../../src/actions/repos.ts";
import type { User } from "../../src/core/users.ts";

export interface FlowFixture {
  readonly runs: number;
  readonly pulls: number;
  readonly open: number;
  readonly edges: number;
  /** Page views over the month. */
  readonly vitals: number;
}

const DAY = 86_400_000;

export async function seedFlowFixture(
  app: App,
  owner: User,
  size: FlowFixture = {
    runs: 100_000,
    pulls: 1_500,
    open: 400,
    edges: 2_266,
    vitals: 30_000,
  },
  now = Date.now(),
): Promise<FlowFixture> {
  const made = await createRepo(app, owner, { name: "busy", visibility: "public" });
  if (!made.ok) throw new Error(`no repo: ${made.error}`);
  const repo = made.value;
  const db = app.db;
  db.run("UPDATE repo SET autonomy = 'auto', autonomy_slots = 2 WHERE id = ?1", [repo.id]);
  db.run("INSERT INTO app (id, repo_id, slug, access) VALUES ('app-busy', ?1, 'busy', 'public')", [repo.id]);
  let s = 3693;
  const r = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const iso = (ms: number): string => new Date(ms).toISOString();
  db.transaction(() => {
    const issue = db.prepare(
      `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    );
    const pull = db.prepare(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
       VALUES (?1, 'main', ?2, '', '', ?3)`,
    );
    for (let n = 1; n <= size.pulls; n++) {
      const asked = now - r() * 21 * DAY;
      issue.run(`fi${n}`, repo.id, 2 * n - 1, "issue", `Ask ${n}`, "", owner.id, "closed", iso(asked));
      const opened = asked + r() * DAY;
      const merged = Math.min(now - 60_000, opened + r() * 3 * DAY);
      issue.run(`fp${n}`, repo.id, 2 * n, "pull", `Pull ${n}`, `Closes #${2 * n - 1}`, owner.id, "closed", iso(opened));
      pull.run(`fp${n}`, `crew/${n}`, iso(merged));
    }
    // Open asks, each with a finished crew run on a branch of its own.
    for (let n = 1; n <= size.open; n++)
      issue.run(`fo${n}`, repo.id, 2 * size.pulls + n, "issue", `Open ${n}`, "", owner.id, "open", iso(now - r() * 30 * DAY));
    const run = db.prepare(
      `INSERT INTO run (id, repo_id, kind, issue_id, env, branch, state, reason, created_at, started_at, finished_at, serving_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    );
    for (let n = 0; n < size.runs; n++) {
      const at = now - r() * 30 * DAY;
      const pick = r();
      const kind = pick < 0.7 ? "check" : pick < 0.95 ? "agent" : "deploy";
      const pullN = 1 + Math.floor(r() * size.pulls);
      const open = kind === "agent" && size.open > 0 && r() < 0.05 ? 1 + Math.floor(r() * size.open) : 0;
      const env = kind === "deploy" ? (r() < 0.5 ? "production" : "preview") : "";
      run.run(
        `fr${String(n).padStart(7, "0")}`,
        repo.id,
        kind,
        kind === "deploy" ? null : open > 0 ? `fo${open}` : `fp${pullN}`,
        env,
        kind === "deploy" ? "main" : open > 0 ? `crew/open-${open}` : `crew/${pullN}`,
        r() < 0.9 ? "ok" : "failed",
        kind === "agent" && r() < 0.4 ? "review" : "",
        iso(at),
        iso(at + 1_000),
        iso(at + 60_000),
        env === "production" ? iso(at + 90_000) : null,
      );
    }
    // Production's map: 2,266 edges, each ask waiting on an older one.
    const asks = [
      ...Array.from({ length: size.pulls }, (_, n) => `fi${n + 1}`),
      ...Array.from({ length: size.open }, (_, n) => `fo${n + 1}`),
    ];
    const edge = db.prepare("INSERT OR IGNORE INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)");
    for (let n = 0; n < size.edges; n++) {
      const later = 1 + Math.floor(r() * (asks.length - 1));
      edge.run(asks[later]!, asks[Math.floor(r() * later)]!);
    }
    // A month of page views, as the beacon writes them: 1,000 a day.
    const vital = db.prepare(
      "INSERT INTO page_vital (day, at, route, visitor, ttfb, load, lcp, inp, cls) VALUES (?1, ?2, '/', ?3, 20, ?4, ?4, ?5, 0)",
    );
    for (let n = 0; n < size.vitals; n++) {
      const at = now - r() * 30 * DAY;
      vital.run(iso(at).slice(0, 10), at, `v${Math.floor(r() * 400)}`, 100 + r() * 900, r() < 0.5 ? null : 10 + r() * 200);
    }
  })();
  // The seed went through the WAL: fold it back and give its pages up, so
  // the suite holds one copy of the data on disk and not two. The gate runs
  // many suites side by side on one disk (#3693).
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  return { ...size };
}
