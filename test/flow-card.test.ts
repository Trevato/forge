/**
 * A stalled flow step is a card on the home (#1807): the pull whose check is
 * red or was never asked for, past its stage's allowance, with the one
 * button that unblocks it. A step that moves on loses its card; the cost is
 * the same few queries however many stall.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readStalled } from "../src/flow/stalled.ts";
import { askCheck } from "../src/checks/again.ts";
import { getPull } from "../src/core/pulls.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { stalledScreen } from "../src/tui/screens/stalled.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { utilities } from "../src/web/style/base.ts";
import { settleApp } from "./helpers/tui.ts";
import { unblock } from "../src/flow/unblock.ts";
import { stalledRows } from "../src/tui/screens/stalled.ts";
import { feedJs } from "../src/web/studio/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("stalled steps on the home", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let cookie = "";
  let repo: Repo;
  let n = 0;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  const pullOn = async (): Promise<Pull> => {
    const branch = `b${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title: `Change ${branch}`,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    app.db
      .query("UPDATE issue SET created_at = ?2 WHERE id = ?1")
      .run(o.value.id, hoursAgo(5));
    return o.value;
  };
  const run = (pull: Pull, state: "failed" | "queued", hours = 4) => {
    const r = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    if (state === "failed") {
      claimRun(app.db, r.id);
      finishRun(app.db, r.id, { state: "failed", summary: "red" });
    }
    app.db
      .query("UPDATE run SET created_at = ?2, finished_at = CASE WHEN ?3 = 'failed' THEN ?2 END WHERE id = ?1")
      .run(r.id, hoursAgo(hours), state);
  };
  const home = async (): Promise<string> =>
    (await fetch(`${servers.url}/feed`, { headers: { cookie: `${cookie}; forge_mode=studio` } })).text();
  const stalled = (user = alice) => readStalled(app.db, user, new Date());

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flow-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    await mk("keeper", true);
    alice = await mk("alice");
    bob = await mk("bob");
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stalled check shows a card with re-run; after the re-run it is gone", async () => {
    const pull = await pullOn();
    run(pull, "failed");
    const html = await home();
    expect(html).toContain(`data-flow-card="${repo.id}#${pull.number}"`);
    expect(html).toContain(`action="/alice/garden/pulls/${pull.number}/checks"`);
    expect(html).toContain("Re-run");
    expect(html).toContain(`Change b1`);
    // The re-run is a new run at the same head: queued, no longer red.
    run(pull, "queued", 0);
    expect(await home()).not.toContain(`data-flow-card="${repo.id}#${pull.number}"`);
  });

  test("a pull nobody asked a check for is a card that runs it; a fresh one is not", async () => {
    const old = await pullOn();
    expect(stalled().find((s) => s.pull === old.number)).toMatchObject({
      action: "run",
      stage: "pull",
    });
    app.db.query("UPDATE issue SET created_at = ?2 WHERE id = ?1").run(old.id, hoursAgo(0));
    expect(stalled().find((s) => s.pull === old.number)).toBeUndefined();
  });

  test("only those who can write to the repository see the card", async () => {
    const pull = await pullOn();
    expect(stalled(alice).some((s) => s.pull === pull.number)).toBe(true);
    expect(stalled(bob)).toEqual([]);
  });

  test("the button is a same-origin-checked post", async () => {
    const pull = await pullOn();
    const res = await fetch(`${servers.url}/alice/garden/pulls/${pull.number}/checks`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  test("cards cost a constant number of queries however many steps stall", async () => {
    const counted = () => {
      const db = app.db as unknown as { query: (sql: string) => unknown };
      const original = db.query;
      let queries = 0;
      db.query = (sql: string) => {
        queries++;
        return original.call(app.db, sql);
      };
      try {
        const steps = stalled();
        return { queries, steps: steps.length };
      } finally {
        db.query = original;
      }
    };
    const few = counted();
    for (let i = 0; i < 6; i++) run(await pullOn(), "failed");
    const many = counted();
    expect(many.steps).toBeGreaterThanOrEqual(few.steps + 6);
    expect(many.queries).toBe(few.queries);
  });

  test("the re-run returns to the home, and only to the home", async () => {
    const pull = await pullOn();
    run(pull, "failed");
    expect(await home()).toContain('name="next" value="/"');
    const post = (next: string) =>
      fetch(`${servers.url}/alice/garden/pulls/${pull.number}/checks`, {
        method: "POST",
        headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ next }),
        redirect: "manual",
      });
    expect((await post("/")).headers.get("location")).toBe("/");
    // Anything else, an off-site address included, goes to the pull as before.
    for (const bad of ["https://evil.example/", "//evil.example", "/settings"])
      expect((await post(bad)).headers.get("location")).toBe(`/alice/garden/pulls/${pull.number}`);
  });

  test("the cards sit outside the feed the feed's script acts on", async () => {
    const pull = await pullOn();
    run(pull, "failed", 90);
    app.db.query("UPDATE issue SET created_at = ?2 WHERE id = ?1").run(pull.id, hoursAgo(100));
    const page = await home();
    const card = page.indexOf(`data-flow-card="${repo.id}#${pull.number}"`);
    const feedAt = page.indexOf('id="live-feed"');
    expect(card).toBeGreaterThan(-1);
    expect(card).toBeLessThan(feedAt);
    expect(feedJs).toContain("document.getElementById('live-feed')");
    expect(feedJs).toContain("feed.contains(a)");
  });

  test("the terminal lists the same steps and re-runs them, for writers only", async () => {
    const pull = await pullOn();
    run(pull, "failed");
    const step = stalled().find((s) => s.pull === pull.number)!;
    const rows = stalledRows([step]);
    expect(rows[0]!.title).toContain(`alice/garden #${pull.number}`);
    expect(rows[0]!.meta).toContain("re-run");
    const checkRuns = () =>
      app.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'check'")
        .get(pull.id)!.n;
    const before = checkRuns();
    const refused = await unblock(app, bob, step);
    expect(refused).toEqual({ ok: false, message: "only someone who can write here can ask for a check" });
    expect(checkRuns()).toBe(before);
    // A writer's ask is exactly what askCheck answers for the pull's head.
    const expected = await askCheck(app, alice, repo, getPull(app.db, repo.id, pull.number)!);
    const asked = await unblock(app, alice, step);
    expect(asked.ok).toBe(expected.ok);
    if (!asked.ok && !expected.ok) expect(asked.message).toBe(expected.message);
    expect(stalled(bob)).toEqual([]);
  });

  const screenFor = async (user: User) => {
    const terminal = headlessTerminal(100, 30);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(stalledScreen(session, tui.ctx));
    await settleApp(tui);
    const text = tui.screen.toText();
    return { tui, text };
  };

  test("the stalled screen shows a step to a writer and the empty state to a guest", async () => {
    const pull = await pullOn();
    run(pull, "failed");
    const writer = await screenFor(alice);
    expect(writer.text).toContain(`alice/garden #${pull.number}`);
    expect(writer.text).not.toContain("Nothing is stalled");
    writer.tui.stop();
    const guest = await screenFor(bob);
    expect(guest.text).toContain("Nothing is stalled");
    expect(guest.text).not.toContain(`alice/garden #${pull.number}`);
    guest.tui.stop();
  });

  test("the card's who, reason and unblock are §5's badge, break and bar: no fcard-* class in its markup (#4268)", async () => {
    const pull = await pullOn();
    run(pull, "failed");
    const page = await home();
    const at = page.indexOf(`data-flow-card="${repo.id}#${pull.number}"`);
    const end = page.indexOf("</section>", at);
    const card = page.slice(at, end === -1 ? undefined : end);
    expect(card).not.toMatch(/fcard-/);
    expect(card).toContain('class="badge"');
    expect(card).toContain('class="break"');
    expect(card).toMatch(/<form[^>]*class="bar"/);
    expect(card).toContain(`href="/alice/garden/pulls/${pull.number}"`);
    expect(card).toContain(`action="/alice/garden/pulls/${pull.number}/checks"`);
    expect(card).toContain('name="next" value="/"');
    expect(card).toContain("Re-run");
    expect(card).toContain("Change b1");
  });

  test("every stalled step is a card, past any cap; the button wraps on its own", async () => {
    for (let i = 0; i < 8; i++) run(await pullOn(), "failed");
    const page = await home();
    expect(page.split("data-flow-card=").length - 1).toBe(stalled().length);
    expect(stalled().length).toBeGreaterThan(6);
    expect(utilities).toMatch(/\.bar \{[^}]*flex-wrap: wrap/);
  });
});
