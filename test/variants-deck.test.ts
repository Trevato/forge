import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listDecisions } from "../src/core/decisions.ts";
import { listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const gitEnv = gitClientEnv();

describe("a deck chooses among sibling pulls", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let dir: string;
  let ownerCookie = "";
  let readerCookie = "";

  async function gitOk(args: string[]): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      env: gitEnv,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  }
  async function signUp(username: string): Promise<string> {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { origin: base },
      body: new URLSearchParams({
        username,
        email: `${username}@f.dev`,
        password: "variants-deck-pass",
      }),
      redirect: "manual",
    });
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }
  const post = (path: string, cookie: string, fields: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { origin: base, cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  const pull = (n: number) =>
    getPull(app.db, getRepo(app.db, "dev", "app")!.id, n)!;
  const ledger = () =>
    listDecisions(app.db, getRepo(app.db, "dev", "app")!.id, { kind: "lean" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-vd-"));
    work = await mkdtemp(join(tmpdir(), "forge-vd-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    ownerCookie = await signUp("dev");
    readerCookie = await signUp("reader");
    const token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "dev",
        password: "variants-deck-pass",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    const auth = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    dir = work;
    await gitOk([
      "clone",
      `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`,
      "app",
    ]);
    dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\n");
    await gitOk(["add", "."]);
    await gitOk(["commit", "-m", "base"]);
    await gitOk(["push", "origin", "main"]);
    for (const name of ["a", "b"]) {
      await gitOk(["checkout", "-B", name, "main"]);
      await Bun.write(join(dir, "code.txt"), `alpha\n${name}\n`);
      await gitOk(["commit", "-am", name]);
      await gitOk(["push", "origin", name]);
      await fetch(`${base}/api/v1/repos/dev/app/pulls`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ base: "main", head: name, title: `Try ${name}` }),
      });
    }
    app.db.run("UPDATE pull SET variant_group = 'deck1'");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("the page shows one card per open sibling; a writer has buttons, a reader none", async () => {
    const mine = await (
      await fetch(`${base}/dev/app/variants/deck1`, { headers: { cookie: ownerCookie } })
    ).text();
    expect(mine).toContain("Try a");
    expect(mine).toContain("Try b");
    expect(mine).toContain('action="/dev/app/variants/deck1/1/like"');
    expect(mine).not.toContain("Ship");
    const theirs = await (
      await fetch(`${base}/dev/app/variants/deck1`, { headers: { cookie: readerCookie } })
    ).text();
    expect(theirs).toContain("Try a");
    expect(theirs).not.toContain("/variants/deck1/1/like");
    expect((await fetch(`${base}/dev/app/variants/nope`)).status).toBe(404);
  });

  test("a reader's post is refused and writes nothing", async () => {
    const res = await post("/dev/app/variants/deck1/1/dislike", readerCookie);
    expect(res.status).toBe(403);
    expect(ledger()).toHaveLength(0);
    expect(pull(1).state).toBe("open");
  });

  test("a cross-origin post is refused", async () => {
    const res = await fetch(`${base}/dev/app/variants/deck1/1/like`, {
      method: "POST",
      headers: { origin: "http://evil.example", cookie: ownerCookie },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(ledger()).toHaveLength(0);
  });

  test("a like writes one lean row and closes nothing", async () => {
    await post("/dev/app/variants/deck1/1/like", ownerCookie);
    const rows = ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("like");
    expect(rows[0]!.issueId).toBe(pull(1).id);
    expect(pull(1).state).toBe("open");
  });

  test("a dislike writes one row, closes the pull, and leaves the reason as a comment", async () => {
    await post("/dev/app/variants/deck1/2/dislike", ownerCookie, {
      reason: "too   loud\nand garish",
    });
    const rows = ledger().filter((r) => r.answer === "dislike");
    expect(rows).toHaveLength(1);
    expect(pull(2).state).toBe("closed");
    const comments = listComments(app.db, pull(2).id);
    expect(comments.some((c) => c.body.includes("too loud and garish"))).toBe(true);
    // A decided variant takes no second vote.
    await post("/dev/app/variants/deck1/2/dislike", ownerCookie);
    expect(ledger()).toHaveLength(2);
  });

  test("the last open sibling shows Ship", async () => {
    const html = await (
      await fetch(`${base}/dev/app/variants/deck1`, { headers: { cookie: ownerCookie } })
    ).text();
    expect(html).toContain("Ship");
    expect(html).not.toContain("Try b</a>");
  });
});
