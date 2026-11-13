/**
 * /flow shows what moves (#1779): from a seeded forge — six pulls landed
 * over three hours, each closing an issue asked at a known time, a
 * production deploy that served them, checks that passed and failed, a
 * builder started on an issue twice, a release preflighted — each stage
 * counts its items out per hour, the headline says how many landed in the
 * last hour and in 24 h and the median ask→live, and every count links to
 * the items it counted.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { PIPELINE } from "../src/flow/pipeline.ts";
import { createToken } from "../src/core/tokens.ts";
import { median, readThroughput, stageOf, throughputSays } from "../src/flow/throughput.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("/flow: actual throughput per stage", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const get = async (path: string) =>
    fetch(`${servers.url}${path}`, { headers: { cookie: await login("alice") }, redirect: "manual" });

  const newIssue = (title: string, createdAt: string, body = "") => {
    const issue = openIssue(app, alice, repo, { title, body });
    if (!issue.ok) throw new Error(String(issue.error));
    app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(createdAt, issue.value.id);
    return issue.value;
  };
  const pull = (title: string, body: string, createdAt: string, mergedAt: string | null) => {
    const issue = newIssue(title, createdAt, body);
    app.db
      .query("UPDATE issue SET kind = 'pull', state = ?1 WHERE id = ?2")
      .run(mergedAt === null ? "open" : "closed", issue.id);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
         VALUES (?1, ?2, ?3, '', '', ?4)`,
      )
      .run(issue.id, repo.defaultBranch, `mason/${issue.number}`, mergedAt);
    return issue;
  };
  const run = (kind: "check" | "agent" | "deploy", set: Record<string, string | null>, extra = {}) => {
    const r = createRun(app.db, { repoId: repo.id, kind, ...extra });
    for (const [column, value] of Object.entries(set))
      app.db.query(`UPDATE run SET ${column} = ?1 WHERE id = ?2`).run(value, r.id);
    return r;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-throughput-"));
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
    repo = made.value;

    // Six landings over three hours: two in the last hour, three in the
    // one before, one in the one before that. Each closes an issue asked
    // 1, 2, 3, 4, 5 and 6 hours before the deploy that served them all.
    const landedAt = [10, 40, 70, 80, 100, 150].map((m) => ago(m * MIN));
    landedAt.forEach((mergedAt, n) => {
      const asked = newIssue(`Ask ${n + 1}`, ago(5 * MIN + (n + 1) * HOUR));
      pull(`Answer ${n + 1}`, `Closes #${asked.number}`, ago(4 * HOUR), mergedAt);
    });
    // Merged a day and a half ago and served by the next deploy: neither
    // landed nor live in the window, so not in the median.
    pull("Old", "", ago(40 * HOUR), ago(36 * HOUR));
    run("deploy", { state: "ok", created_at: ago(35 * HOUR), serving_at: ago(35 * HOUR - MIN) }, { env: "production" });
    // Open, opened 20 minutes ago: one pull opened in the last hour.
    pull("Draft", "", ago(20 * MIN), null);
    // The deploy that served all six went live five minutes ago.
    run("deploy", { state: "ok", created_at: ago(8 * MIN), serving_at: ago(5 * MIN) }, { env: "production" });

    // Checks: two passed in the last hour, one failed two hours ago, one cancelled (not finished).
    run("check", { state: "ok", started_at: ago(30 * MIN), finished_at: ago(20 * MIN) });
    run("check", { state: "ok", started_at: ago(30 * MIN), finished_at: ago(25 * MIN) });
    run("check", { state: "failed", started_at: ago(2 * HOUR + 20 * MIN), finished_at: ago(2 * HOUR + 10 * MIN) });
    run("check", { state: "cancelled", finished_at: ago(15 * MIN) });

    // A builder started twice on one issue: one issue started. A review returned.
    const cart = newIssue("Add a cart", ago(3 * HOUR));
    run("agent", { state: "failed", started_at: ago(50 * MIN) }, { reason: "assigned", issueId: cart.id });
    run("agent", { state: "running", started_at: ago(20 * MIN) }, { reason: "assigned", issueId: cart.id });
    run("agent", { state: "ok", finished_at: ago(3 * HOUR + 10 * MIN) }, { reason: "review" });

    // One release preflighted, one that failed preflight.
    const release = app.db.query(
      "INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at) VALUES (?1, ?2, ?3, ?4, '', ?5)",
    );
    release.run("a".repeat(40), repo.id, 1, 1, ago(30 * MIN));
    release.run("b".repeat(40), repo.id, 2, 0, ago(30 * MIN));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("each stage counts its items out per hour, hour 0 the last", () => {
    const t = readThroughput(app.db, PIPELINE, new Date(NOW));
    const by = new Map(t.stages.map((s) => [s.key, s]));
    expect(by.get("approved")?.hours.slice(0, 4)).toEqual([2, 3, 1, 0]);
    expect(by.get("approved")?.hours.reduce((a, b) => a + b)).toBe(6);
    expect(by.get("approved")?.items).toHaveLength(6);
    expect(by.get("approved")?.items[0]?.href).toBe("/alice/shop/pulls/2");
    expect(by.get("ready")?.items).toHaveLength(1);
    expect(by.get("ready")?.hours[0]).toBe(1);
    expect(by.get("building")?.hours[0]).toBe(1);
    expect(by.get("check-queue")?.hours.slice(0, 3)).toEqual([2, 0, 1]);
    expect(by.get("checking")?.hours.slice(0, 3)).toEqual([2, 0, 1]);
    expect(by.get("checking")?.items.map((i) => i.outcome)).toEqual(["passed", "passed", "failed"]);
    expect(by.get("review")?.hours[3]).toBe(1);
    expect(by.get("landed")?.items.map((i) => i.href)).toEqual(["/alice/shop/pulls/1"]);
    expect(by.get("live")?.hours[0]).toBe(1);
    expect(by.get("live")?.items[0]?.href).toStartWith("/alice/shop/runs/");
  });

  test("the median ask→live is over what went live in the last 24 hours", () => {
    // Asks 1h05 … 6h05 before NOW, live 5 minutes ago: 1 … 6 hours; median 3.5 h.
    expect(readThroughput(app.db, PIPELINE, new Date(NOW)).medianAskToLiveMs).toBe(3.5 * HOUR);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(stageOf("landed")).toBe("approved");
    expect(stageOf("approved")).toBeUndefined();
  });

  test("the page says it in the headline and beside each stage, and every count links to its items", async () => {
    const res = await get("/boards");
    expect(res.status).toBe(200);
    const page = await res.text();
    // The figures say it: landed in the last hour, in 24 hours, and the median from an ask to live.
    expect(page).toContain("<span data-landed-hour>2</span>");
    expect(page).toContain("<span data-landed-day>6</span> changes landed on main in 24 hours");
    expect(page).toContain("<span data-median>3h 30m</span>");
    expect(throughputSays(readThroughput(app.db, PIPELINE, new Date(NOW)))).toBe(
      "landed 2 in the last hour · 6 in 24 h · median ask→live 3.5 h (24 h)",
    );
    expect(page).toMatch(/data-out="landed">\s*<a href="\/boards\?out=landed&amp;hour=0#out" data-hour="0"[^>]*>2<\/a>/);
    expect(page).toMatch(/data-day="6"[^>]*>6<\/a>/);
    expect(page).toContain("2 of 3 checks passed in 24 hours");
    expect(page).toContain("checks finished: 2 passed, 1 failed");
    expect(page).not.toContain("flow-bar");
    expect(page).not.toContain("flow-out");
    expect((page.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(PIPELINE.length * 24);
  });

  test("each sparkline is a picture only: hidden from assistive tech, no links or tab stops of its own", async () => {
    const page = await (await get("/boards")).text();
    const svgs = page.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
    const sparks = svgs.filter((s) => s.includes('viewBox="0 0 72 16"'));
    expect(sparks).toHaveLength(PIPELINE.length);
    for (const svg of sparks) {
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain('focusable="false"');
      expect(svg).not.toContain("role=");
      expect(svg).not.toContain("<a");
    }
    // The way in is the two counts per stage: last hour and 24 h.
    for (const key of PIPELINE) {
      const out = { ready: "started", building: "opened", "check-queue": "check-started", checking: "checked",
        review: "reviewed", approved: "landed", landed: "released", live: "live" }[key];
      expect(page).toContain(`href="/boards?out=${out}&amp;hour=0#out" data-hour="0"`);
      expect(page).toMatch(new RegExp(`href="/boards\\?out=${out}#out" data-day=`));
    }
  });

  const mcpFlow = async (user: User) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken(app.db, user.id, "t", "ro").token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flow", arguments: {} } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    return { error: body.result.isError === true, text: body.result.content[0]!.text };
  };

  test("through MCP, the flow tool carries the same throughput, and only for a forge admin", async () => {
    const admin = await mcpFlow(alice);
    expect(admin.error).toBe(false);
    const read = JSON.parse(admin.text) as {
      throughput: {
        says: string;
        medianAskToLiveMs: number | null;
        stages: { key: string; out: string; lastHour: number; day: number; hours: number[] }[];
      };
    };
    expect(read.throughput.says).toBe("landed 2 in the last hour · 6 in 24 h · median ask→live 3.5 h (24 h)");
    expect(read.throughput.medianAskToLiveMs).toBeGreaterThan(3.5 * HOUR - MIN);
    expect(read.throughput.stages.map((s) => s.key)).toEqual([...PIPELINE]);
    const landed = read.throughput.stages.find((s) => s.key === "approved");
    expect(landed).toMatchObject({ out: "landed", lastHour: 2, day: 6 });
    expect(landed?.hours.slice(0, 4)).toEqual([2, 3, 1, 0]);
    expect(read.throughput.stages.find((s) => s.key === "checking")).toMatchObject({ lastHour: 2, day: 3 });
    const member = await mcpFlow(bob);
    expect(member.error).toBe(true);
    expect(member.text).toContain("forbidden");
  });

  test("in the terminal, an admin's Flow dialog says the headline and each stage's last hour and 24 h", () => {
    const lines = flowLines(app.db, new Date(NOW));
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("landed 2 in the last hour · 6 in 24 h · median ask→live 3.5 h (24 h)");
    expect(lines.find((l) => l.startsWith("Approved "))).toMatch(/^Approved\s+2\s+6\s+landed$/);
    expect(lines.find((l) => l.startsWith("Checking "))).toMatch(/^Checking\s+2\s+3\s+checks finished$/);
    expect(lines.find((l) => l.startsWith("Ready "))).toMatch(/^Ready\s+1\s+1\s+issues started$/);
    expect(lines.find((l) => l.startsWith("Live "))).toMatch(/^Live\s+1\s+1\s+live$/);
    const pushed: Screen[] = [];
    const ctx = { push: (s: Screen) => pushed.push(s) } as unknown as Ctx;
    const command = (user: User) =>
      forgeCommands(
        new Session(app, { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user }),
      )(ctx).find((c) => c.id === "flow");
    command(alice)!.run();
    expect(pushed.map((s) => s.title)).toEqual(["Flow"]);
    expect(command(bob)).toBeUndefined();
  });

  test("following a count lists the items it counted; a bad ask lists nothing", async () => {
    const hour = await (await get("/boards?out=landed&hour=0")).text();
    expect(hour).toContain('id="out"');
    expect(hour).toContain("2 landed in the last hour");
    expect(hour).toContain('href="/alice/shop/pulls/2"');
    expect(hour).toContain('href="/alice/shop/pulls/4"');
    expect(hour).not.toContain('href="/alice/shop/pulls/6"');
    const day = await (await get("/boards?out=landed")).text();
    expect(day).toContain("6 landed in the last 24 hours");
    for (const bad of ["?out=nope", "?out=landed&hour=24", "?out=landed&hour=-1", "?out=landed&hour=1e1"])
      expect(await (await get(`/boards${bad}`)).text()).not.toContain('id="out"');
  });
});
