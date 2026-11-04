/**
 * Following the origin across forges: a repository brought from another forge
 * shows how many commits the origin has that it has not taken, and one action
 * takes them. Two real forges: the origin serves git, a fake API speaks for it.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { takeFromOrigin } from "../src/actions/origins.ts";
import {
  clearCursor,
  createOrigin,
  forgetRepoCursors,
  getCursor,
  markNeedsReauth,
  originForRepo,
  setCursor,
} from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { settled } from "../src/origins/jobs.ts";
import {
  aheadBusy,
  aheadOf,
  CONFLICT_WORDS,
  HELD_WORDS,
  pickDue,
  readAhead,
  readAheadDue,
  runAheadReads,
  UNREAD_WORDS,
} from "../src/origins/ahead.ts";
import { requestSyncNow, runSync, syncBusy, syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { originAheadScreen } from "../src/tui/screens/originahead.ts";
import type { Session } from "../src/tui/session.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-ahead-token-7a21c4";
const PASSWORD = "alice-secret-5521";
const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("new commits upstream, taken with one action", () => {
  const dirs: string[] = [];
  let app: App;
  let originApp: App;
  let servers: Servers;
  let originServers: Servers;
  let fake: FakeForge;
  const mine = { authorization: basic("alice", PASSWORD) };
  const theirs = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };

  const commitOnOrigin = async (path: string): Promise<void> => {
    const made = await fetch(`${originServers.url}/api/v1/repos/octo/lib/contents`, {
      method: "POST",
      headers: theirs,
      body: JSON.stringify({ branch: "main", message: `add ${path}`, files: [{ path, content: `${path}\n` }] }),
    });
    expect(made.status).toBeLessThan(300);
  };
  const head = async (): Promise<string> =>
    (await (await fetch(`${servers.url}/alice/lib`, { headers: mine })).text());

  beforeAll(async () => {
    for (const prefix of ["forge-ahead-", "forge-ahead-origin-"])
      dirs.push(await mkdtemp(join(tmpdir(), prefix)));
    originApp = createApp({ dataDir: dirs[1]!, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, { username: LOGIN, email: "octo@origin.test", password: TOKEN });
    proveAll(originApp);
    const created = await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: theirs,
      body: JSON.stringify({ name: "lib", visibility: "public" }),
    });
    expect(created.status).toBeLessThan(300);
    await commitOnOrigin("README.md");

    const state = newFakeState("forgejo", LOGIN, TOKEN);
    state.repos.push({
      id: 5,
      fullName: "octo/lib",
      private: false,
      defaultBranch: "main",
      cloneUrl: `${originServers.url}/octo/lib.git`,
    });
    fake = serveFakeForge(state);
    state.repos[0]!.htmlUrl = `${fake.url}/octo/lib`;
    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    proveAll(app);
    const made = createOrigin(app.db, app.config.dataDir, {
      userId: getUserByName(app.db, "alice")!.id,
      kind: "forgejo",
      apiUrl: fake.apiUrl,
      webUrl: fake.url,
      login: LOGIN,
      token: TOKEN,
    });
    if (!made.ok) throw new Error(made.error);
    const started = await fetch(`${servers.url}/bring`, {
      method: "POST",
      redirect: "manual",
      headers: { ...mine, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link: `${fake.url}/octo/lib` }).toString(),
    });
    expect(started.status).toBe(303);
    const job = await settled(started.headers.get("location")!.split("/").pop()!);
    expect(job?.stage).toBe("done");
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  const post = (as: Record<string, string>, path = "sync/take") =>
    fetch(`${servers.url}/alice/lib/${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { ...as, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: "",
    });
  const flashed = async (res: Response): Promise<string> => {
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    return (await (await fetch(`${servers.url}/alice/lib`, { headers: { ...mine, cookie } })).text());
  };
  const mainOid = (): string =>
    Bun.spawnSync(["git", "rev-parse", "main"], { cwd: join(app.reposRoot, "alice", "lib.git") }).stdout.toString().trim();

  test("commit on the origin, see the count, take them, the count is 0", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    expect(aheadOf(app, repo)).toBeUndefined();
    expect(await head()).not.toContain("data-origin-ahead");

    await commitOnOrigin("one.txt");
    await commitOnOrigin("two.txt");
    expect((await readAhead(app, repo))?.count).toBe(2);
    expect(aheadOf(app, repo)?.count).toBe(2);
    const shown = await head();
    expect(shown).toContain("data-origin-ahead");
    expect(shown).toContain("2 new commits upstream");

    const taken = await post(mine);
    expect(taken.status).toBe(303);
    expect(await flashed(taken)).toContain("Took 2 new commits from the origin.");
    expect(aheadOf(app, repo)).toBeUndefined();
    expect((await readAhead(app, repo))?.count).toBe(0);
    expect(await head()).not.toContain("data-origin-ahead");
  });

  test("the worker's pass reads a mirror on its own", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    await commitOnOrigin("three.txt");
    expect(await readAheadDue(app, Date.now() + 3 * 60_000)).toBeGreaterThan(0);
    expect(aheadOf(app, repo)?.count).toBe(1);
  });

  test("a mirror holding commits the origin lacks says conflict and moves nothing", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    const dir = join(app.reposRoot, "alice", "lib.git");
    const tree = Bun.spawnSync(["git", "rev-parse", "main^{tree}"], { cwd: dir }).stdout.toString().trim();
    const main = Bun.spawnSync(["git", "rev-parse", "main"], { cwd: dir }).stdout.toString().trim();
    const local = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-p", main, "-m", "local only"],
      { cwd: dir },
    ).stdout.toString().trim();
    Bun.spawnSync(["git", "update-ref", "refs/heads/main", local], { cwd: dir });
    await readAhead(app, repo);
    expect(aheadOf(app, repo)?.diverged).toBe(true);
    const taken = await post(mine);
    expect(taken.status).toBe(303);
    expect(await flashed(taken)).toContain(CONFLICT_WORDS(repo.defaultBranch, aheadOf(app, repo)!.count));
    expect(mainOid()).toBe(local);
  });

  test("the sweep leaves a diverged main untouched, and says why where the last fetch is", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    const before = mainOid();
    expect(aheadOf(app, repo)?.diverged).toBe(true);
    await syncOrigin(app, originForRepo(app.db, repo.id)!.origin);
    expect(mainOid()).toBe(before);
    expect(getRepo(app.db, "alice", "lib")!.origin!.fetchError).toBe(HELD_WORDS(repo.defaultBranch));
    expect(aheadOf(app, repo)?.diverged).toBe(true);
  });

  test("a reading stuck on a slow origin does not hold the sweep", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    const origin = originForRepo(app.db, repo.id)!.origin;
    // An origin that accepts and never answers: git waits on it.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const row = app.db
      .query<{ clone_url: string }, [string]>("SELECT clone_url FROM origin_repo WHERE origin_id = ?1")
      .get(origin.id)!;
    app.db.query("UPDATE origin_repo SET clone_url = ?1 WHERE origin_id = ?2")
      .run(`http://127.0.0.1:${silent.port}/octo/lib.git`, origin.id);
    clearCursor(app.db, origin.id, `repo:${repo.id}:ahead-read`);
    const reads = runAheadReads(app);
    expect(aheadBusy(app)).toBe(true);
    app.db.query("UPDATE origin_repo SET clone_url = ?1 WHERE origin_id = ?2").run(row.clone_url, origin.id);
    requestSyncNow(app, origin.id);
    runSync(app);
    expect(syncBusy(app)).toBe(true);
    const deadline = Date.now() + 30_000;
    while (syncBusy(app) && Date.now() < deadline) await Bun.sleep(10);
    expect(syncBusy(app)).toBe(false);
    expect(getCursor(app.db, origin.id, "next_sync_at") ?? "").not.toBe(new Date(0).toISOString());
    expect(aheadBusy(app)).toBe(true);
    silent.stop(true);
    await reads;
    expect(aheadBusy(app)).toBe(false);
  });

  test("a non-writer and a guest see the count but no Take them; a guest sees nothing on a private mirror", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob", email: "bob@forge.test", password: "bob-secret-5521",
    });
    expect(made.ok).toBe(true);
    proveAll(app);
    const bob = { authorization: basic("bob", "bob-secret-5521") };
    expect(await head()).toContain("Take them");
    for (const as of [bob, {}]) {
      const page = await (await fetch(`${servers.url}/alice/lib`, { headers: as })).text();
      expect(page).toContain("new commit");
      expect(page).toContain("conflicts with commits here");
      expect(page).not.toContain("Take them");
    }
    expect((await post(bob)).status).not.toBe(200);
    expect((await post(bob, "sync")).status).not.toBe(200);
    app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(repo.id);
    const guest = await fetch(`${servers.url}/alice/lib`);
    expect(await guest.text()).not.toContain("data-origin-ahead");
    app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(repo.id);
  });

  test("the terminal shows the line and takes them under the page's rules", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    const alice = getUserByName(app.db, "alice")!;
    const bob = getUserByName(app.db, "bob")!;
    const screenFor = (user: typeof alice | undefined) => {
      const toasts: string[] = [];
      const ctx = {
        theme: theme("dark"), invalidate() {}, push() {}, pop() {}, copy() {},
        toast: (m: string) => toasts.push(m),
      } as unknown as Ctx;
      const screen = originAheadScreen({ app, db: app.db, user } as unknown as Session, ctx);
      const draw = (): string => {
        const s = new Surface(110, 20);
        screen.render({ x: 0, y: 0, w: 110, h: 20 }, s);
        return s.toText();
      };
      return { screen, toasts, draw };
    };
    expect(screenFor(alice).draw()).toContain("conflicts with commits here");
    expect(screenFor(bob).draw()).toContain("not take it");
    expect(screenFor(undefined).draw()).toContain("alice/lib");
    const before = mainOid();
    const b = screenFor(bob);
    expect(b.screen.key!({ key: "t" } as never)).toBe(false);
    expect(b.screen.taking()).toBeUndefined();
    const a = screenFor(alice);
    expect(a.screen.key!({ key: "t" } as never)).toBe(true);
    await a.screen.taking();
    expect(a.toasts[0]).toBe(CONFLICT_WORDS(repo.defaultBranch, 1));
    expect(mainOid()).toBe(before);
    app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(repo.id);
    expect(screenFor(undefined).draw()).not.toContain("alice/lib");
    app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(repo.id);
  });

  test("Sync now is the way out: it replaces a diverged main with the origin's", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    const tip = aheadOf(app, repo)!.tip;
    const res = await post(mine, "sync");
    expect(await flashed(res)).toContain("Synced from the origin.");
    expect(mainOid()).toBe(tip);
    expect(aheadOf(app, repo)).toBeUndefined();
    expect(getRepo(app.db, "alice", "lib")!.origin!.fetchError).toBe("");
  });

  test("an origin that cannot be read is refused, not synced over", async () => {
    const repo = getRepo(app.db, "alice", "lib")!;
    const alice = getUserByName(app.db, "alice")!;
    const origin = originForRepo(app.db, repo.id)!.origin;
    markNeedsReauth(app.db, origin.id, "test");
    const before = mainOid();
    const taken = await takeFromOrigin(app, alice, repo);
    expect(taken.ok && taken.value.kind).toBe("unread");
    expect(mainOid()).toBe(before);
    const res = await post(mine);
    expect(await flashed(res)).toContain(UNREAD_WORDS);
  });

  test("a repository's readings go with it, and only its own", () => {
    const origin = originForRepo(app.db, getRepo(app.db, "alice", "lib")!.id)!.origin;
    setCursor(app.db, origin.id, "repo:gone:ahead", "1 x 0 now");
    setCursor(app.db, origin.id, "repo:gone:ahead-read", "now");
    setCursor(app.db, origin.id, "repo:gonealso:ahead", "1 x 0 now");
    forgetRepoCursors(app.db, "gone", origin.id);
    expect(getCursor(app.db, origin.id, "repo:gone:ahead")).toBe("1 x 0 now");
    forgetRepoCursors(app.db, "gone");
    expect(getCursor(app.db, origin.id, "repo:gone:ahead")).toBeUndefined();
    expect(getCursor(app.db, origin.id, "repo:gone:ahead-read")).toBeUndefined();
    expect(getCursor(app.db, origin.id, "repo:gonealso:ahead")).toBe("1 x 0 now");
  });
});

describe("which mirrors a tick reads", () => {
  const MIN = 60_000;
  const now = 100 * MIN;
  test("at most four, longest-ago first, none read within two minutes", () => {
    const seen = [
      { repoId: "a", at: now - 10 * MIN },
      { repoId: "b", at: now - 9 * MIN },
      { repoId: "c", at: now - 8 * MIN },
      { repoId: "d", at: now - 7 * MIN },
      { repoId: "e", at: now - 6 * MIN },
      { repoId: "never", at: 0 },
      { repoId: "fresh", at: now - 119_000 },
    ];
    expect(pickDue(seen, now)).toEqual(["never", "a", "b", "c"]);
    expect(pickDue([{ repoId: "x", at: now - 2 * MIN }], now)).toEqual(["x"]);
    expect(pickDue([{ repoId: "x", at: now - 2 * MIN + 1 }], now)).toEqual([]);
  });
});
