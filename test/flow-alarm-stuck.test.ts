/** The stuck-pull alarm (#5930): approved, open, unheld, and quiet for 30 minutes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { alarmStuck } from "../src/flow/alarm_stuck.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

let dir: string;
let app: App;
let n = 0;
const userId = (name: string): string =>
  app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?1").get(name)!.id;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "alarm-stuck-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  app.db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r', ?1, 'r')", [u.value.id]);
  app.db.run("UPDATE repo SET autonomy = 'auto' WHERE id = 'r'");
  const b = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

/** An open pull with one approval and one check run finishing `eventMin` ago. */
function pull(opts: { repo?: string; eventMin: number; approved?: boolean; held?: boolean; state?: string; check?: string; oid?: string; merged?: boolean }): number {
  n++;
  const db = app.db;
  const [u] = db.query<{ id: string }, []>("SELECT id FROM user LIMIT 1").all();
  db.run(
    `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at)
     VALUES (?1, ?6, ?2, 'pull', 't', ?3, ?4, ?5)`,
    [`p${n}`, n, u!.id, opts.state ?? "open", ago(10_000), opts.repo ?? "r"],
  );
  db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', ?3)", [`p${n}`, `b${n}`, opts.merged ? ago(1) : null]);
  if (opts.approved !== false)
    db.run("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, 'approved', ?5, ?4)", [`rv${n}`, `p${n}`, u!.id, ago(opts.eventMin + 500), opts.oid ?? "h"]);
  db.run(
    `INSERT INTO run (id, repo_id, kind, issue_id, state, commit_oid, created_at, finished_at)
     VALUES (?1, 'r', 'check', ?2, ?3, 'h', ?4, ?4)`,
    [`run${n}`, `p${n}`, opts.check ?? "failed", ago(opts.eventMin)],
  );
  if (opts.held) db.run("INSERT INTO pull_hold (id, issue_id, held_by, why) VALUES (?1, ?2, ?3, 'wait')", [`h${n}`, `p${n}`, u!.id]);
  return n;
}
const reset = (): void => {
  for (const t of ["event", "pull_hold", "run", "review", "pull"]) app.db.run(`DELETE FROM ${t}`);
  app.db.run("DELETE FROM issue");
};

