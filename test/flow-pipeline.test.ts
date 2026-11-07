/**
 * /flow shows the forge's own bottleneck (#1554): from a seeded forge —
 * checks queued for hours, builder runs queued for minutes, two ready
 * issues an hour old beside open issues that are not ready, pulls approved
 * and overridden, merged before and after a deploy, deploys live today and
 * two days ago — each stage counts what it holds, the check queue is
 * named as the bottleneck in one sentence with its capacity — on the page,
 * in the terminal and through MCP — and nobody but a forge admin sees any
 * of it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { setDirectionIssue } from "../src/core/repos.ts";
import { setCapacity } from "../src/core/capacity.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { bottleneck, readPipeline, span, verdict } from "../src/flow/pipeline.ts";
import { shellJs } from "../src/web/client.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("/flow: the forge shows its own bottleneck", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const get = (path: string, cookie: string) =>
    fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flow-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const made = await createRepo(app, alice, { name: "shop" });
    if (!made.ok) throw new Error(String(made.error));
    const set = await updateRepoSettings(app, alice, made.value, {
      autonomy: "assisted",
      autonomyDirection: "keep the shop open",
      autonomySlots: 2,
      autonomyCeilingUsd: 15,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(String(set.error));
    const repo = set.value;
    setCapacity(app.db, "checks.concurrency", "1", alice.id);
    setCapacity(app.db, "crew.concurrency", "3", alice.id);

    // Two ready issues, opened an hour ago: they wait, but not the longest.
    for (const title of ["Add a cart", "Show the prices"]) {
      const issue = openIssue(app, alice, repo, { title });
      if (!issue.ok) throw new Error(String(issue.error));
      app.db
        .query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
        .run(ago(HOUR), issue.value.id);
    }
    // Three checks queued three hours ago, one running: the bottleneck.
    for (let n = 0; n < 4; n++) {
      const run = createRun(app.db, { repoId: repo.id, kind: "check", reason: "push" });
      app.db
        .query("UPDATE run SET created_at = ?1, state = ?2, started_at = ?3 WHERE id = ?4")
        .run(ago(3 * HOUR), n === 0 ? "running" : "queued", n === 0 ? ago(HOUR) : null, run.id);
    }
    // A builder run queued ten minutes ago.
    const build = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned" });
    app.db
      .query("UPDATE run SET created_at = ?1 WHERE id = ?2")
      .run(ago(10 * 60_000), build.id);
    // A check paused on a limit until later is not waiting for a worker.
    const paused = createRun(app.db, { repoId: repo.id, kind: "check", reason: "push" });
    app.db
      .query("UPDATE run SET created_at = ?1, not_before = ?2 WHERE id = ?3")
      .run(ago(9 * HOUR), new Date(Date.now() + HOUR).toISOString(), paused.id);

    // Open issues that are not ready: one blocked by an open issue, the
    // blocker itself with an agent run queued on it, one whose agent branch
    // already has an open pull, and the direction issue. Ready stays at 2.
    const newIssue = (title: string) => {
      const issue = openIssue(app, alice, repo, { title });
      if (!issue.ok) throw new Error(String(issue.error));
      app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(ago(HOUR), issue.value.id);
      return issue.value;
    };
    const blocker = newIssue("Pick a payment provider");
    const blocked = newIssue("Take payments");
    const linked = addDependency(app.db, blocked, blocker, alice.id);
    if (!linked.ok) throw new Error(linked.error);
    const queuedOn = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      reason: "assigned",
      issueId: blocker.id,
    });
    app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(ago(5 * 60_000), queuedOn.id);
    const built = newIssue("Add a footer");
    const builtRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      reason: "assigned",
      issueId: built.id,
      branch: "mason/footer",
    });
    app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(builtRun.id);
    setDirectionIssue(app.db, repo.id, newIssue("Direction").id);

    // Pulls, made from issues: open or merged into the default branch.
    const pull = (title: string, head: string, mergedAt: string | null) => {
      const issue = newIssue(title);
      app.db
        .query("UPDATE issue SET kind = 'pull', state = ?1 WHERE id = ?2")
        .run(mergedAt === null ? "open" : "closed", issue.id);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
           VALUES (?1, ?2, ?3, '', '', ?4)`,
        )
        .run(issue.id, repo.defaultBranch, head, mergedAt);
      return issue.id;
    };
    const review = (issueId: string, state: string, at: string) =>
      app.db
        .query(
          `INSERT INTO review (id, issue_id, author_id, state, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .run(crypto.randomUUID(), issueId, alice.id, state, at);
    // Approved, with a comment after: still approved — and its head is the footer's agent branch.
    const approved = pull("Footer", "mason/footer", null);
    review(approved, "approved", ago(30 * 60_000));
    review(approved, "commented", ago(20 * 60_000));
    // Approved, then changes requested: not approved.
    const overridden = pull("Header", "mason/header", null);
    review(overridden, "approved", ago(40 * 60_000));
    review(overridden, "changes_requested", ago(35 * 60_000));

    // The shop is an app: one pull merged before its last production deploy,
    // one merged after (landed, not live yet).
    app.db
      .query("INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, 'shop', 'public')")
      .run(crypto.randomUUID(), repo.id);
    pull("Logo", "mason/logo", ago(2 * HOUR));
    pull("Colours", "mason/colours", ago(30 * 60_000));
    const deploy = (createdAt: string, servingAt: string) => {
      const run = createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production" });
      app.db
        .query("UPDATE run SET state = 'ok', created_at = ?1, serving_at = ?2 WHERE id = ?3")
        .run(createdAt, servingAt, run.id);
    };
    // Live within the hour, and one two days ago that is not counted.
    deploy(ago(90 * 60_000), ago(HOUR - 60_000));
    deploy(ago(48 * HOUR + 60_000), ago(48 * HOUR));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("each stage counts what it holds, with its capacity; the longest wait is the bottleneck", () => {
    const stages = readPipeline(app.db);
    expect(stages.map((s) => s.key)).toEqual([
      "ready",
      "building",
      "check-queue",
      "checking",
      "review",
      "approved",
      "landed",
      "live",
    ]);
    const by = new Map(stages.map((s) => [s.key, s]));
    expect(by.get("ready")).toMatchObject({ waiting: 2, active: 0 });
    expect(by.get("ready")?.capacity).toBe("2 slots in 1 autonomous repository");
    expect(by.get("building")).toMatchObject({ waiting: 2, capacity: "crew runs at once 3" });
    expect(by.get("check-queue")).toMatchObject({ waiting: 3, capacity: "checks at once 1" });
    expect(by.get("checking")).toMatchObject({ waiting: 0, active: 1 });
    expect(by.get("review")).toMatchObject({ waiting: 0, active: 0, oldestWaiting: null });
    expect(by.get("approved")).toMatchObject({ waiting: 1, active: 0, capacity: null });
    expect(by.get("landed")).toMatchObject({ waiting: 1, active: 0, capacity: null });
    expect(by.get("live")).toMatchObject({ waiting: 0, active: 1, capacity: null });
    expect(bottleneck(stages)?.key).toBe("check-queue");
    expect(verdict(stages)).toBe(
      "Check queue is the bottleneck: its oldest has waited 3h, 3 wait, checks at once 1.",
    );
  });

  test("with nothing waiting, nothing is named", () => {
    expect(verdict([])).toBe("Nothing is waiting: every stage is empty or being worked.");
    expect(span(45_000)).toBe("45s");
    expect(span(3 * HOUR + 5 * 60_000)).toBe("3h 5m");
    expect(span(52 * HOUR)).toBe("2d 4h");
  });

  test("an admin reads the stages as rows under the one sentence, linked from the header", async () => {
    const cookie = await login("alice");
    const res = await get("/boards", cookie);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('id="bottleneck" data-stage="check-queue"');
    expect(page).toContain("Check queue is the bottleneck");
    expect(page).toMatch(/data-stage="check-queue"\s+data-bottleneck="true"/);
    for (const key of ["ready", "building", "checking", "review", "approved", "landed", "live"])
      expect(page).toContain(`data-stage="${key}"`);
    expect(page).toContain('href="/settings/capacity"');
    // Nothing links to Flow any more (#2831): the home an admin sees has no such href.
    expect(await (await get("/", cookie)).text()).not.toContain('href="/flow"');
  });

  test("/flow with a query is the old drill, a permanent redirect to /boards; /boards is for a forge admin", async () => {
    const bob = await login("bob");
    for (const cookie of [bob, ""]) {
      const res = await get("/flow?out=approved", cookie);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/boards?out=approved");
    }
    expect((await get("/boards", bob)).status).toBe(404);
    expect(await (await get("/", bob)).text()).not.toContain('href="/flow"');
  });

  test("the top bar holds search, New and the user menu; Flow, help and theme live in menus", async () => {
    expect(alice.isAdmin).toBe(true);
    const page = await (await get("/", await login("alice"))).text();
    const bar = page.slice(page.indexOf('<header class="topbar"'), page.indexOf("</header>"));
    // Nothing but menus and search sits in the bar: no bare Flow link, no help button.
    expect(bar).not.toContain("flow-link");
    expect(bar).not.toContain("theme-menu");
    expect(bar.match(/<details/g)?.length).toBe(2);
    // They are still one open away, in the user menu.
    const panel = bar.slice(bar.lastIndexOf('<details'));
    expect(panel).not.toContain('href="/flow"');
    expect(panel).toContain("data-help");
    expect(panel).toContain('action="/theme"');
  });

  test("a guest's bar has search, one appearance menu and Sign in; no bare theme button", async () => {
    const page = await (await get("/explore", "")).text();
    const bar = page.slice(page.indexOf('<header class="topbar"'), page.indexOf("</header>"));
    expect(bar).toContain("Sign in");
    expect(bar).not.toContain("theme-menu");
    expect(bar.replace(/<details[\s\S]*?<\/details>/g, "")).not.toContain("<button");
    expect(bar.match(/<details/g)?.length).toBe(1);
    const panel = bar.slice(bar.indexOf("<details"));
    expect(panel).toContain("data-help");
    expect(panel).toContain('action="/theme"');
  });

  test("the shell script wires the theme form by its new class and guards focus on the theme form", () => {
    expect(shellJs).toContain("doc.querySelector('.theme-form')");
    expect(shellJs).not.toContain(".theme-menu form");
    expect(shellJs).toContain("first.closest('.theme-form')");
  });

  const flowCommand = (user?: User) => {
    const pushed: Screen[] = [];
    const ctx = { push: (s: Screen) => pushed.push(s) } as unknown as Ctx;
    const session = new Session(app, {
      sshUsername: user?.username ?? "git",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:test",
      user,
    });
    return { found: forgeCommands(session)(ctx).find((c) => c.id === "flow"), pushed };
  };

  test("in the terminal, an admin's Flow command says the same sentence; nobody else is offered it", () => {
    const { found, pushed } = flowCommand(alice);
    expect(found?.title).toBe("Flow");
    found!.run();
    expect(pushed.map((s) => s.title)).toEqual(["Flow"]);
    const lines = flowLines(app.db);
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain(verdict(readPipeline(app.db)));
    expect(lines[0]).toStartWith("Check queue is the bottleneck");
    expect(flowCommand(bob).found).toBeUndefined();
    expect(flowCommand(undefined).found).toBeUndefined();
  });

  test("through MCP, an admin reads the stages and the sentence; anyone else is forbidden", async () => {
    const call = async (token: string) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "flow", arguments: {} },
        }),
      });
      const body = (await res.json()) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
      return { error: body.result.isError === true, text: body.result.content[0]!.text };
    };
    const admin = await call(createToken(app.db, alice.id, "t", "ro").token);
    expect(admin.error).toBe(false);
    const read = JSON.parse(admin.text) as {
      says: string;
      stages: { key: string; waiting: number }[];
    };
    expect(read.says).toStartWith("Check queue is the bottleneck");
    expect(read.stages.find((s) => s.key === "check-queue")?.waiting).toBe(3);
    const member = await call(createToken(app.db, bob.id, "t", "admin").token);
    expect(member.error).toBe(true);
    expect(member.text).toContain("forbidden");
  });
});
