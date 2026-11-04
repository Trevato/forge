/** The flow report (#6595): one line per read, cut to public repositories for a reader who may not see private ones. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { flowReadings, flowReportLines } from "../src/flow/report.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const ORDER = [
  "build_yield", "review_latency", "outsiders", "checks_pile", "stale_reds", "gate_minutes",
  "oldest_approved", "idle_pulls", "lead_time", "openers",
];
const name = (line: string) => line.split(":")[0]!;

let dir: string;
let app: App;
let priv: string;
let alice: string;
let bot: string;
let carol: string;
let n = 0;

const issue = (repo: string, author: string, minutes: number) => {
  const iid = id();
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, ?5)`)
    .run(iid, repo, ++n, author, ago(minutes));
  return iid;
};
const pull = (iid: string, head: string, mergedMin: number | null = null) =>
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', ?3, ?4)`)
    .run(iid, `b/${n}`, head, mergedMin === null ? null : ago(mergedMin));
const review = (iid: string, state: string, min: number) =>
  app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).run(id(), iid, alice, state, ago(min));
const run = (repo: string, kind: string, extra: { issue?: string; oid?: string; state: string; start: number; end: number | null; reason?: string }) =>
  app.db
    .query(
      `INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, reason, started_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .run(id(), repo, kind, extra.issue ?? null, extra.oid ?? "", extra.state, extra.reason ?? "", ago(extra.start), extra.end === null ? null : ago(extra.end));

beforeEach(async () => {
  n = 0;
  dir = mkdtempSync(join(tmpdir(), "forge-report-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string) => {
    const u = await createUser(app.db, { username, email: `${username}@forge.test`, password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!u.ok) throw new Error(u.error);
    return u.value.id;
  };
  alice = await mk("alice");
  bot = await mk("builder");
  carol = await mk("carol");
  app.db.query(`UPDATE user SET is_agent = 1 WHERE id = ?1`).run(bot);
  app.db.query(`INSERT INTO agent (user_id, model, brief, budget_usd, created_by, roles) VALUES (?1, 'm', '', 1, ?2, 'builder')`).run(bot, alice);
  const repo = (rname: string, visibility: string) => {
    const rid = id();
    app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)`).run(rid, alice, rname, visibility);
    return rid;
  };
  repo("pub", "public");
  priv = repo("priv", "private");
  app.db.query(`INSERT INTO repo_crew (repo_id, user_id) VALUES (?1, ?2)`).run(priv, bot);

  // Everything below lives in the private repository, so each read has something to hide.
  const idle = issue(priv, bot, 100 * 60); // crew pull, untouched for 100 h, approved 30 h ago
  pull(idle, "h1");
  review(idle, "approved", 30 * 60);
  const landed = issue(priv, bot, 5 * 60); // crew pull, first verdict 2 h ago, landed 1 h ago
  pull(landed, "h2", 60);
  review(landed, "changes_requested", 2 * 60);
  const outsider = issue(priv, carol, 20); // an outsider's pull, red check, opened in the last hour
  pull(outsider, "h3");
  run(priv, "check", { issue: outsider, oid: "h3", state: "failed", start: 60, end: 40 });
  run(priv, "agent", { state: "ok", start: 180, end: 120, reason: "build" });
});
afterEach(() => {
  app.close?.();
  rmSync(dir, { recursive: true, force: true });
});

const flowReport = (db: Database, now: Date, publicOnly: boolean) => flowReportLines(flowReadings(db, now, publicOnly));

describe("flowReportLines", () => {
  test("one line per read, in a fixed order", () => {
    const lines = flowReport(app.db, NOW, false);
    expect(lines.map(name)).toEqual(ORDER);
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
  });

  test("every read sees the private repository, and every read goes quiet under publicOnly", () => {
    const all = flowReport(app.db, NOW, false);
    const pub = flowReport(app.db, NOW, true);
    for (let i = 0; i < ORDER.length; i++) expect(pub[i], ORDER[i]).not.toBe(all[i]!);
    expect(pub).toEqual([
      "build_yield: 0 of 0 runs pushed in 24 h, 0 landed, 0 closed",
      "review_latency: no first verdict in 24 h",
      "outsiders: 0 open, oldest 0 h",
      "checks_pile: 0 red, 0 queued",
      "stale_reds: none",
      "gate_minutes: gates 0 min in 1 h, 0 min in 6 h; pull checks 0 min in 1 h, 0 min in 6 h",
      "oldest_approved: none waiting",
      "idle_pulls: none",
      "lead_time: 0 landed in 24 h, median —, slowest —",
      "openers: none in 1 h",
    ]);
  });

  test("the words carry the numbers", () => {
    const all = Object.fromEntries(flowReport(app.db, NOW, false).map((l) => [name(l), l]));
    expect(all.build_yield).toContain("0 of 1 runs pushed");
    expect(all.review_latency).toContain("over 1 pulls");
    expect(all.outsiders).toBe("outsiders: 1 open, oldest 0 h");
    expect(all.checks_pile).toBe("checks_pile: 1 red, 0 queued");
    expect(all.stale_reds).toBe("stale_reds: 1 red with no run for 30 min, oldest 0.7 h");
    expect(all.gate_minutes).toContain("pull checks 20 min in 1 h");
    expect(all.oldest_approved).toContain("priv#1");
    expect(all.idle_pulls).toContain("priv#1");
    expect(all.lead_time).toContain("1 landed in 24 h");
    expect(all.openers).toBe("openers: carol 1 (0 flow)");
  });
});

describe("scripts/flow-report.ts", () => {
  const exec = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", "scripts/flow-report.ts", ...args], { env: { ...process.env, FORGE_DATA: dir } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const db = () => join(dir, "forge.db");

  test("prints nine lines; --db and FORGE_DATA name the same file", () => {
    const a = exec("--db", db());
    expect(a.code).toBe(0);
    expect(a.out.trim().split("\n").map(name)).toEqual(ORDER);
    expect(exec().out).toBe(a.out);
  });

  test("--public cuts to public repositories", () => {
    expect(exec("--db", db(), "--public").out).toContain("checks_pile: 0 red, 0 queued");
    expect(exec("--db", db()).out).toContain("checks_pile: 1 red");
  });

  test("--json prints the raw values", () => {
    const v = JSON.parse(exec("--db", db(), "--json").out);
    expect(Object.keys(v)).toEqual(ORDER);
    expect(v.checks_pile).toEqual({ red: 1, queued: 0 });
  });

  test("a bad flag or a --db without a path exits 2 and says the usage", () => {
    for (const args of [["--nope"], ["--db"], ["stray"], ["--db", "--public"]]) {
      const r = exec(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("usage:");
    }
  });

  test("a missing database exits 1 with one line, no stack", () => {
    const r = exec("--db", join(dir, "nope.db"));
    expect(r.code).toBe(1);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    expect(r.err).toContain("cannot open");
  });
});
