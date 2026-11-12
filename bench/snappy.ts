/**
 * The snappy fixture (#2675): a forge shaped like the one the owner reported
 * slow — a dozen apps with planned work, dependencies between issues, a few
 * running themselves — and the two pages measured on it, `/map` and `/`, as
 * the owner and as a stranger.
 *
 *   bun run bench/snappy.ts            # p50/p95 and SQL per request
 *   bun run bench/snappy.ts --n 100
 *
 * `test/snappy.test.ts` boots the same fixture and holds the budgets
 * (docs/CACHING.md), so the numbers in a pull and the numbers a test keeps
 * are measured the same way.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { setMember } from "../src/core/roles.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { countStatements, type SqlCounter } from "./run.ts";

export interface SnappyFixture {
  readonly app: App;
  readonly servers: Servers;
  readonly base: string;
  readonly owner: User;
  readonly peer: User;
  /** A session cookie for the owner, the forge's admin. */
  readonly ownerCookie: string;
  /** A session cookie for a member who owns one small repository of their own. */
  readonly peerCookie: string;
  readonly counter: SqlCounter;
  /** The owner's repositories, in the order they were made. */
  readonly repos: readonly Repo[];
  readonly dataDir: string;
  close(): Promise<void>;
}

export interface FixturePlan {
  readonly repos: number;
  readonly issuesPerRepo: number;
}

export const FIXTURE: FixturePlan = { repos: 12, issuesPerRepo: 24 };

async function person(app: App, username: string, admin: boolean): Promise<User> {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: admin,
  });
  if (!made.ok) throw new Error(made.error);
  setMember(app.db, made.value.id, true, made.value.id, new Date());
  return made.value;
}

/**
 * Each repository: `issuesPerRepo` open issues, every third one waiting on
 * the one before it and every fifth on the first — a few chains and a fan,
 * so the layout has crossings to undo. Every fourth repository runs itself.
 */
