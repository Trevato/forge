/**
 * The usage ledger: a run's tokens, cost, wall time and outcome, attributed
 * to subscription, app, agent and issue — summed the way a hand would, and
 * read back over the API and MCP only by those who may see spend.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { usageDays } from "../src/actions/usage.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, listRuns } from "../src/core/runs.ts";
import {
  addSubscription,
  EVERYONE,
  setGrants,
} from "../src/core/subscriptions.ts";
import { migrations } from "../src/core/schema.ts";
import { createToken } from "../src/core/tokens.ts";
import {
  getUsage,
  recentUsage,
  recordUsage,
  usageTotals,
} from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { tokensOf } from "../src/crew/claude.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { openDb } from "../src/kernel/db.ts";
import { serve, type Servers } from "../src/http/server.ts";

const OAT = "sk-ant-oat01-personal-token-for-the-usage-test";
const KEY = "sk-ant-api03-work-key-for-the-usage-test";

describe("a result's token counts", () => {
  test("input is fresh + cache writes + cache reads; output is output", () => {
    // 1200 + 300 + 45000 = 46500 read; 800 written.
    expect(
      tokensOf({
        input_tokens: 1200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 45000,
        output_tokens: 800,
      }),
    ).toEqual({ tokensIn: 46500, tokensOut: 800 });
  });
  test("a missing or odd field counts nothing, never NaN", () => {
    expect(tokensOf(undefined)).toEqual({ tokensIn: 0, tokensOut: 0 });
    expect(
      tokensOf({ input_tokens: "12", output_tokens: -5, cache_read_input_tokens: NaN }),
    ).toEqual({ tokensIn: 0, tokensOut: 0 });
  });
});

describe("the ledger's migration", () => {
  test("repairs a database that took the ledger as migration 36 and never ran share", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-usage-mig-"));
    try {
      const path = join(dir, "forge.db");
      // What a preview migrated before the renumbering holds: 1–35, then
      // the ledger alone as 36 — no share table.
      const ledger = migrations[36]!.slice(
        migrations[36]!.indexOf("CREATE TABLE IF NOT EXISTS usage"),
      );
      const before = openDb(path, [...migrations.slice(0, 35), ledger]);
      const has = (db: typeof before, name: string): boolean =>
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1",
          )
          .get(name)!.n === 1;
      expect(has(before, "usage")).toBe(true);
      expect(has(before, "share")).toBe(false);
      before.close();
      // Today's list boots it: 36 is skipped as applied, 37 fills the gap.
      const after = openDb(path, migrations);
      expect(has(after, "usage")).toBe(true);
      expect(has(after, "share")).toBe(true);
      after.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the window a read covers", () => {
  test("is 1–90 whole days, 7 when unsaid, refused otherwise", () => {
    expect(usageDays(null)).toBe(7);
    expect(usageDays("")).toBe(7);
    expect(usageDays("1")).toBe(1);
    expect(usageDays("90")).toBe(90);
    for (const bad of ["0", "91", "-1", "1.5", "7d", "1e2", " 7"])
      expect(usageDays(bad)).toBeUndefined();
  });
});

describe("the ledger", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let other: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-usage-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const one = await createRepo(app, alice, { name: "one", visibility: "private" });
    const two = await createRepo(app, alice, { name: "two", visibility: "private" });
    if (!one.ok || !two.ok) throw new Error("repos");
    repo = one.value;
    other = two.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const run = (r: Repo) => createRun(app.db, { repoId: r.id, kind: "agent" }).id;

  test("sums by subscription, app and outcome as a hand would", () => {
    const a = run(repo);
    const b = run(repo);
    const c = run(repo);
    const d = run(other);
    const old = run(repo);
    const line = {
      issueId: null,
      agentId: alice.id,
      at: "2026-10-01T12:00:00.000Z",
    };
    recordUsage(app.db, {
      ...line,
      runId: a,
      repoId: repo.id,
      subscriptionId: "sub-work",
      tokensIn: 1000,
      tokensOut: 100,
      costUsd: 0.25,
      wallMs: 60_000,
      outcome: "ok",
    });
    recordUsage(app.db, {
      ...line,
      runId: b,
      repoId: repo.id,
      subscriptionId: "sub-work",
      tokensIn: 3000,
      tokensOut: 300,
      costUsd: 0.5,
      wallMs: 120_000,
      outcome: "paused",
    });
    recordUsage(app.db, {
      ...line,
      runId: c,
      repoId: repo.id,
      subscriptionId: null,
      tokensIn: 10,
      tokensOut: 1,
      costUsd: 0.01,
      wallMs: 1_000,
      outcome: "failed",
    });
    recordUsage(app.db, {
      ...line,
      runId: d,
      repoId: other.id,
      subscriptionId: "sub-work",
      tokensIn: 5,
      tokensOut: 5,
      costUsd: 2,
      wallMs: 5,
      outcome: "ok",
    });
    // Outside the window: never counted.
    recordUsage(app.db, {
      ...line,
      runId: old,
      repoId: repo.id,
      subscriptionId: "sub-work",
      tokensIn: 99_999,
      tokensOut: 99_999,
      costUsd: 99,
      wallMs: 99,
      outcome: "ok",
      at: "2026-09-01T00:00:00.000Z",
    });

    const since = "2026-09-30T00:00:00.000Z";
    const bySub = usageTotals(app.db, "subscription", { since, repoId: repo.id });
    // sub-work: 1000+3000 in, 100+300 out, $0.25+$0.50, 60s+120s, 1 ok + 1 paused.
    expect(bySub).toEqual([
      {
        key: "sub-work",
        runs: 2,
        ok: 1,
        failed: 0,
        paused: 1,
        tokensIn: 4000,
        tokensOut: 400,
        costUsd: 0.75,
        wallMs: 180_000,
      },
      {
        key: null,
        runs: 1,
        ok: 0,
        failed: 1,
        paused: 0,
        tokensIn: 10,
        tokensOut: 1,
        costUsd: 0.01,
        wallMs: 1_000,
      },
    ]);
    // Across every app, by app: two's $2 first, then one's $0.76.
    const byRepo = usageTotals(app.db, "repo", { since });
    expect(byRepo.map((r) => [r.key, r.runs, r.costUsd])).toEqual([
      [other.id, 1, 2],
      [repo.id, 3, 0.76],
    ]);
    expect(
      recentUsage(app.db, { since, repoId: other.id }, 10).map((u) => u.runId),
    ).toEqual([d]);
  });

  test("a run is one line: writing it again replaces, and nonsense counts as zero", () => {
    const a = run(repo);
    const base = {
      runId: a,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: null,
      at: "2026-10-02T00:00:00.000Z",
    } as const;
    recordUsage(app.db, {
      ...base,
      tokensIn: 7,
      tokensOut: 7,
      costUsd: 1,
      wallMs: 7,
      outcome: "failed",
    });
    recordUsage(app.db, {
      ...base,
      tokensIn: Number.NaN,
      tokensOut: -3,
      costUsd: Number.POSITIVE_INFINITY,
      wallMs: 2.6,
      outcome: "ok",
    });
    expect(getUsage(app.db, a)).toEqual({
      ...base,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      wallMs: 3,
      outcome: "ok",
      // Unsaid, a run is a build.
      kind: "build",
    });
    expect(
      app.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage WHERE run_id = ?1")
        .get(a)!.n,
    ).toBe(1);
  });
});

describe("a crew run's line, and who may read it", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bob: User;
  let bot: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-usage-run-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // On the personal token the provider is out for the week; on the work
    // key the stand-in does the work and reports what it read and wrote.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "${OAT}" ]; then
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You'"'"'ve hit your weekly limit · resets Sep 26 at 9pm (UTC)","total_cost_usd":0,"num_turns":0,"session_id":"fake-1"}'
  exit 1
fi
echo "work by the crew" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md.","total_cost_usd":0.0375,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed","usage":{"input_tokens":120,"cache_creation_input_tokens":2000,"cache_read_input_tokens":30000,"output_tokens":640}}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 2,
      runTimeoutMs: 60_000,
      // The pump picks queued runs on a tick; 5 s by default, 20 ms here,
      // so the paused run's retry on the work key starts at once.
      tickMs: 20,
    });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "another-good-passphrase",
    });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "public",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function until<T>(read: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(10);
    }
    throw new Error("did not happen in time");
  }

  test("each run is attributed to the account it ran on, the app, the agent and the issue", async () => {
    // Invariant: a crew run's ledger line names its subscription, app, agent and issue, and only the owner reads it over API and MCP.
    const personal = addSubscription(app.db, dataDir, { name: "personal", token: OAT });
    const work = addSubscription(app.db, dataDir, { name: "work", token: KEY });
    if (!personal.ok || !work.ok) throw new Error("pool");
    setGrants(app.db, repo.id, EVERYONE, [personal.value.id, work.value.id]);
    const issue = openIssue(app, alice, repo, { title: "Plant tulips", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const done = await until(() =>
      listRuns(app.db, repo.id, { kind: "agent" }).find(
        (r) => r.issueId === issue.value.id && r.state === "ok",
      ),
    );
    const refused = listRuns(app.db, repo.id, { kind: "agent" }).find((r) =>
      /takes over/.test(r.summary),
    )!;

    const line = await until(() => getUsage(app.db, done.id));
    // 120 + 2000 + 30000 read, 640 written, the provider's $0.0375.
    expect(line).toMatchObject({
      repoId: repo.id,
      issueId: issue.value.id,
      agentId: bot.id,
      subscriptionId: work.value.id,
      tokensIn: 32_120,
      tokensOut: 640,
      costUsd: 0.0375,
      outcome: "ok",
    });
    expect(line.wallMs).toBeGreaterThan(0);
    expect(getUsage(app.db, refused.id)).toMatchObject({
      subscriptionId: personal.value.id,
      tokensIn: 0,
      tokensOut: 0,
      outcome: "paused",
    });

    // The API: the owner reads it, summed and named.
    const owner = createToken(app.db, alice.id, "ro", "ro").token;
    const url = `${servers.url}/api/v1/repos/alice/garden/usage`;
    const got = await fetch(url, { headers: { authorization: `Bearer ${owner}` } });
    expect(got.status).toBe(200);
    const body = (await got.json()) as any;
    expect(body.app).toBe("alice/garden");
    expect(body.days).toBe(7);
    expect(body.total).toMatchObject({ runs: 2, ok: 1, paused: 1, tokensIn: 32_120 });
    expect(
      body.bySubscription.map((r: any) => [r.subscription, r.runs, r.tokensOut]),
    ).toEqual([
      ["work", 1, 640],
      ["personal", 1, 0],
    ]);
    expect(body.byAgent).toEqual([expect.objectContaining({ agent: "bot", runs: 2 })]);
    expect(body.byIssue).toEqual([
      expect.objectContaining({ issue: issue.value.number, runs: 2 }),
    ]);
    expect(body.recent[0].subscription).toBe("work");
    expect(JSON.stringify(body)).not.toContain(KEY);

    // Each account's standing rides along. The personal plan's week is full
    // on the provider's word, until the reset it named; the work key's
    // windows are inferred from the one run it paid for.
    expect(body.standing.map((s: any) => s.subscription)).toEqual([
      "personal",
      "work",
    ]);
    const [mine, theirs] = body.standing;
    const week = mine.windows.find((w: any) => w.window === "week");
    expect(week.resetsAt.source).toBe("read");
    expect(week.resetsAt.value.slice(5, 16)).toBe("09-26T21:00");
    expect(week.remaining).toEqual({ value: 0, source: "read" });
    expect(week.said).toContain("weekly limit");
    const session = theirs.windows.find((w: any) => w.window === "5h");
    expect(session.used).toEqual({ value: 0.0375, source: "inferred" });
    expect(session.startsAt.source).toBe("inferred");
    expect(session.cap).toBeNull();
    expect(session.tokensIn).toBe(32_120);

    // A window that is not 1–90 days is refused, not guessed at.
    const bad = await fetch(`${url}?days=365`, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).error).toBe("invalid_days");

    // Spend is the owner's fact: a reader of the public app is refused,
    // and so is nobody at all.
    const reader = createToken(app.db, bob.id, "ro", "ro").token;
    const refusedRead = await fetch(url, {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(refusedRead.status).toBe(403);
    expect((await fetch(url)).status).toBe(403);

    // MCP says the same, and refuses the same.
    const mcp = async (token: string, args: Record<string, unknown>) => {
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
          params: { name: "usage", arguments: args },
        }),
      });
      return (await res.json()) as any;
    };
    const told = await mcp(owner, { repo: "alice/garden", days: 7 });
    const value = JSON.parse(told.result.content[0].text);
    expect(value.total).toEqual(body.total);
    expect(value.standing.map((s: any) => s.subscription)).toEqual([
      "personal",
      "work",
    ]);
    const no = await mcp(reader, { repo: "alice/garden" });
    expect(no.result.isError).toBe(true);
    expect(no.result.content[0].text).toContain("forbidden");
    const odd = await mcp(owner, { repo: "alice/garden", days: "7" });
    expect(odd.result.content[0].text).toContain("invalid_days");
  }, 60_000);
});
