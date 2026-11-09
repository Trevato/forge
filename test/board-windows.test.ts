/**
 * The board's two new readings: each subscription's windows (used, left,
 * resets — and *inferred* wherever the provider did not say), and each
 * app's spend per shipped change over the week. Numbers are checked against
 * a hand calculation; statements are counted, so neither grows a query per
 * row (`test/counts.test.ts`'s rule).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { efficiencyForRepos } from "../src/core/efficiency.ts";
import { createRun } from "../src/core/runs.ts";
import {
  noteLimit,
  standing,
  standings,
  type WindowStanding,
} from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { perShippedWords } from "../src/core/efficiency.ts";
import { windowWords } from "../src/web/studio/words.ts";

/** Count the statements a block of work runs, through `db.query`. */
async function statements(db: Database, work: () => Promise<void> | void) {
  const original = db.query.bind(db);
  let count = 0;
  (db as unknown as { query: unknown }).query = (sql: string) => {
    count++;
    return original(sql);
  };
  try {
    await work();
  } finally {
    (db as unknown as { query: unknown }).query = original;
  }
  return count;
}

describe("the words for a window", () => {
  const base: WindowStanding = {
    window: "5h",
    startsAt: { value: "2026-10-02T10:00:00.000Z", source: "inferred" },
    resetsAt: { value: "2026-10-02T15:00:00.000Z", source: "inferred" },
    cap: { value: 10, source: "inferred" },
    used: { value: 3.2, source: "inferred" },
    remaining: { value: 6.8, source: "inferred" },
    kept: { value: 0, source: "inferred" },
    crewRemaining: { value: 6.8, source: "inferred" },
    runs: 2,
    tokensIn: 0,
    tokensOut: 0,
    said: null,
  };

  test("worked out from the ledger, every figure says inferred", () => {
    const w = windowWords(base);
    expect(w.name).toBe("5-hour window");
    expect(w.used).toEqual({ text: "$3.20 used", inferred: true });
    expect(w.remaining).toEqual({ text: "$6.80 left", inferred: true });
    expect(w.resets).toEqual({ text: "resets 15:00 UTC", inferred: true });
    // 3.20 ÷ 10.00 = 32 %.
    expect(w.usedPct).toBe(32);
  });

  test("a window the provider called full reads full, its reset as said", () => {
    const w = windowWords({
      ...base,
      window: "week",
      resetsAt: { value: "2026-10-05T03:00:00.000Z", source: "read" },
      remaining: { value: 0, source: "read" },
    });
    expect(w.name).toBe("weekly window");
    expect(w.remaining).toEqual({ text: "full", inferred: false });
    expect(w.resets).toEqual({ text: "resets 03:00 UTC", inferred: false });
    expect(w.usedPct).toBe(100);
  });

  test("before the first refusal there is no cap, and no bar", () => {
    const w = windowWords({ ...base, cap: null, remaining: null });
    expect(w.remaining).toEqual({ text: "cap not known yet", inferred: false });
    expect(w.usedPct).toBeNull();
    const closed = windowWords({ ...base, startsAt: null, resetsAt: null });
    expect(closed.resets.text).toBe("opens on next use");
  });

  test("spend per shipped change, and what is true without a ratio", () => {
    const e = { repoId: "r", runs: 2, spentUsd: 3.5, shipped: 2 };
    expect(perShippedWords({ ...e, perShippedUsd: 1.75 })).toBe(
      "$1.75 per shipped change",
    );
    expect(perShippedWords({ ...e, shipped: 0, perShippedUsd: null })).toBe(
      "$3.50 spent, nothing shipped",
    );
    expect(perShippedWords(undefined)).toBe("nothing spent or shipped");
  });
});

