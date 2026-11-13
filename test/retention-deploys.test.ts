/**
 * deploy_pull is trimmed to recent deploys (#12009): a deploy whose rows
 * are gone is asked for through the function the run page and the run API
 * use, and the same list comes back from git; one batch deletes rows of old
 * deploys only, keeps the deploy an app is running, and a 5,000-row batch
 * costs a fixed handful of statements, not one per row (#7824: no clock).
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
  deployRetention,
  pruneDeploys,
} from "../src/system/retention_deploys.ts";

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

  const record = (runId: string, oid: string) =>
    recordCarried(app.db, { runId, repoId: repo.id, commitOid: oid, dir });

  test("a deploy whose rows are gone gets the same list back from git", async () => {
    deploy("rebuilt", merged[1]!.oid, ago(30));
    const before = await record("rebuilt", merged[1]!.oid);
    expect(before).toEqual([merged[0]!.number, merged[1]!.number]);
    app.db.query("DELETE FROM deploy_pull WHERE run_id = 'rebuilt'").run();
    expect(carriedBy(app.db, "rebuilt")).toEqual([]);
    const run = { id: "rebuilt", repoId: repo.id, kind: "deploy", env: "production", state: "ok", commitOid: merged[1]!.oid };
    expect(await carriedFor(app.db, run, dir)).toEqual(before);
    // Kept again, so the next view reads rows.
    expect(carriedBy(app.db, "rebuilt")).toEqual(before);
  });

  const trimmed = async (id: string): Promise<void> => {
    deploy(id, merged[1]!.oid, ago(30));
    expect(await record(id, merged[1]!.oid)).toHaveLength(2);
    app.db.query("DELETE FROM deploy_pull WHERE run_id = ?1").run(id);
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
    deploy("recent-preview", merged[1]!.oid, ago(1), "pull-2");
    for (const id of ["old", "running", "recent-preview"]) await record(id, merged[1]!.oid);
    app.db
      .query("INSERT INTO app (id, repo_id, slug, access) VALUES ('app-1', ?1, 'engine', 'public')")
      .run(repo.id);
    expect(pruneDeploys(app.db, now, 100)).toEqual({ deleted: 2, more: false });
    expect(rows("old")).toBe(0);
    expect(rows("running")).toBe(2);
    expect(rows("recent-preview")).toBe(2);
    // Without the app, its last deploy is just an old one.
    app.db.query("DELETE FROM app").run();
    expect(pruneDeploys(app.db, now, 1)).toEqual({ deleted: 1, more: true });
    expect(pruneDeploys(app.db, now, 1)).toEqual({ deleted: 1, more: true });
    expect(pruneDeploys(app.db, now, 1)).toEqual({ deleted: 0, more: false });
    expect(rows("running")).toBe(0);
    expect(rows("recent-preview")).toBe(2);
  });

  test("a 5,000-row batch costs a fixed handful of statements, and the tick keeps going while batches are full", async () => {
    deploy("big", merged[0]!.oid, ago(DEPLOY_PULL_KEEP_DAYS + 10));
    const insert = app.db.query(
      "INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES ('big', ?1, ?2, 'x')",
    );
    app.db.transaction(() => {
      for (let i = 0; i < 7_000; i++) insert.run(`issue-${i}`, i);
    })();
    const tick = deployRetention(app.db);
    let first: ReturnType<typeof tick>;
    const cost = await once(app.db, () => {
      first = tick(now);
    });
    expect(first!).toEqual({ deleted: 5_000, more: true });
    expectWork(cost, { max: 4 });
    expect(tick(now)).toEqual({ deleted: 2_000, more: false });
    // Nothing full last time: the next batch waits for the hour.
    expect(tick(now)).toBeUndefined();
    expect(tick(new Date(now.getTime() + 61 * 60_000))).toEqual({ deleted: 0, more: false });
  });
});
