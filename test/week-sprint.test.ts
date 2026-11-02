/**
 * The week is the sprint (#8704): an estimate is a range from past issues of
 * its size and kind and says when it has too little history; the cut line
 * falls where the week's capacity ends and moves when the list is reranked;
 * the same state gives the same line; at the reset the forge writes one
 * frozen retrospective with at most three proposals, and nothing changes
 * until a person takes one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { takeProposal } from "../src/actions/week.ts";
import { getIssue } from "../src/core/issues.ts";
import { nextUp } from "../src/core/next_up.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { estimate, issueHistory, sizeOf, type Sample } from "../src/flow/estimate.ts";
import { noteLimit } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { weekCapacity } from "../src/flow/week.ts";
import { latestRetro, takenOf, tickWeeks, windowShipped, windowSpend, writeRetro } from "../src/flow/retro.ts";
import { cutLine, priceRows, projection } from "../src/flow/week.ts";
import { serve, type Servers } from "../src/http/server.ts";

const sample = (usd: number, size: Sample["size"] = "small", kind = ""): Sample => ({ size, kind, usd });

describe("estimates and the cut line, as data", () => {
  test("with too little history an estimate says so", () => {
    const e = estimate([sample(1), sample(2)], "small", "");
    expect(e.known).toBe(false);
    expect(e.basis).toContain("too little history");
  });

  test("a range comes from past issues of the same size and kind, else the same size", () => {
    const history = [1, 2, 3, 4, 5].map((n) => sample(n)).concat([sample(40, "small", "bug")]);
    expect(estimate(history, "small", "")).toMatchObject({ known: true, samples: 5 });
    // One "bug" sample is too few to speak for the kind: the size answers.
    expect(estimate(history, "small", "bug")).toMatchObject({ known: true, samples: 6 });
    const bugs = estimate([...history, sample(8, "small", "bug"), sample(9, "small", "bug")], "small", "bug");
    expect(bugs).toMatchObject({ known: true, samples: 3 });
    expect(estimate(history, "large", "").known).toBe(false);
  });

  test("the same history gives the same estimate", () => {
    const history = [5, 1, 4, 2, 3].map((n) => sample(n));
    expect(estimate(history, "small", "")).toEqual(estimate([...history].reverse(), "small", ""));
  });

  const priced = (mids: (number | null)[]) =>
    mids.map((m, i) => ({
      number: i + 1,
      estimate:
        m === null
          ? ({ known: false, samples: 0, basis: "x" } as const)
          : ({ known: true, low: m / 2, mid: m, high: m * 2, samples: 9, basis: "x" } as const),
    }));

  test("the line falls after the last issue that fits, strictly from the top", () => {
    const cut = cutLine(priced([2, 3, 1]), { usd: 5, resetsAt: null });
    expect(cut.fits).toEqual([1, 2]);
    // Issue 3 would fit the money left over, but the crew builds from the top and stops.
    expect(cutLine(priced([4, 3, 1]), { usd: 5, resetsAt: null }).fits).toEqual([1]);
  });

  test("reranking moves the line, and the same state gives the same line", () => {
    const cap = { usd: 5, resetsAt: null };
    expect(cutLine(priced([2, 3, 1]), cap)).toEqual(cutLine(priced([2, 3, 1]), cap));
    expect(cutLine(priced([2, 3, 1]), cap).fits).toEqual([1, 2]);
    const swapped = [priced([2, 3, 1])[2]!, priced([2, 3, 1])[0]!, priced([2, 3, 1])[1]!];
    expect(cutLine(swapped, cap).fits).toEqual([3, 1]);
  });

  test("no capacity or no history means no line, and the sentence says why", () => {
    expect(cutLine(priced([1]), null).unsure).toContain("capacity");
    expect(cutLine(priced([null]), { usd: 9, resetsAt: null }).unsure).toContain("history");
    expect(projection(cutLine(priced([null]), null), 1, null)).toStartWith("No projection yet");
  });

  test("the projection is one sentence with a range and a confidence", () => {
    const cap = { usd: 5, resetsAt: "2026-11-09T00:00:00.000Z" };
    const words = projection(cutLine(priced([2, 3, 1]), cap), 3, cap);
    expect(words).toContain("of the 3 issues");
    expect(words).toContain("2026-11-09");
    expect(words).toContain("high confidence");
  });
});

describe("the week, in a forge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookie: string;
  const n: Record<string, number> = {};
  const WEEK_END = "2026-11-09T00:00:00.000Z";

  const open = (title: string, body = ""): number => {
    const o = openIssue(app, alice, repo, { title, body });
    if (!o.ok) throw new Error(String(o.error));
    return o.value.number;
  };
  const close = (number: number) => {
    const r = setIssueState(app, alice, repo, getIssue(app.db, repo.id, number)!, "closed");
    if (!r.ok) throw new Error(String(r.error));
  };
  const spend = (number: number, usd: number, state = "ok", startedAt = "2026-11-04T10:00:00.000Z", summary = "") => {
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, issue_id, state, cost_usd, started_at, summary)
         VALUES (lower(hex(randomblob(8))), ?1, 'agent', ?2, ?3, ?4, ?5, ?6)`,
      )
      .run(repo.id, getIssue(app.db, repo.id, number)!.id, state, usd, startedAt, summary);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-week-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "plan", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    n.gate = open("Later gate: not now");
    // Past work: five small issues done at $1..$5 are the history.
    for (const usd of [1, 2, 3, 4, 5]) {
      const done = open(`Past ${usd}`);
      spend(done, usd);
      close(done);
    }
    n.a = open("Alpha");
    n.b = open("Beta");
    n.stuck = open("Stuck one");
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("history is the closed issues' real spend", () => {
    const h = issueHistory(app.db, repo.id);
    expect(h.map((s) => s.usd).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(sizeOf({ title: "x", body: "" })).toBe("small");
  });

  test("each row of Next up has a range, and the same rows give the same prices", () => {
    const rows = nextUp(app.db, repo).rows;
    const one = priceRows(app.db, repo.id, rows);
    expect(one).toEqual(priceRows(app.db, repo.id, rows));
    expect(one.every((p) => p.estimate.known)).toBe(true);
  });

  test("the page shows ranges and the projection sentence; no capacity read means no line", async () => {
    const res = await fetch(`${servers.url}/alice/plan/next`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("$2.00–$4.00");
    expect(text).toContain("No projection yet: the weekly capacity has not been read yet.");
    expect(text).not.toContain('role="separator"');
  });

  test("capacity is what the weekly window leaves, read from the ledger", () => {
    expect(weekCapacity(app.db, new Date("2026-11-06T00:00:00Z"))).toBeNull();
    const added = addSubscription(app.db, dataDir, { name: "week account", token: "sk-ant-oat01-week-test-1" });
    if (!added.ok) throw new Error(added.error);
    const sub = added.value.id;
    const ran = (at: string, usd: number) =>
      recordUsage(app.db, {
        runId: createRun(app.db, { repoId: repo.id, kind: "agent" }).id, repoId: repo.id, issueId: null, agentId: null,
        subscriptionId: sub, tokensIn: 1, tokensOut: 1, costUsd: usd, wallMs: 1000, outcome: "ok", at,
      });
    ran("2026-10-30T10:00:00.000Z", 20);
    noteLimit(app.db, sub, {
      window: "week", resetsAt: "2026-11-02T00:00:00.000Z", observedAt: "2026-10-31T00:00:00.000Z", said: "weekly limit",
    });
    ran("2026-11-05T10:00:00.000Z", 5);
    // The provider refused at $20 of spend and reset on the 2nd: that is the cap, the next window ends a week on, and $5 of it is used.
    const cap = weekCapacity(app.db, new Date("2026-11-06T00:00:00Z"))!;
    expect(cap.resetsAt).toBe(WEEK_END);
    expect(cap.usd).toBeGreaterThan(0);
    expect(cap.usd).toBeLessThanOrEqual(15);
  });

  test("with capacity, the page draws the cut line between what fits and next week", () => {
    const rows = nextUp(app.db, repo).rows;
    const priced = priceRows(app.db, repo.id, rows);
    const cut = cutLine(priced, { usd: 3, resetsAt: WEEK_END });
    expect(cut.unsure).toBeNull();
    expect(cut.fits.length).toBeGreaterThan(0);
    expect(cut.fits.length).toBeLessThan(rows.length);
    expect(projection(cut, rows.length, { usd: 3, resetsAt: WEEK_END })).toContain("of the");
  });

  test("the retrospective is written once, frozen, with proposals that change nothing until taken", () => {
    app.db
      .query("INSERT INTO week_projection (repo_id, week_end, body, at) VALUES (?1, ?2, ?3, ?4)")
      .run(
        repo.id,
        WEEK_END,
        JSON.stringify({ sentence: "s", fits: [n.a], shipLow: 1, shipHigh: 2, confidence: "medium", ranges: { [String(n.a!)]: { low: 1, high: 3 } } }),
        "2026-11-02T00:00:00.000Z",
      );
    // Alpha shipped at $2 (inside its range); Stuck one spent $9 over three failed runs and is still open.
    spend(n.a!, 2);
    close(n.a!);
    app.db.query("UPDATE issue SET closed_at = '2026-11-05T00:00:00.000Z' WHERE repo_id = ?1 AND number = ?2").run(repo.id, n.a!);
    for (let i = 0; i < 3; i++) spend(n.stuck!, 3, "failed", "2026-11-06T10:00:00.000Z", "the check failed");
    const now = new Date("2026-11-09T01:00:00.000Z");
    expect(tickWeeks(app.db, [repo], now)).toHaveLength(1);
    expect(tickWeeks(app.db, [repo], now)).toHaveLength(0);
    expect(writeRetro(app.db, repo, WEEK_END, now)).toBe(false);
    const retro = latestRetro(app.db, repo.id)!;
    expect(retro.shipped.map((s) => s.number)).toContain(n.a!);
    expect(retro.accuracy).toEqual({ compared: 1, inside: 1 });
    expect(retro.stuck.map((s) => s.number)).toEqual([n.stuck!]);
    expect(retro.stuck[0]!.why).toContain("its check failed");
    expect(retro.proposals.length).toBeLessThanOrEqual(3);
    expect(retro.proposals[0]).toMatchObject({ kind: "not_now", number: n.stuck! });
    // Writing it changed nothing: the issue is still on the list.
    expect(nextUp(app.db, repo).rows.map((r) => r.issue.number)).toContain(n.stuck!);
  });

  test("the screen is reachable and a tap takes a proposal once", async () => {
    const page = await (await fetch(`${servers.url}/alice/plan/week`, { headers: { cookie } })).text();
    expect(page).toContain("What shipped");
    expect(page).toContain("Take it");
    const retro = latestRetro(app.db, repo.id)!;
    const taken = takeProposal(app, alice, repo, retro.weekEnd, 0);
    expect(taken.ok).toBe(true);
    expect(takenOf(app.db, repo.id, retro.weekEnd).has(0)).toBe(true);
    expect(takeProposal(app, alice, repo, retro.weekEnd, 0).ok).toBe(false);
    expect(nextUp(app.db, repo).rows.map((r) => r.issue.number)).not.toContain(n.stuck!);
  });

  test("a proposal is refused for a reader and for one that does not exist", () => {
    const retro = latestRetro(app.db, repo.id)!;
    expect(takeProposal(app, alice, repo, retro.weekEnd, 7).ok).toBe(false);
    expect(takeProposal(app, alice, repo, "2020-01-01T00:00:00.000Z", 0).ok).toBe(false);
  });
});

describe("the reads walk an index", () => {
  test("history, labels and the window reads show no scan and no sort in their plans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-week-plan-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      const db = app.db;
      const original = db.query.bind(db);
      const sqls: string[] = [];
      (db as unknown as { query: unknown }).query = (sql: string) => (sqls.push(sql), original(sql));
      issueHistory(db, "x");
      windowSpend(db, "x", "a", "b");
      windowShipped(db, "x", "a", "b");
      (await import("../src/flow/estimate.ts")).labelsOf(db, ["x"]);
      (db as unknown as { query: unknown }).query = original;
      const lines = sqls
        .filter((q) => /^\s*SELECT/i.test(q))
        .flatMap((q) => {
          const n = Math.max(0, ...[...q.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
          return original(`EXPLAIN QUERY PLAN ${q}`).all(...Array.from({ length: n }, () => "x")).map((r) => (r as { detail: string }).detail);
        });
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) {
        expect(line).not.toMatch(/^SCAN (?!.*USING (COVERING )?INDEX)/);
        expect(line).not.toContain("TEMP B-TREE");
      }
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