describe("alarmStuck", () => {
  test("quiet forge: not fired", () => {
    reset();
    expect(alarmStuck(app, NOW)).toEqual({ fired: false, says: "No approved pull is sitting still." });
  });

  test("an approved pull with an event 31 minutes ago fires and names it", () => {
    reset();
    const num = pull({ eventMin: 31 });
    const a = alarmStuck(app.db, NOW);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(ago(31));
    expect(a.says).toBe(`alice/r#${num} has sat approved for 31 minutes; its last event was a red check at 11:29.`);
  });

  test("a walled pull says a person must decide, in plain words (#7847)", () => {
    reset();
    const num = pull({ eventMin: 31 });
    const wall = (head: string): void =>
      void app.db.run(
        "INSERT INTO decision (id, kind, repo_id, issue_id, state, answer, p, by, ms) VALUES (?1, 'land', 'r', ?2, ?3, 'wall', 1, 'wall', 0)",
        [`d${num}${head}`, `p${num}`, JSON.stringify({ head, cells: ["pack.read as anon: new, and yes"], plain: ["anyone signed out could read pack records"] })],
      );
    wall("other");
    expect(alarmStuck(app, NOW).wall).toBeUndefined();
    app.db.run("DELETE FROM decision");
    wall("h");
    const a = alarmStuck(app, NOW);
    expect(a.wall).toEqual(["anyone signed out could read pack records"]);
    expect(a.says).toBe(`${a.repo}#${a.number} is approved and waits for a person to merge it.`);
    expect(a.says.length).toBeLessThan(80);
  });

  test("an event 29 minutes ago does not fire", () => {
    reset();
    pull({ eventMin: 29 });
    expect(alarmStuck(app, NOW).fired).toBe(false);
  });

  test("a held, unapproved, or closed pull never counts", () => {
    reset();
    pull({ eventMin: 600, held: true });
    pull({ eventMin: 600, approved: false });
    pull({ eventMin: 600, state: "closed" });
    expect(alarmStuck(app, NOW).fired).toBe(false);
  });

  test("names the oldest, in days", () => {
    reset();
    pull({ eventMin: 90 });
    const old = pull({ eventMin: 5 * 1440, check: "ok" });
    const a = alarmStuck(app, NOW);
    expect(a.says).toStartWith(`alice/r#${old} has sat approved for 5 days; its last event was a green check at `);
  });

  test("a stale approval (for an old head) or a merged pull never counts", () => {
    reset();
    pull({ eventMin: 600, oid: "old" });
    pull({ eventMin: 600, merged: true });
    expect(alarmStuck(app, NOW).fired).toBe(false);
  });

  test("changes requested at the current head excludes the pull", () => {
    reset();
    const num = pull({ eventMin: 600 });
    expect(alarmStuck(app, NOW).fired).toBe(true);
    const other = userId("bob");
    app.db.run(
      "INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES ('cr', ?1, ?2, 'changes_requested', 'h', ?3)",
      [`p${num}`, other, ago(599)],
    );
    expect(alarmStuck(app, NOW).fired).toBe(false);
  });

  const push = (branch: string, minutes: number): void => {
    app.db.run(
      "INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'push', 'r', ?2, ?3)",
      [`e${++n}`, JSON.stringify({ updates: [{ ref: `refs/heads/${branch}`, newOid: "x" }] }), ago(minutes)],
    );
  };

  test("a recent push to the head branch is an event; one to a look-alike branch is not", () => {
    reset();
    const num = pull({ eventMin: 600 });
    const branch = `b${num}`;
    // Underscore and percent are LIKE wildcards; neither may match another branch.
    push(branch.replace("b", "x"), 5);
    push("%", 5);
    expect(alarmStuck(app, NOW).fired).toBe(true);
    push(branch, 5);
    expect(alarmStuck(app, NOW).fired).toBe(false);
  });

  test("a branch name with wildcards matches only itself", () => {
    reset();
    const num = pull({ eventMin: 600 });
    app.db.run("UPDATE pull SET head_branch = 'a_b' WHERE issue_id = ?1", [`p${num}`]);
    push("axb", 5);
    expect(alarmStuck(app, NOW).fired).toBe(true);
    push("a_b", 5);
    expect(alarmStuck(app, NOW).fired).toBe(false);
  });

  test("a released hold is an event", () => {
    reset();
    const num = pull({ eventMin: 600, held: true });
    expect(alarmStuck(app, NOW).fired).toBe(false);
    app.db.run("UPDATE pull_hold SET released_at = ?2 WHERE issue_id = ?1", [`p${num}`, ago(600)]);
    expect(alarmStuck(app, NOW).fired).toBe(true);
    app.db.run("UPDATE pull_hold SET released_at = ?2 WHERE issue_id = ?1", [`p${num}`, ago(5)]);
    expect(alarmStuck(app, NOW).fired).toBe(false);
  });

  test("a repository the crew does not finish does not count, unless asked for by id", () => {
    reset();
    app.db.run("INSERT INTO repo (id, owner_id, name) VALUES ('q', ?1, 'quiet')", [userId("alice")]);
    const num = pull({ eventMin: 600, repo: "q" });
    expect(alarmStuck(app, NOW).fired).toBe(false);
    expect(alarmStuck(app, NOW, { repoId: "q" }).says).toStartWith(`alice/quiet#${num} has sat`);
    expect(alarmStuck(app, NOW, { repoId: "r" }).fired).toBe(false);
    app.db.run("DELETE FROM repo WHERE id = 'q'");
  });

  test("publicOnly leaves a private repository out", () => {
    reset();
    app.db.run("UPDATE repo SET visibility = 'private' WHERE id = 'r'");
    pull({ eventMin: 600 });
    expect(alarmStuck(app, NOW).fired).toBe(true);
    expect(alarmStuck(app, NOW, { publicOnly: true }).fired).toBe(false);
    app.db.run("UPDATE repo SET visibility = 'public' WHERE id = 'r'");
    expect(alarmStuck(app, NOW, { publicOnly: true }).fired).toBe(true);
  });
});
