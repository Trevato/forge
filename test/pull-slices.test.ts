import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { setHold, releaseHold } from "../src/core/holds.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getPull } from "../src/core/pulls.ts";
import { getUserByName } from "../src/core/users.ts";
import { getRepo } from "../src/core/repos.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});

describe("a fork's pull lands in slices (#9010)", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice = "";
  let bob = "";

  async function git(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  const call = (path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const authed = (user: string, token: string) =>
    `${base.replace("http://", `http://${user}:${token}@`)}`;

  let cookie = "";
  async function signup(username: string): Promise<string> {
    const signed = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "kept-fork-pass" }),
      redirect: "manual",
    });
    if (username === "alice") cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    return tokenFor(app, username, "admin", "k");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sl-"));
    work = await mkdtemp(join(tmpdir(), "forge-sl-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await signup("alice");
    bob = await signup("bob");
    proveAll(app);
    promote(app.db);
    await call("/api/v1/repos", alice, { name: "app", visibility: "public" });
    await git(["clone", `${authed("alice", alice)}/alice/app.git`, "a"], work);
    await Bun.write(join(work, "a/one.txt"), "one\n");
    await git(["add", "."], join(work, "a"));
    await git(["commit", "-m", "seed"], join(work, "a"));
    await git(["push", "origin", "main"], join(work, "a"));
    await call("/api/v1/repos/alice/app/forks", bob, {});
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("each slice merges the author's commits as they are, the last merges the head, and the author's merge of main is a fast-forward", async () => {
    const b = join(work, "b");
    await git(["clone", `${authed("bob", bob)}/bob/app.git`, "b"], work);
    const mine: string[] = [];
    for (const n of ["x", "y", "z"]) {
      await Bun.write(join(b, `${n}.txt`), `${n}\n`);
      await git(["add", "."], b);
      await git(["commit", "-m", `add ${n}`], b);
      mine.push(await git(["rev-parse", "HEAD"], b));
    }
    await git(["push", "origin", "main"], b);
    const opened = await call("/api/v1/repos/alice/app/pulls", bob, {
      title: "Jay's long work",
      base: "main",
      head: "main",
      headRepo: "bob/app",
    });
    expect(opened.status).toBe(201);
    const { number } = (await opened.json()) as { number: number };

    const a = join(work, "a");
    await Bun.write(join(a, "two.txt"), "two\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "alice moves on"], a);
    await git(["push", "origin", "main"], a);

    const slice = (token: string, upTo: string) =>
      call(`/api/v1/repos/alice/app/pulls/${number}/slices`, token, { upTo });

    // Someone who cannot write cannot land a slice; nor can anything not his.
    expect((await slice(bob, mine[0]!)).status).toBeGreaterThanOrEqual(403);
    expect((await slice(alice, "not-an-oid")).status).toBe(422);
    const alicesTip = await git(["rev-parse", "HEAD"], a);
    expect((await slice(alice, alicesTip)).status).toBe(422);

    const first = await slice(alice, mine[0]!);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ last: false, left: 2 });
    await git(["pull", "--no-rebase", "origin", "main"], a);
    expect((await git(["log", "-1", "--format=%P"], a)).split(" ")[1]).toBe(mine[0]!);
    // Landed already: the same end again is refused.
    expect((await slice(alice, mine[0]!)).status).toBe(422);

    const page = async () =>
      (await fetch(`${base}/alice/app/pulls/${number}/files`, { headers: { cookie } })).text();
    const shown = await page();
    expect(shown).toContain("Slice 1: up to");
    expect(shown).toContain("2 commits left to land.");
    expect(shown).toContain(`value="${mine[1]}"`);

    expect(await (await slice(alice, mine[1]!)).json()).toMatchObject({ last: false, left: 1 });
    const last = await slice(alice, mine[2]!);
    expect(last.status).toBe(200);
    expect(await last.json()).toMatchObject({ last: true, left: 0 });

    const after = await page();
    expect(after).toContain("Slice 2: up to");
    expect(after).toContain("Nothing left");
    const pull = (await (await call(`/api/v1/repos/alice/app/pulls/${number}`, alice)).json()) as { merged?: boolean; state?: string; mergedAt?: string | null };
    expect(pull.mergedAt ?? (pull.merged ? "yes" : null)).not.toBeNull();

    // Every commit of the author's is an ancestor of main, unrewritten.
    await git(["pull", "--no-rebase", "origin", "main"], a);
    for (const oid of mine) await git(["merge-base", "--is-ancestor", oid, "HEAD"], a);
    // The last merge takes the head itself, or the combined branch built on it (#9027).
    const lastSecond = (await git(["log", "-1", "--format=%P"], a)).split(" ")[1]!;
    await git(["merge-base", "--is-ancestor", mine[2]!, lastSecond], a);

    // The author's side: main comes back as a fast-forward.
    await git(["fetch", `${authed("alice", alice)}/alice/app.git`, "main"], b);
    await git(["merge", "--ff-only", "FETCH_HEAD"], b);
    expect(await git(["rev-parse", "HEAD"], b)).toBe(await git(["rev-parse", "HEAD"], a));
  });

  test("a slice before the head passes the whole pull's gate: no hold, no red check, a fork only", async () => {
    const b = join(work, "b");
    await git(["checkout", "-b", "more"], b);
    const mine: string[] = [];
    for (const n of ["p", "q"]) {
      await Bun.write(join(b, `${n}.txt`), `${n}\n`);
      await git(["add", "."], b);
      await git(["commit", "-m", `add ${n}`], b);
      mine.push(await git(["rev-parse", "HEAD"], b));
    }
    await git(["push", "origin", "more"], b);
    const opened = await call("/api/v1/repos/alice/app/pulls", bob, {
      title: "More",
      base: "main",
      head: "more",
      headRepo: "bob/app",
    });
    expect(opened.status).toBe(201);
    const { number } = (await opened.json()) as { number: number };
    const repo = getRepo(app.db, "alice", "app")!;
    const pull = getPull(app.db, repo.id, number)!;
    const slice = (upTo: string) =>
      call(`/api/v1/repos/alice/app/pulls/${number}/slices`, alice, { upTo });

    setHold(app.db, pull.id, getUserByName(app.db, "alice")!.id, "wait for the release");
    const held = await slice(mine[0]!);
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: "held" });
    // The page's form says so in its flash, and lands nothing.
    const form = async (upTo: string): Promise<string> => {
      const posted = await fetch(`${base}/alice/app/pulls/${number}/slice`, {
        method: "POST",
        headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ upTo }),
        redirect: "manual",
      });
      expect(posted.status).toBe(303);
      expect(posted.headers.get("location")).toBe(`/alice/app/pulls/${number}/files`);
      const flash = /forge_flash=([^;]*)/.exec(posted.headers.get("set-cookie") ?? "")?.[1] ?? "";
      return (JSON.parse(decodeURIComponent(flash)) as { message: string }).message;
    };
    expect(await form(mine[0]!)).toContain("A hold stands on this pull");
    releaseHold(app.db, pull.id, getUserByName(app.db, "alice")!.id);
    expect(await form("0".repeat(40))).toContain("not one of this pull's");

    // A head the review gate stops stops every slice of it too.
    app.db.query("UPDATE repo SET require_review = 1 WHERE id = ?1").run(repo.id);
    const unreviewed = await slice(mine[0]!);
    expect(unreviewed.status).toBe(409);
    expect(await unreviewed.json()).toEqual({ error: "review_required" });
    app.db.query("UPDATE repo SET require_review = 0 WHERE id = ?1").run(repo.id);

    const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: `pull-${number}`, commitOid: mine[1]! });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary: "red" });
    const red = await slice(mine[0]!);
    expect(red.status).toBe(409);
    expect(await red.json()).toEqual({ error: "checks_required" });

    // A branch of the repository itself lands whole.
    const a = join(work, "a");
    await git(["checkout", "-b", "local"], a);
    for (const n of ["r", "s"]) {
      await Bun.write(join(a, `${n}.txt`), `${n}\n`);
      await git(["add", "."], a);
      await git(["commit", "-m", `add ${n}`], a);
    }
    const first = await git(["rev-parse", "HEAD~1"], a);
    await git(["push", "origin", "local"], a);
    const own = await call("/api/v1/repos/alice/app/pulls", alice, { title: "Own", base: "main", head: "local" });
    const ownNumber = ((await own.json()) as { number: number }).number;
    const notFork = await call(`/api/v1/repos/alice/app/pulls/${ownNumber}/slices`, alice, { upTo: first });
    expect(notFork.status).toBe(422);
    expect(await notFork.json()).toEqual({ error: "not_fork" });
  });
});