export async function snappyFixture(
  plan: FixturePlan = FIXTURE,
): Promise<SnappyFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-snappy-"));
  const app = createApp({ dataDir, port: 0 });
  const owner = await person(app, "olive", true);
  const peer = await person(app, "pablo", false);
  const repos: Repo[] = [];
  for (let r = 0; r < plan.repos; r++) {
    const made = await createRepo(app, owner, {
      name: `app-${r}`,
      visibility: r % 3 === 0 ? "public" : "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    repos.push(repo);
    const issues: Issue[] = [];
    for (let i = 0; i < plan.issuesPerRepo; i++) {
      const opened = openIssue(app, owner, repo, {
        title: `Step ${i + 1} of the plan for app ${r}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      issues.push(opened.value);
    }
    for (let i = 1; i < issues.length; i++) {
      const issue = issues[i]!;
      if (i % 3 === 0) addDependency(app.db, issue, issues[i - 1]!, owner.id);
      if (i % 5 === 0) addDependency(app.db, issue, issues[0]!, owner.id);
    }
    if (r % 4 === 0) {
      const on = await updateRepoSettings(app, owner, repo, {
        autonomy: "assisted",
        autonomyDirection: "Keep going.",
        autonomyCeilingUsd: 10,
        autonomySlots: 1,
        autonomyBy: owner.id,
      });
      if (!on.ok) throw new Error(String(on.error));
    }
  }
  const mine = await createRepo(app, peer, { name: "notes", visibility: "private" });
  if (!mine.ok) throw new Error(String(mine.error));
  openIssue(app, peer, mine.value, { title: "Peer's own private plan" });

  const counter = countStatements(app.db);
  const servers = await serve(app);
  const cookie = (user: User): string =>
    `forge_session=${createSession(app.db, user.id).token}`;
  return {
    app,
    servers,
    base: servers.url,
    owner,
    peer,
    ownerCookie: cookie(owner),
    peerCookie: cookie(peer),
    counter,
    repos,
    dataDir,
    async close() {
      servers.stop();
      counter.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Timing {
  readonly name: string;
  readonly p50: number;
  readonly p95: number;
  readonly sql: number;
  readonly status: number;
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;

/**
 * Telemetry flushes on their own timer (docs/CACHING.md, "Telemetry does not
 * invalidate"). They share the connection, so a flush that lands inside a
 * timed request would be counted against the page, and which request it lands
 * in depends on the machine's load, not on the page. Only the flush's writes
 * are named: INSERT/UPDATE/DELETE on `route_timing` and `usage_count`, and the
 * `PRAGMA busy_timeout` calls around them. A page's own read of those tables
 * still counts.
 */
const TELEMETRY_SQL =
  /^(INSERT INTO|UPDATE|DELETE FROM)\s+(route_timing|usage_count)\b|^PRAGMA busy_timeout/i;

/** The statements run since the counter's last reset, less the telemetry flush's. */
export function pageStatements(counter: SqlCounter): number {
  let telemetry = 0;
  for (const { sql, times } of counter.top(Number.MAX_SAFE_INTEGER)) if (TELEMETRY_SQL.test(sql)) telemetry += times;
  return counter.count - telemetry;
}

/**
 * The median of per-request statement counts. Another timer's stray statement
 * lands in one window or another by the machine's load and must not move the
 * figure. The cost: a statement issued by fewer than half the requests (a
 * cache miss every fourth request) is not seen here; the cold rows, which
 * write before every request, are where misses are budgeted.
 */
export function medianCount(counts: readonly number[]): number {
  const sorted = [...counts].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Time `n` sequential requests after one warm-up; SQL is per request. */
export async function timeRoute(
  f: SnappyFixture,
  name: string,
  path: string,
  headers: Record<string, string>,
  n: number,
  /** Run before each timed request, outside the timer: a write, for a cold cache. */
  before?: () => void,
): Promise<Timing> {
  const hit = async (): Promise<number> => {
    const res = await fetch(`${f.base}${path}`, { headers, redirect: "manual" });
    await res.arrayBuffer();
    return res.status;
  };
  await hit();
  const times: number[] = [];
  let status = 0;
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    before?.();
    // Only the page's own statements count: not the write before it.
    f.counter.reset();
    const started = performance.now();
    status = await hit();
    times.push(performance.now() - started);
    counts.push(pageStatements(f.counter));
  }
  const sql = medianCount(counts);
  times.sort((a, b) => a - b);
  return { name, p50: percentile(times, 50), p95: percentile(times, 95), sql, status };
}

/** The four rows the issue asks for, plus the owner's map after a write. */
export async function snappyTimings(f: SnappyFixture, n: number): Promise<Timing[]> {
  const owner = { cookie: f.ownerCookie };
  const peer = { cookie: f.peerCookie };
  let k = 0;
  const touch = () =>
    f.app.db
      .query("UPDATE repo SET description = ?1 WHERE id = ?2")
      .run(`touched ${k++}`, f.repos[0]!.id);
  return [
    await timeRoute(f, "GET /map  owner", "/map", owner, n),
    await timeRoute(f, "GET /map  member", "/map", peer, n),
    await timeRoute(f, "GET /map  stranger", "/map", {}, n),
    await timeRoute(f, "GET /     owner", "/", owner, n),
    await timeRoute(f, "GET /     member", "/", peer, n),
    await timeRoute(f, "GET /     stranger", "/", {}, n),
    // Cold: a write before each request, so every cache misses.
    await timeRoute(f, "GET /map  owner cold", "/map", owner, n, touch),
    await timeRoute(f, "GET /     owner cold", "/", owner, n, touch),
  ];
}

export function table(rows: readonly Timing[]): string {
  const head = "route                    p50 ms   p95 ms   SQL/req  status";
  return [
    head,
    "-".repeat(head.length),
    ...rows.map((r) =>
      [
        r.name.padEnd(22),
        r.p50.toFixed(1).padStart(8),
        r.p95.toFixed(1).padStart(8),
        r.sql.toFixed(1).padStart(9),
        String(r.status).padStart(7),
      ].join(" "),
    ),
  ].join("\n");
}

if (import.meta.main) {
  // Quiet for the table; never inside a test run, where the level is global.
  setLogLevel("error");
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--n");
  const n = i === -1 ? 50 : Math.max(1, Number(argv[i + 1]) || 50);
  const f = await snappyFixture();
  console.log(table(await snappyTimings(f, n)));
  await f.close();
  process.exit(0);
}
