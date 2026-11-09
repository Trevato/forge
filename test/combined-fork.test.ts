import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { previewCommit } from "../src/git/combined.ts";
import { repoDir } from "../src/git/repos.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { refreshPullHead } from "../src/core/following.ts";
import { getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});

describe("a conflicting fork pull is combined on our side (#9012)", () => {
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

  async function signup(username: string): Promise<string> {
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "kept-fork-pass" }),
      redirect: "manual",
    });
    return tokenFor(app, username, "admin", "k");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cb-"));
    work = await mkdtemp(join(tmpdir(), "forge-cb-work-"));
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

  test("the combined branch, its note, its preview, and the landing keep the author's head", async () => {
    const a = join(work, "a");
    const b = join(work, "b");
    await git(["clone", `${authed("bob", bob)}/bob/app.git`, "b"], work);
    await Bun.write(join(b, "one.txt"), "bob\n");
    await git(["commit", "-am", "bob's one"], b);
    await git(["push", "origin", "main"], b);
    const bobHead = await git(["rev-parse", "HEAD"], b);

    await Bun.write(join(a, "one.txt"), "alice\n");
    await Bun.write(join(a, "two.txt"), "two\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "alice moves on"], a);
    await git(["push", "origin", "main"], a);
    const aliceMain = await git(["rev-parse", "HEAD"], a);

    const opened = await call("/api/v1/repos/alice/app/pulls", bob, {
      title: "Jay's work",
      base: "main",
      head: "main",
      headRepo: "bob/app",
    });
    expect(opened.status).toBe(201);
    const { number } = (await opened.json()) as { number: number };

    // The branch on our side: main merged into his head, main's side kept.
    const bare = repoDir(app.reposRoot, "alice", "app");
    const tip = await git(["rev-parse", `refs/heads/combined/${number}`], bare);
    expect((await git(["log", "-1", "--format=%P", tip], bare)).split(" ")).toEqual([bobHead, aliceMain]);
    expect(await git(["show", `${tip}:one.txt`], bare)).toBe("alice");
    expect(await git(["show", `${tip}:two.txt`], bare)).toBe("two");
    const note = await git(["log", "-1", "--format=%B", tip], bare);
    expect(note).toContain("- one.txt: 1 block, main's side kept");
    // His branch is untouched.
    expect(await git(["ls-remote", "origin", "refs/heads/main"], b)).toStartWith(bobHead);

    // The preview builds the combined tree.
    const repo = getRepo(app.db, "alice", "app")!;
    const pull = getPull(app.db, repo.id, number)!;
    expect(await previewCommit(bare, pull)).toBe(tip);

    // The pull says so, with the note.
    const page = await call(`/alice/app/pulls/${number}`, alice);
    const body = await page.text();
    expect(body).toContain(`combined/${number}`);
    expect(body).toContain("one.txt: 1 block, main&#39;s side kept");

    expect(body).toContain("your side was dropped from the landed tree");
    expect(body).toContain("To get your side back");
    expect(body).toContain("The checks line says which commit the check ran on.");
    expect(body).not.toContain("Stale: main has moved");

    // The terminal's pull screen says the same (#9012).
    const screenText = async (): Promise<string> => {
      const user = getUserByName(app.db, "alice")!;
      const { app: tui, session } = createForgeApp(
        app,
        { sshUsername: "alice", remoteAddress: "127.0.0.1", user },
        { terminal: headlessTerminal(200, 80), exitHooks: false },
      );
      tui.start();
      await settleApp(tui);
      tui.push(pullScreen(session, tui.ctx, local(session, repo), number));
      await settleApp(tui);
      const out = tui.screen.toText();
      tui.stop();
      return out;
    };
    const shown = await screenText();
    expect(shown).toContain("Combined with main");
    expect(shown).toContain(`combined/${number} (${tip.slice(0, 10)})`);
    expect(shown).toContain("one.txt: 1 block, main's side kept; your side was dropped");

    // A push to the fork recombines: the new head is the branch's first parent.
    await Bun.write(join(b, "three.txt"), "three\n");
    await git(["add", "."], b);
    await git(["commit", "-m", "bob's three"], b);
    await git(["push", "origin", "main"], b);
    const bobNext = await git(["rev-parse", "HEAD"], b);
    // The push's own follow may have refreshed it already; this is the same door.
    await refreshPullHead(app, repo, getPull(app.db, repo.id, number)!);
    let retip = "";
    for (let i = 0; i < 40; i++) {
      retip = await git(["rev-parse", `refs/heads/combined/${number}`], bare);
      if ((await git(["log", "-1", "--format=%P", retip], bare)).startsWith(bobNext)) break;
      await Bun.sleep(50);
    }
    expect(getPull(app.db, repo.id, number)!.headOid).toBe(bobNext);
    expect((await git(["log", "-1", "--format=%P", retip], bare)).split(" ")).toEqual([bobNext, aliceMain]);
    expect(await previewCommit(bare, getPull(app.db, repo.id, number)!)).toBe(retip);

    // Main moves on its own: the card says the preview is stale, and on what it was built.
    await Bun.write(join(a, "four.txt"), "four\n");
    await git(["add", "."], a);
    await git(["commit", "-m", "alice's four"], a);
    // Moved past the hook (a push to main would recombine at once, #10040), so
    // the preview stays built on the old main and the card must say so.
    await git(["push", "origin", "main:refs/heads/four"], a);
    await git(["update-ref", "refs/heads/main", await git(["rev-parse", "HEAD"], a)], bare);
    const stale = await (await call(`/alice/app/pulls/${number}`, alice)).text();
    expect(stale).toContain(`Stale: main has moved since ${aliceMain.slice(0, 10)}`);
    expect(await screenText()).toContain("Combined with main · stale");

    // The merge lands the combined branch: his head is an ancestor of main.
    const merged = await call(`/api/v1/repos/alice/app/pulls/${number}/merge`, alice, { strategy: "merge" });
    expect(merged.status).toBe(200);
    await git(["pull", "--no-rebase", "origin", "main"], a);
    await git(["merge-base", "--is-ancestor", bobNext, "HEAD"], a);
    expect(await Bun.file(join(a, "four.txt")).text()).toBe("four\n");
    expect(await Bun.file(join(a, "one.txt")).text()).toBe("alice\n");
  }, 30_000);
});
