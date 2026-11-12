/**
 * The growth panel and the planner's switch (#11604): the counts match the rows for a fixture with
 * owner, person, planner, builder and watcher authors; pausing stops the planner's issues, plans and
 * runs while a builder's queued run still starts; a timed pause lifts itself; the API and the page answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPlan } from "../src/actions/plan.ts";
import { setPlannerSwitch, switchInput } from "../src/actions/planner_switch.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow, getAgent } from "../src/core/agents.ts";
import { growth, oldest } from "../src/core/growth.ts";
import { nextWeek, pauseSentence, pausedUntil } from "../src/core/planner_pause.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { eventAudience } from "../src/core/event_audience.ts";
import { weekCapacity } from "../src/flow/week.ts";
import { noteLimit } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { sealedScope } from "../src/core/sealed.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const NOW = new Date("2026-11-12T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

describe("growth and the planner switch", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let owner: User;
  let person: User;
  let planner: User;
  let builder: User;
  let watcher: User;
  let repo: Repo;
  let seq = 0;

  const insert = (author: User, kind: "issue" | "pull", created: string, closed: string | null, merged = false) => {
    const n = ++seq;
    const id = `fx${n}`;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .run(id, repo.id, 1000 + n, kind, `fixture ${n}`, author.id, closed === null ? "open" : "closed", created, closed);
    if (kind === "pull")
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
        )
        .run(id, `b${n}`, merged ? closed : null);
    return id;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-growth-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const mk = async (username: string, agent: boolean, roles: string[] = []) => {
      const made = await createUser(app.db, {
        username,
        email: `${username}@forge.test`,
        ...(agent
          ? { agent: true, origin: "agent" as const }
          : { password: "a-good-passphrase", origin: "seed" as const, trusted: true, adminIfFirst: username === "alice" }),
      });
      if (!made.ok) throw new Error(String(made.error));
      if (agent) createAgentRow(app.db, { userId: made.value.id, roles: roles as never });
      return made.value;
    };
    owner = await mk("alice", false);
    person = await mk("pat", false);
    planner = await mk("plan", true, ["planner"]);
    builder = await mk("build", true, ["builder"]);
    watcher = await mk("watch", true, ["maintainer"]);
    const made = await newApp(app, owner, { name: "shop", description: "Words", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = getRepo(app.db, "alice", "shop")!;
    addCrew(app.db, repo.id, planner.id, owner.id, "planner");
    addCrew(app.db, repo.id, builder.id, owner.id, "builder");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("the counts match the rows, by day and by author", () => {
    app.db.query("DELETE FROM issue WHERE repo_id = ?1").run(repo.id);
    const base = 0;
    // today: 2 planner + 1 owner opened, 1 closed; yesterday: 1 person + 1 builder + 1 watcher opened, 2 closed
    insert(planner, "issue", at(0), at(0));
    insert(planner, "issue", at(0), null);
    insert(owner, "issue", at(0), null);
    insert(person, "issue", at(1), null);
    insert(builder, "issue", at(1), at(1));
    insert(watcher, "issue", at(1), at(1));
    // an old one is outside the window; pulls: 2 opened a day ago, one landed today, one closed unmerged
    insert(planner, "issue", at(40), null);
    insert(builder, "pull", at(1), at(0), true);
    insert(builder, "pull", at(1), at(0), false);
    insert(builder, "pull", at(3), null);

    const g = growth(app.db, repo, 14, NOW);
    expect(g.days).toHaveLength(14);
    const today = g.days[13]!;
    const yesterday = g.days[12]!;
    expect(today.day).toBe("2026-11-12");
    expect(today.issuesOpened).toBe(3);
    expect(today.openedBy).toEqual({ owner: 1, people: 0, planner: 2, builders: 0, watchers: 0 });
    expect(today.issuesClosed).toBe(1);
    expect(yesterday.openedBy).toEqual({ owner: 0, people: 1, planner: 0, builders: 1, watchers: 1 });
    expect(yesterday.issuesClosed).toBe(2);
    expect(yesterday.pullsOpened).toBe(2);
    expect(today.pullsLanded).toBe(1);
    expect(today.pullsClosed).toBe(1);
    expect(g.open.issues).toBe(base + 4);
    expect(g.open.pulls).toBe(1);
    // net over the window: 6 opened, 3 closed
    expect(g.perDay).toBeCloseTo(3 / 14);
    expect(g.sentences).toHaveLength(2);
    expect(JSON.stringify(g)).not.toContain("spend");
    expect(g.sentences[1]).toContain("days of work");
    expect(oldest(app.db, repo.id).pull?.openedAt).toBe(at(3));
  });

  test("a suggestion appears when the list has grown three days running, and nothing pauses by itself", () => {
    for (const d of [0, 1, 2]) {
      insert(planner, "issue", at(d), null);
      insert(planner, "issue", at(d), null);
    }
    const g = growth(app.db, repo, 14, NOW);
    expect(g.growingRun).toBe(3);
    expect(g.suggest).toContain("pause the planner");
    expect(pausedUntil(app.db, repo.id, NOW)).toBeNull();
  });

  test("pausing stops the planner's issues, plans and runs; a builder's queued run still starts", () => {
    const direction = insert(owner, "issue", at(0), null);
    app.db.query("UPDATE repo SET direction_issue_id = ?2, autonomy = 'auto' WHERE id = ?1").run(repo.id, direction);
    repo = getRepo(app.db, "alice", "shop")!;
    const task = openIssue(app, owner, repo, { title: "A task" });
    if (!task.ok) throw new Error(task.error);
    const plan = (key: string) => [{ key, title: `Plan ${key}`, body: "x", blockedBy: [] }];
    const directionIssue = { ...task.value, id: direction };
    const plannerAgent = getAgent(app.db, planner.id)!;
    const builderAgent = getAgent(app.db, builder.id)!;

    // On: the planner opens and plans, and its run is queued.
    expect(openIssue(app, planner, repo, { title: "By the planner" }).ok).toBe(true);
    expect(openPlan(app, planner, repo, plan("a")).ok).toBe(true);
    expect(queueAgentRun(app, repo, directionIssue, plannerAgent, "assigned")).toBeDefined();
    app.db.query("UPDATE run SET state = 'cancelled' WHERE repo_id = ?1").run(repo.id);

    // Only the owner switches it.
    expect(setPlannerSwitch(app, person, repo, { mode: "owner" })).toEqual({ ok: false, error: "forbidden" });
    expect(setPlannerSwitch(app, planner, repo, { mode: "owner" })).toEqual({ ok: false, error: "forbidden" });
    const paused = setPlannerSwitch(app, owner, repo, { mode: "owner" }, NOW);
    expect(paused.ok).toBe(true);

    const refusedIssue = openIssue(app, planner, repo, { title: "Again" });
    expect(refusedIssue).toEqual({ ok: false, error: "planner_paused" });
    const refusedPlan = openPlan(app, planner, repo, plan("b"));
    expect(refusedPlan.ok ? "" : refusedPlan.error.error).toBe("planner_paused");
    expect(queueAgentRun(app, repo, directionIssue, plannerAgent, "assigned")).toBeUndefined();
    // Others carry on: a person's issue, a builder's plan and a builder's queued run.
    expect(openIssue(app, owner, repo, { title: "Owner still asks" }).ok).toBe(true);
    expect(openPlan(app, builder, repo, plan("c")).ok).toBe(true);
    expect(queueAgentRun(app, repo, task.value, builderAgent, "assigned")).toBeDefined();

    // Switched on, the planner works again.
    expect(setPlannerSwitch(app, owner, repo, { mode: "on" }).ok).toBe(true);
    expect(openIssue(app, planner, repo, { title: "Back" }).ok).toBe(true);
  });

  test("a timed pause lifts itself, and the weekly reset is the next Monday", () => {
    const t = new Date(Date.now() + 3_600_000).toISOString();
    expect(setPlannerSwitch(app, owner, repo, { mode: "until", at: t })).toEqual({ ok: true, value: t });
    expect(pausedUntil(app.db, repo.id, new Date(Date.now() + 1000))).toBe(t);
    expect(pausedUntil(app.db, repo.id, new Date(Date.now() + 7_200_000))).toBeNull();
    expect(setPlannerSwitch(app, owner, repo, { mode: "until", at: "2020-01-01T00:00:00Z" })).toEqual({ ok: false, error: "invalid" });
    expect(setPlannerSwitch(app, owner, repo, { mode: "until", at: "nonsense" })).toEqual({ ok: false, error: "invalid" });
    expect(nextWeek(NOW)).toBe("2026-11-16T00:00:00.000Z");
    expect(setPlannerSwitch(app, owner, repo, { mode: "week" }, NOW).ok).toBe(true);
    setPlannerSwitch(app, owner, repo, { mode: "on" });
  });

  test("the API answers the numbers, the page shows them and the switch needs the owner and the same origin", async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/shop/growth?days=14`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: unknown[]; open: { issues: number }; planner: { paused: boolean } };
    expect(body.days).toHaveLength(14);
    expect(body.planner.paused).toBe(false);
    expect(body.open.issues).toBe(growth(app.db, repo, 14, new Date()).open.issues);
    expect((await fetch(`${servers.url}/api/v1/repos/alice/shop/growth?days=0`)).status).toBe(422);
    expect((await fetch(`${servers.url}/api/v1/repos/alice/shop/growth?days=999`)).status).toBe(422);

    const html = await (await fetch(`${servers.url}/alice/shop/queue`)).text();
    expect(html).toContain("data-growth");
    expect(html).toContain("The planner is");
    expect(html).not.toContain("Pause the planner"); // a stranger sees the state, not the switch

    const token = createToken(app.db, owner.id, "t", "rw").token;
    const form = (origin: string | null) =>
      fetch(`${servers.url}/alice/shop/queue/planner`, {
        method: "POST",
        redirect: "manual",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
        body: "mode=owner",
      });
    expect((await form("https://evil.example")).status).toBe(403);
    expect(pausedUntil(app.db, repo.id, new Date())).toBeNull();
    expect((await form(servers.url)).status).toBeLessThan(400);
    expect(pausedUntil(app.db, repo.id, new Date())).not.toBeNull();
    const paused = await (await fetch(`${servers.url}/alice/shop/queue`)).text();
    expect(paused).toContain("paused");
  });

  test("the per-day reads walk an index, never a scan of issue", () => {
    const db = app.db;
    const original = db.query.bind(db);
    const sqls: string[] = [];
    (db as unknown as { query: unknown }).query = (sql: string) => (sqls.push(sql), original(sql));
    try {
      growth(db, repo, 14, NOW);
    } finally {
      (db as unknown as { query: unknown }).query = original;
    }
    const windowed = sqls.filter((q) => /^\s*SELECT/i.test(q) && /created_at >= \?2|closed_at >= \?2/.test(q) && !/FROM run r/.test(q));
    expect(windowed).toHaveLength(2);
    for (const q of windowed) {
      const n = Math.max(...[...q.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = original(`EXPLAIN QUERY PLAN ${q}`).all(...Array.from({ length: n }, () => "x")).map((r) => (r as { detail: string }).detail);
      expect(plan.filter((d) => /SCAN (i|issue)\b/.test(d) && !/USING/.test(d))).toEqual([]);
    }
    // Opened-per-day walks the new index; closed-per-day walks the repository's own rows by an existing one.
    const plans = windowed.map((q) => {
      const n = Math.max(...[...q.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      return original(`EXPLAIN QUERY PLAN ${q}`).all(...Array.from({ length: n }, () => "x")).map((r) => (r as { detail: string }).detail).join("\n");
    });
    expect(plans.some((p) => p.includes("issue_repo_created"))).toBe(true);
    for (const p of plans) expect(p).toMatch(/SEARCH i(ssue)? USING (COVERING )?INDEX/);
  });

  test("a sealed issue is in no number and no title for a guest, a reader or a stranger; a writer sees it", async () => {
    const before = growth(app.db, repo, 14, NOW, {});
    const sealedId = insert(person, "issue", at(45), null);
    app.db.query("UPDATE issue SET sealed = 1, title = 'secret hole in login' WHERE id = ?1").run(sealedId);
    const sealedToday = insert(person, "issue", at(0), null);
    app.db.query("UPDATE issue SET sealed = 1 WHERE id = ?1").run(sealedToday);
    const guest = sealedScope(app.db, repo, undefined);
    const stranger = sealedScope(app.db, repo, { ...person, id: "someone-else" } as User);
    for (const scope of [guest, stranger]) {
      const g = growth(app.db, repo, 14, NOW, scope);
      expect(g.open).toEqual(before.open);
      expect(g.days[13]!.issuesOpened).toBe(before.days[13]!.issuesOpened);
      expect(oldest(app.db, repo.id, scope).issue?.title).not.toBe("secret hole in login");
    }
    // The filer follows their own report; a writer sees all.
    expect(growth(app.db, repo, 14, NOW, sealedScope(app.db, repo, person)).open.issues).toBe(before.open.issues + 2);
    expect(growth(app.db, repo, 14, NOW, sealedScope(app.db, repo, owner)).open.issues).toBe(before.open.issues + 2);
    expect(oldest(app.db, repo.id, sealedScope(app.db, repo, owner)).issue?.title).toBe("secret hole in login");

    const page = await (await fetch(`${servers.url}/alice/shop/queue`)).text();
    expect(page).not.toContain("secret hole in login");
    const api = (await (await fetch(`${servers.url}/api/v1/repos/alice/shop/growth`)).json()) as { open: { issues: number } };
    expect(api.open.issues).toBe(before.open.issues);
    app.db.query("DELETE FROM issue WHERE id IN (?1, ?2)").run(sealedId, sealedToday);
  });

  test("no dollars are on the page or in the API", async () => {
    const body = await (await fetch(`${servers.url}/api/v1/repos/alice/shop/growth`)).text();
    expect(body).not.toContain("spend");
    const page = await (await fetch(`${servers.url}/alice/shop/queue`)).text();
    expect(page).not.toContain("went to work");
    expect(page).not.toMatch(/\$\d/);
  });

  test("the weekly reset pauses until the account's own reset, not just the next Monday", () => {
    const added = addSubscription(app.db, dataDir, { name: "growth week", token: "sk-ant-oat01-growth-test-1" });
    if (!added.ok) throw new Error(added.error);
    const ran = (at: string, usd: number) =>
      recordUsage(app.db, {
        runId: createRun(app.db, { repoId: repo.id, kind: "agent" }).id, repoId: repo.id, issueId: null, agentId: null,
        subscriptionId: added.value.id, tokensIn: 1, tokensOut: 1, costUsd: usd, wallMs: 1000, outcome: "ok", at,
      });
    ran("2026-10-30T10:00:00.000Z", 20);
    noteLimit(app.db, added.value.id, { window: "week", resetsAt: "2026-11-03T00:00:00.000Z", observedAt: "2026-11-04T00:00:00.000Z", said: "weekly limit" });
    ran("2026-11-05T10:00:00.000Z", 5);
    const NOW = new Date("2026-11-06T00:00:00Z");
    const reset = weekCapacity(app.db, NOW)?.resetsAt;
    expect(reset).toBeTruthy();
    expect(reset).not.toBe(nextWeek(NOW));
    expect(setPlannerSwitch(app, owner, repo, { mode: "week" }, NOW)).toEqual({ ok: true, value: reset! });
    setPlannerSwitch(app, owner, repo, { mode: "on" });
  });

  test("the planner's pause and resume are for the admins to hear", () => {
    expect(eventAudience("planner.paused")).toBe("admins");
    expect(eventAudience("planner.resumed")).toBe("admins");
  });

  test("a time with or without seconds is UTC, and a pause says it in one sentence", () => {
    expect(switchInput("until", "2026-11-20T09:00")).toEqual({ mode: "until", at: "2026-11-20T09:00:00Z" });
    expect(switchInput("until", "2026-11-20T09:00:30")).toEqual({ mode: "until", at: "2026-11-20T09:00:30Z" });
    expect(switchInput("until", "2026-11-20T09:00:00Z")).toEqual({ mode: "until", at: "2026-11-20T09:00:00Z" });
    expect(switchInput("nope", "")).toBeUndefined();
    expect(pauseSentence(null)).toBe("The planner is on.");
    expect(pauseSentence("9999-12-31T00:00:00.000Z")).toContain("until you switch it on");
    expect(pauseSentence("2026-11-20T09:00:00.000Z")).toBe("The planner is paused until 2026-11-20 09:00 UTC.");
  });
});
