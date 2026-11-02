/** `askToLiveFor` reads the window's merged pulls in a fixed number of queries, answers as the per-pull read did, and keeps sealed issues from a viewer who cannot see them (#6186). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { askToLiveOf, pillarWindowStart, type PillarView } from "../src/core/pillars.ts";
import { closesFromBody } from "../src/core/pulls.ts";
import { sealedScope } from "../src/core/sealed.ts";
import type { Repo } from "../src/core/repos.ts";
import { askToLiveFor } from "../src/web/ask_to_live.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";

let root = "";
let app: App;
let repo: Repo;
let view: PillarView;
const PILLARS = 8;
const PULLS = 400;
const T = Date.now();
const at = (hoursAgo: number) => new Date(T - hoursAgo * 3_600_000).toISOString();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-ask-to-live-"));
  app = createApp({ dataDir: root, port: 0 });
  const db = app.db;
  db.query(
    "INSERT INTO user (id, username, email, password_hash) VALUES ('u1','alice','a@x.local','x')",
  ).run();
  db.query("INSERT INTO repo (id, owner_id, name) VALUES ('r1','u1','engine')").run();
  repo = db.query("SELECT * FROM repo WHERE id = 'r1'").get() as never;
  const issue = db.query(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, sealed)
     VALUES (?1, 'r1', ?2, ?3, ?4, ?5, 'u1', 'closed', ?6, ?7)`,
  );
  const pull = db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid)
     VALUES (?1, 'main', ?2, 'a', 'b', ?3, ?4)`,
  );
  const run = db.query(
    `INSERT INTO run (id, repo_id, kind, env, state, serving_at, finished_at)
     VALUES (?1, 'r1', ?2, ?3, 'ok', ?4, ?4)`,
  );
  const carry = db.query(
    "INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1, ?2, 0, 'o')",
  );
  const pillars = Array.from({ length: PILLARS }, (_, p) => ({
    short: `P${p}`,
    name: `P${p} Pillar`,
    umbrella: undefined as never,
  }));
  const of = new Map<string, string>();
  db.transaction(() => {
    for (let i = 0; i < PULLS; i++) {
      const ask = `ask${i}`;
      // Every 25th ask is sealed; the rest are public.
      issue.run(ask, i + 1, "issue", `ask ${i}`, "", at(160 - (i % 7)), i % 25 === 0 ? 1 : 0);
      of.set(ask, pillars[i % PILLARS]!.name);
      issue.run(`pr${i}`, PULLS + i + 1, "pull", `Land ${i}`, `Closes #${i + 1}`, at(150), 0);
      pull.run(`pr${i}`, `b${i}`, at(100 - (i % 50)), `oid${i}`);
      // Most are live a few hours after the merge; every 10th never is.
      if (i % 10 !== 0) {
        run.run(`d${i}`, "deploy", "production", at(90 - (i % 60)));
        carry.run(`d${i}`, `pr${i}`);
      }
    }
    // Noise a real repository carries: thousands of agent runs and previews.
    for (let n = 0; n < 5000; n++)
      run.run(`n${n}`, n % 2 ? "agent" : "deploy", n % 2 ? "" : "pull-1", at(n % 160));
    // And the long history of successful production deploys, each carrying pulls merged before the window.
    for (let n = 0; n < 40000; n++) {
      run.run(`h${n}`, "deploy", "production", at(n % 160));
      carry.run(`h${n}`, `old${n}`);
    }
  })();
  view = { set: { pillars, gate: undefined, later: undefined }, names: [], of, merged: [] };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The answer as it was read one pull at a time. */
function reference(sealedOk: boolean) {
  const db = app.db;
  const since = pillarWindowStart();
  const first = new Map<number, { pillar: string; hours: number }>();
  const pulls = db
    .query<{ id: string; body: string; at: string }, [string]>(
      `SELECT i.id, i.body, p.merged_at AS at FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE p.merged_at >= ?1`,
    )
    .all(since);
  for (const p of pulls) {
    for (const n of closesFromBody(p.body)) {
      const ask = db
        .query<{ id: string; created_at: string; sealed: number }, [number]>(
          "SELECT id, created_at, sealed FROM issue WHERE number = ?1 AND kind = 'issue'",
        )
        .get(n);
      const pillar = ask && view.of.get(ask.id);
      if (!ask || !pillar || (ask.sealed === 1 && !sealedOk)) continue;
      const live = db
        .query<{ at: string }, [string, string]>(
          `SELECT COALESCE(r.serving_at, r.finished_at) AS at FROM deploy_pull dp
             JOIN run r ON r.id = dp.run_id
            WHERE dp.issue_id = ?1 AND r.kind = 'deploy' AND r.env = 'production' AND r.state = 'ok'
              AND COALESCE(r.serving_at, r.finished_at) >= ?2
            ORDER BY 1 LIMIT 1`,
        )
        .get(p.id, p.at);
      if (!live) continue;
      const hours = Math.max(0, (Date.parse(live.at) - Date.parse(ask.created_at)) / 3_600_000);
      const seen = first.get(n);
      if (!seen || hours < seen.hours) first.set(n, { pillar, hours });
      break;
    }
  }
  return view.set.pillars.map(({ name }) => {
    const hs = [...first.values()].filter((f) => f.pillar === name).map((f) => f.hours).sort((a, b) => a - b);
    if (hs.length === 0) return { pillar: name, askToLive: undefined };
    const mid = hs.length >> 1;
    const median = hs.length % 2 ? hs[mid]! : (hs[mid - 1]! + hs[mid]!) / 2;
    return { pillar: name, askToLive: { median, slowest: hs[hs.length - 1]! } };
  });
}

const simple = (rows: ReturnType<typeof askToLiveOf>) =>
  rows.map((r) => ({
    pillar: r.pillar,
    askToLive: r.askToLive && { median: r.askToLive.medianHours, slowest: r.askToLive.slowest.hours },
  }));

test("the answer is the per-pull answer, for a writer and for a stranger", () => {
  const writer = askToLiveOf(app.db, repo, view, { sealed: true });
  const stranger = askToLiveFor(app, repo, view, undefined);
  expect(simple(writer)).toEqual(reference(true) as never);
  expect(simple(stranger)).toEqual(reference(false) as never);
  expect(writer.filter((r) => r.askToLive).length).toBe(PILLARS);
  // Sealed asks are left out for the stranger, so the two differ.
  expect(simple(writer)).not.toEqual(simple(stranger));
  expect(sealedScope(app.db, repo, undefined)).toEqual({});
});

test(`${PULLS} merged pulls over ${PILLARS} pillars answer in a bounded number of statements`, async () => {
  askToLiveFor(app, repo, view, undefined);
  expectWork(await statements(app.db, () => void askToLiveFor(app, repo, view, undefined)), { max: 5 });
});
