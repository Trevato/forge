/** The unproposed-work alarm (#6391): `now` is passed in; nothing reads the wall clock. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { repoDir } from "../src/git/repos.ts";
import { alarmUnproposed } from "../src/flow/alarm_unproposed.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const NOW = new Date("2026-10-26T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("alarm_unproposed", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let forkId: string;
  let dir: string;
  let main: string;
  let authorId: string;

  const git = async (args: string[], date?: string, stdin?: string): Promise<string> => {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@f.dev", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@f.dev", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
    return out.trim();
  };
  /** A commit on top of main, aged `h` hours, held by `refs/heads/<name>`. */
  const branch = async (name: string, h: number): Promise<string> => {
    const tree = await git(["rev-parse", `${main}^{tree}`]);
    const oid = await git(["commit-tree", tree, "-p", main, "-m", name], ago(h));
    await git(["update-ref", `refs/heads/${name}`, oid]);
    return oid;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-alarm-unproposed-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const alice = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
    authorId = alice.id;
    const bot = must(await createUser(app.db, { origin: "seed", trusted: true, username: "bot", email: "bot@f.dev", agent: true }));
    const upstream = must(await createRepo(app, alice, { name: "app", visibility: "public" }));
    dir = repoDir(app.reposRoot, "alice", "app");
    const empty = await git(["hash-object", "-t", "tree", "-w", "--stdin"], undefined, "");
    main = await git(["commit-tree", empty, "-m", "root"], ago(40));
    await git(["update-ref", `refs/heads/${upstream.defaultBranch}`, main]);
    const fork = must(await forkRepo(app, bot, upstream));
    forkId = fork.id;
    dir = repoDir(app.reposRoot, "bot", "app");
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const openPull = (head: string, state: string, merged: string | null) => {
    const issueId = id();
    const n = (app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue").get()?.n ?? 0) + 1;
    app.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, ?5, ?6)`)
      .run(issueId, forkId, n, authorId, state, ago(1));
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, 'main', ?2, '', '', ?3, ?4)`)
      .run(issueId, head, forkId, merged);
  };

  test("quiet when no crew branch is waiting", async () => {
    const a = await alarmUnproposed(app.db, app.reposRoot, NOW);
    expect(a.fires).toBe(false);
  });

  test("a 7 h branch with no pull fires and is named; the others do not", async () => {
    await branch("lonely", 7);
    await branch("fresh", 2);
    await branch("proposed", 9);
    openPull("proposed", "open", null);
    const tree = await git(["rev-parse", `${main}^{tree}`]);
    const merged = await git(["commit-tree", tree, "-p", main, "-m", "m"], ago(10));
    await git(["update-ref", `refs/heads/${(await git(["symbolic-ref", "--short", "HEAD"]))}`, merged]);
    await git(["update-ref", "refs/heads/landed", merged]);

    const a = await alarmUnproposed(app.db, app.reposRoot, NOW);
    expect(a.fires).toBe(true);
    expect(a.branches.map((b) => b.branch)).toEqual(["lonely"]);
    expect(a.says).toContain("bot's lonely (7 h)");
  });

  test("says names the oldest three with owner and age", async () => {
    await branch("older", 30);
    await branch("old", 12);
    await branch("oldish", 8);
    const a = await alarmUnproposed(app.db, app.reposRoot, NOW);
    expect(a.branches.map((b) => b.branch)).toEqual(["older", "old", "oldish", "lonely"]);
    expect(a.says).toContain("bot's older (30 h), bot's old (12 h), bot's oldish (8 h) and 1 more");
  });
});
