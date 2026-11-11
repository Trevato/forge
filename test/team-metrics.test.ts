/** A team's coordination figures: known answers over a fixture ledger, and the page and MCP over 10k runs (#572). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrg, listTeams, OWNERS_TEAM, type Team } from "../src/core/orgs.ts";
import type { Session } from "../src/tui/session.ts";
import { teamFigureRows } from "../src/tui/screens/teamfigures.ts";
import {
  metricsRows,
  quantile,
  teamLedger,
  teamMetrics,
  FIGURES_KEPT,
  FIGURES_TTL_MS,
  keptFigures,
  teamWindows,
  type Ledger,
  type LedgerRun,
} from "../src/core/team-metrics.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

quietLogs();

const H = 3_600_000;
const run = (item: string, role: LedgerRun["role"], start: number, end: number | null, cost: number, reason = ""): LedgerRun => ({
  item,
  role,
  reason,
  costUsd: cost,
  startedAt: start * H,
  finishedAt: end === null ? null : end * H,
});

const ledger: Ledger = {
  slots: 3,
  items: [
    { id: "i1", kind: "issue", authorRole: "planner", openedAt: -2 * H, closedAt: 4 * H, mergedAt: null },
    { id: "i2", kind: "issue", authorRole: null, openedAt: 0, closedAt: 2 * H, mergedAt: null },
    { id: "i3", kind: "issue", authorRole: null, openedAt: 1 * H, closedAt: 11 * H, mergedAt: null },
    { id: "i4", kind: "issue", authorRole: null, openedAt: 0, closedAt: null, mergedAt: null },
    { id: "p1", kind: "pull", authorRole: "builder", openedAt: 3 * H, closedAt: 5 * H, mergedAt: 5 * H },
    { id: "p2", kind: "pull", authorRole: "builder", openedAt: 6 * H, closedAt: 8 * H, mergedAt: 8 * H },
    { id: "p3", kind: "pull", authorRole: null, openedAt: 9 * H, closedAt: null, mergedAt: null },
  ],
  runs: [
    run("i1", "planner", 0, 1, 1),
    run("i1", "builder", 1.5, 3.5, 2),
    run("i4", "planner", 1, 2, 1),
    run("i4", "builder", 5, 6, 2, "conflict"),
    run("i3", "planner", 1.5, 2, 0.5),
    run("i3", "builder", 4, 5, 1.5),
    run("i2", "builder", 1, 2, 1),
    run("p2", "reviewer", 8.5, 9.5, 1),
    run("p3", "builder", 9, 10, 1),
    run("i2", "builder", -5, -4, 100, "conflict"),
    run("i4", "builder", 22, null, 0),
  ],
  events: [{ item: "i3", kind: "reopened", at: 5 * H }],
  decisions: [
    { item: "p1", state: "changes_requested", at: 4 * H },
    { item: "p2", state: "approved", at: 9 * H },
    { item: "p3", state: "commented", at: 14 * H },
  ],
};

describe("teamMetrics over a fixture ledger", () => {
  const m = teamMetrics(ledger, 0, 24 * H);

  test("throughput and lead time", () => {
    expect(m.hours).toBe(24);
    expect(m.closedPerHour).toBe(3 / 24);
    expect(m.leadMedianMs).toBe(6 * H);
    expect(m.leadP90Ms).toBe(10 * H);
  });

  test("hand-off latency: planner to builder, builder to reviewer", () => {
    expect(m.plannerToBuilderMs).toBe(2 * H);
    expect(m.builderToReviewerMs).toBe(2.5 * H);
  });

  test("rework, conflicts, cost per shipped change", () => {
    expect(m.reworkRate).toBe(2 / 5);
    expect(m.conflictRate).toBe(1 / 10);
    expect(m.shipped).toBe(2);
    expect(m.costPerShippedUsd).toBe(5.5);
  });

  test("parallelism against slots, a running run counted to the window's end", () => {
    expect(m.parallelism).toBeCloseTo(11.5 / 24, 10);
    expect(m.slots).toBe(3);
  });

  test("an empty window measures nothing rather than zero", () => {
    const e = teamMetrics(ledger, 100 * H, 124 * H);
    expect(e.closedPerHour).toBe(0);
    expect(e.leadMedianMs).toBeNull();
    expect(e.plannerToBuilderMs).toBeNull();
    expect(e.reworkRate).toBeNull();
    expect(e.conflictRate).toBeNull();
    expect(e.costPerShippedUsd).toBeNull();
    expect(metricsRows(e)).toEqual([
      { label: "Issues closed", value: "0.00 an hour" },
      { label: "Lead time", value: "– typical, – for the slowest tenth" },
      { label: "Planner to builder", value: "–" },
      { label: "Builder to reviewer", value: "–" },
      { label: "Sent back", value: "–" },
      { label: "Conflicts", value: "–" },
      { label: "Cost per shipped change", value: "nothing shipped" },
      { label: "Slots busy", value: "1.0 of 3" },
    ]);
  });

  test("quantile is nearest-rank", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe("a team's page and the org_teams metrics action over 10k runs", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let teamId = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-team-metrics-"));
    app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
    const mk = async (username: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await mk("alice");
    const agents = [await mk("plan"), await mk("build"), await mk("check")];
    proveAll(app);
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error(org.error);
    teamId = listTeams(app.db, org.value.id).find((t) => t.name === OWNERS_TEAM)!.id;
    const roles = ["planner", "builder", "reviewer"];
    agents.forEach((a, i) =>
      app.db.run("INSERT INTO team_member (team_id, user_id, role) VALUES (?1, ?2, ?3)", [teamId, a.id, roles[i]!]),
    );
    const repo = await createRepo(app, alice, { name: "work" });
    if (!repo.ok) throw new Error(String(repo.error));

    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    const issue = app.db.prepare(
      `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at, closed_at)
       VALUES (?1, ?2, ?3, 'issue', 't', ?4, ?5, ?6, ?7)`,
    );
    const agentRun = app.db.prepare(
      `INSERT INTO run (id, repo_id, kind, issue_id, state, actor_id, reason, cost_usd, created_at, started_at, finished_at)
       VALUES (?1, ?2, 'agent', ?3, 'ok', ?4, ?5, 0.25, ?6, ?6, ?7)`,
    );
    app.db.transaction(() => {
      for (let n = 1; n <= 2_500; n++) {
        const opened = now - ((n % 160) + 2) * H;
        const id = `metrics-issue-${n}`;
        const closed = n % 2 === 0 ? iso(opened + H) : null;
        issue.run(id, repo.value.id, n, agents[0]!.id, closed ? "closed" : "open", iso(opened), closed);
        for (let k = 0; k < 4; k++) {
          const start = opened + k * 10 * 60_000;
          agentRun.run(`metrics-run-${n}-${k}`, repo.value.id, id, agents[k % 3]!.id, k === 3 && n % 10 === 0 ? "conflict" : "", iso(start), iso(start + 5 * 60_000));
        }
      }
    })();
    servers = await serve(app);
  });
  afterAll(() => {
    servers.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the ledger reads the runs and issues", () => {
    const { day, week } = teamWindows(app.db, teamId, Date.now());
    expect(week.slots).toBe(3);
    expect(week.closedPerHour).toBeGreaterThan(day.closedPerHour / 7);
    expect(week.leadMedianMs).toBe(H);
    expect(week.plannerToBuilderMs).toBe(5 * 60_000);
    expect(week.conflictRate).toBeGreaterThan(0);
    expect(week.costPerShippedUsd).toBeNull();
  });

  test("cold, the ledger is five statements, each a seek by index, never a scan of runs, issues, events or reviews", () => {
    const door = app.db as unknown as { query: (sql: string) => unknown };
    const original = app.db.query.bind(app.db);
    const seen: string[] = [];
    door.query = (sql: string) => {
      seen.push(sql);
      return original(sql);
    };
    try {
      teamLedger(app.db, teamId, Date.now() - 7 * 86_400_000);
    } finally {
      door.query = original;
    }
    expect(seen.length).toBe(5);
    for (const sql of seen) {
      const plan = app.db
        .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql.replace(/\?(\d)/g, "NULL")}`)
        .all()
        .map((p) => p.detail);
      expect(plan.filter((d) => /^SCAN (run|issue|event|review|pull)\b/.test(d))).toEqual([]);
    }
  });

  test("the figures of at most FIGURES_KEPT teams are kept", () => {
    const now = Date.now() + 60 * 60_000;
    for (let i = 0; i < FIGURES_KEPT + 10; i++) teamWindows(app.db, `no-such-team-${i}`, now);
    expect(keptFigures(app.db)).toBe(FIGURES_KEPT);
  });

  test("the terminal shows the page's rows to an org admin, and nothing to anyone else", () => {
    const org = { id: app.db.query<{ org_id: string }, [string]>("SELECT org_id FROM team WHERE id = ?1").get(teamId)!.org_id } as User;
    const team = { id: teamId } as Team;
    const rows = teamFigureRows({ app, user: alice } as unknown as Session, org, team);
    const { day, week } = teamWindows(app.db, teamId, Date.now());
    expect(rows.map((r) => r.title)).toEqual(metricsRows(day).map((r) => r.label));
    expect(rows[1]!.below).toEqual([`24 h: ${metricsRows(day)[1]!.value}`, `7 d: ${metricsRows(week)[1]!.value}`]);
    expect(teamFigureRows({ app, user: undefined } as unknown as Session, org, team)).toEqual([]);
  });

  test("the figures are kept a minute, then read again", () => {
    const now = Date.now() + 10 * 60_000;
    const before = teamWindows(app.db, teamId, now).week.reworkRate;
    app.db.run("UPDATE issue SET state = 'open', closed_at = NULL WHERE id = 'metrics-issue-2'");
    app.db.run(
      `INSERT INTO event (id, kind, repo_id, payload, created_at)
       SELECT 'metrics-reopen', 'issue.reopened', repo_id, '{"number":4}', ?1 FROM issue WHERE id = 'metrics-issue-4'`,
      [new Date(now - 60_000).toISOString()],
    );
    expect(teamWindows(app.db, teamId, now + 1_000).week.reworkRate).toBe(before);
    expect(teamWindows(app.db, teamId, now + FIGURES_TTL_MS).week.reworkRate).toBeGreaterThan(before ?? 0);
  });

  test("GET /:owner/-/teams/:team shows a line for 24 h and one for 7 d, from the cache once warm", async () => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const url = `${servers.url}/acme/-/teams/${teamId}`;
    const res = await fetch(url, { headers: { cookie } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("How fast this team turns issues into shipped changes");
    expect(body).toContain("<h3>24 h</h3>");
    expect(body).toContain("<h3>7 d</h3>");
    expect(body).toMatch(/<dt>Issues closed<\/dt><dd>[\d.]+ an hour<\/dd>/);
    expect(body).toContain("<dt>Lead time</dt><dd>1 h typical, 1 h for the slowest tenth</dd>");
    expect(body).not.toContain("p90");
    // Warm, the figures come from the minute's cache: the 10k-run ledger is not read again.
    const warm = await requestStatements(app.db, url, { headers: { cookie } });
    expectWork(warm, { max: 20 });
  });

  test("org_teams { action: metrics } returns the page's numbers", async () => {
    const token = createToken(app.db, alice.id, "admin", "admin").token;
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "org_teams", arguments: { org: "acme", team: OWNERS_TEAM, action: "metrics" } },
      }),
    });
    const got = JSON.parse(((await res.json()) as any).result.content[0].text);
    const want = teamWindows(app.db, teamId, Date.now());
    expect(got.week.leadMedianMs).toBe(want.week.leadMedianMs);
    expect(got.week.plannerToBuilderMs).toBe(want.week.plannerToBuilderMs);
    expect(got.week.conflictRate).toBe(want.week.conflictRate);
    expect(got.day.slots).toBe(3);
  });
});