describe("efficiency and standing, grouped", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let servers: Servers;
  let cookie = "";
  let bobCookie = "";
  const repos: Record<string, string> = {};

  const signIn = async (username: string) =>
    (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

  const seedRepo = (name: string, autonomy = "off") => {
    const repoId = id();
    app.db
      .query(
        `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch)
         VALUES (?1, ?2, ?3, 'private', '', 'main')`,
      )
      .run(repoId, alice.id, name);
    app.db
      .query(
        `INSERT INTO app (id, repo_id, slug, access) VALUES (?1, ?2, ?3, 'private')`,
      )
      .run(id(), repoId, name);
    app.db.query("UPDATE repo SET autonomy = ?2 WHERE id = ?1").run(repoId, autonomy);
    repos[name] = repoId;
    return repoId;
  };
  let number = 0;
  const merged = (repoId: string, at: string | null) => {
    const issueId = id();
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, author_id, state)
         VALUES (?1, ?2, ?3, 'pull', 'a change', ?4, ?5)`,
      )
      .run(issueId, repoId, ++number, alice.id, at === null ? "open" : "closed");
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
         VALUES (?1, 'main', 'b', 'x', 'y', ?2)`,
      )
      .run(issueId, at);
  };
  const spend = (repoId: string, at: string, usd: number, sub: string | null = null) =>
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId, kind: "agent" }).id,
      repoId,
      issueId: null,
      agentId: null,
      subscriptionId: sub,
      tokensIn: 100,
      tokensOut: 10,
      costUsd: usd,
      wallMs: 60_000,
      outcome: "ok",
      at,
    });
  let subs = 0;
  const account = () => {
    const added = addSubscription(app.db, dataDir, {
      name: `account ${++subs}`,
      token: `sk-ant-oat01-board-windows-${subs}`,
    });
    if (!added.ok) throw new Error(added.error);
    return added.value.id;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-board-windows-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [
      ["alice", true],
      ["bob", false],
    ] as const) {
      const u = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      if (username === "alice") alice = u.value;
    }
    cookie = await signIn("alice");
    bobCookie = await signIn("bob");
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("spend per shipped change matches the hand sum, in one statement", async () => {
    const one = seedRepo("one");
    const two = seedRepo("two");
    const three = seedRepo("three");
    const quiet = seedRepo("quiet");
    const since = "2026-09-25T00:00:00.000Z";
    // one: $1.00 + $2.50 in the window ($10 before it is not); two merges
    // in it, one before, one still open. 3.50 ÷ 2 = 1.75.
    spend(one, "2026-09-26T12:00:00.000Z", 1);
    spend(one, "2026-09-30T12:00:00.000Z", 2.5);
    spend(one, "2026-09-20T12:00:00.000Z", 10);
    merged(one, "2026-09-27T00:00:00.000Z");
    merged(one, "2026-10-01T00:00:00.000Z");
    merged(one, "2026-09-01T00:00:00.000Z");
    merged(one, null);
    // two: spent, shipped nothing. three: shipped on no ledger spend.
    spend(two, "2026-09-28T00:00:00.000Z", 0.4);
    merged(three, "2026-09-29T00:00:00.000Z");

    let got = new Map();
    const n = await statements(app.db, () => {
      got = efficiencyForRepos(app.db, [one, two, three, quiet], since);
    });
    expect(n).toBe(1);
    expect(got.get(one)).toEqual({
      repoId: one,
      runs: 2,
      spentUsd: 3.5,
      shipped: 2,
      perShippedUsd: 1.75,
    });
    expect(got.get(two)).toEqual({
      repoId: two,
      runs: 1,
      spentUsd: 0.4,
      shipped: 0,
      perShippedUsd: null,
    });
    expect(got.get(three)?.perShippedUsd).toBe(0);
    expect(got.has(quiet)).toBe(false);
    expect(efficiencyForRepos(app.db, [], since).size).toBe(0);
  });

  test("the batch agrees with each account read alone, in three statements however many", async () => {
    const repoId = repos.one!;
    const now = new Date("2026-10-02T12:00:00.000Z");
    const a = account();
    const b = account();
    const c = account();
    spend(repoId, "2026-10-02T10:00:00.000Z", 1.25, a);
    spend(repoId, "2026-09-30T10:00:00.000Z", 4, a);
    spend(repoId, "2026-10-02T11:00:00.000Z", 0.75, b);
    noteLimit(app.db, b, {
      window: "5h",
      resetsAt: "2026-10-02T14:00:00.000Z",
      observedAt: "2026-10-02T11:30:00.000Z",
      said: "You've hit your session limit",
    });
    for (const ids of [[a], [a, b, c, "nope"]]) {
      const n = await statements(app.db, () => {
        standings(app.db, ids, now);
      });
      expect(n).toBe(3);
    }
    const all = standings(app.db, [a, b, c, "nope"], now);
    expect(all.has("nope")).toBe(false);
    for (const s of [a, b, c]) expect(all.get(s)).toEqual(standing(app.db, s, now)!);
    // a: the 5-hour window opened with the 10:00 run — $1.25; the week, the
    // chain from 30 Sep — $1.25 + $4.00.
    expect(all.get(a)!.windows.map((w) => w.used.value)).toEqual([1.25, 5.25]);
    expect(all.get(b)!.windows[0]!.remaining).toEqual({ value: 0, source: "read" });
  });

  test("the board shows each window to an admin, and each app's efficiency", async () => {
    // Fresh, relative to now: the board reads the week back from the clock.
    const now = Date.now();
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const live = seedRepo("live", "autonomous");
    spend(live, ago(30), 3);
    spend(live, ago(2), 1.5);
    merged(live, ago(20));
    merged(live, ago(1));
    merged(live, ago(9 * 24));
    // An app with autonomy off: spent on this week, nothing merged.
    spend(seedRepo("idle"), ago(5), 0.4);
    const full = account();
    spend(live, ago(1), 0.5, full);
    noteLimit(app.db, full, {
      window: "5h",
      resetsAt: new Date(now + 2 * 3_600_000).toISOString(),
      observedAt: ago(0.5),
      said: "You've hit your session limit",
    });

    const board = async (c: string) =>
      (await fetch(`${servers.url}/board`, { headers: { cookie: c } })).text();
    const page = await board(cookie);
    expect(page).toContain('id="windows"');
    expect(page).toContain("account 1");
    expect(page).toContain("5-hour window");
    expect(page).toContain("weekly window");
    // A plain row per subscription, never a boxed card, inside the strip.
    const strip = page.slice(page.indexOf('id="windows"'), page.indexOf('id="spend-detail"'));
    expect(strip).not.toContain('class="card');
    expect(strip).toContain('data-group="crew"');
    // A credential no app is scoped to sits in its own group.
    expect(strip).toContain('data-group="apart"');
    expect(strip).toContain('data-key="sub:');
    expect(strip).toContain('data-window="5h"');
    expect(strip).toContain('data-window="week"');
    expect(page).toMatch(/data-variant="outline"\s*>inferred</);
    expect(page).toContain(">full<");
    // ($3.00 + $1.50 + $0.50) ÷ 2 merged this week = $2.50.
    expect(page).toContain("$2.50 per shipped change this week");
    // An app the crew spent on with autonomy off still reads its ratio.
    expect(page).toContain("$0.40 spent, nothing shipped this week");

    // The pool is an admin's; nobody else gets the strip, or the reads.
    expect(await board(bobCookie)).not.toContain('id="windows"');

    // More accounts cost the board no more statements.
    const before = await statements(app.db, async () => {
      await board(cookie);
    });
    for (let i = 0; i < 4; i++) spend(live, ago(3), 0.1, account());
    const after = await statements(app.db, async () => {
      await board(cookie);
    });
    expect(after).toBe(before);
  });
});
