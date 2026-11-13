/**
 * The old per-deploy ledger (deploy_pull) is trimmed to recent deploys (#12009) and nothing writes it
 * any more: a deploy with no rows is asked for through the function the run page and the run API
 * use, and its list comes from git; one slice deletes rows of old deploys only, keeps the deploy an
 * app is running, starts only once deploy_landed is filled, and costs a fixed handful of statements,
 * not one per row (#7824: no clock).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { once } from "./helpers/statements.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectWork } from "./helpers/work.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { carriedBy, carriedFor, recordCarried } from "../src/core/carried.ts";
import { getPull } from "../src/core/pulls.ts";
import { repoDir } from "../src/git/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import {
  DEPLOY_PULL_KEEP_DAYS,
  DEPLOY_PULL_SCAN,
  deployRetention,
  pruneDeploys,
} from "../src/system/retention_deploys.ts";
import { LIMITS, limitValue, setLimit } from "../src/settings/limits.ts";

quietLogs();

const DAY = 86_400_000;

describe("deploy_pull retention", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;
  let dir: string;
  let servers: Servers;
  let start = "";
  const merged: { number: number; oid: string }[] = [];
  const now = new Date();
  const ago = (days: number): string => new Date(now.getTime() - days * DAY).toISOString();

  const deploy = (id: string, oid: string, at: string, env = "production"): void => {
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, commit_oid, state, serving_at, finished_at, created_at)
         VALUES (?1, ?2, 'deploy', ?3, ?4, 'ok', ?5, ?5, ?5)`,
      )
      .run(id, repo.id, env, oid, at);
  };
  const rows = (runId: string): number =>
    app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM deploy_pull WHERE run_id = ?1")
      .get(runId)!.n;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-retention-deploys-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = getUserByName(app.db, "alice")!;
    const created = await createRepo(app, alice, { name: "engine", visibility: "public" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    dir = repoDir(app.reposRoot, "alice", "engine");
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    start = seeded.value.commitOid;
    for (const name of ["one", "two"]) {
      const branch = await commitToBranch(app, alice, repo, {
        branch: `feature/${name}`,
        base: "main",
        message: name,
        files: [{ path: `${name}.md`, content: `${name}\n` }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, alice, repo, {
        title: name,
        body: "",
        baseBranch: "main",
        headBranch: `feature/${name}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const done = await mergePull(app, alice, repo, opened.value, "squash");
      if (!done.ok) throw new Error(JSON.stringify(done.error));
      const pull = getPull(app.db, repo.id, opened.value.number)!;
      merged.push({ number: pull.number, oid: pull.mergedOid! });
    }
  });

  afterAll(async () => {
    servers?.stop();
    app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** What an older release wrote when a deploy finished: one row per pull its commit carries. */
  const record = async (runId: string, oid: string): Promise<number[]> => {
    const numbers = await recordCarried(app.db, { runId, repoId: repo.id, commitOid: oid, dir });
    const insert = app.db.query(
      "INSERT OR IGNORE INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1, ?2, ?3, 'o')",
    );
    for (const n of numbers) insert.run(runId, getPull(app.db, repo.id, n)!.id, n);
    return numbers;
  };

  test("a deploy with no rows gets its list from git, and none is written", async () => {
    deploy("rebuilt", merged[1]!.oid, ago(30));
    const run = { id: "rebuilt", repoId: repo.id, kind: "deploy", env: "production", state: "ok", commitOid: merged[1]!.oid };
    expect(await carriedFor(app.db, run, dir)).toEqual([merged[0]!.number, merged[1]!.number]);
    // Kept in memory: the next view is not another walk, and the table holds nothing for it.
    expect(rows("rebuilt")).toBe(0);
    expect(await carriedFor(app.db, { ...run, commitOid: start }, dir)).toEqual([merged[0]!.number, merged[1]!.number]);
  });

  test("a deploy an older release recorded reads its rows until retention trims them", async () => {
    deploy("older", merged[1]!.oid, ago(0.5));
    await record("older", merged[1]!.oid);
    const run = { id: "older", repoId: repo.id, kind: "deploy", env: "production", state: "ok", commitOid: start };
    // The commit named here carries none: the answer is the rows, not a walk.
    expect(await carriedFor(app.db, run, dir)).toEqual([merged[0]!.number, merged[1]!.number]);
    expect(carriedBy(app.db, "older")).toEqual([merged[0]!.number, merged[1]!.number]);
  });

  const trimmed = async (id: string): Promise<void> => {
    deploy(id, merged[1]!.oid, ago(30));
  };
  const both = () => [merged[0]!.number, merged[1]!.number];

  test("the run API reads a trimmed deploy's carries back from git", async () => {
    servers ??= await serve(app);
    await trimmed("api-door");
    const res = await fetch(`${servers.url}/api/v1/repos/alice/engine/runs/api-door`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { carries: number[] }).carries).toEqual(both());
  });

  test("the run page reads a trimmed deploy's carries back from git", async () => {
    servers ??= await serve(app);
    await trimmed("page-door");
    const res = await fetch(`${servers.url}/alice/engine/runs/page-door`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('id="run-carries"');
    for (const n of both()) expect(page).toContain(`#${n}`);
  });

  test("the terminal's deploys screen reads a trimmed deploy's carries back from git", async () => {
    await trimmed("tui-door");
    // No deploy on the list keeps rows: whatever it shows, it rebuilt.
    app.db.query("DELETE FROM deploy_pull").run();
    const alice = getUserByName(app.db, "alice")!;
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
      { terminal: headlessTerminal(160, 40), exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(deploysScreen(session, tui.ctx, repo));
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop();
    expect(text).toContain(`carries ${both().map((n) => `#${n}`).join(" ")}`);
  });

  test("a deploy that carries none is walked once, not on every view", async () => {
    deploy("none", start, ago(30));
    const run = { id: "none", repoId: repo.id, kind: "deploy", env: "production", state: "ok", commitOid: start };
    expect(await carriedFor(app.db, run, dir)).toEqual([]);
    // Had it walked again, this commit would carry both pulls.
    expect(await carriedFor(app.db, { ...run, commitOid: merged[1]!.oid }, dir)).toEqual([]);
    expect(rows("none")).toBe(0);
  });

  test("two views of one trimmed deploy share one walk", async () => {
    deploy("shared", merged[0]!.oid, ago(30));
    const run = { id: "shared", repoId: repo.id, kind: "deploy", env: "production", state: "ok", commitOid: merged[0]!.oid };
    // The second asks with another commit: a second walk would answer both pulls.
    const [a, b] = await Promise.all([
      carriedFor(app.db, run, dir),
      carriedFor(app.db, { ...run, commitOid: merged[1]!.oid }, dir),
    ]);
    expect(a).toEqual([merged[0]!.number]);
    expect(b).toEqual(a);
  });

  test("a preview deploy with no rows is not walked", async () => {
    const run = { id: "preview", repoId: repo.id, kind: "deploy", env: "pull-1", state: "ok", commitOid: merged[1]!.oid };
    expect(await carriedFor(app.db, run, dir)).toEqual([]);
    expect(rows("preview")).toBe(0);
  });

  test("a batch drops old deploys' rows and keeps recent ones and the one an app runs", async () => {
    app.db.query("DELETE FROM deploy_pull").run();
    app.db.query("DELETE FROM run").run();
    deploy("old", merged[0]!.oid, ago(DEPLOY_PULL_KEEP_DAYS + 5));
    deploy("running", merged[1]!.oid, ago(DEPLOY_PULL_KEEP_DAYS + 3));
    deploy("recent-preview", merged[1]!.oid, ago(0.5), "pull-2");
    for (const id of ["old", "running", "recent-preview"]) await record(id, merged[1]!.oid);
    app.db
      .query("INSERT INTO app (id, repo_id, slug, access) VALUES ('app-1', ?1, 'engine', 'public')")
      .run(repo.id);
    expect(pruneDeploys(app.db, now, 100)).toEqual({ deleted: 2, more: false, next: 0 });
    expect(rows("old")).toBe(0);
    expect(rows("running")).toBe(2);
    expect(rows("recent-preview")).toBe(2);
    // Without the app, its last deploy is just an old one.
    app.db.query("DELETE FROM app").run();
    // One row at a time, each batch starting where the last one stopped: kept rows are passed, not reread.
    let after = 0;
    let deleted = 0;
    let batches = 0;
    for (;;) {
      const r = pruneDeploys(app.db, now, 1, after);
      deleted += r.deleted;
      after = r.next;
      batches++;
      if (!r.more) break;
    }
    expect(deleted).toBe(2);
    expect(batches).toBe(5);
    expect(rows("running")).toBe(0);
    expect(rows("recent-preview")).toBe(2);
  });

  test("a slice costs a fixed handful of statements whatever the table holds, and a pass goes on a slice at a time", async () => {
    app.db.query("DELETE FROM deploy_pull").run();
    deploy("big", merged[0]!.oid, ago(DEPLOY_PULL_KEEP_DAYS + 10));
    const insert = app.db.query(
      "INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES ('big', ?1, ?2, 'x')",
    );
    app.db.transaction(() => {
      for (let i = 0; i < 7_000; i++) insert.run(`issue-${i}`, i);
    })();
    let ready = false;
    const tick = deployRetention(app.db, undefined, undefined, () => ready);
    // Nothing goes before deploy_landed has what the rows hold.
    expect(tick(now)).toBeUndefined();
    expect(app.db.query("SELECT COUNT(*) AS n FROM deploy_pull").get()).toEqual({ n: 7_000 });
    ready = true;
    let first: ReturnType<typeof tick>;
    const cost = await once(app.db, () => {
      first = tick(now);
    });
    expect(first!.more).toBe(true);
    expect(first!.deleted).toBe(DEPLOY_PULL_SCAN);
    expectWork(cost, { max: 6 });
    // Each call is one slice, the pacing is the caller's.
    let total = first!.deleted;
    let slices = 1;
    for (;;) {
      const r = tick(now)!;
      total += r.deleted;
      slices++;
      if (!r.more) break;
    }
    expect(total).toBe(7_000);
    // A slice that ends exactly on the last row cannot know it was the last: one more finds none.
    expect(slices).toBe(Math.floor(7_000 / DEPLOY_PULL_SCAN) + 1);
    // The pass is over: the next one waits for the hour.
    expect(tick(now)).toBeUndefined();
    expect(tick(new Date(now.getTime() + 62 * 60_000))).toMatchObject({ deleted: 0, more: false });
  });

  test("a slice out of its time budget ends after a chunk of 10 rows, and the next starts after the last row it passed", async () => {
    app.db.query("DELETE FROM deploy_pull").run();
    app.db.query("DELETE FROM run").run();
    app.db.query("DELETE FROM app").run();
    deploy("slow", merged[0]!.oid, ago(30));
    const insert = app.db.query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES ('slow', ?1, ?2, 'x')");
    app.db.transaction(() => {
      for (let i = 0; i < 100; i++) insert.run(`i-${i}`, i);
    })();
    // A budget already spent: a chunk of 10 rows is looked at, then the slice hands the thread back.
    const first = pruneDeploys(app.db, now, 100, 0, 1, 0);
    expect(first).toMatchObject({ deleted: 10, more: true });
    expect(first.next).toBeGreaterThan(0);
    let total = first.deleted;
    let after = first.next;
    for (;;) {
      const r = pruneDeploys(app.db, now, 100, after, 1, 0);
      total += r.deleted;
      after = r.next;
      if (!r.more) break;
    }
    expect(total).toBe(100);
    expect(rows("slow")).toBe(0);
  });

  test("the keep window is the setting's: deploys past it go, deploys inside it stay, each slice bounded", async () => {
    app.db.query("DELETE FROM deploy_pull").run();
    app.db.query("DELETE FROM run").run();
    app.db.query("DELETE FROM app").run();
    // Inside a 14-day window, past a 7-day setting.
    deploy("past", merged[0]!.oid, ago(9));
    deploy("inside", merged[1]!.oid, ago(3));
    for (const id of ["past", "inside"]) await record(id, merged[1]!.oid);
    expect(pruneDeploys(app.db, now, 100, 0, 14)).toMatchObject({ deleted: 0 });
    const alice = getUserByName(app.db, "alice")!;
    expect(setLimit(app.db, "retention.deploy_pull_days", 7, alice.id).ok).toBe(true);
    const tick = deployRetention(app.db, undefined, () => limitValue(app.db, "retention.deploy_pull_days"));
    const r = tick(now)!;
    expect(r).toMatchObject({ deleted: 2, more: false });
    expect(rows("past")).toBe(0);
    expect(rows("inside")).toBe(2);
    // One row a slice: a slice never reads more than its cap.
    deploy("past2", merged[0]!.oid, ago(10));
    await record("past2", merged[1]!.oid);
    expect(pruneDeploys(app.db, now, 1, 0, 7)).toMatchObject({ more: true });
    expect(LIMITS["retention.deploy_pull_days"].default).toBe(DEPLOY_PULL_KEEP_DAYS);
    setLimit(app.db, "retention.deploy_pull_days", null, alice.id);
  });
});
